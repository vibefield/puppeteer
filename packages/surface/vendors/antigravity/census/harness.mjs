#!/usr/bin/env node
/**
 * Authentication-independent census for an exact Antigravity CLI artifact.
 *
 * It can inspect any required release archive without execution. On a matching
 * platform it executes only argument-parser probes: --version, --help, and one
 * rejected option. It never starts print mode, a conversation, an updater, or
 * an authenticated service request. Runtime census remains blocked on the
 * authorization gate in draft/ANTIGRAVITY-ADAPTATION-PLAN.md.
 *
 * usage:
 *   node harness.mjs --artifact /path/to/antigravity --archive /path/to/archive --platform darwin-arm64
 *   node harness.mjs --archive-only --archive /path/to/archive --platform linux-x64
 *   node harness.mjs --extras --artifact /path/to/antigravity --platform darwin-arm64
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SUBCOMMAND_HELP, scanStaticStringCandidates } from './documentation.mjs';

export const VERSION = '1.1.12';
export const REQUIRED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64'];
export const REQUIRED_FLAGS = [
  '--add-dir',
  '--agent',
  '--continue',
  '--conversation',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print',
  '--prompt-interactive',
  '--sandbox',
];
export const REQUIRED_SUBCOMMANDS = ['agent', 'agents', 'changelog', 'help', 'install', 'models', 'plugin', 'update'];

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const referencePath = join(vendorRoot, 'references', `antigravity@${VERSION}`, 'release.json');
const upstreamPath = join(vendorRoot, 'upstream.json');
const MAX_BUFFER = 536_870_912;
const EXPECTED_MAC_TEAM_ID = 'EQHXZ8M8AV';
const AUTO_UPDATE_ENV_CANDIDATE = 'AGY_CLI_DISABLE_AUTO_UPDATE';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

function staticStringCandidates(bytes) {
  return {
    disableAutoUpdateEnvironment: {
      value: AUTO_UPDATE_ENV_CANDIDATE,
      present: bytes.includes(Buffer.from(AUTO_UPDATE_ENV_CANDIDATE)),
      status: 'unverified-contract',
    },
  };
}

function probeHost() {
  return { platform: process.platform, arch: process.arch, osRelease: osRelease() };
}

function executablePath(input) {
  if (!input) throw new Error('--artifact is required for the offline census');
  if (!isAbsolute(input) && !input.includes('/')) {
    throw new Error('--artifact must be an explicit path, not a PATH lookup');
  }
  const path = resolve(input);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`artifact does not exist: ${path}`);
  return path;
}

function filesUnder(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path).split(sep).join('/')];
    })
    .sort();
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function primaryOutput(result) {
  return result.stdout.trim().length > 0 ? result.stdout : result.stderr;
}

function safeArchiveEntry(entry) {
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

function archiveListing(archive, format) {
  const commands =
    format === 'tar.gz'
      ? [['tar', ['-tzf', archive]]]
      : [
          ['unzip', ['-Z1', archive]],
          ['tar', ['-tf', archive]],
        ];
  let lastError;
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    if (!result.error && result.status === 0) {
      const entries = result.stdout.split('\n').filter(Boolean);
      if (entries.length === 0) throw new Error('release archive is empty');
      if (entries.some((entry) => !safeArchiveEntry(entry))) throw new Error('release archive has an unsafe entry');
      return { command, entries };
    }
    lastError = result.error ?? new Error(`${command} exited ${result.status}: ${result.stderr}`);
    if (result.error?.code !== 'ENOENT') break;
  }
  throw lastError ?? new Error(`cannot list ${format} archive`);
}

function archiveMemberBytes(archive, entry, format, listingCommand) {
  const args =
    format === 'tar.gz'
      ? ['-xOzf', archive, entry]
      : listingCommand === 'unzip'
        ? ['-p', archive, entry]
        : ['-xOf', archive, entry];
  const result = spawnSync(listingCommand, args, { timeout: 30_000, maxBuffer: MAX_BUFFER });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot read ${entry} from release archive: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function fileDescription(path) {
  const result = spawnSync('file', ['-b', path], { encoding: 'utf8', timeout: 10_000 });
  return result.error || result.status !== 0 ? undefined : result.stdout.trim();
}

function macSignature(path) {
  if (process.platform !== 'darwin') return undefined;
  const verification = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', path], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const verificationResult = verification.error
    ? 'tool-error'
    : verification.status === 0
      ? 'valid'
      : verification.stderr.includes('invalid signature')
        ? 'invalid-signature'
        : 'verification-failed';
  const result = spawnSync('codesign', ['-dv', '--verbose=4', path], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`codesign verification failed: ${result.error?.message ?? result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const value = (name) => new RegExp(`^${name}=(.+)$`, 'm').exec(output)?.[1]?.trim();
  const signature = {
    verified: verification.status === 0 && !verification.error,
    verificationResult,
    verificationExitCode: verification.status,
    identifier: value('Identifier'),
    teamIdentifier: value('TeamIdentifier'),
    authorities: [...output.matchAll(/^Authority=(.+)$/gm)].map((entry) => entry[1].trim()),
  };
  if (signature.teamIdentifier !== EXPECTED_MAC_TEAM_ID) {
    throw new Error(`expected macOS signing team ${EXPECTED_MAC_TEAM_ID}, got ${signature.teamIdentifier ?? 'none'}`);
  }
  return signature;
}

export function canonicalPlatform(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!normalizedArch) throw new Error(`unsupported architecture ${arch}`);
  if (platform === 'darwin') return `darwin-${normalizedArch}`;
  if (platform === 'linux' && normalizedArch === 'x64') return 'linux-x64';
  if (platform === 'win32' && normalizedArch === 'x64') return 'windows-x64';
  throw new Error(`unsupported census platform ${platform}-${arch}`);
}

export function validateReleaseContract(reference = json(referencePath), upstream = json(upstreamPath)) {
  const problems = [];
  if (reference.vendor !== 'antigravity' || reference.vendorVersion !== VERSION) {
    problems.push('release reference identity must be antigravity@1.1.12');
  }
  if (reference.repository !== upstream.repository)
    problems.push('release reference repository differs from upstream policy');
  if (reference.release?.tag !== VERSION || reference.release?.relation !== 'release-tag') {
    problems.push('release reference tag relation is invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(reference.release?.revision ?? '')) {
    problems.push('release reference must retain the full tagged revision');
  }
  if (reference.release?.draft || reference.release?.prerelease) problems.push('release reference is not stable');
  if (upstream.sourceRelation?.strategy !== 'release-tag' || upstream.sourceRelation?.template !== '${version}') {
    problems.push('upstream source relation must resolve directly to the numeric release tag');
  }
  if (JSON.stringify(upstream.platforms) !== JSON.stringify(REQUIRED_PLATFORMS)) {
    problems.push('upstream required-platform order or inventory drifted');
  }
  const assets = new Map((reference.assets ?? []).map((asset) => [asset.platform, asset]));
  for (const platform of REQUIRED_PLATFORMS) {
    const asset = assets.get(platform);
    const policy = upstream.acquisition?.artifacts?.[platform];
    if (!asset || !policy) {
      problems.push(`${platform}: missing release asset or acquisition policy`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) problems.push(`${platform}: invalid published SHA-256`);
    if (!Number.isInteger(asset.size) || asset.size < 1) problems.push(`${platform}: invalid published asset size`);
    if (asset.format !== policy.format) problems.push(`${platform}: archive format differs from acquisition policy`);
    if (JSON.stringify(asset.executableBasenames) !== JSON.stringify(policy.executableBasenames)) {
      problems.push(`${platform}: executable basename policy drifted`);
    }
    const expanded = policy.urls?.map((url) => url.replaceAll('${version}', VERSION)) ?? [];
    if (expanded.length !== 1 || expanded[0] !== asset.url)
      problems.push(`${platform}: release URL differs from policy`);
    if (basename(new URL(asset.url).pathname) !== asset.name) problems.push(`${platform}: asset name differs from URL`);
  }
  for (const platform of assets.keys()) {
    if (!REQUIRED_PLATFORMS.includes(platform)) problems.push(`${platform}: unexpected release asset in pinned policy`);
  }
  return problems.sort();
}

export function probeOffline({
  artifact,
  archive,
  platform = canonicalPlatform(),
  output,
  probedAt = new Date().toISOString(),
  replace = false,
}) {
  const release = json(referencePath);
  const upstream = json(upstreamPath);
  const contractProblems = validateReleaseContract(release, upstream);
  if (contractProblems.length > 0) throw new Error(`invalid release contract:\n${contractProblems.join('\n')}`);
  if (platform !== canonicalPlatform())
    throw new Error(`cannot execute ${platform} artifact on ${canonicalPlatform()}`);
  const asset = release.assets.find((candidate) => candidate.platform === platform);
  if (!asset) throw new Error(`release reference has no ${platform} asset`);

  const artifactPath = executablePath(artifact);
  const archivePath = executablePath(archive);
  const outputRoot = resolve(output ?? join(vendorRoot, 'probes', `antigravity@${VERSION}`, platform));
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    if (!replace) throw new Error(`refusing to overwrite non-empty probe directory: ${outputRoot}`);
    rmSync(outputRoot, { recursive: true, force: true });
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });

  const archiveBytes = readFileSync(archivePath);
  const archiveDigest = sha256(archiveBytes);
  if (archiveBytes.length !== asset.size) {
    throw new Error(`archive size mismatch: expected ${asset.size}, got ${archiveBytes.length}`);
  }
  if (archiveDigest !== asset.sha256) {
    throw new Error(`archive SHA-256 mismatch: expected ${asset.sha256}, got ${archiveDigest}`);
  }
  const listing = archiveListing(archivePath, asset.format);
  const matches = listing.entries.filter(
    (entry) => !entry.endsWith('/') && asset.executableBasenames.includes(basename(entry)),
  );
  if (matches.length !== 1)
    throw new Error(`release archive must contain one reviewed executable, found ${matches.length}`);

  const artifactBytes = readFileSync(artifactPath);
  const memberBytes = archiveMemberBytes(archivePath, matches[0], asset.format, listing.command);
  const artifactDigest = sha256(artifactBytes);
  const memberDigest = sha256(memberBytes);
  if (artifactDigest !== memberDigest || artifactBytes.length !== memberBytes.length) {
    throw new Error('caller-supplied executable does not match the reviewed release archive member');
  }

  const isolationRoot = mkdtempSync(join(tmpdir(), 'chopsticks-antigravity-offline-'));
  const home = join(isolationRoot, 'home');
  const isolatedTmp = join(isolationRoot, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
  const inherited = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(inherited.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    NO_COLOR: '1',
    TERM: 'dumb',
  });

  let versionProbe;
  let helpProbe;
  let rejectedProbe;
  let isolatedHomeFiles;
  try {
    versionProbe = run(artifactPath, ['--version'], env);
    helpProbe = run(artifactPath, ['--help'], env);
    const rejectedFlag = '--definitely-not-an-antigravity-option';
    rejectedProbe = { flag: rejectedFlag, ...run(artifactPath, [rejectedFlag], env) };
    isolatedHomeFiles = filesUnder(home);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }

  const versionOutput = primaryOutput(versionProbe).trim();
  const helpOutput = primaryOutput(helpProbe);
  if (versionProbe.status !== 0 || versionOutput !== VERSION) {
    throw new Error(`expected Antigravity ${VERSION}, got ${versionOutput || `exit ${versionProbe.status}`}`);
  }
  if (helpProbe.status !== 0) throw new Error(`Antigravity help probe exited ${helpProbe.status}`);
  for (const option of REQUIRED_FLAGS) {
    if (!helpOutput.includes(option)) throw new Error(`Antigravity help is missing ${option}`);
  }
  for (const command of REQUIRED_SUBCOMMANDS) {
    if (!new RegExp(`^  ${command}\\s`, 'm').test(helpOutput))
      throw new Error(`Antigravity help is missing ${command}`);
  }
  if (
    rejectedProbe.status === 0 ||
    ![rejectedProbe.flag, rejectedProbe.flag.slice(1)].some((value) =>
      `${rejectedProbe.stdout}\n${rejectedProbe.stderr}`.includes(value),
    )
  ) {
    throw new Error('Antigravity rejected-option probe did not fail closed');
  }
  if (isolatedHomeFiles.length > 0) {
    throw new Error(`offline argument probes wrote to isolated home: ${isolatedHomeFiles.join(', ')}`);
  }

  const signature = platform.startsWith('darwin-') ? macSignature(artifactPath) : undefined;
  writeFileSync(join(outputRoot, 'version.txt'), `${versionOutput}\n`);
  writeFileSync(join(outputRoot, 'help.txt'), helpOutput.endsWith('\n') ? helpOutput : `${helpOutput}\n`);
  writeJson(join(outputRoot, 'archive.json'), {
    probeKind: 'parser-execution',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    releaseAsset: asset.name,
    sourceUrl: asset.url,
    bytes: archiveBytes.length,
    sha256: archiveDigest,
    format: asset.format,
    entries: listing.entries,
    selectedExecutable: matches[0],
    memberSha256: memberDigest,
    memberBytes: memberBytes.length,
    memberMatchesArtifact: true,
    probedAt,
  });
  writeJson(join(outputRoot, 'artifact.json'), {
    probeKind: 'parser-execution',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    artifact: '$CHOPSTICKS_ANTIGRAVITY_BIN',
    bytes: artifactBytes.length,
    sha256: artifactDigest,
    fileDescription: fileDescription(artifactPath),
    versionArgs: ['--version'],
    versionOutput,
    signature,
    staticStringCandidates: staticStringCandidates(artifactBytes),
    probeHost: probeHost(),
    isolatedHomeFiles,
    probedAt,
  });
  writeJson(join(outputRoot, 'flags.json'), {
    requiredFlags: REQUIRED_FLAGS,
    requiredSubcommands: REQUIRED_SUBCOMMANDS,
    rejectedOption: {
      flag: rejectedProbe.flag,
      status: rejectedProbe.status,
      signal: rejectedProbe.signal,
      stdoutBytes: Buffer.byteLength(rejectedProbe.stdout),
      stderrBytes: Buffer.byteLength(rejectedProbe.stderr),
      mentionsRejectedFlag: [rejectedProbe.flag, rejectedProbe.flag.slice(1)].some((value) =>
        `${rejectedProbe.stdout}\n${rejectedProbe.stderr}`.includes(value),
      ),
    },
  });
  return { outputRoot, platform, archiveSha256: archiveDigest, artifactSha256: artifactDigest };
}

export function probeArchiveOnly({ archive, platform, output, probedAt = new Date().toISOString(), replace = false }) {
  if (!REQUIRED_PLATFORMS.includes(platform)) throw new Error(`unsupported release platform ${platform}`);
  const release = json(referencePath);
  const upstream = json(upstreamPath);
  const contractProblems = validateReleaseContract(release, upstream);
  if (contractProblems.length > 0) throw new Error(`invalid release contract:\n${contractProblems.join('\n')}`);
  const asset = release.assets.find((candidate) => candidate.platform === platform);
  if (!asset) throw new Error(`release reference has no ${platform} asset`);
  const archivePath = executablePath(archive);
  const outputRoot = resolve(output ?? join(vendorRoot, 'probes', `antigravity@${VERSION}`, platform));
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    if (!replace) throw new Error(`refusing to overwrite non-empty probe directory: ${outputRoot}`);
    rmSync(outputRoot, { recursive: true, force: true });
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });

  const archiveBytes = readFileSync(archivePath);
  const archiveDigest = sha256(archiveBytes);
  if (archiveBytes.length !== asset.size) {
    throw new Error(`archive size mismatch: expected ${asset.size}, got ${archiveBytes.length}`);
  }
  if (archiveDigest !== asset.sha256) {
    throw new Error(`archive SHA-256 mismatch: expected ${asset.sha256}, got ${archiveDigest}`);
  }
  const listing = archiveListing(archivePath, asset.format);
  const matches = listing.entries.filter(
    (entry) => !entry.endsWith('/') && asset.executableBasenames.includes(basename(entry)),
  );
  if (matches.length !== 1)
    throw new Error(`release archive must contain one reviewed executable, found ${matches.length}`);
  const memberBytes = archiveMemberBytes(archivePath, matches[0], asset.format, listing.command);
  const memberDigest = sha256(memberBytes);

  const inspectionRoot = mkdtempSync(join(tmpdir(), 'chopsticks-antigravity-member-'));
  const memberPath = join(inspectionRoot, basename(matches[0]));
  let description;
  let signature;
  try {
    writeFileSync(memberPath, memberBytes, { mode: platform === 'windows-x64' ? 0o644 : 0o755 });
    if (platform !== 'windows-x64') chmodSync(memberPath, 0o755);
    description = fileDescription(memberPath);
    if (platform.startsWith('darwin-')) signature = macSignature(memberPath);
  } finally {
    rmSync(inspectionRoot, { recursive: true, force: true });
  }

  writeJson(join(outputRoot, 'archive.json'), {
    probeKind: 'archive-only',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    releaseAsset: asset.name,
    sourceUrl: asset.url,
    bytes: archiveBytes.length,
    sha256: archiveDigest,
    format: asset.format,
    entries: listing.entries,
    selectedExecutable: matches[0],
    memberSha256: memberDigest,
    memberBytes: memberBytes.length,
    memberMatchesArtifact: true,
    probedAt,
  });
  writeJson(join(outputRoot, 'artifact.json'), {
    probeKind: 'archive-only',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    artifact: '$RELEASE_ARCHIVE_MEMBER',
    bytes: memberBytes.length,
    sha256: memberDigest,
    fileDescription: description,
    signature,
    staticStringCandidates: staticStringCandidates(memberBytes),
    probeHost: probeHost(),
    execution: {
      status: 'not-run',
      reason: 'archive identity probe only; version/help execution requires a matching platform runner',
    },
    probedAt,
  });
  return { outputRoot, platform, archiveSha256: archiveDigest, artifactSha256: memberDigest };
}

export function probeOfflineExtras({
  artifact,
  platform = canonicalPlatform(),
  output,
  probedAt = new Date().toISOString(),
}) {
  if (platform !== canonicalPlatform())
    throw new Error(`cannot execute ${platform} artifact on ${canonicalPlatform()}`);
  const artifactPath = executablePath(artifact);
  const outputRoot = resolve(output ?? join(vendorRoot, 'probes', `antigravity@${VERSION}`, platform));
  if (!existsSync(join(outputRoot, 'artifact.json'))) {
    throw new Error(`extras require an existing ${platform} artifact probe at ${outputRoot}`);
  }
  const identity = json(join(outputRoot, 'artifact.json'));
  if (identity.vendor !== 'antigravity' || identity.vendorVersion !== VERSION || identity.platform !== platform) {
    throw new Error(`existing ${platform} artifact probe identity drifted`);
  }
  const artifactBytes = readFileSync(artifactPath);
  const artifactDigest = sha256(artifactBytes);
  if (artifactDigest !== identity.sha256 || artifactBytes.length !== identity.bytes) {
    throw new Error('extras artifact does not match the reviewed executable identity');
  }

  const isolationRoot = mkdtempSync(join(tmpdir(), 'chopsticks-antigravity-extras-'));
  const home = join(isolationRoot, 'home');
  const isolatedTmp = join(isolationRoot, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
  const inherited = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(inherited.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    NO_COLOR: '1',
    TERM: 'dumb',
  });

  const subcommands = [];
  try {
    for (const command of REQUIRED_SUBCOMMAND_HELP) {
      const result = run(artifactPath, command.args, env);
      const isolatedHomeFiles = filesUnder(home);
      if (isolatedHomeFiles.length > 0) {
        throw new Error(
          `subcommand help ${command.args.join(' ')} wrote to isolated home: ${isolatedHomeFiles.join(', ')}`,
        );
      }
      subcommands.push({
        id: command.id,
        args: command.args,
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }

  const candidates = scanStaticStringCandidates(artifactBytes);
  const missing = Object.entries(candidates)
    .filter(([, candidate]) => candidate.present !== true)
    .map(([id]) => id);
  if (missing.length > 0) throw new Error(`expected static strings missing: ${missing.join(', ')}`);

  writeJson(join(outputRoot, 'static-strings.json'), {
    probeKind: 'static-strings',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    artifactSha256: artifactDigest,
    status: 'unverified-contract',
    candidates,
    probedAt,
  });
  writeJson(join(outputRoot, 'subcommand-help.json'), {
    probeKind: 'parser-execution',
    vendor: 'antigravity',
    vendorVersion: VERSION,
    platform,
    isolatedHomeFiles: [],
    commands: subcommands.map((command) => ({
      id: command.id,
      args: command.args,
      status: command.status,
      signal: command.signal,
      stdout: command.stdout,
      stderr: command.stderr,
    })),
    probedAt,
  });
  return { outputRoot, platform, artifactSha256: artifactDigest };
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const mode = flag('--mode', 'offline');
  if (mode !== 'offline') {
    throw new Error('authenticated Antigravity census is blocked until the authorization gate is resolved');
  }
  const extras = process.argv.includes('--extras');
  const archiveOnly = process.argv.includes('--archive-only');
  const result = extras
    ? probeOfflineExtras({
        artifact: flag('--artifact', process.env.CHOPSTICKS_ANTIGRAVITY_BIN),
        platform: flag('--platform', canonicalPlatform()),
        output: flag('--output'),
      })
    : archiveOnly
      ? probeArchiveOnly({
          archive: flag('--archive'),
          platform: flag('--platform'),
          output: flag('--output'),
          replace: process.argv.includes('--replace'),
        })
      : probeOffline({
          artifact: flag('--artifact', process.env.CHOPSTICKS_ANTIGRAVITY_BIN),
          archive: flag('--archive'),
          platform: flag('--platform', canonicalPlatform()),
          output: flag('--output'),
          replace: process.argv.includes('--replace'),
        });
  const kind = extras ? 'extras' : archiveOnly ? 'archive' : 'parser';
  console.log(
    `wrote Antigravity ${VERSION} ${result.platform} ${kind} probes at ${result.outputRoot} (${result.artifactSha256})`,
  );
}
