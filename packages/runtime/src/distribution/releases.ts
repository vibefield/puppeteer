import {
  DistributionFailureSchema,
  ReleaseSnapshotSchema,
  type AgentInstallation,
  type DistributionFailure,
  type DistributionProvider,
  type DistributionService,
  type ReleaseChannel,
  type ReleaseDetector,
  type ReleaseSnapshot,
} from '@vibecook/puppeteer-core';
import type { ReleaseCheckResult } from '../types.js';

/**
 * Release awareness. Adapters declare where releases are published; the
 * runtime executes those declarations and asks the agent's own update oracle
 * first when one exists.
 *
 * Network access is an explicit, user-initiated capability: nothing here
 * reaches the network unless the caller passes `network: true`. Every failure
 * is returned as a typed `DistributionFailure`; a release check never throws.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/** Unauthenticated vendor endpoints rate-limit by agent; identify the runtime honestly. */
const USER_AGENT = 'puppeteer-runtime';
const NPM_ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';
const DEFAULT_ETAG_CACHE_ENTRIES = 64;

export interface ReleaseEtagEntry {
  etag?: string;
  body: string;
}

/**
 * In-memory conditional-request cache. GitHub counts a 304 against the
 * unauthenticated hourly budget but returns no body, so the last body is kept
 * to answer a revalidated request without a second round trip.
 */
export interface ReleaseEtagCache {
  get(url: string): ReleaseEtagEntry | undefined;
  set(url: string, entry: ReleaseEtagEntry): void;
  clear(): void;
}

