/**
 * GitHub Copilot CLI distribution: install classification, release detectors,
 * and the vendor update command.
 *
 * Fingerprints are native evidence probed 2026-09-06 on Copilot 1.0.80
 * (darwin-arm64): `~/.local/bin/copilot` is a Mach-O binary placed by the
 * vendor installer whose real path resolves to itself, while the same build is
 * also published to npm as `@github/copilot`.
 */

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import type {
  AutoUpdateState,
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstalledAgent,
  InstallRecipe,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import { parseCopilotVersion } from '../detection.js';

const COPILOT_NPM_PACKAGE = '@github/copilot';
/**
 * The first install the vendor lists (github.com/github/copilot-cli README,
 * read 2026-10-29). It redirects to the repository's own `install.sh`, which
 * downloads a GitHub release into `~/.local/bin/copilot`; its one question (add
 * that directory to the shell rc) reads /dev/tty, so nothing is edited without one.
 */
const COPILOT_INSTALL_SCRIPT_URL = 'https://gh.io/copilot-install';
const COPILOT_NPM_PATTERN = /^(.*[/\\]node_modules[/\\]@github[/\\]copilot)(?:[/\\]|$)/u;
const COPILOT_COMMANDS = ['copilot'];
const COPILOT_VERSION_FLAG = '--version';
/** Documented kill switch for the startup update check; Copilot has no update oracle. */
const COPILOT_AUTO_UPDATE_VARIABLE = 'COPILOT_AUTO_UPDATE';

/** Injected process execution so unit tests never run a real binary. */
export type CopilotDistributionExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface CopilotDistributionServiceOptions {
  executable?: string | undefined;
  exec?: CopilotDistributionExec | undefined;
  /** Injected so tests never read the developer's own environment. */
  env?: NodeJS.ProcessEnv | undefined;
}

export const COPILOT_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'copilot',
  label: 'GitHub Copilot',
  commands: [...COPILOT_COMMANDS],
  npmPackages: [COPILOT_NPM_PACKAGE],
  brewNames: [],
  // The install script's $PREFIX/bin for an install that is not root's (read 2026-10-29).
  installDirectories: ['.local/bin'],
  // Mirrors packages/surface/vendors/copilot/upstream.json plus the npm registry
  // the vendor publishes its platform tarballs to.
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/github/copilot-cli/releases?per_page=30',
      tagPattern: '^v?(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    { kind: 'npm-registry', id: 'npm-latest', channel: 'stable', package: COPILOT_NPM_PACKAGE, distTag: 'latest' },
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

function isCopilotCommandName(value: string): boolean {
  const name = basename(value).toLowerCase();
  return COPILOT_COMMANDS.some((command) => name === command || name === `${command}.exe`);
}

type Classification = Pick<InstalledAgent, 'method' | 'packageName' | 'location'>;

/** Classify one candidate from path evidence only; undefined means it is not Copilot. */
export function classifyCopilotCandidate(candidate: InstallCandidate): Classification | undefined {
  const npmRoot =
    COPILOT_NPM_PATTERN.exec(candidate.realPath)?.[1] ??
    (candidate.packageRoot ? COPILOT_NPM_PATTERN.exec(`${candidate.packageRoot}/`)?.[1] : undefined);
  if (npmRoot) return { method: 'npm-global', packageName: COPILOT_NPM_PACKAGE, location: npmRoot };
  if (isCopilotCommandName(candidate.realPath) || isCopilotCommandName(candidate.executable)) {
    return { method: 'standalone-binary', location: dirname(candidate.realPath) };
  }
  return undefined;
}

/** The startup update check is on unless the documented variable turns it off. */
function autoUpdateState(env: NodeJS.ProcessEnv): AutoUpdateState {
  const value = env[COPILOT_AUTO_UPDATE_VARIABLE];
  if (value === undefined) return 'unknown';
  const normalized = value.trim().toLowerCase();
  return normalized === 'false' || normalized === '0' ? 'disabled' : 'enabled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCopilotDistributionService(options: CopilotDistributionServiceOptions = {}): DistributionService {
  const exec = options.exec ?? defaultExec;
  const env = options.env ?? process.env;
  return {
    provider: COPILOT_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classifyCopilotCandidate(candidate);
      if (!classification) return undefined;
      const warnings: string[] = [];
      let version: string | undefined;
      try {
        const { stdout, stderr } = await exec(candidate.executable, [COPILOT_VERSION_FLAG]);
        version = parseCopilotVersion(`${stdout}\n${stderr}`);
        if (!version) {
          warnings.push(`${candidate.executable} ${COPILOT_VERSION_FLAG} returned an unrecognized version string`);
        }
      } catch (error) {
        warnings.push(`${candidate.executable} ${COPILOT_VERSION_FLAG} failed: ${errorMessage(error)}`);
      }
      return {
        provider: 'copilot',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        autoUpdate: autoUpdateState(env),
        detectedAt: new Date().toISOString(),
        warnings,
      };
    },

    installRecipe(): InstallRecipe {
      return { kind: 'installer-script', url: COPILOT_INSTALL_SCRIPT_URL };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? COPILOT_NPM_PACKAGE };
      }
      // `copilot update` replaces the installed binary in place.
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },
  };
}
