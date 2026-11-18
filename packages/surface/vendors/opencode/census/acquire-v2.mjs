#!/usr/bin/env node
/**
 * Acquire the OpenCode 2.x census binary (and the 1.19.5 store-migration seed)
 * without executing either.
 *
 * Census lane only. `upstream.json` keeps the 1.x `opencode-<platform>`
 * acquisition until the switch PR (plan §3 option (a): switching early breaks
 * re-acquiring 1.x), so the 2.x `@opencode/cli-<platform>` template lives
 * here, built from the version, and goes through the governed downloader's own
 * pieces: `resolveArtifactDownload` (https, allowlisted host, template
 * expansion), `fetchArtifact` (manual redirects, byte cap) and
 * `extractExecutable` (exactly one reviewed executable in the archive). The
 * registry's own version document is read first and must name the same
 * tarball URL, and the downloaded tarball must match its sha512 integrity.
 *
 * Hosts: registry.npmjs.org only. No npm client runs, so no npm rc file is read.
 *
 * usage:
 *   node acquire-v2.mjs --resolve-latest
 *   node acquire-v2.mjs --version 2.2.5 --check-platforms
 *   node acquire-v2.mjs --version 2.2.5 --platform darwin-arm64 [--output <dir>]
 *   node acquire-v2.mjs --seed --platform darwin-arm64 [--output <dir>]
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadAgentArtifact,
  extractExecutable,
  fetchArtifact,
  resolveArtifactDownload,
} from '../../../../../scripts/download-agent-artifact.mjs';
import { displayPath } from './harness-common.mjs';

export const REGISTRY_HOST = 'registry.npmjs.org';
export const CLI_PACKAGE = '@opencode/cli';
export const CENSUS_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64'];
export const SEED_VERSION = '1.19.5';
/** Above the 2.2.5 Windows executable (259,169,160 bytes, plan §2.5 vii); bounds both tarball and executable. */
export const MAX_BYTES = 512 * 1024 * 1024;
const VERSION_2 = /^2\.\d+\.\d+$/;

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const repoRoot = resolve(vendorRoot, '../../../..');

export function platformPackage(platform) {
  if (!CENSUS_PLATFORMS.includes(platform)) throw new Error(`unsupported census platform ${platform}`);
  return `${CLI_PACKAGE}-${platform}`;
}

/** The registry document for a package, or for one version of it. The scope slash is encoded, as npm does. */
export function registryMetadataURL(name, version) {
  const encoded = name.replace('/', '%2f');
  return `https://${REGISTRY_HOST}/${encoded}${version ? `/${version}` : ''}`;
}

/**
 * The 2.x acquisition in the shape `upstream.json` uses, so the governed
 * resolver validates it exactly as it will validate the switch PR's policy.
 */
export function censusAcquisitionPolicy() {
  return {
    vendor: 'opencode',
    platforms: CENSUS_PLATFORMS,
    acquisition: {
      strategy: 'https-template',
      allowedHosts: [REGISTRY_HOST],
      maxBytes: MAX_BYTES,
      artifacts: Object.fromEntries(
        CENSUS_PLATFORMS.map((platform) => [
          platform,
          {
            urls: [`https://${REGISTRY_HOST}/${CLI_PACKAGE}-${platform}/-/cli-${platform}-\${version}.tgz`],
            format: 'tar.gz',
            executableBasenames: [platform.startsWith('windows-') ? 'opencode.exe' : 'opencode'],
          },
        ]),
      ),
    },
  };
}

