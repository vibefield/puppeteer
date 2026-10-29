/**
 * Codex distribution facts (RFC 006): which install one host-discovered
 * candidate belongs to, which version it runs, and the update command.
 *
 * Native command, native evidence. `codex update` detects npm, bun, pnpm, a
 * Homebrew cask, or a standalone install itself and checks package-root
 * provenance, so the recipe is always the vendor updater; Puppeteer never
 * decides which package manager owns the install.
 *
 * Probed 2026-09-06 on Codex 0.153.4 (darwin-arm64):
 *   `codex --version`  → `codex-cli 0.153.4`
 *   `which codex`      → `<nvm prefix>/bin/codex`
 *   realpath           → `<nvm prefix>/lib/node_modules/@openai/codex/bin/codex.js`
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstallMethod,
  InstalledAgent,
  InstallRecipe,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import {
  CODEX_VERSION_BANNER_MARKER,
  CODEX_VERSION_FLAG,
  parseCodexVersion,
  resolveCodexExecutable,
} from '../detection.js';

/** npm package that carries the CLI when a global npm install owns it. */
export const CODEX_NPM_PACKAGE = '@openai/codex';
/** Homebrew cask the vendor publishes. */
export const CODEX_BREW_NAMES = ['codex'] as const;
/**
 * The first install the vendor lists (github.com/openai/codex README, read
 * 2026-10-29): `curl -fsSL … | sh`, a POSIX script that redirects to
 * `releases.openai.com`. It asks two questions on /dev/tty — remove another
 * install, start Codex now — which `CODEX_NON_INTERACTIVE` skips; it leaves
 * `~/.local/bin/codex` and adds that directory to the shell profile when it is
 * not on PATH already.
 */
export const CODEX_INSTALL_SCRIPT_URL = 'https://chatgpt.com/codex/install.sh';

const execFileAsync = promisify(execFile);
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

