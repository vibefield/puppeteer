#!/usr/bin/env node
/**
 * Isolated-home census for the pinned Hermes Agent source checkout.
 *
 * Identity probes execute `hermes --version`, `--help`, one rejected option,
 * and `hermes acp --version/--check`. They never submit a model prompt, never
 * authenticate a provider, and never touch the operator's ~/.hermes.
 *
 * The reviewed locked recipe installs no optional extras, and ACP's protocol
 * package is the optional `acp` extra in every pinned release. `acp --check`
 * is therefore recorded with its exit status rather than required to pass:
 * ACP is a separate host that Puppeteer never runs beside the native TUI.
 *
 * usage:
 *   node harness.mjs --hermes-bin /path/to/hermes --home /isolated/HERMES_HOME --checkout /path/to/tag
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reviewed release pins. A Hermes GitHub release is a date tag whose
 * annotated-tag subject carries the product version
 * (`Hermes Agent v0.21.5 (2026.9.24)`), matching `pyproject.toml` and
 * `hermes_cli.__version__` at the peeled commit.
 */
export const RELEASES = Object.freeze({
  '0.20.0': Object.freeze({
    releaseTag: 'v2026.8.3',
    releaseDate: '2026.8.3',
    sourceRevision: '3c27eb6234bf91b8ceee9e9071591b31e9b148cb',
    tagObject: '7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2',
  }),
  '0.21.5': Object.freeze({
    releaseTag: 'v2026.9.24',
    releaseDate: '2026.9.24',
    sourceRevision: 'f97608f178d1ffeca59860195ab7da295f7c8e5f',
    tagObject: 'e3dd27ee2d8b011737a4eea8e3eb3d711ab78690',
  }),
});

