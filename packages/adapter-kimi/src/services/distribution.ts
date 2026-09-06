/**
 * Kimi Code distribution: install classification, release detectors, and the
 * vendor upgrade command.
 *
 * Fingerprints are native evidence probed 2026-09-06 on Kimi 0.37.1
 * (darwin-arm64): the vendor install script places a standalone Mach-O binary
 * at `~/.kimi-code/bin/kimi` whose real path resolves to itself. Kimi ships
 * platform archives through GitHub releases only, so no npm or Homebrew name
 * is declared.
 */

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type {
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  UpdateRecipe,
} from '@vibecook/puppeteer-core';
import { parseKimiVersion } from '../detection.js';

/** `~/.kimi-code/bin/kimi`; the capture is the Kimi home that owns the install. */
const KIMI_HOME_PATTERN = /^(.*[/\\]\.kimi-code)[/\\]bin[/\\]/u;
const KIMI_COMMANDS = ['kimi'];
const KIMI_VERSION_FLAG = '--version';

/** Injected process execution so unit tests never run a real binary. */
export type KimiDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface KimiDistributionServiceOptions {
  executable?: string;
  exec?: KimiDistributionExec;
}

export const KIMI_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'kimi',
  label: 'Kimi',
  commands: [...KIMI_COMMANDS],
  npmPackages: [],
  brewNames: [],
  // Mirrors packages/surface/vendors/kimi/upstream.json.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=30',
      tagPattern: '^@moonshot-ai/kimi-code@(\\d+\\.\\d+\\.\\d+)$',
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

function isKimiCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return KIMI_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'packageName' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not Kimi. */
export function classifyKimiCandidate(candidate: InstallCandidate): Classification | undefined {
  const kimiHome = KIMI_HOME_PATTERN.exec(candidate.realPath)?.[1];
  if (kimiHome) return { method: 'standalone-binary', location: kimiHome };
  if (isKimiCommandName(candidate.realPath) || isKimiCommandName(candidate.executable)) {
    // A `kimi` outside the vendor home is real, but nothing says how it arrived.
    return { method: 'unknown', location: dirname(candidate.realPath) };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createKimiDistributionService(options: KimiDistributionServiceOptions = {}): DistributionService {
  const exec = options.exec ?? defaultExec;
  return {
    provider: KIMI_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyKimiCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [KIMI_VERSION_FLAG]);
        version = parseKimiVersion(`${stdout}\n${stderr}`);
        if (!version) {
          warnings.push(`${candidate.executable} ${KIMI_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${KIMI_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }
      return {
        provider: 'kimi',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.location ? { location: classification.location } : {}),
        // Kimi documents no auto-update setting or oracle.
        autoUpdate: 'unknown',
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      // `kimi upgrade` replaces the binary under the vendor home.
      return { kind: 'native-self-update', argv: [install.executable, 'upgrade'] };
    },
  };
}