/** Problems with a registry version document against the package, version and tarball URL the policy expects. */
export function registryVersionProblems(document, { name, version, tarballUrl }) {
  const problems = [];
  if (document?.name !== name) problems.push(`registry name ${String(document?.name)} is not ${name}`);
  if (document?.version !== version) problems.push(`registry version ${String(document?.version)} is not ${version}`);
  if (document?.deprecated) problems.push(`registry marks ${name}@${version} deprecated: ${document.deprecated}`);
  if (document?.dist?.tarball !== tarballUrl) {
    problems.push(`registry tarball ${String(document?.dist?.tarball)} is not the policy URL ${tarballUrl}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(document?.dist?.integrity ?? '')) {
    problems.push('registry document has no sha512 integrity');
  }
  return problems;
}

/** True when `bytes` hash to an SRI `sha512-<base64>` value. */
export function integrityMatches(bytes, integrity) {
  const expected = /^sha512-(.+)$/.exec(integrity ?? '')?.[1];
  return Boolean(expected) && createHash('sha512').update(bytes).digest('base64') === expected;
}

/** The latest stable 2.x version from an (abbreviated) packument; refuses anything else. */
export function latestStableVersion(packument) {
  const latest = packument?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !VERSION_2.test(latest)) {
    throw new Error(`${CLI_PACKAGE} latest is ${String(latest)}, not a stable 2.x version`);
  }
  return latest;
}

/** The TeamIdentifier `codesign -dv` reports (on stderr), if any. */
export function teamIdentifier(codesignOutput) {
  const value = /^TeamIdentifier=(.+)$/m.exec(codesignOutput ?? '')?.[1]?.trim();
  return value && value !== 'not set' ? value : undefined;
}

/** The ledger's artifact digest for `platform` on the opencode row, read from support/agents.json. */
export function ledgerArtifactSha256(ledger, platform, version = SEED_VERSION) {
  const row = (ledger?.agents ?? []).find((entry) => entry?.id === 'opencode');
  if (!row || row.currentVersion !== version) {
    throw new Error(`the ledger's opencode row is not at ${version}; the seed digest cannot be checked against it`);
  }
  const digest = row.verification?.platformArtifacts?.find((entry) => entry.platform === platform)?.artifactSha256;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`the ledger names no ${platform} artifact for opencode ${version}`);
  }
  return digest.slice('sha256:'.length);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function registryJson(url, { accept = 'application/json', limit = 64 * 1024 * 1024 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== REGISTRY_HOST) throw new Error(`refusing ${parsed.origin}`);
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { accept, 'user-agent': 'vibecook-puppeteer-artifact-acquisition' },
  });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  const text = await response.text();
  if (text.length > limit) throw new Error(`GET ${url} answered more than ${limit} bytes`);
  return JSON.parse(text);
}

