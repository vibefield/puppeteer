/**
 * OpenCode distribution: install classification, release detectors, and the
 * vendor upgrade command.
 *
 * Fingerprints are native evidence probed 2026-09-06 on OpenCode 1.18.23
 * (darwin-arm64): the install script places a standalone Mach-O binary at
 * `~/.opencode/bin/opencode` whose real path resolves to itself. The same build
 * ships as the npm package `opencode-ai` and as a Homebrew formula.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  AutoUpdateState,
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  InstallMethod,
  InstallRecipe,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import { OPENCODE_VERSION_FLAG, readOpenCodeVersion } from '../detection.js';
import { withoutOpenCodeServerPasswords } from '../launch/credentials.js';
import { parseOpenCodeJsonc } from './config-jsonc.js';

const OPENCODE_NPM_PACKAGE = 'opencode-ai';
/**
 * The install opencode.ai/docs lists first (read 2026-10-29): the 1.x line this
 * adapter covers. (The repository's README now leads with `opencode.ai/v2/install`,
 * a 2.x line the 1.x script refuses and that cannot sit beside it.) It asks
 * nothing, places `~/.opencode/bin/opencode`, adds that directory to the shell
 * rc, and reads SHELL under `set -u`, so it needs one.
 */
const OPENCODE_INSTALL_SCRIPT_URL = 'https://opencode.ai/install';
const OPENCODE_BREW_NAME = 'opencode';
/** `~/.opencode/bin/opencode`; the capture is the vendor home that owns the install. */
const OPENCODE_HOME_PATTERN = /^(.*[/\\]\.opencode)[/\\]bin[/\\]/u;
const OPENCODE_NPM_PATTERN = /^(.*[/\\]node_modules[/\\]opencode-ai)(?:[/\\]|$)/u;
/** Homebrew keeps formula installs under `<prefix>/Cellar/<name>/<version>`. */
const OPENCODE_CELLAR_PATTERN = /^(.*[/\\]Cellar[/\\]opencode[/\\][^/\\]+)(?:[/\\]|$)/u;
const OPENCODE_COMMANDS = ['opencode'];
/**
 * `opencode upgrade` with no target keeps a 1.x install on 1.x: the 1.x upgrade refuses major 2 unless it is given
 * `--major` (the plan's draft/OPENCODE-2-MIGRATION-PLAN.md §1). `--major` replaces the install with the 2.x line,
 * which this adapter refuses, so a recipe never carries it.
 */
export const OPENCODE_UPGRADE_ARGUMENTS: readonly string[] = Object.freeze(['upgrade']);

/** Injected process execution so unit tests never run a real binary. */
export type OpenCodeDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Injected file read so unit tests never touch a real config directory. */
export type OpenCodeDistributionReadFile = (path: string) => Promise<string>;

export interface OpenCodeDistributionServiceOptions {
  executable?: string | undefined;
  exec?: OpenCodeDistributionExec | undefined;
  readConfigFile?: OpenCodeDistributionReadFile | undefined;
  /** Injected so tests never read the developer's own environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injected so tests never read the real home directory. */
  home?: string | undefined;
}

export const OPENCODE_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'opencode',
  label: 'OpenCode',
  commands: [...OPENCODE_COMMANDS],
  npmPackages: [OPENCODE_NPM_PACKAGE],
  brewNames: [OPENCODE_BREW_NAME],
  // The install script's fixed INSTALL_DIR (read 2026-10-29).
  installDirectories: ['.opencode/bin'],
  // Mirrors packages/surface/vendors/opencode/upstream.json plus the npm
  // registry the vendor publishes its platform tarballs to.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/anomalyco/opencode/releases?per_page=30',
      tagPattern: '^v(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    { kind: 'npm-registry', id: 'npm-latest', channel: 'stable', package: OPENCODE_NPM_PACKAGE, distTag: 'latest' },
  ],
  nativeUpdateCheck: false,
};

function defaultExec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      // A probe owns no server, so no server password goes with it.
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: withoutOpenCodeServerPasswords(process.env) },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolvePromise({ stdout, stderr });
      },
    );
  });
}

function isOpenCodeCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return OPENCODE_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'packageName' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not OpenCode. */
export function classifyOpenCodeCandidate(candidate: InstallCandidate): Classification | undefined {
  const npmRoot =
    OPENCODE_NPM_PATTERN.exec(candidate.realPath)?.[1] ??
    (candidate.packageRoot ? OPENCODE_NPM_PATTERN.exec(`${candidate.packageRoot}/`)?.[1] : undefined);
  if (npmRoot) return { method: 'npm-global', packageName: OPENCODE_NPM_PACKAGE, location: npmRoot };
  const cellar = OPENCODE_CELLAR_PATTERN.exec(candidate.realPath)?.[1];
  if (cellar) return { method: 'brew', packageName: OPENCODE_BREW_NAME, location: cellar };
  const vendorHome = OPENCODE_HOME_PATTERN.exec(candidate.realPath)?.[1];
  if (vendorHome) return { method: 'standalone-binary', location: vendorHome };
  if (isOpenCodeCommandName(candidate.realPath) || isOpenCodeCommandName(candidate.executable)) {
    return { method: 'unknown', location: dirname(candidate.realPath) };
  }
  return undefined;
}

/**
 * The first release whose update check never installs anything. Upstream evidence, recorded with file digests in
 * packages/surface/vendors/opencode/findings.md §0.7: at tag v1.19.0 of sst/opencode (now anomalyco/opencode),
 * packages/opencode/src/cli/upgrade.ts opens with "Checking never installs anything. Updates only happen when the
 * user runs `/update` or `opencode upgrade`" and no longer calls `Installation.upgrade`; at v1.18.16 and v1.18.35
 * the file is byte-identical and still installs patch releases.
 */
const OPENCODE_NOTIFY_ONLY_SINCE = [1, 19, 0] as const;
/** The release line whose installing update check findings.md §0.7 records. */
const OPENCODE_SELF_INSTALLING_LINE = [1, 18] as const;

function versionParts(version: string): number[] {
  return version.split('.').map(Number);
}

function notifyOnlyRelease(version: string): boolean {
  const parts = versionParts(version);
  for (let index = 0; index < OPENCODE_NOTIFY_ONLY_SINCE.length; index += 1) {
    const part = parts[index] ?? 0;
    if (part !== OPENCODE_NOTIFY_ONLY_SINCE[index]) return part > OPENCODE_NOTIFY_ONLY_SINCE[index]!;
  }
  return true;
}

function selfInstallingRelease(version: string): boolean {
  const [major, minor] = versionParts(version);
  return major === OPENCODE_SELF_INSTALLING_LINE[0] && minor === OPENCODE_SELF_INSTALLING_LINE[1];
}

/**
 * What one global config file says about `autoupdate`. `absent` covers both a missing file (the default install)
 * and a config without the key; `unreadable` is a file Puppeteer cannot read the way OpenCode would.
 */
export type OpenCodeAutoUpdateConfig = { kind: 'absent' } | { kind: 'value'; value: unknown } | { kind: 'unreadable' };

