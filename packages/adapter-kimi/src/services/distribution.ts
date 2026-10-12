/**
 * Kimi Code distribution: install classification, release detectors, and the
 * vendor's update path for each install.
 *
 * Fingerprints are native evidence probed 2026-09-06 on Kimi 0.37.1
 * (darwin-arm64): the vendor install script places a standalone Mach-O binary
 * at `~/.kimi-code/bin/kimi` whose real path resolves to itself. Kimi ships
 * platform archives through GitHub releases only, so no npm or Homebrew name
 * is declared.
 *
 * Probed 2026-09-22 on the same build: Kimi calls that layout its NATIVE
 * INSTALLER, and `kimi upgrade` does not move it — it prints "Detected install
 * source: native installer / To update manually, run: curl -fsSL
 * https://code.kimi.com/kimi-code/install.sh | bash" and exits 0. So a
 * native-installer install updates by running that script again (it resolves
 * the latest release, verifies its sha256, and replaces the binary under
 * `KIMI_INSTALL_DIR`); `KIMI_NO_MODIFY_PATH` keeps it out of the shell rc,
 * which an update has no business touching. `kimi.ai` serves no script (it
 * redirects to the web page); `code.kimi.com` does (via `cdn.kimi.com`).
 */

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type {
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import { parseKimiVersion } from '../detection.js';

/** `~/.kimi-code/bin/kimi`; the capture is the Kimi home that owns the install. */
const KIMI_HOME_PATTERN = /^(.*[/\\]\.kimi-code)[/\\]bin[/\\]/u;
/** The script Kimi's own upgrade command names for a native-installer install. */
const KIMI_INSTALL_SCRIPT_URL = 'https://code.kimi.com/kimi-code/install.sh';
const KIMI_COMMANDS = ['kimi'];
const KIMI_VERSION_FLAG = '--version';

/** Injected process execution so unit tests never run a real binary. */
export type KimiDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface KimiDistributionServiceOptions {
  executable?: string | undefined;
  exec?: KimiDistributionExec | undefined;
  /** The install script is a bash script; defaults to this process's platform. */
  platform?: NodeJS.Platform | undefined;
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
  if (kimiHome) return { method: 'native-installer', location: kimiHome };
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
  const platform = options.platform ?? process.platform;
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
      if (install.method === 'native-installer' && install.location && platform !== 'win32') {
        return {
          kind: 'installer-script',
          url: KIMI_INSTALL_SCRIPT_URL,
          env: { KIMI_INSTALL_DIR: install.location, KIMI_NO_MODIFY_PATH: '1' },
        };
      }
      // Elsewhere `kimi upgrade` detects its own install source and updates it.
      return { kind: 'native-self-update', argv: [install.executable, 'upgrade'] };
    },
  };
}
