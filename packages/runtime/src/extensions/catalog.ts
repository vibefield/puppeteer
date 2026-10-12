import {
  ExtensionCatalogSchema,
  ExtensionFailureSchema,
  type AgentProfile,
  type ExtensionCatalog,
  type ExtensionFailure,
  type ExtensionProvider,
} from '@vibefield/puppeteer-core';
import type { ExtensionProviderEntry } from './inventory.js';

/**
 * RFC 006 C2: what a profile's agent could install — the plugins listed by
 * the marketplaces it knows — read through the adapter's own ExtensionService
 * from the catalogs the agent already fetched. The runtime resolves the
 * profile, asks the adapter, checks the answer against Core's schema and that
 * it names the provider and profile asked for, and turns a throw or a
 * malformed answer into a typed failure. Reading never fetches a catalog:
 * that is the agent's own act, `update` on a marketplace.
 */
export type ExtensionCatalogResult = ExtensionCatalog | ExtensionFailure;

export interface ExtensionCatalogReaderOptions {
  providers: ReadonlyMap<string, ExtensionProviderEntry>;
  /** A registered or native-default profile of this provider, or why there is none. */
  resolveProfile(providerId: string, profileId: string): Promise<{ profile: AgentProfile } | { error: string }>;
  /** The native default's id, when the provider has a native default root. */
  nativeDefaultProfileId(providerId: string): string | undefined;
  report?(error: unknown): void;
}

export interface ExtensionCatalogReader {
  /**
   * One profile's catalog; the native default's when none is named.
   * Concurrent reads of one target coalesce — unless `fresh`, which starts a
   * read of its own (one that began before an act finished cannot show it).
   */
  catalog(providerId: string, profileId?: string, options?: { fresh?: boolean }): Promise<ExtensionCatalogResult>;
}

export function createExtensionCatalogReader(options: ExtensionCatalogReaderOptions): ExtensionCatalogReader {
  const inflight = new Map<string, Promise<ExtensionCatalogResult>>();
  return {
    catalog(providerId, profileId, readOptions) {
      const entry = options.providers.get(providerId);
      if (!entry) {
        return Promise.resolve(
          failure('unsupported', providerId, `agent provider does not expose extensions: ${providerId}`, false),
        );
      }
      // an agent with one catalog of its own and no marketplaces to manage (Hermes) still has a catalog
      if (entry.service.catalog === undefined) {
        return Promise.resolve(
          failure('unsupported', providerId, `${entry.provider.label} has no catalog to read`, false),
        );
      }
      const target = profileId ?? options.nativeDefaultProfileId(providerId);
      if (target === undefined) {
        return Promise.resolve(
          failure('unsupported', providerId, `${providerId} has no native default profile to read`, false),
        );
      }
      const key = `${providerId} ${target}`;
      const existing = inflight.get(key);
      if (existing && readOptions?.fresh !== true) return existing;
      const request: Promise<ExtensionCatalogResult> = (async (): Promise<ExtensionCatalogResult> => {
        const resolved = await options.resolveProfile(providerId, target);
        if ('error' in resolved) return failure('not-found', providerId, resolved.error, false);
        return checkCatalog(entry.provider, resolved.profile, await entry.service.catalog!(resolved.profile));
      })()
        .catch((error: unknown): ExtensionCatalogResult => {
          options.report?.(error);
          return failure('unavailable', providerId, `the catalog read failed for ${providerId}`, true);
        })
        .finally(() => {
          // a fresh read may have taken this key over: leave its entry alone
          if (inflight.get(key) === request) inflight.delete(key);
        });
      inflight.set(key, request);
      return request;
    },
  };
}

function checkCatalog(provider: ExtensionProvider, profile: AgentProfile, result: unknown): ExtensionCatalogResult {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    const parsed = ExtensionFailureSchema.safeParse(result);
    return parsed.success
      ? { ...parsed.data, provider: provider.id }
      : failure('invalid', provider.id, `${provider.id} answered with a malformed catalog failure`, false);
  }
  const parsed = ExtensionCatalogSchema.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      'invalid',
      provider.id,
      `${provider.id} answered with a malformed catalog: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid'}`,
      false,
    );
  }
  const catalog = parsed.data;
  if (catalog.provider !== provider.id || catalog.profileId !== profile.id) {
    return failure(
      'invalid',
      provider.id,
      `${provider.id} answered for ${catalog.provider} ${catalog.profileId}, not ${profile.id}`,
      false,
    );
  }
  return catalog;
}

function failure(
  status: ExtensionFailure['status'],
  provider: string,
  message: string,
  retryable: boolean,
): ExtensionFailure {
  return { status, provider, message, retryable };
}
