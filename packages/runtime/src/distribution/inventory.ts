import { readFile as readFileNative, readdir as readdirNative, realpath as realpathNative } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  InstallCandidateSchema,
  InstalledAgentSchema,
  type AgentInstallation,
  type DistributionService,
  type InstallCandidate,
  type InstallCandidateOrigin,
  type InstalledAgent,
} from '@vibefield/puppeteer-core';

/**
 * Host-owned discovery of candidate agent executables.
 *
 * Finding executables is provider-neutral machinery (PATH order, npm global
 * roots, Homebrew prefixes, symlink resolution), so the runtime owns it.
 * Deciding whether a candidate is one particular agent, reading its version,
 * and classifying its install method are provider facts, so every candidate is
 * handed to the adapter's `inspect`. The runtime never guesses a version and
 * never parses installer output.
 */

/** Homebrew prefixes probed on macOS (Apple silicon first) and Linuxbrew-style installs. */
const DEFAULT_BREW_PREFIXES = ['/opt/homebrew', '/usr/local'] as const;

export interface InventoryFileAccess {
  /** Resolve symlinks; rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
  /** Read one UTF-8 file; rejects when it is absent or unreadable. */
  readFile(path: string): Promise<string>;
  /** List one directory's entry names; rejects when it is absent. */
  readdir(path: string): Promise<string[]>;
}

/** One provider's distribution capability plus the executables the runtime would launch. */
export interface InventoryProvider {
  providerId: string;
  service: DistributionService;
  /**
   * Launch-command executables in declaration order. Only absolute entries are
   * candidates: a bare name resolves through PATH like any other command.
   */
  launchExecutables: readonly string[];
}

export interface InstallInventoryOptions {
  providers: readonly InventoryProvider[];
  /** PATH-style search list; defaults to process.env.PATH. */
  searchPath?: string;
  files?: Partial<InventoryFileAccess>;
  brewPrefixes?: readonly string[];
  onError?: (error: Error) => void;
}

export interface InspectInventoryOptions {
  providerId?: string;
  /** Discard the cached inventory for the selected providers before inspecting. */
  refresh?: boolean;
}

export interface InstallInventory {
  inspect(options?: InspectInventoryOptions): Promise<AgentInstallation[]>;
  /** The install the runtime would launch for one provider. */
  active(providerId: string, options?: { refresh?: boolean }): Promise<AgentInstallation | undefined>;
  invalidate(providerId?: string): void;
}

const defaultFileAccess: InventoryFileAccess = {
  realpath: (path) => realpathNative(path),
  readFile: (path) => readFileNative(path, 'utf8'),
  readdir: (path) => readdirNative(path),
};

/** PATH entries in order, without duplicates. An empty entry means "cwd" and is deliberately not searched. */
export function searchPathDirectories(searchPath: string | undefined): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const entry of (searchPath ?? '').split(delimiter)) {
    const directory = entry.trim();
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

interface DiscoveredCandidate {
  executable: string;
  origin: InstallCandidateOrigin;
  packageRoot?: string;
}

/**
 * Read the executable a global npm package provides. `bin` is a string for a
 * single-command package and a map otherwise; the map entry named like one of
 * the provider's commands wins so a multi-command package resolves to the
 * agent's own entry point rather than an arbitrary sibling.
 */
function npmPackageExecutable(packageRoot: string, manifest: unknown, commands: readonly string[]): string | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined;
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === 'string' && bin.trim()) return resolve(packageRoot, bin);
  if (!bin || typeof bin !== 'object') return undefined;
  const entries = Object.entries(bin as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
  );
  if (entries.length === 0) return undefined;
  const preferred = entries.find(([name]) => commands.includes(name)) ?? entries[0];
  if (preferred === undefined) return undefined;
  return resolve(packageRoot, preferred[1]);
}

