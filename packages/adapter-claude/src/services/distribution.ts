/**
 * Claude Code distribution facts (RFC 006): which install one host-discovered
 * candidate belongs to, which version it runs, and the vendor-documented update
 * command for that install method.
 *
 * Native command, native evidence. This service never installs, updates, or
 * parses updater output. It classifies from paths, reads the native version
 * banner, and reads Claude Code's own settings for auto-update state; the host
 * runs the recipe and re-inspects to learn whether anything changed.
 *
 * Probed 2026-09-06 on Claude Code 2.1.263 (darwin-arm64):
 *   `claude --version`  → `2.1.263 (Claude Code)`
 *   `which claude`      → `~/.local/bin/claude` (launcher symlink)
 *   realpath            → `~/.local/share/claude/versions/2.1.263`
 *   `~/.claude.json`    → installMethod `native`, autoUpdates `false`,
 *                         autoUpdatesProtectedForNative `true`
 */

import { readFile as readFileFromDisk } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AutoUpdateState,
  DistributionProvider,
  DistributionService,
  InstallCandidate,
  InstallMethod,
  InstalledAgent,
  ReleaseChannel,
  UpdateRecipe,
} from '@vibecook/puppeteer-core';
import {
  CLAUDE_VERSION_FLAG,
  defaultClaudeExec,
  parseClaudeVersion,
  resolveClaudeExecutable,
  type ClaudeExec,
} from '../detection.js';
import { CLAUDE_DETECTION_SURFACE } from '../generated/detection-surface.js';

/** npm package that carries the CLI when a global npm install owns it. */
export const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code';
/** Homebrew casks the vendor publishes. */
export const CLAUDE_BREW_NAMES = ['claude-code', 'claude-code@latest'] as const;

/**
 * The version banner minus the version, taken from the generated detection
 * surface rather than hand-written here, so the fingerprint follows Surface.
 * `2.1.226 (Claude Code)` → `(Claude Code)`.
 */
const VENDOR_BANNER_MARKER = (() => {
  const banner = CLAUDE_DETECTION_SURFACE.versionOutput;
  const version = parseClaudeVersion(banner);
  return (version ? banner.replace(version, '') : banner).trim();
})();

/** Native installer layout: `<home>/.local/share/claude/versions/<version>`. */
const NATIVE_VERSIONS_SEGMENTS = ['.local', 'share', 'claude', 'versions'] as const;

/**
 * `DISABLE_AUTOUPDATER` (background updates) and `DISABLE_UPDATES` (every path)
 * are treated the way shell users write them: any value other than empty, `0`,
 * or `false` turns the switch on.
 */
function envSwitchIsOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** Path containment that tolerates Windows separators without changing the reported paths. */
function posixish(path: string): string {
  return path.replaceAll('\\', '/');
}

export interface ClaudeDistributionOptions {
  /** Executable the runtime launches; only used to answer version probes for a configured candidate. */
  executable?: string | undefined;
  exec?: ClaudeExec | undefined;
  /** Injected reader so unit tests never touch a real home directory. */
  readFile?: ((path: string) => Promise<string>) | undefined;
  /** Home directory the native layouts hang off; defaults to the process home. */
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

/** Adapter-declared distribution facts. Detectors mirror packages/surface/vendors/claude/upstream.json. */
export const CLAUDE_DISTRIBUTION_PROVIDER: DistributionProvider = {
  id: 'claude',
  label: 'Claude',
  commands: ['claude'],
  npmPackages: [CLAUDE_NPM_PACKAGE],
  brewNames: [...CLAUDE_BREW_NAMES],
  detectors: [
    {
      kind: 'text',
      id: 'vendor-stable',
      channel: 'stable',
      url: 'https://downloads.claude.ai/claude-code-releases/stable',
      versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-.][0-9A-Za-z]+)*)',
    },
    {
      kind: 'github-release',
      id: 'github-latest',
      channel: 'preview',
      url: 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=20',
      tagPattern: '^v(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    {
      kind: 'text',
      id: 'vendor-latest',
      channel: 'preview',
      url: 'https://downloads.claude.ai/claude-code-releases/latest',
      versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-.][0-9A-Za-z]+)*)',
    },
  ],
  // `claude doctor` and `.last-update-result.json` report the last update, not
  // the newest release, so there is no native "what is available" oracle.
  nativeUpdateCheck: false,
};