async function acquireCensusBinary({ version, platform, output }) {
  const policy = censusAcquisitionPolicy();
  const spec = resolveArtifactDownload(policy, platform, version);
  const name = platformPackage(platform);
  const document = await registryJson(registryMetadataURL(name, version));
  const problems = registryVersionProblems(document, { name, version, tarballUrl: spec.urls[0] });
  if (problems.length > 0) throw new Error(problems.join('\n'));

  mkdirSync(output, { recursive: true, mode: 0o700 });
  const executable = join(output, spec.executableBasenames[0]);
  const downloaded = await fetchArtifact(spec, fetch);
  if (!integrityMatches(downloaded.bytes, document.dist.integrity)) {
    throw new Error(`${name}@${version} tarball does not match the registry sha512 integrity`);
  }
  const bytes = extractExecutable(downloaded.bytes, spec, executable);
  writeFileSync(executable, bytes);
  if (!platform.startsWith('windows-')) chmodSync(executable, 0o755);

  let team;
  if (process.platform === 'darwin' && platform.startsWith('darwin-')) {
    // Reads the signature; never runs the binary.
    const signature = spawnSync('codesign', ['-dv', '--verbose=2', executable], { encoding: 'utf8', timeout: 30_000 });
    team = teamIdentifier(`${signature.stdout ?? ''}\n${signature.stderr ?? ''}`);
  }
  const artifact = {
    vendor: 'opencode',
    version,
    platform,
    package: `${name}@${version}`,
    sha256: sha256(bytes),
    bytes: bytes.length,
    capturedAt: new Date().toISOString(),
    sourceUrl: downloaded.sourceUrl,
    tarball: {
      sha256: sha256(downloaded.bytes),
      integrity: document.dist.integrity,
      bytes: downloaded.bytes.length,
    },
    sourceTag: `v${version}`,
    // The tag's commit is not in the npm document. A reviewer records it from the
    // upstream tag before the model is generated (generate-model-v2 requires it).
    sourceRevision: null,
    ...(team ? { teamIdentifier: team } : {}),
  };
  writeFileSync(join(output, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
  return { executable, artifact };
}

/** The name an acquired executable has until its digest is checked: never the path the census is pointed at. */
export function unverifiedName(target) {
  return `${target}.unverified`;
}

/**
 * The seed goes through the governed downloader under an unverified name and
 * is made non-executable at once; only bytes equal to the ledger's digest are
 * renamed to the final path (and made executable again). Bytes that do not
 * match are removed, so nothing unverified waits where step 4 points
 * `--seed-artifact`. The ledger is read before anything is fetched.
 */
async function acquireSeed({ platform, output }) {
  const ledger = JSON.parse(readFileSync(join(repoRoot, 'support', 'agents.json'), 'utf8'));
  const expected = ledgerArtifactSha256(ledger, platform);
  const target = join(output, 'opencode');
  const staging = unverifiedName(target);
  const executable = !platform.startsWith('windows-');
  const result = await downloadAgentArtifact({
    vendor: 'opencode',
    version: SEED_VERSION,
    platform,
    output: relative(repoRoot, staging),
  });
  if (executable) chmodSync(staging, 0o600);
  const actual = sha256(readFileSync(staging));
  if (actual !== expected) {
    rmSync(staging, { force: true });
    throw new Error(`seed sha256 ${actual} does not match the ledger's ${expected}; the download was removed`);
  }
  renameSync(staging, target);
  if (executable) chmodSync(target, 0o755);
  const artifact = {
    ...result,
    output: relative(repoRoot, target).split(sep).join('/'),
    sha256: actual,
    ledgerVerified: true,
  };
  writeFileSync(join(output, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
  return { executable: target, artifact };
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactsRoot = join(vendorRoot, 'captures-raw', 'artifacts');
  if (argv.includes('--resolve-latest')) {
    const packument = await registryJson(registryMetadataURL(CLI_PACKAGE), {
      accept: 'application/vnd.npm.install-v1+json',
    });
    console.log(latestStableVersion(packument));
  } else if (argv.includes('--seed')) {
    const platform = flag('--platform') ?? 'darwin-arm64';
    const output = resolve(flag('--output') ?? join(artifactsRoot, `opencode@${SEED_VERSION}`, platform));
    const { executable, artifact } = await acquireSeed({ platform, output });
    console.log(`seed ${artifact.version} ${platform} sha256 ${artifact.sha256} (matches the ledger)`);
    console.log(`  -> ${displayPath(executable, repoRoot)}`);
  } else {
    const version = flag('--version') ?? process.env.PUPPETEER_OPENCODE_VERSION;
    if (!version || !VERSION_2.test(version)) throw new Error('--version <2.x.y> is required');
    if (argv.includes('--check-platforms')) {
      const spec = (platform) => resolveArtifactDownload(censusAcquisitionPolicy(), platform, version);
      let failed = false;
      for (const platform of CENSUS_PLATFORMS) {
        const name = platformPackage(platform);
        const document = await registryJson(registryMetadataURL(name, version));
        const problems = registryVersionProblems(document, { name, version, tarballUrl: spec(platform).urls[0] });
        failed ||= problems.length > 0;
        console.log(
          `${platform.padEnd(14)} ${problems.length === 0 ? 'ok' : problems.join('; ')} ` +
            `unpackedSize=${String(document?.dist?.unpackedSize)} fileCount=${String(document?.dist?.fileCount)}`,
        );
      }
      if (failed) process.exitCode = 1;
    } else {
      const platform = flag('--platform') ?? 'darwin-arm64';
      const output = resolve(flag('--output') ?? join(artifactsRoot, `opencode@${version}`, platform));
      const { executable, artifact } = await acquireCensusBinary({ version, platform, output });
      console.log(`${artifact.package} sha256 ${artifact.sha256} (tarball sha512 matches the registry)`);
      if (artifact.teamIdentifier) console.log(`  TeamIdentifier ${artifact.teamIdentifier}`);
      console.log(`  -> ${displayPath(executable, repoRoot)}`);
      console.log(`  metadata -> ${displayPath(join(output, 'artifact.json'), repoRoot)}`);
    }
  }
}
