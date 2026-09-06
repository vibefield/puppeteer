/**
 * Hermes distribution: install classification, release detectors, and the
 * vendor update command.
 *
 * Hermes installs as a source checkout plus a uv-managed virtual environment
 * behind a wrapper script. Probed 2026-09-06 on Hermes 0.20.5 (darwin-arm64),
 * `~/.local/bin/hermes` is a bash wrapper whose last line is
 * `exec "<checkout>/venv/bin/python" "<checkout>/hermes" "$@"`, so the wrapper
 * itself is the evidence that names the checkout. Only a bounded head of the
 * file is read, so a candidate that turns out to be a large binary costs
 * nothing.
 */

import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type {
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  UpdateRecipe,
} from '@vibecook/puppeteer-core';
import { parseHermesVersion } from '../detection.js';
import { HERMES_VERSION_FLAG } from '../generated/detection.js';

const HERMES_COMMANDS = ['hermes'];
const MAX_WRAPPER_BYTES = 8 * 1024;
/** `exec "<checkout>/venv/bin/python" …` in the installer's wrapper script. */
const HERMES_VENV_PATTERN = /(?:^|["'\s])([^"'\s]+)[/\\]venv[/\\]bin[/\\]python[0-9.]*(?=["'\s]|$)/mu;

/** Injected process execution so unit tests never run a real binary. */
export type HermesDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Injected bounded file read so unit tests never touch a real install. */
export type HermesDistributionReadHead = (path: string) => Promise<string>;

export interface HermesDistributionServiceOptions {
  executable?: string;
  exec?: HermesDistributionExec;
  readHead?: HermesDistributionReadHead;
}

export const HERMES_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'hermes',
  label: 'Hermes',
  commands: [...HERMES_COMMANDS],
  npmPackages: [],
  brewNames: [],
  // Mirrors packages/surface/vendors/hermes/upstream.json: the tag carries the
  // calendar release and the title carries the semantic version.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=30',
      tagPattern: '^v(\\d{4}\\.\\d{1,2}\\.\\d{1,2})$',
      titlePattern: 'v(\\d+\\.\\d+\\.\\d+)',
      prerelease: false,
    },
  ],
  // `hermes update --check` exists but prints prose; text is never a semantic source.
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

async function defaultReadHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_WRAPPER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_WRAPPER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function isHermesCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return HERMES_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

/** The checkout the wrapper script execs, or undefined when it is not that wrapper. */
export function hermesCheckoutFromWrapper(wrapper: string): string | undefined {
  if (!wrapper.startsWith('#!')) return undefined;
  return HERMES_VENV_PATTERN.exec(wrapper)?.[1];
}

export function createHermesDistributionService(options: HermesDistributionServiceOptions = {}): DistributionService {
  const exec = options.exec ?? defaultExec;
  const readHead = options.readHead ?? defaultReadHead;

  return {
    provider: HERMES_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      if (!isHermesCommandName(candidate.realPath) && !isHermesCommandName(candidate.executable)) return undefined;
      const warnings: string[] = [];

      let method: InstalledAgent['method'] = 'unknown';
      let location = dirname(candidate.realPath);
      try {
        const checkout = hermesCheckoutFromWrapper(await readHead(candidate.realPath));
        if (checkout) {
          method = 'source-checkout';
          location = checkout;
        }
      } catch (error) {
        warnings.push(`${candidate.realPath} could not be read: ${errorMessage(error)}`);
      }

      let version: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [HERMES_VERSION_FLAG]);
        version = parseHermesVersion(`${stdout}\n${stderr}`)?.version;
        if (!version) {
          warnings.push(`${candidate.executable} ${HERMES_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${HERMES_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }

      return {
        provider: 'hermes',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method,
        location,
        // Hermes updates only when asked; it documents no auto-update setting.
        autoUpdate: 'unknown',
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      // `--yes` keeps the vendor updater non-interactive; it still rebuilds the
      // checkout and the virtual environment itself.
      return { kind: 'native-self-update', argv: [install.executable, 'update', '--yes'] };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