interface Classification {
  method: InstallMethod;
  packageName?: string;
  location?: string;
  /** True when a path layout identified the install; a version banner is then not required. */
  definitive: boolean;
}

/** The directory that owns the install: everything up to and including `<segment>`'s last name. */
function ownerDirectory(source: string, segment: string): string {
  return source.slice(0, source.indexOf(segment) + segment.length - 1);
}

function classify(candidate: InstallCandidate, home: string): Classification {
  const realPath = posixish(candidate.realPath);
  // A trailing separator lets one `includes` match both a package root and a
  // file inside it, and keeps every offset relative to the same string.
  const packageRoot = candidate.packageRoot === undefined ? '' : `${posixish(candidate.packageRoot)}/`;

  const versionsRoot = posixish(join(home, ...NATIVE_VERSIONS_SEGMENTS));
  if (realPath.startsWith(`${versionsRoot}/`)) {
    return { method: 'native-installer', location: join(home, ...NATIVE_VERSIONS_SEGMENTS), definitive: true };
  }

  const npmSegment = `/node_modules/${CLAUDE_NPM_PACKAGE}/`;
  const npmSource = realPath.includes(npmSegment)
    ? realPath
    : packageRoot.includes(npmSegment)
      ? packageRoot
      : undefined;
  if (npmSource !== undefined) {
    return {
      method: 'npm-global',
      packageName: CLAUDE_NPM_PACKAGE,
      location: ownerDirectory(npmSource, npmSegment),
      definitive: true,
    };
  }

  for (const name of CLAUDE_BREW_NAMES) {
    for (const store of ['Caskroom', 'Cellar']) {
      const segment = `/${store}/${name}/`;
      const source = realPath.includes(segment) ? realPath : packageRoot.includes(segment) ? packageRoot : undefined;
      if (source === undefined) continue;
      return { method: 'brew', packageName: name, location: ownerDirectory(source, segment), definitive: true };
    }
  }

  return { method: 'standalone-binary', definitive: false };
}