/** Injected process runner; the default wraps node:child_process execFile without a shell. */
export type CodexExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultCodexExec: CodexExec = async (file, args) => {
  // npm installs expose a `.js` shim, and Imposter supplies a JavaScript entry
  // point; run those under Node rather than relying on the shebang.
  const isScript = SCRIPT_EXECUTABLE.test(file);
  const command = isScript ? (process.versions.electron ? 'node' : process.execPath) : file;
  const commandArgs = isScript ? [file, ...args] : args;
  const { stdout } = await execFileAsync(command, commandArgs, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return { stdout };
};

function posixish(path: string): string {
  return path.replaceAll('\\', '/');
}

export interface CodexDistributionOptions {
  executable?: string | undefined;
  exec?: CodexExec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Adapter-declared distribution facts. The GitHub detectors mirror
 * packages/surface/vendors/codex/upstream.json; the npm detector is added here
 * because the vendor also publishes every release to the npm `latest` tag,
 * which answers without spending a GitHub rate-limit request.
 */
export const CODEX_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'codex',
  label: 'Codex',
  commands: ['codex'],
  npmPackages: [CODEX_NPM_PACKAGE],
  brewNames: [...CODEX_BREW_NAMES],
  // The install script's BIN_DIR when CODEX_INSTALL_DIR is unset (read 2026-10-29).
  installDirectories: ['.local/bin'],
  detectors: [
    {
      kind: 'github-release',
      id: 'github-stable',
      channel: 'stable',
      url: 'https://api.github.com/repos/openai/codex/releases?per_page=30',
      tagPattern: '^rust-v(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    {
      kind: 'github-release',
      id: 'github-preview',
      channel: 'preview',
      url: 'https://api.github.com/repos/openai/codex/releases?per_page=30',
      tagPattern: '^rust-v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+))$',
      prerelease: true,
    },
    {
      kind: 'npm-registry',
      id: 'npm-latest',
      channel: 'stable',
      package: CODEX_NPM_PACKAGE,
      distTag: 'latest',
    },
  ],
  // `codex update` performs the update; it is not a "what is available" oracle.
  nativeUpdateCheck: false,
};

interface Classification {
  method: InstallMethod;
  packageName?: string;
  location?: string;
  definitive: boolean;
}

/** The directory that owns the install: everything up to and including `<segment>`'s last name. */
function ownerDirectory(source: string, segment: string): string {
  return source.slice(0, source.indexOf(segment) + segment.length - 1);
}

function classify(candidate: InstallCandidate): Classification {
  const realPath = posixish(candidate.realPath);
  // A trailing separator lets one `includes` match both a package root and a
  // file inside it, and keeps every offset relative to the same string.
  const packageRoot = candidate.packageRoot === undefined ? '' : `${posixish(candidate.packageRoot)}/`;

  const npmSegment = `/node_modules/${CODEX_NPM_PACKAGE}/`;
  const npmSource = realPath.includes(npmSegment)
    ? realPath
    : packageRoot.includes(npmSegment)
      ? packageRoot
      : undefined;
  if (npmSource !== undefined) {
    return {
      method: 'npm-global',
      packageName: CODEX_NPM_PACKAGE,
      location: ownerDirectory(npmSource, npmSegment),
      definitive: true,
    };
  }

  for (const name of CODEX_BREW_NAMES) {
    for (const store of ['Caskroom', 'Cellar']) {
      const segment = `/${store}/${name}/`;
      const source = realPath.includes(segment) ? realPath : packageRoot.includes(segment) ? packageRoot : undefined;
      if (source === undefined) continue;
      return { method: 'brew', packageName: name, location: ownerDirectory(source, segment), definitive: true };
    }
  }

  return { method: 'standalone-binary', definitive: false };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Codex distribution capability: candidate classification, version probe, update recipe. */
export function createCodexDistributionService(options: CodexDistributionOptions = {}): DistributionService {
  const exec = options.exec ?? defaultCodexExec;
  const environment = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const configured = resolveCodexExecutable(options.executable, environment);

  return {
    provider: CODEX_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classify(candidate);
      const warnings: string[] = [];

      let version: string | undefined;
      let banner: string | undefined;
      try {
        banner = (await exec(candidate.executable, [CODEX_VERSION_FLAG])).stdout;
        version = parseCodexVersion(banner);
        if (!version) warnings.push(`could not parse a version from \`${candidate.executable} ${CODEX_VERSION_FLAG}\``);
      } catch (error) {
        warnings.push(`\`${candidate.executable} ${CODEX_VERSION_FLAG}\` failed: ${errMessage(error)}`);
      }

      // A package layout is proof. Otherwise the banner has to name Codex,
      // except for the executable this adapter was configured to launch.
      const bannerNamesCodex = banner !== undefined && banner.includes(CODEX_VERSION_BANNER_MARKER);
      const isConfigured = candidate.origin === 'configured' || candidate.executable === configured;
      if (!classification.definitive && !bannerNamesCodex && !isConfigured) {
        if (banner !== undefined) return undefined;
        warnings.push('version banner was unreadable; classified from the discovered command name only');
      }

      return {
        provider: 'codex',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        // Probed 2026-09-06 on 0.153.4: `codex --help` and `codex update --help`
        // advertise no auto-update switch and config.toml has no key for one, so
        // there is no evidence either way. Report unknown rather than assert.
        autoUpdate: 'unknown',
        detectedAt: now().toISOString(),
        warnings,
      };
    },

    installRecipe(): InstallRecipe {
      return {
        kind: 'installer-script',
        url: CODEX_INSTALL_SCRIPT_URL,
        shell: 'sh',
        env: { CODEX_NON_INTERACTIVE: '1' },
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      // `codex update` resolves npm, bun, pnpm, brew, and standalone installs
      // itself, so there is never a reason to run a package manager directly.
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },
  };
}
