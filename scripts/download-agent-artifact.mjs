#!/usr/bin/env node
/** Download reviewed upstream artifact URLs; never execute the downloaded bytes. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(repoRoot, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('output path is required');
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function resolveArtifactDownload(config, platform, version, { tag } = {}) {
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('invalid version');
  if (!(config.platforms ?? []).includes(platform)) throw new Error(`unsupported platform ${platform}`);
  const sourceArchive = config.acquisition?.strategy === 'source-revision';
  const artifact = sourceArchive ? config.acquisition.sourceArchive : config.acquisition?.artifacts?.[platform];
  if (!artifact) throw new Error(`unsupported platform ${platform}`);
  const urls = artifact.urls.map((template) => {
    if (template.includes('${tag}') && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag ?? '')) {
      throw new Error('a normalized release tag is required');
    }
    const expanded = template.replaceAll('${version}', version).replaceAll('${tag}', tag ?? '');
    if (expanded.includes('${')) throw new Error(`unsupported URL template in ${platform}`);
    const url = new URL(expanded);
    if (url.protocol !== 'https:' || !config.acquisition.allowedHosts.includes(url.hostname)) {
      throw new Error(`artifact URL origin is not allowlisted: ${url.origin}`);
    }
    return url.href;
  });
  return {
    ...artifact,
    artifactKind: sourceArchive ? 'source-archive' : 'standalone-executable',
    urls,
    maxBytes: config.acquisition.maxBytes,
    allowedHosts: config.acquisition.allowedHosts,
  };
}

async function fetchArtifact(spec, fetchImpl) {
  const failures = [];
  for (const url of spec.urls) {
    try {
      let currentUrl = url;
      let response;
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        response = await fetchImpl(currentUrl, {
          redirect: 'manual',
          headers: { 'user-agent': 'vibecook-puppeteer-artifact-acquisition' },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirects === 5) throw new Error('artifact redirect limit exceeded');
        const location = response.headers.get('location');
        if (!location) throw new Error(`artifact redirect ${response.status} has no location`);
        const redirected = new URL(location, currentUrl);
        if (redirected.protocol !== 'https:' || !spec.allowedHosts.includes(redirected.hostname)) {
          throw new Error(`redirected to non-allowlisted origin ${redirected.origin}`);
        }
        currentUrl = redirected.href;
      }
      if (!response) throw new Error('artifact request produced no response');
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const finalUrl = new URL(response.url || currentUrl);
      if (finalUrl.protocol !== 'https:' || !spec.allowedHosts.includes(finalUrl.hostname)) {
        throw new Error(`redirected to non-allowlisted origin ${finalUrl.origin}`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > spec.maxBytes)
        throw new Error(`artifact exceeds ${spec.maxBytes} bytes`);
      const reader = response.body?.getReader?.();
      let bytes;
      if (reader) {
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            length += chunk.length;
            if (length > spec.maxBytes) {
              await reader.cancel('artifact exceeded configured byte limit');
              throw new Error(`artifact exceeds ${spec.maxBytes} bytes`);
            }
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
        bytes = Buffer.concat(chunks, length);
      } else {
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (bytes.length < 1 || bytes.length > spec.maxBytes) throw new Error(`artifact size ${bytes.length} is invalid`);
      // Record the reviewed URL, never where it redirected: release hosts answer with
      // short-lived signed URLs (`sig=`, `jwt=` bearer material), and this metadata is
      // copied into tracked evidence by the assemble and evidence-update steps.
      return { bytes, sourceUrl: url };
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`artifact download failed:\n${failures.join('\n')}`);
}

/**
 * Entries of an archive listing. Windows bsdtar ends listing lines with CRLF; splitting on LF alone
 * left a trailing CR on every entry, which the control-character guard then rejected. A CR anywhere
 * else in a name still makes the entry unsafe.
 */
export function archiveListingEntries(listing) {
  return listing.split(/\r?\n/).filter(Boolean);
}

export function safeArchiveEntry(entry) {
  return (
    Boolean(entry) &&
    !entry.startsWith('/') &&
    !entry.startsWith('-') &&
    !entry.startsWith('@') &&
    !entry.includes('\\') &&
    !entry.split('/').includes('..') &&
    !/[\u0000-\u001f\u007f*?[\]]/.test(entry)
  );
}