export function createReleaseEtagCache(maxEntries = DEFAULT_ETAG_CACHE_ENTRIES): ReleaseEtagCache {
  const entries = new Map<string, ReleaseEtagEntry>();
  return {
    get: (url) => entries.get(url),
    set(url, entry) {
      entries.delete(url);
      entries.set(url, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear: () => entries.clear(),
  };
}

/**
 * Compare two vendor version strings by their numeric segments. Vendors print
 * versions in incompatible shapes (`2.1.263`, `codex-cli 0.153.4`, `v1.0.13`,
 * `1.0.80.`), so every run of non-digits is a separator and missing trailing
 * segments read as zero.
 */
export function compareVersions(left: string, right: string): number {
  const segments = (value: string): number[] =>
    value
      .split(/[^0-9]+/u)
      .filter((part) => part.length > 0)
      .map((part) => Number.parseInt(part, 10));
  const a = segments(left);
  const b = segments(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function failure(provider: string, message: string, retryable = true): DistributionFailure {
  return { status: 'unavailable', provider, message, retryable };
}

function compileDetectorPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
}

async function fetchBody(
  url: string,
  accept: string | undefined,
  fetchImpl: typeof fetch,
  cache: ReleaseEtagCache,
): Promise<string> {
  const cached = cache.get(url);
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  if (accept) headers.accept = accept;
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 304) {
    if (!cached) throw new Error(`release endpoint answered 304 without a cached body: ${url}`);
    return cached.body;
  }
  if (!response.ok) throw new Error(`release endpoint returned ${response.status}`);
  const body = await response.text();
  const etag = response.headers.get('etag') ?? undefined;
  cache.set(url, { body, ...(etag === undefined ? {} : { etag }) });
  return body;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
  html_url?: unknown;
}

function githubReleaseVersion(
  release: GithubRelease,
  tagPattern: RegExp,
  titlePattern: RegExp | undefined,
): string | undefined {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : undefined;
  if (!tag) return undefined;
  const tagMatch = tagPattern.exec(tag);
  if (!tagMatch) return undefined;
  if (!titlePattern) return tagMatch[1]?.trim() || undefined;
  // The tag qualifies the release; the title carries the version.
  const title = typeof release.name === 'string' ? release.name : undefined;
  if (!title) return undefined;
  return titlePattern.exec(title)?.[1]?.trim() || undefined;
}

async function runDetector(
  provider: DistributionProvider,
  detector: ReleaseDetector,
  fetchImpl: typeof fetch,
  cache: ReleaseEtagCache,
  fetchedAt: string,
): Promise<ReleaseSnapshot | DistributionFailure> {
  if (detector.kind === 'text') {
    const pattern = compileDetectorPattern(detector.versionPattern);
    if (!pattern) return failure(provider.id, `release detector ${detector.id} has an invalid pattern`, false);
    const body = await fetchBody(detector.url, undefined, fetchImpl, cache);
    const version = pattern.exec(body)?.[1]?.trim();
    if (!version) return failure(provider.id, `release detector ${detector.id} matched no version`);
    return {
      provider: provider.id,
      channel: detector.channel,
      version,
      url: detector.url,
      fetchedAt,
      source: { kind: 'text', id: detector.id },
    };
  }

  if (detector.kind === 'npm-registry') {
    const url = `https://registry.npmjs.org/${detector.package}`;
    const body = await fetchBody(url, NPM_ABBREVIATED_ACCEPT, fetchImpl, cache);
    const document = JSON.parse(body) as { 'dist-tags'?: Record<string, unknown> };
    const version = document['dist-tags']?.[detector.distTag];
    if (typeof version !== 'string' || !version.trim()) {
      return failure(provider.id, `release detector ${detector.id} found no ${detector.distTag} dist-tag`);
    }
    return {
      provider: provider.id,
      channel: detector.channel,
      version: version.trim(),
      url,
      fetchedAt,
      source: { kind: 'npm-registry', id: detector.id },
    };
  }

  const tagPattern = compileDetectorPattern(detector.tagPattern);
  const titlePattern = detector.titlePattern ? compileDetectorPattern(detector.titlePattern) : undefined;
  if (!tagPattern || (detector.titlePattern && !titlePattern)) {
    return failure(provider.id, `release detector ${detector.id} has an invalid pattern`, false);
  }
  const body = await fetchBody(detector.url, 'application/vnd.github+json', fetchImpl, cache);
  const parsed: unknown = JSON.parse(body);
  const releases = Array.isArray(parsed) ? (parsed as GithubRelease[]) : [];
  let best: { version: string; release: GithubRelease } | undefined;
  for (const release of releases) {
    if (release.draft === true) continue;
    if (release.prerelease === true && !detector.prerelease) continue;
    const version = githubReleaseVersion(release, tagPattern, titlePattern);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, release };
  }
  if (!best) return failure(provider.id, `release detector ${detector.id} matched no release`);
  const publishedAt = typeof best.release.published_at === 'string' ? best.release.published_at : undefined;
  const url = typeof best.release.html_url === 'string' ? best.release.html_url : detector.url;
  return {
    provider: provider.id,
    channel: detector.channel,
    version: best.version,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    url,
    fetchedAt,
    source: { kind: 'github-release', id: detector.id },
  };
}

export interface ProviderReleaseCheckOptions {
  provider: DistributionProvider;
  service: DistributionService;
  /** The install the runtime launches; releases are compared against its version. */
  installed?: AgentInstallation;
  /** Outbound requests to declared detectors. Native oracles run regardless. */
  network: boolean;
  fetch: typeof fetch;
  cache: ReleaseEtagCache;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export async function checkProviderReleases(options: ProviderReleaseCheckOptions): Promise<ReleaseCheckResult> {
  const { provider, service, installed } = options;
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const releases: ReleaseSnapshot[] = [];
  const failures: DistributionFailure[] = [];
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  // The agent's own oracle is preferred: it knows its channel and its installer.
  if (provider.nativeUpdateCheck && installed) {
    if (!service.checkUpdate) {
      report(new Error(`distribution provider ${JSON.stringify(provider.id)} declares nativeUpdateCheck without one`));
      failures.push(failure(provider.id, 'native update check is declared but not implemented', false));
    } else {
      try {
        const { active: _active, origin: _origin, ...install } = installed;
        const outcome = await service.checkUpdate(install);
        const snapshot = ReleaseSnapshotSchema.safeParse(outcome);
        if (snapshot.success && snapshot.data.provider === provider.id) {
          releases.push(snapshot.data);
        } else {
          const declared = DistributionFailureSchema.safeParse(outcome);
          if (declared.success) failures.push(declared.data);
          else {
            report(new Error(`native update check for ${JSON.stringify(provider.id)} failed schema validation`));
            failures.push(failure(provider.id, 'native update check returned an unreadable result'));
          }
        }
      } catch (error) {
        report(error);
        failures.push(failure(provider.id, 'native update check failed'));
      }
    }
  }

  if (options.network) {
    const detected = await Promise.all(
      provider.detectors.map(async (detector) => {
        try {
          return await runDetector(provider, detector, options.fetch, options.cache, checkedAt);
        } catch (error) {
          // Network failures are ordinary. Keep the detector id, drop the cause.
          report(error);
          return failure(provider.id, `release detector ${detector.id} could not be read`);
        }
      }),
    );
    for (const outcome of detected) {
      if ('status' in outcome) failures.push(outcome);
      else releases.push(outcome);
    }
  }

  const behind: { channel: ReleaseChannel; version: string }[] = [];
  const installedVersion = installed?.version;
  if (installedVersion) {
    const newestByChannel = new Map<ReleaseChannel, string>();
    for (const release of releases) {
      const current = newestByChannel.get(release.channel);
      if (!current || compareVersions(release.version, current) > 0) {
        newestByChannel.set(release.channel, release.version);
      }
    }
    for (const [channel, version] of newestByChannel) {
      if (compareVersions(version, installedVersion) > 0) behind.push({ channel, version });
    }
  }

  return {
    provider: provider.id,
    checkedAt,
    ...(installed === undefined ? {} : { installed }),
    releases,
    behind,
    failures,
  };
}