export function readOpenCodeAutoUpdateConfig(document: string): OpenCodeAutoUpdateConfig {
  // OpenCode substitutes these before parsing, even in keys. Until those inputs are resolved, the literal
  // document cannot establish the effective off switch or whether the whole config falls back to defaults.
  if (/\{(?:env|file):[^}]+\}/u.test(document)) return { kind: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = parseOpenCodeJsonc(document);
  } catch {
    return { kind: 'unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'unreadable' };
  if (!Object.hasOwn(parsed, 'autoupdate')) return { kind: 'absent' };
  return { kind: 'value', value: (parsed as Record<string, unknown>).autoupdate };
}

export interface OpenCodeAutoUpdateEvidence {
  config: OpenCodeAutoUpdateConfig;
  /** The version the native probe reported; undefined when it could not be parsed. */
  version?: string | undefined;
  /** The install method Puppeteer classified from path evidence. */
  method?: InstallMethod | undefined;
  /** The environment the service was given, which an agent launched from it inherits. */
  env?: NodeJS.ProcessEnv | undefined;
}

/** Upstream `Flag.truthy`: only "true" and "1", case-insensitively. */
function truthyFlag(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/**
 * Whether OpenCode will replace itself, from the evidence upstream `cli/upgrade.ts` reads.
 *
 * - From 1.19.0 the check never installs: every config state (missing file, no key, any value) is `disabled`.
 * - On 1.18.x the check returns early for `autoupdate: false` or `OPENCODE_DISABLE_AUTOUPDATE`, only notifies for
 *   `"notify"` or a non-patch release, and otherwise calls `Installation.upgrade` — so an absent key behaves like
 *   `true`. It also returns before upgrading when its own install-method probe finds nothing, which Puppeteer's
 *   path classification cannot stand in for, so an unclassified install stays `unknown`.
 * - Without a parsed version, or on a line no evidence covers, only the explicit off switches are evidence.
 */
export function openCodeAutoUpdateState(evidence: OpenCodeAutoUpdateEvidence): AutoUpdateState {
  const { config, version } = evidence;
  if (version !== undefined && notifyOnlyRelease(version)) return 'disabled';
  const value = config.kind === 'value' ? config.value : undefined;
  if (value === false || value === 'notify' || truthyFlag(evidence.env?.OPENCODE_DISABLE_AUTOUPDATE)) {
    return 'disabled';
  }
  if (version === undefined || !selfInstallingRelease(version)) return 'unknown';
  // Any other value fails OpenCode's own config validation, and OpenCode then falls back to its defaults (which
  // install); Puppeteer cannot confirm that fallback from outside, so the state stays unknown.
  if (config.kind === 'unreadable' || (config.kind === 'value' && value !== true)) return 'unknown';
  return evidence.method === 'unknown' ? 'unknown' : 'enabled';
}

/**
 * The global config files the update check reads through `Config.getGlobal`, in upstream merge order: at v1.18.16,
 * packages/opencode/src/config/config.ts `loadGlobal` merges `config.json`, then `opencode.json`, then
 * `opencode.jsonc`, so a later file's `autoupdate` wins.
 */
export const OPENCODE_GLOBAL_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'] as const;

/**
 * One view of the merged global config. A file Puppeteer cannot read the way OpenCode would (unresolved
 * substitutions, invalid JSONC, permissions) makes the whole view `unreadable`: OpenCode then either reads it differently
 * or falls back to defaults, and Puppeteer cannot tell which.
 */
export function mergeOpenCodeAutoUpdateConfig(files: readonly OpenCodeAutoUpdateConfig[]): OpenCodeAutoUpdateConfig {
  let merged: OpenCodeAutoUpdateConfig = { kind: 'absent' };
  for (const file of files) {
    if (file.kind === 'unreadable') return file;
    if (file.kind === 'value') merged = file;
  }
  return merged;
}

function missingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOpenCodeDistributionService(
  options: OpenCodeDistributionServiceOptions = {},
): DistributionService {
  const exec = options.exec ?? defaultExec;
  const readConfigFile = options.readConfigFile ?? ((path: string) => readFile(path, 'utf8'));
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  // Config lives beside the XDG config root, not the data root a profile binds.
  const configRoot = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');

  return {
    provider: OPENCODE_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyOpenCodeCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout } = await exec(candidate.executable, [OPENCODE_VERSION_FLAG]);
        const reading = readOpenCodeVersion(stdout);
        if (reading.status === 'supported') {
          version = reading.version;
        } else if (reading.status === 'unsupported-release-line') {
          // The version stays unset: nothing else this service reads (autoupdate, upgrade) is established for 2.x.
          warnings.push(`${candidate.executable}: ${reading.message}`);
        } else {
          warnings.push(`${candidate.executable} ${OPENCODE_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${OPENCODE_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }

      const files: OpenCodeAutoUpdateConfig[] = [];
      for (const name of OPENCODE_GLOBAL_CONFIG_FILES) {
        try {
          files.push(readOpenCodeAutoUpdateConfig(await readConfigFile(join(configRoot, name))));
        } catch (error) {
          // A missing config is the documented default, not a fault worth warning about.
          files.push(missingFile(error) ? { kind: 'absent' } : { kind: 'unreadable' });
        }
      }
      const config = mergeOpenCodeAutoUpdateConfig(files);
      const autoUpdate = openCodeAutoUpdateState({ config, version, method: classification.method, env });

      return {
        provider: 'opencode',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        autoUpdate,
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    installRecipe(): InstallRecipe {
      return { kind: 'installer-script', url: OPENCODE_INSTALL_SCRIPT_URL };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? OPENCODE_NPM_PACKAGE };
      }
      // `opencode upgrade` detects curl, npm, pnpm, bun, and brew installs itself.
      return { kind: 'native-self-update', argv: [install.executable, ...OPENCODE_UPGRADE_ARGUMENTS] };
    },
  };
}