function listArchive(archive, format) {
  if (format === 'tar.gz') {
    return {
      entries: execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
      tool: 'tar',
    };
  }
  if (format !== 'zip') throw new Error(`unsupported archive format ${format}`);
  try {
    return {
      entries: execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
      tool: 'unzip',
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // Windows ships bsdtar, which can read ZIP archives even when unzip is absent.
    return {
      entries: execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
      tool: 'tar',
    };
  }
}

function readArchiveEntry(archive, entry, format, tool, maxBytes) {
  const args =
    format === 'tar.gz'
      ? ['-xOzf', archive, entry]
      : tool === 'unzip'
        ? ['-p', archive, entry]
        : ['-xOf', archive, entry];
  return execFileSync(tool, args, { maxBuffer: maxBytes + 1 });
}

function extractExecutable(archiveBytes, spec, output) {
  const archive = `${output}.download.${spec.format === 'zip' ? 'zip' : 'tar.gz'}`;
  writeFileSync(archive, archiveBytes);
  try {
    const listing = listArchive(archive, spec.format);
    const entries = archiveListingEntries(listing.entries);
    if (entries.some((entry) => !safeArchiveEntry(entry))) throw new Error('archive contains an unsafe path');
    const matches = entries.filter(
      (entry) => !entry.endsWith('/') && spec.executableBasenames.includes(basename(entry)),
    );
    if (matches.length !== 1) {
      throw new Error(`archive must contain exactly one reviewed executable (found ${matches.length})`);
    }
    const bytes = readArchiveEntry(archive, matches[0], spec.format, listing.tool, spec.maxBytes);
    if (bytes.length < 1 || bytes.length > spec.maxBytes) throw new Error('extracted executable has an invalid size');
    return bytes;
  } finally {
    rmSync(archive, { force: true });
  }
}

export function resolveSourceArchiveRoot(entries, rootFiles) {
  const anchor = rootFiles[0];
  const candidates = new Set(
    entries
      .filter((entry) => entry === anchor || entry.endsWith(`/${anchor}`))
      .map((entry) => entry.slice(0, entry.length - anchor.length).replace(/\/$/, '')),
  );
  const valid = [...candidates].filter((root) =>
    rootFiles.every((rootFile) => {
      const expected = root === '.' || root === '' ? rootFile : `${root}/${rootFile}`;
      return entries.filter((entry) => entry === expected).length === 1;
    }),
  );
  if (valid.length !== 1) {
    throw new Error(`source archive must contain exactly one reviewed project root (found ${valid.length})`);
  }
  return valid[0] || '.';
}

function inspectSourceArchive(archiveBytes, spec, output) {
  const archive = `${output}.download.${spec.format === 'zip' ? 'zip' : 'tar.gz'}`;
  writeFileSync(archive, archiveBytes);
  try {
    const listing = listArchive(archive, spec.format);
    const entries = archiveListingEntries(listing.entries);
    if (entries.some((entry) => !safeArchiveEntry(entry))) throw new Error('archive contains an unsafe path');
    return resolveSourceArchiveRoot(entries, spec.rootFiles);
  } finally {
    rmSync(archive, { force: true });
  }
}

export async function downloadAgentArtifact({
  repoRoot = root,
  vendor,
  version,
  platform,
  tag,
  output,
  fetchImpl = fetch,
}) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('invalid vendor');
  const configPath = resolve(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json');
  const config = json(configPath);
  if (config.vendor !== vendor) throw new Error('upstream configuration vendor mismatch');
  const spec = resolveArtifactDownload(config, platform, version, { tag });
  const destination = safePath(repoRoot, output);
  mkdirSync(dirname(destination), { recursive: true });
  const downloaded = await fetchArtifact(spec, fetchImpl);
  const artifact =
    spec.artifactKind === 'source-archive'
      ? downloaded.bytes
      : spec.format === 'binary'
        ? downloaded.bytes
        : extractExecutable(downloaded.bytes, spec, destination);
  const archiveRoot =
    spec.artifactKind === 'source-archive' ? inspectSourceArchive(artifact, spec, destination) : undefined;
  writeFileSync(destination, artifact);
  if (spec.artifactKind === 'standalone-executable' && platform !== 'windows-x64') chmodSync(destination, 0o755);
  return {
    schemaVersion: 1,
    vendor,
    version,
    platform,
    artifactKind: spec.artifactKind,
    ...(tag ? { sourceReference: tag } : {}),
    ...(archiveRoot ? { archiveRoot } : {}),
    output,
    bytes: artifact.length,
    sourceUrl: downloaded.sourceUrl,
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = await downloadAgentArtifact({
    vendor: flag('--vendor'),
    version: flag('--version'),
    platform: flag('--platform'),
    tag: flag('--tag'),
    output: flag('--output'),
  });
  const metadata = flag('--metadata');
  if (metadata) writeFileSync(safePath(root, metadata), `${JSON.stringify(result, null, 2)}\n`);
  else console.log(JSON.stringify(result));
}
