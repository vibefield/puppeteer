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
  UpdateRecipe,
} from '@vibecook/puppeteer-core';
import { OPENCODE_VERSION_FLAG, parseOpenCodeVersion } from '../detection.js';

const OPENCODE_NPM_PACKAGE = 'opencode-ai';
const OPENCODE_BREW_NAME = 'opencode';
/** `~/.opencode/bin/opencode`; the capture is the vendor home that owns the install. */
const OPENCODE_HOME_PATTERN = /^(.*[/\\]\.opencode)[/\\]bin[/\\]/u;
const OPENCODE_NPM_PATTERN = /^(.*[/\\]node_modules[/\\]opencode-ai)(?:[/\\]|$)/u;
/** Homebrew keeps formula installs under `<prefix>/Cellar/<name>/<version>`. */
const OPENCODE_CELLAR_PATTERN = /^(.*[/\\]Cellar[/\\]opencode[/\\][^/\\]+)(?:[/\\]|$)/u;
const OPENCODE_COMMANDS = ['opencode'];

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
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
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
 * OpenCode's `autoupdate` config key is `true`, `false`, or `"notify"`. Only
 * `true` means the agent replaces itself; `"notify"` reports and waits.
 */
export function autoUpdateFromConfig(document: string): AutoUpdateState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>).autoupdate;
  if (value === true) return 'enabled';
  if (value === false || value === 'notify') return 'disabled';
  return undefined;
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
  const configPath = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'opencode.json');

  return {
    provider: OPENCODE_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyOpenCodeCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout } = await exec(candidate.executable, [OPENCODE_VERSION_FLAG]);
        version = parseOpenCodeVersion(stdout);
        if (!version) {
          warnings.push(`${candidate.executable} ${OPENCODE_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${OPENCODE_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }

      let autoUpdate: AutoUpdateState = 'unknown';
      try {
        autoUpdate = autoUpdateFromConfig(await readConfigFile(configPath)) ?? 'unknown';
      } catch {
        // A missing config is the documented default, not a fault worth warning about.
      }

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

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? OPENCODE_NPM_PACKAGE };
      }
      // `opencode upgrade` detects curl, npm, pnpm, bun, and brew installs itself.
      return { kind: 'native-self-update', argv: [install.executable, 'upgrade'] };
    },
  };
}