interface AutoUpdateEvidence {
  autoUpdate: AutoUpdateState;
  channel?: string;
  warnings: string[];
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Evaluate Claude Code's own update settings.
 *
 * Probed 2026-09-06 on 2.1.263: the legacy `autoUpdates: false` key is ignored
 * for native installs, which `autoUpdatesProtectedForNative: true` records, so
 * this machine auto-updates despite carrying that key. `DISABLE_AUTOUPDATER`
 * stops background updates and `DISABLE_UPDATES` stops every update path.
 */
export function evaluateClaudeAutoUpdate(
  method: InstallMethod,
  config: unknown,
  settings: unknown,
  env: NodeJS.ProcessEnv,
): AutoUpdateEvidence {
  const warnings: string[] = [];
  const channelValue = rec(settings)?.autoUpdatesChannel;
  const channel = typeof channelValue === 'string' && channelValue.trim() ? channelValue.trim() : undefined;

  if (envSwitchIsOn(env.DISABLE_UPDATES)) {
    return { autoUpdate: 'disabled', ...(channel ? { channel } : {}), warnings };
  }
  if (envSwitchIsOn(env.DISABLE_AUTOUPDATER)) {
    return { autoUpdate: 'disabled', ...(channel ? { channel } : {}), warnings };
  }

  const document = rec(config);
  if (!document) return { autoUpdate: 'unknown', ...(channel ? { channel } : {}), warnings };

  const protectedForNative = document.autoUpdatesProtectedForNative === true;
  const autoUpdates = typeof document.autoUpdates === 'boolean' ? document.autoUpdates : undefined;
  const nativeInstall = method === 'native-installer' || document.installMethod === 'native';

  if (autoUpdates === false && nativeInstall && protectedForNative) {
    warnings.push('`autoUpdates: false` is ignored for native installs (autoUpdatesProtectedForNative)');
    return { autoUpdate: 'enabled', ...(channel ? { channel } : {}), warnings };
  }
  if (autoUpdates !== undefined) {
    return { autoUpdate: autoUpdates ? 'enabled' : 'disabled', ...(channel ? { channel } : {}), warnings };
  }
  // Native installs update themselves unless one of the switches above is set.
  return { autoUpdate: nativeInstall ? 'enabled' : 'unknown', ...(channel ? { channel } : {}), warnings };
}

/**
 * Which declared release channel an install's own updater follows. The
 * native installer (and a standalone binary, which `claude update` migrates
 * into it) follows `autoUpdatesChannel`: `stable`, or `latest` — the
 * documented default — which the `vendor-latest` and `github-latest`
 * detectors track, as does `rc`. A global npm install is updated to the npm
 * `latest` dist-tag by its recipe, the same line. The `@latest` cask names its
 * line; the plain cask's line is not evidenced, so it stays unclassified.
 */
export function claudeReleaseChannel(
  method: InstallMethod,
  packageName: string | undefined,
  nativeChannel: string | undefined,
): ReleaseChannel | undefined {
  if (method === 'npm-global') return 'preview';
  if (method === 'brew') return packageName?.endsWith('@latest') === true ? 'preview' : undefined;
  return nativeChannel === 'stable' ? 'stable' : 'preview';
}

async function readJson(read: (path: string) => Promise<string>, path: string): Promise<unknown> {
  try {
    return JSON.parse(await read(path));
  } catch {
    return undefined;
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Claude Code distribution capability: candidate classification, version probe, update recipe. */
export function createClaudeDistributionService(options: ClaudeDistributionOptions = {}): DistributionService {
  const exec = options.exec ?? defaultClaudeExec;
  const read = options.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'));
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const configured = resolveClaudeExecutable(options.executable, env);

  return {
    provider: CLAUDE_DISTRIBUTION_PROVIDER,

    async inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined> {
      const classification = classify(candidate, home);
      const warnings: string[] = [];

      let version: string | undefined;
      let banner: string | undefined;
      try {
        banner = (await exec(candidate.executable, [CLAUDE_VERSION_FLAG])).stdout;
        version = parseClaudeVersion(banner);
        if (!version) {
          warnings.push(`could not parse a version from \`${candidate.executable} ${CLAUDE_VERSION_FLAG}\``);
        }
      } catch (error) {
        warnings.push(`\`${candidate.executable} ${CLAUDE_VERSION_FLAG}\` failed: ${errMessage(error)}`);
      }

      // A path layout is proof. Otherwise the banner has to name Claude Code,
      // except for an executable the host was explicitly configured to launch
      // for this provider (custom builds and Imposter entry points).
      const bannerNamesClaude = banner !== undefined && banner.includes(VENDOR_BANNER_MARKER);
      const isConfigured = candidate.origin === 'configured' || candidate.executable === configured;
      if (!classification.definitive && !bannerNamesClaude && !isConfigured) {
        if (banner !== undefined) return undefined;
        warnings.push('version banner was unreadable; classified from the discovered command name only');
      }

      const config = await readJson(read, join(home, '.claude.json'));
      const settings = await readJson(read, join(home, '.claude', 'settings.json'));
      const update = evaluateClaudeAutoUpdate(classification.method, config, settings, env);
      const releaseChannel = claudeReleaseChannel(classification.method, classification.packageName, update.channel);

      return {
        provider: 'claude',
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version ? { version } : {}),
        method: classification.method,
        ...(classification.packageName ? { packageName: classification.packageName } : {}),
        ...(classification.location ? { location: classification.location } : {}),
        autoUpdate: update.autoUpdate,
        ...(update.channel ? { channel: update.channel } : {}),
        ...(releaseChannel ? { releaseChannel } : {}),
        detectedAt: now().toISOString(),
        warnings: [...warnings, ...update.warnings],
      };
    },

    recipeFor(install: InstalledAgent): UpdateRecipe {
      if (install.method === 'npm-global') {
        return { kind: 'npm-global', package: install.packageName ?? CLAUDE_NPM_PACKAGE };
      }
      if (install.method === 'brew') {
        // The vendor ships Claude Code as a cask, not a formula.
        return { kind: 'brew', name: install.packageName ?? CLAUDE_BREW_NAMES[0], cask: true };
      }
      // `claude update` is the documented path for the native installer and for
      // a standalone binary, which it migrates into the native layout.
      return { kind: 'native-self-update', argv: [install.executable, 'update'] };
    },
  };
}