/** The candidate this census tooling currently authors. */
export const VERSION = '0.21.5';
export const RELEASE_TAG = RELEASES[VERSION].releaseTag;
export const RELEASE_DATE = RELEASES[VERSION].releaseDate;
export const SOURCE_REVISION = RELEASES[VERSION].sourceRevision;
export const TAG_OBJECT = RELEASES[VERSION].tagObject;
export const REQUIRED_FLAGS = [
  '--tui',
  '--cli',
  '--resume',
  '--continue',
  '--worktree',
  '--yolo',
  '--ignore-user-config',
  '--ignore-rules',
  '--safe-mode',
  '--version',
];
export const REQUIRED_SUBCOMMANDS = ['chat', 'acp', 'version', 'sessions', 'dashboard'];

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutput = join(vendorRoot, 'probes', `hermes@${VERSION}`);

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sanitizeVersionOutput(text) {
  return String(text ?? '')
    .replace(/^Install directory:.*$/m, 'Install directory: <redacted:install-directory>')
    .replace(/\/(?:private\/)?tmp\/puppeteer-hermes-[^\s]+/g, '<redacted:path>')
    .replace(new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<redacted:home>');
}

/** Redact the probe's own checkout and environment roots wherever a native message names them. */
export function redactProbeRoots(text, roots) {
  let result = String(text ?? '');
  for (const root of [...roots].filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.split(root).join('<redacted:path>');
  }
  return sanitizeVersionOutput(result);
}

export function sanitizeProcessTree(text) {
  return sanitizeVersionOutput(text)
    .replace(/\/Users\/[^\s/]+\/\.nvm\/versions\/node\/[^\s]+/g, '<node>')
    .replace(/\/opt\/homebrew\/[^\s]+/g, '<homebrew>')
    .replace(/^\d+\t\d+\t/gm, '<pid>\t<ppid>\t');
}

export function canonicalizePlatform(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' ? 'x64' : arch;
  if (platform === 'darwin' && (normalizedArch === 'arm64' || normalizedArch === 'x64')) {
    return `darwin-${normalizedArch}`;
  }
  if (platform === 'linux' && normalizedArch === 'x64') return 'linux-x64';
  if (platform === 'win32' && normalizedArch === 'x64') return 'windows-x64';
  throw new Error(`unsupported census platform: ${platform}-${arch}`);
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 20_000,
    env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function validateSourceContract({ sourceRevision, releaseTag, vendorVersion }) {
  const problems = [];
  if (sourceRevision !== SOURCE_REVISION) problems.push(`source revision drifted from ${SOURCE_REVISION}`);
  if (releaseTag !== RELEASE_TAG) problems.push(`release tag drifted from ${RELEASE_TAG}`);
  if (vendorVersion !== VERSION) problems.push(`vendor version drifted from ${VERSION}`);
  return problems;
}

function isolatedEnv(home) {
  return {
    ...process.env,
    HERMES_HOME: home,
    HOME: home,
    PATH: process.env.PATH,
    TERM: 'dumb',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_TOKEN: '',
  };
}

function main() {
  if (!process.argv.includes('--hermes-bin')) {
    console.log('identity census only. pass --hermes-bin, --home, and --checkout to write probes.');
    return;
  }
  const hermesBin = resolve(flag('--hermes-bin'));
  const home = resolve(flag('--home'));
  const checkout = resolve(flag('--checkout'));
  if (!isAbsolute(hermesBin) || !existsSync(hermesBin)) throw new Error(`hermes bin missing: ${hermesBin}`);
  if (!existsSync(home)) throw new Error(`isolated home missing: ${home}`);
  if (!existsSync(join(checkout, 'pyproject.toml'))) throw new Error(`checkout missing: ${checkout}`);

  const env = isolatedEnv(home);
  const probeRoots = [checkout, dirname(dirname(hermesBin)), home];
  const versionProbe = run(hermesBin, ['--version'], env);
  const helpProbe = run(hermesBin, ['--help'], env);
  const rejected = run(hermesBin, ['--definitely-not-a-hermes-option'], env);
  const acpVersion = run(hermesBin, ['acp', '--version'], env);
  const acpCheck = run(hermesBin, ['acp', '--check'], env);
  const sanitizedVersion = sanitizeVersionOutput(versionProbe.stdout);
  if (!sanitizedVersion.includes(VERSION) || !sanitizedVersion.includes(RELEASE_DATE)) {
    throw new Error(`unexpected version output: ${sanitizedVersion}`);
  }
  if (helpProbe.status !== 0) throw new Error('help probe failed');
  for (const name of REQUIRED_FLAGS) {
    if (!helpProbe.stdout.includes(name)) throw new Error(`help is missing ${name}`);
  }
  if (rejected.status === 0) throw new Error('rejected option unexpectedly succeeded');
  if (acpVersion.status !== 0 || !acpVersion.stdout.includes(VERSION)) {
    throw new Error(`acp --version failed: ${acpVersion.stdout || acpVersion.stderr}`);
  }
  if (acpCheck.status === 0 && !acpCheck.stdout.includes('Hermes ACP check OK')) {
    throw new Error(`acp --check succeeded without its native confirmation: ${acpCheck.stdout}`);
  }

  const platform = canonicalizePlatform();
  const platformRoot = join(defaultOutput, platform);
  mkdirSync(platformRoot, { recursive: true });
  writeFileSync(
    join(platformRoot, 'version.txt'),
    sanitizedVersion.endsWith('\n') ? sanitizedVersion : `${sanitizedVersion}\n`,
  );
  writeFileSync(join(platformRoot, 'help.txt'), helpProbe.stdout);
  writeFileSync(join(platformRoot, 'acp-version.txt'), acpVersion.stdout.trimEnd() + '\n');
  writeFileSync(
    join(platformRoot, 'acp-check.txt'),
    `exit ${acpCheck.status}\n${redactProbeRoots(`${acpCheck.stdout}${acpCheck.stderr}`, probeRoots).trimEnd()}\n`,
  );
  writeJson(join(platformRoot, 'flags.json'), {
    visibleHelpOptions: Object.fromEntries(REQUIRED_FLAGS.map((name) => [name, helpProbe.stdout.includes(name)])),
    visibleSubcommands: Object.fromEntries(REQUIRED_SUBCOMMANDS.map((name) => [name, helpProbe.stdout.includes(name)])),
    rejectedOptionProbe: {
      args: ['--definitely-not-a-hermes-option'],
      status: rejected.status,
      stdout: rejected.stdout.trim(),
      stderr: sanitizeVersionOutput(rejected.stderr).trim(),
    },
  });
  const lockBytes = readFileSync(join(checkout, 'uv.lock'));
  writeJson(join(defaultOutput, 'source.json'), {
    vendor: 'hermes',
    vendorVersion: VERSION,
    releaseTag: RELEASE_TAG,
    sourceRevision: SOURCE_REVISION,
    tagObject: TAG_OBJECT,
    relation: 'annotated-tag-peels-to-release-commit',
    pyprojectSha256: sha256(readFileSync(join(checkout, 'pyproject.toml'))),
    uvLockSha256: sha256(lockBytes),
  });
  writeJson(join(platformRoot, 'artifact.json'), {
    probeKind: 'console-script',
    vendor: 'hermes',
    vendorVersion: VERSION,
    platform,
    artifact: '$PUPPETEER_HERMES_BIN',
    identity: 'source-revision-and-lockfile',
    note: 'hermes is a Python console script; product identity is the pinned checkout, not the wrapper bytes.',
    versionArgs: ['--version'],
    versionOutput: sanitizedVersion.split('\n')[0],
    probeHost: { platform: process.platform, arch: process.arch },
    probeEnvironment: {
      install: 'survey: uv sync --frozen --no-default-groups of the exact tag checkout',
      pythonVersion: versionProbe.stdout.match(/^Python: (\S+)$/m)?.[1] ?? 'unknown',
      attested: false,
      note: 'Not the protected installed-console materialization; its pinned toolchain and digests come from the adaptation workflow.',
    },
    probedAt: new Date().toISOString(),
  });
  console.log(`wrote probes under ${defaultOutput}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