export function createInstallationInventory(options: InstallInventoryOptions): InstallInventory {
  const files: InventoryFileAccess = { ...defaultFileAccess, ...options.files };
  const brewPrefixes = options.brewPrefixes ?? DEFAULT_BREW_PREFIXES;
  const providers = new Map(options.providers.map((provider) => [provider.providerId, provider]));
  const cache = new Map<string, Promise<AgentInstallation[]>>();
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  /** PATH directory listings are read once per inspection pass and shared by every provider. */
  async function pathListings(): Promise<Map<string, Set<string>>> {
    const directories = searchPathDirectories(options.searchPath ?? process.env.PATH);
    const listings = new Map<string, Set<string>>();
    await Promise.all(
      directories.map(async (directory) => {
        try {
          listings.set(directory, new Set(await files.readdir(directory)));
        } catch {
          // A PATH entry that does not exist is normal, not an error.
        }
      }),
    );
    // Preserve PATH order: the first match is what the shell would run.
    return new Map(directories.filter((directory) => listings.has(directory)).map((d) => [d, listings.get(d)!]));
  }

  async function discover(
    provider: InventoryProvider,
    listings: Map<string, Set<string>>,
  ): Promise<InstallCandidate[]> {
    const descriptor = provider.service.provider;
    const discovered: DiscoveredCandidate[] = [];

    // 1. The executable the runtime is configured to launch, when it names a file.
    for (const executable of provider.launchExecutables) {
      if (isAbsolute(executable)) discovered.push({ executable, origin: 'configured' });
    }

    // 2. Every PATH match, not only the first: two installs of one agent are normal.
    for (const [directory, entries] of listings) {
      for (const command of descriptor.commands) {
        if (entries.has(command)) discovered.push({ executable: join(directory, command), origin: 'path' });
      }
    }

    // 3. npm global roots are siblings of each PATH bin directory.
    for (const directory of listings.keys()) {
      for (const packageName of descriptor.npmPackages) {
        const packageRoot = resolve(directory, '..', 'lib', 'node_modules', packageName);
        let manifest: unknown;
        try {
          manifest = JSON.parse(await files.readFile(join(packageRoot, 'package.json')));
        } catch {
          continue;
        }
        const executable = npmPackageExecutable(packageRoot, manifest, descriptor.commands);
        if (executable) discovered.push({ executable, origin: 'npm-global', packageRoot });
      }
    }

    // 4. Homebrew casks and formulae. The keg is the evidence; the linked
    //    executable in <prefix>/bin is what actually runs.
    for (const prefix of brewPrefixes) {
      for (const name of descriptor.brewNames) {
        for (const kind of ['Caskroom', 'Cellar'] as const) {
          const keg = join(prefix, kind, name);
          try {
            await files.realpath(keg);
          } catch {
            continue;
          }
          for (const command of descriptor.commands) {
            discovered.push({ executable: join(prefix, 'bin', command), origin: 'brew', packageRoot: keg });
          }
        }
      }
    }

    const byRealPath = new Map<string, InstallCandidate>();
    for (const entry of discovered) {
      let realPath: string;
      try {
        realPath = await files.realpath(entry.executable);
      } catch {
        continue;
      }
      const existing = byRealPath.get(realPath);
      if (existing) {
        // Keep the first (highest-priority) discovery but retain package
        // evidence a later origin contributed for the same file.
        if (!existing.packageRoot && entry.packageRoot) existing.packageRoot = entry.packageRoot;
        continue;
      }
      const parsed = InstallCandidateSchema.safeParse({
        executable: entry.executable,
        realPath,
        origin: entry.origin,
        ...(entry.packageRoot === undefined ? {} : { packageRoot: entry.packageRoot }),
      });
      if (!parsed.success) {
        report(new Error(`discarded malformed install candidate for ${descriptor.id}: ${entry.executable}`));
        continue;
      }
      byRealPath.set(realPath, parsed.data);
    }
    return [...byRealPath.values()];
  }

  async function classify(
    provider: InventoryProvider,
    candidate: InstallCandidate,
  ): Promise<InstalledAgent | undefined> {
    let inspected: InstalledAgent | undefined;
    try {
      inspected = await provider.service.inspect(candidate);
    } catch (error) {
      report(error);
      return undefined;
    }
    if (inspected === undefined) return undefined;
    const parsed = InstalledAgentSchema.safeParse(inspected);
    if (!parsed.success) {
      report(new Error(`install inspection for ${JSON.stringify(provider.providerId)} failed schema validation`));
      return undefined;
    }
    if (parsed.data.provider !== provider.providerId) {
      report(
        new Error(
          `install inspection returned provider ${JSON.stringify(parsed.data.provider)} for ${JSON.stringify(provider.providerId)}`,
        ),
      );
      return undefined;
    }
    return parsed.data;
  }

  async function inspectProvider(provider: InventoryProvider): Promise<AgentInstallation[]> {
    const listings = await pathListings();
    const candidates = await discover(provider, listings);
    const installations: AgentInstallation[] = [];
    for (const candidate of candidates) {
      const installed = await classify(provider, candidate);
      if (!installed) continue;
      installations.push({ ...installed, origin: candidate.origin, active: false });
    }
    // The runtime launches the configured executable when it named a file, and
    // otherwise whatever the shell would resolve first on PATH.
    const chosen =
      installations.find((installation) => installation.origin === 'configured') ??
      installations.find((installation) => installation.origin === 'path');
    if (chosen) chosen.active = true;
    return installations;
  }

  function cachedInspection(provider: InventoryProvider, refresh: boolean): Promise<AgentInstallation[]> {
    if (refresh) cache.delete(provider.providerId);
    const existing = cache.get(provider.providerId);
    if (existing) return existing;
    const pending = inspectProvider(provider).catch((error: unknown) => {
      report(error);
      cache.delete(provider.providerId);
      return [] as AgentInstallation[];
    });
    cache.set(provider.providerId, pending);
    return pending;
  }

  return {
    async inspect(request = {}) {
      const selected =
        request.providerId === undefined
          ? [...providers.values()]
          : [providers.get(request.providerId)].filter((provider): provider is InventoryProvider => Boolean(provider));
      const results = await Promise.all(
        selected.map((provider) => cachedInspection(provider, request.refresh === true)),
      );
      return results.flat().map((installation) => ({ ...installation, warnings: [...installation.warnings] }));
    },

    async active(providerId, request = {}) {
      const provider = providers.get(providerId);
      if (!provider) return undefined;
      const installations = await cachedInspection(provider, request.refresh === true);
      const found = installations.find((installation) => installation.active);
      return found ? { ...found, warnings: [...found.warnings] } : undefined;
    },

    invalidate(providerId) {
      if (providerId === undefined) cache.clear();
      else cache.delete(providerId);
    },
  };
}
