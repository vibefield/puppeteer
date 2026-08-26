import type {
  AccountUsageAvailable,
  AccountUsageFailure,
  AccountUsageFetchResult,
  AccountUsageProvider,
} from '@vibecook/puppeteer-core';
import type { AccountUsageBatch, AccountUsageEntry } from '../protocol.js';

const MAX_BACKOFF_MS = 30 * 60_000;

export interface AccountUsageMonitorOptions {
  providers: readonly AccountUsageProvider[];
  fetchUsage(providerId: string): Promise<AccountUsageFetchResult>;
  publish(batch: AccountUsageBatch): void;
  /** Uniform polling override for tests or product-wide policy. */
  refreshMs?: number;
  tickMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface AccountUsageMonitor {
  snapshot(): Promise<AccountUsageBatch>;
  refresh(): Promise<AccountUsageBatch>;
  /** Apply a provider push update without decoding its native transport. */
  ingest(providerId: string, result: AccountUsageFetchResult): AccountUsageBatch;
  start(): void;
  stop(): void;
}

function unavailable(provider: AccountUsageProvider): AccountUsageFetchResult {
  return {
    status: 'unavailable',
    provider: provider.id,
    message: `${provider.label} account usage could not be refreshed`,
    retryable: true,
  };
}

interface ProviderRefreshState {
  entry?: AccountUsageEntry;
  lastAvailable?: AccountUsageAvailable;
  nextRefreshAtMs: number;
  consecutiveFailures: number;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function publishBatch(
  entries: AccountUsageEntry[],
  refreshedAt: string,
  publish: (batch: AccountUsageBatch) => void,
  onError?: (error: Error) => void,
): AccountUsageBatch {
  const batch = { refreshedAt, entries };
  try {
    publish(batch);
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  return batch;
}

export function createAccountUsageMonitor(options: AccountUsageMonitorOptions): AccountUsageMonitor {
  const providers = options.providers.map((provider) => ({ ...provider, refresh: { ...provider.refresh } }));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  if (providerById.size !== providers.length) throw new Error('account usage provider ids must be unique');

  const refreshMsByProvider = new Map(
    providers.map((provider) => [
      provider.id,
      finitePositive(
        options.refreshMs ?? provider.refresh.pollIntervalMs,
        `${provider.id} account usage refresh interval`,
      ),
    ]),
  );
  const defaultTickMs = refreshMsByProvider.size > 0 ? Math.min(...refreshMsByProvider.values()) : 60_000;
  const tickMs = finitePositive(options.tickMs ?? defaultTickMs, 'account usage polling interval');

  let latest: AccountUsageBatch | undefined;
  let inFlight: Promise<AccountUsageBatch> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const states = new Map<string, ProviderRefreshState>(
    providers.map((provider) => [provider.id, { nextRefreshAtMs: Number.NEGATIVE_INFINITY, consecutiveFailures: 0 }]),
  );
  const now = options.now ?? (() => new Date());

  const nextRefreshAt = (
    provider: AccountUsageProvider,
    result: AccountUsageFailure,
    state: ProviderRefreshState,
    completedAtMs: number,
  ): number => {
    const providerRetryAt = result.retryAt ? Date.parse(result.retryAt) : Number.NaN;
    if (Number.isFinite(providerRetryAt) && providerRetryAt > completedAtMs) return providerRetryAt;
    const multiplier = result.retryable ? 2 ** Math.min(state.consecutiveFailures, 5) : 1;
    return completedAtMs + Math.min(refreshMsByProvider.get(provider.id)! * multiplier, MAX_BACKOFF_MS);
  };

  const materializeBatch = (completedAt: Date): AccountUsageBatch => {
    const entries = providers.map(
      (provider): AccountUsageEntry => states.get(provider.id)!.entry ?? { provider, result: unavailable(provider) },
    );
    const batch = publishBatch(entries, completedAt.toISOString(), options.publish, options.onError);
    latest = batch;
    return batch;
  };

  const applyResult = (
    provider: AccountUsageProvider,
    result: AccountUsageFetchResult,
    completedAtMs: number,
    pushed: boolean,
  ): void => {
    const state = states.get(provider.id)!;
    if (result.status === 'available') {
      state.lastAvailable = result;
      state.entry = { provider, result };
      state.consecutiveFailures = 0;
      const nextPollMs = pushed
        ? (provider.refresh.pushUpdatePollIntervalMs ?? refreshMsByProvider.get(provider.id)!)
        : refreshMsByProvider.get(provider.id)!;
      state.nextRefreshAtMs = completedAtMs + nextPollMs;
      return;
    }

    state.entry = state.lastAvailable
      ? { provider, result: state.lastAvailable, stale: true, refreshFailure: result }
      : { provider, result };
    state.nextRefreshAtMs = nextRefreshAt(provider, result, state, completedAtMs);
    state.consecutiveFailures += 1;
  };

  const refresh = (): Promise<AccountUsageBatch> => {
    if (inFlight) return inFlight;
    const startedAtMs = now().valueOf();
    const dueProviders = providers.filter((provider) => states.get(provider.id)!.nextRefreshAtMs <= startedAtMs);
    if (dueProviders.length === 0 && latest) return Promise.resolve(latest);

    const request = Promise.all(
      dueProviders.map(async (provider): Promise<[AccountUsageProvider, AccountUsageFetchResult]> => {
        try {
          return [provider, await options.fetchUsage(provider.id)];
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          return [provider, unavailable(provider)];
        }
      }),
    ).then((results): AccountUsageBatch => {
      const completedAt = now();
      const completedAtMs = completedAt.valueOf();
      for (const [provider, result] of results) applyResult(provider, result, completedAtMs, false);
      return materializeBatch(completedAt);
    });
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) inFlight = undefined;
      },
      () => {
        if (inFlight === request) inFlight = undefined;
      },
    );
    return request;
  };

  return {
    snapshot: () => (latest ? Promise.resolve(latest) : refresh()),
    refresh,
    ingest(providerId, result) {
      const provider = providerById.get(providerId);
      if (!provider) throw new Error(`unknown account usage provider: ${providerId}`);
      const completedAt = now();
      applyResult(provider, result, completedAt.valueOf(), true);
      return materializeBatch(completedAt);
    },
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
