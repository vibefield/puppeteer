/**
 * Grok distribution: install classification, release detectors, the vendor
 * update command, and Grok's own update oracle.
 *
 * Fingerprints and grammars are native evidence probed 2026-09-06 on Grok
 * 1.0.13 (darwin-arm64): the launcher `~/.local/bin/grok` resolves to
 * `~/.grok/downloads/grok-1.0.13-macos-aarch64` (the vendor downloader), and a
 * second, stale copy sits in the npm global root as `@xai-official/grok`.
 * Two installs of one agent are normal here and are reported, never hidden.
 */

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type {
  DistributionFailure,
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  ReleaseSnapshot,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import { GROK_VERSION_FLAG, parseGrokVersion, resolveGrokExecutable } from '../detection.js';

const GROK_NPM_PACKAGE = '@xai-official/grok';
/** `~/.grok/downloads/grok-<version>-<platform>`; the capture is the Grok home that owns the download. */
const GROK_DOWNLOAD_PATTERN = /^(.*[/\\]\.grok)[/\\]downloads[/\\]/u;
const GROK_NPM_PATTERN = /^(.*[/\\]node_modules[/\\]@xai-official[/\\]grok)(?:[/\\]|$)/u;
const GROK_COMMANDS = ['grok'];

/** Grok's own update oracle, verified 2026-09-06: `grok update --check --json`. */
const GROK_UPDATE_CHECK_ARGS = ['update', '--check', '--json'];
export const GROK_UPDATE_CHECK_COMMAND = 'grok update --check --json';

/**
 * Observed 2026-09-06 on 1.0.13:
 * `{"currentVersion":"1.0.13","latestVersion":"1.0.13","updateAvailable":false,
 *   "installer":"internal","channel":"stable","autoUpdate":true,"error":null}`.
 * Decoded tolerantly: unknown keys are dropped and every field is optional so a
 * future build cannot turn a working oracle into a hard failure.
 */
const GrokUpdateCheckSchema = z.object({
  currentVersion: z.string().optional(),
  latestVersion: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  installer: z.string().optional(),
  channel: z.string().optional(),
  autoUpdate: z.boolean().optional(),
  error: z.string().nullish(),
});

/** Injected process execution so unit tests never run a real binary. */
export type GrokDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface GrokDistributionServiceOptions {
  /** Executable the runtime launches, when the host configured one. */
  executable?: string | undefined;
  exec?: GrokDistributionExec | undefined;
}

export const GROK_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'grok',
  label: 'Grok',
  commands: [...GROK_COMMANDS],
  npmPackages: [GROK_NPM_PACKAGE],
  brewNames: [],
  // Mirrors packages/surface/vendors/grok/upstream.json plus the npm registry,
  // which carries the same builds the vendor endpoints announce.
  detectors: [
    {
      kind: 'text',
      id: 'vendor-stable',
      channel: 'stable',
      url: 'https://x.ai/cli/stable',
      versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-.][0-9A-Za-z]+)*)',
    },
    {
      kind: 'text',
      id: 'vendor-alpha',
      channel: 'preview',
      url: 'https://x.ai/cli/alpha',
      versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-.][0-9A-Za-z]+)*)',
    },
    { kind: 'npm-registry', id: 'npm-latest', channel: 'stable', package: GROK_NPM_PACKAGE, distTag: 'latest' },
  ],
  nativeUpdateCheck: true,
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

function isGrokCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return GROK_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'packageName' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not Grok. */
export function classifyGrokCandidate(candidate: InstallCandidate): Classification | undefined {
  const npmRoot = GROK_NPM_PATTERN.exec(candidate.realPath)?.[1] ?? npmRootFromPackageRoot(candidate.packageRoot);
  if (npmRoot) return { method: 'npm-global', packageName: GROK_NPM_PACKAGE, location: npmRoot };
  const grokHome = GROK_DOWNLOAD_PATTERN.exec(candidate.realPath)?.[1];
  if (grokHome) return { method: 'vendor-downloader', location: grokHome };
  if (isGrokCommandName(candidate.realPath) || isGrokCommandName(candidate.executable)) {
    return { method: 'unknown', location: dirname(candidate.realPath) };
  }
  return undefined;
}

function npmRootFromPackageRoot(packageRoot: string | undefined): string | undefined {
  if (!packageRoot) return undefined;
  return GROK_NPM_PATTERN.exec(`${packageRoot}/`)?.[1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGrokDistributionService(options: GrokDistributionServiceOptions = {}): DistributionService {
  const exec = options.exec ?? defaultExec;
  return {
    provider: GROK_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyGrokCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      let channel: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [GROK_VERSION_FLAG]);
        const parsed = parseGrokVersion(`${stdout}\n${stderr}`);
        if (parsed) {
          version = parsed.version;
          // A clean GROK_HOME omits the channel suffix, so its absence is not evidence of a channel.
          channel = parsed.channel;
        } else {
          warnings.push(`${candidate.executable} ${GROK_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${GROK_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }
      return {
        provider: 'grok',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        // The oracle reports autoUpdate; a version probe alone is no evidence of it.
        autoUpdate: 'unknown',
        ...(channel ? { channel } : {}),
        // `alpha` is Grok's preview line, the same rule the oracle's snapshot applies.
        ...(channel ? { releaseChannel: channel === 'alpha' ? ('preview' as const) : ('stable' as const) } : {}),
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? GROK_NPM_PACKAGE };
      }
      // `grok update` drives the vendor downloader; `--version <v>` pins a build.
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },

    async checkUpdate(install: InstalledAgent): Promise<ReleaseSnapshot | DistributionFailure> {
      const executable = resolveGrokExecutable(install.executable ?? options.executable);
      let payload: unknown;
      try {
        const { stdout } = await exec(executable, GROK_UPDATE_CHECK_ARGS);
        payload = JSON.parse(stdout);
      } catch (error) {
        return {
          status: 'unavailable',
          provider: 'grok',
          message: `${GROK_UPDATE_CHECK_COMMAND} failed: ${errorMessage(error)}`,
          retryable: true,
        };
      }
      const decoded = GrokUpdateCheckSchema.safeParse(payload);
      if (!decoded.success) {
        return {
          status: 'unavailable',
          provider: 'grok',
          message: `${GROK_UPDATE_CHECK_COMMAND} returned an unrecognized document`,
          retryable: false,
        };
      }
      if (decoded.data.error) {
        return {
          status: 'unavailable',
          provider: 'grok',
          message: `${GROK_UPDATE_CHECK_COMMAND} reported an error`,
          retryable: true,
        };
      }
      const version = decoded.data.latestVersion?.trim();
      if (!version) {
        return {
          status: 'unavailable',
          provider: 'grok',
          message: `${GROK_UPDATE_CHECK_COMMAND} reported no latest version`,
          retryable: true,
        };
      }
      return {
        provider: 'grok',
        // `alpha` is Grok's preview channel; every other value follows the stable line.
        channel: decoded.data.channel === 'alpha' ? 'preview' : 'stable',
        version,
        fetchedAt: new Date().toISOString(),
        source: { kind: 'native-oracle', id: GROK_UPDATE_CHECK_COMMAND },
      };
    },
  };
}
