/**
 * Pi distribution: install classification, release detectors, and the vendor
 * update command.
 *
 * Fingerprints are native evidence probed 2026-09-06 on Pi 0.84.3
 * (darwin-arm64): the `pi` launcher in the npm global bin directory resolves to
 * `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
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
import { parsePiVersion } from '../detection.js';

const PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_NPM_PATTERN = /^(.*[/\\]node_modules[/\\]@earendil-works[/\\]pi-coding-agent)(?:[/\\]|$)/u;
const PI_COMMANDS = ['pi'];
const PI_VERSION_FLAG = '--version';

/** Injected process execution so unit tests never run a real binary. */
export type PiDistributionExec = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export interface PiDistributionServiceOptions {
  executable?: string | undefined;
  exec?: PiDistributionExec | undefined;
}

export const PI_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'pi',
  label: 'Pi',
  commands: [...PI_COMMANDS],
  npmPackages: [PI_NPM_PACKAGE],
  brewNames: [],
  // Mirrors packages/surface/vendors/pi/upstream.json plus the npm registry the
  // vendor publishes the installable package to.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/earendil-works/pi/releases?per_page=30',
      tagPattern: '^v?(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    { kind: 'npm-registry', id: 'npm-latest', channel: 'stable', package: PI_NPM_PACKAGE, distTag: 'latest' },
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

function isPiCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return PI_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'packageName' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not Pi. */
export function classifyPiCandidate(candidate: InstallCandidate): Classification | undefined {
  const npmRoot =
    PI_NPM_PATTERN.exec(candidate.realPath)?.[1] ??
    (candidate.packageRoot ? PI_NPM_PATTERN.exec(`${candidate.packageRoot}/`)?.[1] : undefined);
  if (npmRoot) return { method: 'npm-global', packageName: PI_NPM_PACKAGE, location: npmRoot };
  if (isPiCommandName(candidate.realPath) || isPiCommandName(candidate.executable)) {
    return { method: 'unknown', location: dirname(candidate.realPath) };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPiDistributionService(options: PiDistributionServiceOptions = {}): DistributionService {
  const exec = options.exec ?? defaultExec;
  return {
    provider: PI_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyPiCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [PI_VERSION_FLAG]);
        version = parsePiVersion(`${stdout}\n${stderr}`);
        if (!version) {
          warnings.push(`${candidate.executable} ${PI_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${PI_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }
      return {
        provider: 'pi',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        // Pi updates only when asked; it documents no auto-update setting.
        autoUpdate: 'unknown',
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? PI_NPM_PACKAGE };
      }
      // Probed 2026-09-06 on 0.84.3: `pi update` with no target updates Pi
      // itself (`--self` is the documented default).
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },
  };
}
