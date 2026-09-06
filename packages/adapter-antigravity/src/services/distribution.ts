/**
 * Antigravity distribution: install classification, release detectors, and the
 * vendor update command.
 *
 * Probed 2026-09-06 on Antigravity 1.1.21 (darwin-arm64): `~/.local/bin/agy` is
 * a standalone binary whose real path resolves to itself, unpacked from the
 * vendor's `agy_cli_*` release archive, and `agy help` lists `update` as the
 * only distribution subcommand. The CLI is also reachable as `antigravity`.
 */

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type {
  AutoUpdateState,
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  UpdateRecipe,
} from '@vibecook/puppeteer-core';
import { parseAntigravityVersion } from '../detection.js';

const ANTIGRAVITY_COMMANDS = ['agy', 'antigravity'];
const ANTIGRAVITY_VERSION_FLAG = '--version';
/** Documented kill switch for the CLI's own update check. */
const ANTIGRAVITY_DISABLE_AUTO_UPDATE_VARIABLE = 'AGY_CLI_DISABLE_AUTO_UPDATE';

/** Injected process execution so unit tests never run a real binary. */
export type AntigravityDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface AntigravityDistributionServiceOptions {
  executable?: string;
  exec?: AntigravityDistributionExec;
  /** Injected so tests never read the developer's own environment. */
  env?: NodeJS.ProcessEnv;
}

export const ANTIGRAVITY_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  commands: [...ANTIGRAVITY_COMMANDS],
  npmPackages: [],
  brewNames: [],
  // Mirrors packages/surface/vendors/antigravity/upstream.json.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases?per_page=30',
      tagPattern: '^(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
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

function isAntigravityCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return ANTIGRAVITY_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not Antigravity. */
export function classifyAntigravityCandidate(candidate: InstallCandidate): Classification | undefined {
  if (!isAntigravityCommandName(candidate.realPath) && !isAntigravityCommandName(candidate.executable)) {
    return undefined;
  }
  // The vendor ships one unpacked binary; there is no installer, package, or cask.
  return { method: 'standalone-binary', location: dirname(candidate.realPath) };
}

/** The CLI checks for updates unless the documented variable turns that off. */
function autoUpdateState(env: NodeJS.ProcessEnv): AutoUpdateState {
  const value = env[ANTIGRAVITY_DISABLE_AUTO_UPDATE_VARIABLE];
  if (value === undefined) return 'unknown';
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === '0' || normalized === 'false' ? 'enabled' : 'disabled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAntigravityDistributionService(
  options: AntigravityDistributionServiceOptions = {},
): DistributionService {
  const exec = options.exec ?? defaultExec;
  const env = options.env ?? process.env;
  return {
    provider: ANTIGRAVITY_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyAntigravityCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [ANTIGRAVITY_VERSION_FLAG]);
        version = parseAntigravityVersion(`${stdout}\n${stderr}`);
        if (!version) {
          warnings.push(`${candidate.executable} ${ANTIGRAVITY_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${ANTIGRAVITY_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }
      return {
        provider: 'antigravity',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.location ? { location: classification.location } : {}),
        autoUpdate: autoUpdateState(env),
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      // `agy update` replaces the unpacked binary in place.
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },
  };
}
