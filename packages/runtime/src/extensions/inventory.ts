import {
  ExtensionFailureSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type AgentProfile,
  type AgentProviderDescriptor,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionKind,
  type ExtensionKindSupport,
  type ExtensionProvider,
  type ExtensionService,
} from '@vibefield/puppeteer-core';

/**
 * RFC 006 C1: each agent's plugins, marketplaces, MCP servers and skills, read
 * per profile through the adapter's own ExtensionService. The runtime never
 * knows where an agent keeps them. It resolves the profile, asks the adapter,
 * checks the answer against Core's schema — including that it names the
 * provider and profile asked for and holds no kind the adapter says the agent
 * lacks — and turns a throw or a malformed answer into a typed failure.
 */
export type ExtensionInventoryResult = ExtensionInventory | ExtensionFailure;

export interface ExtensionProviderEntry {
  provider: ExtensionProvider;
  service: ExtensionService;
}

/**
 * The composed extension capabilities, each checked against its agent
 * provider's descriptor. Throws on a mismatch, as the other capabilities do:
 * a wrong id or label is a composition error, not a runtime condition.
 */
export function composeExtensionProviders(
  providers: Iterable<{ readonly descriptor: AgentProviderDescriptor; readonly extensions?: ExtensionService }>,
): Map<string, ExtensionProviderEntry> {
  const entries = new Map<string, ExtensionProviderEntry>();
  for (const agent of providers) {
    if (!agent.extensions) continue;
    const provider = ExtensionProviderSchema.parse(agent.extensions.provider);
    if (provider.id !== agent.descriptor.id || provider.label !== agent.descriptor.label) {
      throw new Error(
        `extension provider ${JSON.stringify({ id: provider.id, label: provider.label })} does not match agent provider ${JSON.stringify(agent.descriptor)}`,
      );
    }
    entries.set(provider.id, { provider, service: agent.extensions });
  }
  return entries;
}

export function cloneExtensionProvider(provider: ExtensionProvider): ExtensionProvider {
  const support: ExtensionProvider['support'] = {};
  for (const key of ['plugins', 'marketplaces', 'mcpServers', 'skills'] as const) {
    const kind = provider.support[key];
    if (kind) support[key] = { ...kind };
  }
  return { id: provider.id, label: provider.label, support };
}

export interface ExtensionInventoryReaderOptions {
  providers: ReadonlyMap<string, ExtensionProviderEntry>;
  /** A registered or native-default profile of this provider, or why there is none. */
  resolveProfile(providerId: string, profileId: string): Promise<{ profile: AgentProfile } | { error: string }>;
  /** The native default's id, when the provider has a native default root. */
  nativeDefaultProfileId(providerId: string): string | undefined;
  report?(error: unknown): void;
}

export interface ExtensionInventoryReader {
  /**
   * One profile's inventory; the native default's when none is named.
   * Concurrent reads of one target coalesce — unless `fresh`, which starts a
   * read of its own (one that began before an act finished cannot show it)
   * and becomes the read later callers join.
   */
  inventory(providerId: string, profileId?: string, options?: { fresh?: boolean }): Promise<ExtensionInventoryResult>;
}

export function createExtensionInventoryReader(options: ExtensionInventoryReaderOptions): ExtensionInventoryReader {
  const inflight = new Map<string, Promise<ExtensionInventoryResult>>();
  return {
    inventory(providerId, profileId, readOptions) {
      const entry = options.providers.get(providerId);
      if (!entry)
        return Promise.resolve(
          failure('unsupported', providerId, `agent provider does not expose extensions: ${providerId}`, false),
        );
      const target = profileId ?? options.nativeDefaultProfileId(providerId);
      if (target === undefined) {
        return Promise.resolve(
          failure('unsupported', providerId, `${providerId} has no native default profile to read`, false),
        );
      }
      const key = `${providerId} ${target}`;
      const existing = inflight.get(key);
      if (existing && readOptions?.fresh !== true) return existing;
      const request: Promise<ExtensionInventoryResult> = (async (): Promise<ExtensionInventoryResult> => {
        const resolved = await options.resolveProfile(providerId, target);
        if ('error' in resolved) return failure('not-found', providerId, resolved.error, false);
        return checkInventory(entry.provider, resolved.profile, await entry.service.inventory(resolved.profile));
      })()
        .catch((error: unknown): ExtensionInventoryResult => {
          options.report?.(error);
          return failure('unavailable', providerId, `extension inventory failed for ${providerId}`, true);
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

const SUPPORT_KEY: Record<ExtensionKind, keyof ExtensionProvider['support']> = {
  plugin: 'plugins',
  marketplace: 'marketplaces',
  'mcp-server': 'mcpServers',
  skill: 'skills',
};

function checkInventory(provider: ExtensionProvider, profile: AgentProfile, result: unknown): ExtensionInventoryResult {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    const parsed = ExtensionFailureSchema.safeParse(result);
    return parsed.success
      ? { ...parsed.data, provider: provider.id }
      : failure('invalid', provider.id, `${provider.id} answered with a malformed extension failure`, false);
  }
  const parsed = ExtensionInventorySchema.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      'invalid',
      provider.id,
      `${provider.id} answered with a malformed extension inventory: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid'}`,
      false,
    );
  }
  const inventory = parsed.data;
  if (inventory.provider !== provider.id || inventory.profileId !== profile.id) {
    return failure(
      'invalid',
      provider.id,
      `${provider.id} answered for ${inventory.provider} ${inventory.profileId}, not ${profile.id}`,
      false,
    );
  }
  const support: Partial<Record<ExtensionKind, ExtensionKindSupport | undefined>> = {};
  for (const item of inventory.items) {
    const kind = (support[item.kind] ??= provider.support[SUPPORT_KEY[item.kind]]);
    if (!kind)
      return failure(
        'invalid',
        provider.id,
        `${provider.id} declares no ${item.kind} kind but its inventory holds one`,
        false,
      );
  }
  return inventory;
}

function failure(
  status: ExtensionFailure['status'],
  provider: string,
  message: string,
  retryable: boolean,
): ExtensionFailure {
  return { status, provider, message, retryable };
}
