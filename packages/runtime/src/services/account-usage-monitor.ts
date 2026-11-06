import type {
  AccountUsageAvailable,
  AccountUsageBatch,
  AccountUsageEntry,
  AccountUsageFailure,
  AccountUsageFetchResult,
  AccountUsageMetric,
  AccountUsageProvider,
  AccountUsageSnapshot,
} from '@vibefield/puppeteer-core';

const MAX_BACKOFF_MS = 30 * 60_000;
// A product guard against repeated clicks, not a vendor's published rate limit.
const MANUAL_REFRESH_INTERVAL_MS = 30_000;

/** One registered account of one provider, as the runtime's profile registry reports it. */
export interface AccountUsageProfileRef {
  id: string;
  provider: string;
  label: string;
}

export interface AccountUsageMonitorOptions {
  providers: readonly AccountUsageProvider[];
  fetchUsage(providerId: string, profileId?: string): Promise<AccountUsageFetchResult>;
  /** Registered accounts; absent means one unkeyed reading per provider. */
  listProfiles?(): Promise<readonly AccountUsageProfileRef[]>;
  publish(batch: AccountUsageBatch): void;
  /** Uniform polling override for tests or product-wide policy. */
  refreshMs?: number;
  /** The longest the started monitor sleeps; it wakes sooner when a read falls due. Defaults to the fastest poll. */
  tickMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface AccountUsageRefreshOptions {
  /** Bypass the normal polling interval, but never a failure's backoff or Retry-After.
   * Successful readings are reused for at least 30 seconds: a poll's, or a push
   * that carries every meter the last poll did. */
  force?: boolean;
  /** Only ask these registered accounts; the returned batch still contains every row. */
  profileIds?: readonly string[];
}

export interface AccountUsageMonitor {
  snapshot(): Promise<AccountUsageBatch>;
  refresh(options?: AccountUsageRefreshOptions): Promise<AccountUsageBatch>;
  /** Apply a provider push update without decoding its native transport. A
   * push merges into its row by metric id and never brings a poll forward. */
  ingest(providerId: string, result: AccountUsageFetchResult): AccountUsageBatch;
  /** Re-read the registry; `poll: false` only reconciles rows, allowing a caller
   * to follow with a refresh of selected accounts instead of fetching every new row. */
  refreshProfiles(options?: { poll?: boolean }): Promise<AccountUsageBatch>;
  /** Discard a completed login's previous reading without fetching. Only an
   * authentication failure's local cooldown is reset; server backoff survives. */
  invalidateProfileAuthentication(profileId: string): Promise<AccountUsageBatch>;
  start(): void;
  stop(): void;
}

/** Readings are per provider AND per account; the pair is the identity of a row. */
export function accountUsageEntryKey(providerId: string, profileId?: string): string {
  return profileId === undefined ? providerId : `${providerId}\0${profileId}`;
}

function unavailable(provider: AccountUsageProvider): AccountUsageFetchResult {
  return {
    status: 'unavailable',
    provider: provider.id,
    message: `${provider.label} account usage could not be refreshed`,
    retryable: true,
  };
}

/**
 * A push is a reading of the meters it carries. Over the row's reading, each
 * meter it carries replaces the one with its id, in that reading's order; a
 * meter it does not carry stays, dated by the reading it came from when that
 * is older than the push; a meter only the push carries follows, in the
 * push's order. The rest of the snapshot is the push's, the credits too when
 * it carries them, and the account is the row's. With no reading yet, the
 * push is the reading.
 */
function mergePush(
  base: AccountUsageAvailable | undefined,
  push: AccountUsageAvailable,
  profileId: string | undefined,
): AccountUsageAvailable {
  if (!base) return push;
  const pushed = new Map(push.snapshot.metrics.map((metric) => [metric.id, metric]));
  const pushedAtMs = Date.parse(push.snapshot.fetchedAt);
  const metrics = base.snapshot.metrics.map((metric): AccountUsageMetric => {
    const fresh = pushed.get(metric.id);
    if (fresh) return fresh;
    const readAt = metric.fetchedAt ?? base.snapshot.fetchedAt;
    return Date.parse(readAt) < pushedAtMs ? { ...metric, fetchedAt: readAt } : metric;
  });
  const kept = new Set(base.snapshot.metrics.map((metric) => metric.id));
  metrics.push(...push.snapshot.metrics.filter((metric) => !kept.has(metric.id)));
  const credits = push.snapshot.credits ?? base.snapshot.credits;
  const snapshot: AccountUsageSnapshot = {
    provider: push.snapshot.provider,
    fetchedAt: push.snapshot.fetchedAt,
    scope: push.snapshot.scope,
    source: push.snapshot.source,
    metrics,
    ...(credits ? { credits } : {}),
    ...(profileId === undefined ? {} : { profileId }),
  };
  return { status: 'available', snapshot };
}

/**
 * The earliest reset a reading names strictly after `afterMs`, when its
 * windows stop describing the account. A window the provider still reports
 * as passed adds no read: the next poll is the retry.
 */
function nextResetAfter(snapshot: AccountUsageSnapshot, afterMs: number): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const metric of snapshot.metrics) {
    const resetMs = metric.resetsAt ? Date.parse(metric.resetsAt) : Number.NaN;
    if (resetMs > afterMs && resetMs < earliest) earliest = resetMs;
  }
  return earliest;
}

/** A push stands in for the last poll only when it carries every meter that poll did, and its credits if any. */
function covers(push: AccountUsageAvailable, polled: AccountUsageAvailable | undefined): boolean {
  if (!polled) return false;
  const carried = new Set(push.snapshot.metrics.map((metric) => metric.id));
  return (
    polled.snapshot.metrics.every((metric) => carried.has(metric.id)) &&
    (polled.snapshot.credits === undefined || push.snapshot.credits !== undefined)
  );
}

interface ProviderRefreshState {
  provider: AccountUsageProvider;
  profile?: AccountUsageProfileRef;
  entry?: AccountUsageEntry;
  /** The row's reading: the last poll's, with every push since merged into it. */
  lastAvailable?: AccountUsageAvailable;
  /** The last successful poll, what a push must carry all of before it may defer the next one. */
  lastPolled?: AccountUsageAvailable;
  nextRefreshAtMs: number;
  consecutiveFailures: number;
  lastCompletedAtMs?: number;
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
  let profilesInFlight: Promise<AccountUsageBatch> | undefined;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const states = new Map<string, ProviderRefreshState>(
    providers.map((provider) => [
      accountUsageEntryKey(provider.id),
      { provider, nextRefreshAtMs: Number.NEGATIVE_INFINITY, consecutiveFailures: 0 },
    ]),
  );
  const now = options.now ?? (() => new Date());

  const addState = (provider: AccountUsageProvider, profile?: AccountUsageProfileRef): ProviderRefreshState => {
    const key = accountUsageEntryKey(provider.id, profile?.id);
    const existing = states.get(key);
    if (existing) {
      if (profile) existing.profile = profile;
      return existing;
    }
    const state: ProviderRefreshState = {
      provider,
      ...(profile ? { profile } : {}),
      nextRefreshAtMs: Number.NEGATIVE_INFINITY,
      consecutiveFailures: 0,
    };
    states.set(key, state);
    return state;
  };

  /** Provider order first, then the order the registry reported each account. */
  const orderedStates = (): ProviderRefreshState[] => {
    const byProvider = new Map<string, ProviderRefreshState[]>();
    for (const state of states.values()) {
      const group = byProvider.get(state.provider.id);
      if (group) group.push(state);
      else byProvider.set(state.provider.id, [state]);
    }
    return providers.flatMap((provider) => byProvider.get(provider.id) ?? []);
  };

  const identify = (state: ProviderRefreshState): Pick<AccountUsageEntry, 'profileId' | 'profileLabel'> =>
    state.profile ? { profileId: state.profile.id, profileLabel: state.profile.label } : {};

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
    // A row is published under the registry's present name for it: a reading stored before the registry
    // answered (a push kept under its bare id) takes the account's label once the registry names it.
    const entries = orderedStates().map((state): AccountUsageEntry =>
      state.entry
        ? { ...state.entry, ...identify(state) }
        : { provider: state.provider, ...identify(state), result: unavailable(state.provider) },
    );
    const batch = publishBatch(entries, completedAt.toISOString(), options.publish, options.onError);
    latest = batch;
    arm();
    return batch;
  };

  /** A failure keeps the row's last good reading beside it (`stale`), or is the row's result when there is none. */
  const failureEntry = (state: ProviderRefreshState, result: AccountUsageFailure): AccountUsageEntry => {
    const provider = state.provider;
    return state.lastAvailable
      ? { provider, ...identify(state), result: state.lastAvailable, stale: true, refreshFailure: result }
      : { provider, ...identify(state), result };
  };

  /**
   * A poll is the whole reading: it replaces the row's, pushes merged in
   * included, and sets the poll's clock. The next read is due at the poll
   * interval, or at the reading's earliest reset when that comes first.
   */
  const applyPolled = (state: ProviderRefreshState, result: AccountUsageFetchResult, completedAtMs: number): void => {
    const provider = state.provider;
    state.lastCompletedAtMs = completedAtMs;
    if (result.status === 'available') {
      state.lastAvailable = result;
      state.lastPolled = result;
      state.entry = { provider, ...identify(state), result };
      state.consecutiveFailures = 0;
      state.nextRefreshAtMs = Math.min(
        completedAtMs + refreshMsByProvider.get(provider.id)!,
        nextResetAfter(result.snapshot, completedAtMs),
      );
      return;
    }

    state.entry = failureEntry(state, result);
    state.nextRefreshAtMs = nextRefreshAt(provider, result, state, completedAtMs);
    state.consecutiveFailures += 1;
  };

  /**
   * A push is a reading of the meters it carries: it merges into the row by
   * metric id and never moves the poll's clock (its cadence, its failure
   * backoff and Retry-After, the manual guard), save that a push carrying
   * every meter the last poll did stands in for that poll and may defer the
   * next one (by the push interval, or to the merged reading's earliest reset
   * when that comes first), never bring it forward. A failed push shows
   * beside the row's reading and moves nothing.
   */
  const applyPushed = (state: ProviderRefreshState, result: AccountUsageFetchResult, completedAtMs: number): void => {
    const provider = state.provider;
    if (result.status !== 'available') {
      state.entry = failureEntry(state, result);
      return;
    }
    const merged = mergePush(state.lastAvailable, result, state.profile?.id);
    state.lastAvailable = merged;
    state.entry = { provider, ...identify(state), result: merged };
    if (!covers(result, state.lastPolled)) return;
    state.lastCompletedAtMs = completedAtMs;
    const deferMs = provider.refresh.pushUpdatePollIntervalMs ?? refreshMsByProvider.get(provider.id)!;
    const deferredToMs = Math.min(completedAtMs + deferMs, nextResetAfter(merged.snapshot, completedAtMs));
    state.nextRefreshAtMs = Math.max(state.nextRefreshAtMs, deferredToMs);
  };

  const refresh = (requestOptions: AccountUsageRefreshOptions = {}): Promise<AccountUsageBatch> => {
    if (inFlight) {
      // A poll may only cover a different account. Recheck the manual targets
      // after it settles; accounts it just read are covered by the 30s guard.
      return requestOptions.force ? inFlight.then(() => refresh(requestOptions)) : inFlight;
    }
    const startedAtMs = now().valueOf();
    const targets = requestOptions.profileIds === undefined ? undefined : new Set(requestOptions.profileIds);
    const due = orderedStates().filter((state) => {
      if (targets && (!state.profile || !targets.has(state.profile.id))) return false;
      if (
        requestOptions.force &&
        state.consecutiveFailures === 0 &&
        state.lastCompletedAtMs !== undefined &&
        startedAtMs - state.lastCompletedAtMs < MANUAL_REFRESH_INTERVAL_MS
      )
        return false;
      if (state.nextRefreshAtMs <= startedAtMs) return true;
      return requestOptions.force === true && state.consecutiveFailures === 0;
    });
    if (due.length === 0 && latest) return Promise.resolve(latest);

    const request = Promise.all(
      due.map(async (state): Promise<[ProviderRefreshState, AccountUsageFetchResult]> => {
        try {
          return [state, await options.fetchUsage(state.provider.id, state.profile?.id)];
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          return [state, unavailable(state.provider)];
        }
      }),
    ).then((results): AccountUsageBatch => {
      const completedAt = now();
      const completedAtMs = completedAt.valueOf();
      for (const [state, result] of results) applyPolled(state, result, completedAtMs);
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

  /**
   * The started monitor's one timer: it wakes at the soonest due read, and at
   * least every tick. It is re-armed wherever a due time can move (each
   * materialized batch) and after every wake settles, because a wake that
   * finds nothing due materializes nothing. A wake during a read awaits it.
   */
  const arm = (): void => {
    if (!started) return;
    if (timer !== undefined) clearTimeout(timer);
    let dueAtMs = Number.POSITIVE_INFINITY;
    for (const state of states.values()) dueAtMs = Math.min(dueAtMs, state.nextRefreshAtMs);
    timer = setTimeout(wake, Math.min(tickMs, Math.max(0, dueAtMs - now().valueOf())));
    timer.unref?.();
  };

  const wake = (): void => {
    timer = undefined;
    void refresh().then(arm, arm);
  };

  /**
   * A push carries the account it belongs to when the provider knows one.
   * A monitor with no registry keeps one unkeyed reading per provider, so a
   * push is that row's whatever account it names. Without an account, a
   * provider tracking exactly one account is unambiguous; anything else
   * registers its own row rather than overwriting another's.
   */
  const ingestState = (provider: AccountUsageProvider, profileId: string | undefined): ProviderRefreshState => {
    const exact = states.get(accountUsageEntryKey(provider.id, profileId));
    if (exact) return exact;
    if (!options.listProfiles) return addState(provider);
    if (profileId === undefined) {
      const owned = orderedStates().filter((state) => state.provider.id === provider.id);
      if (owned.length === 1) return owned[0]!;
      return addState(provider);
    }
    return addState(provider, { id: profileId, provider: provider.id, label: profileId });
  };

  const reconcileProfiles = async (poll = true): Promise<AccountUsageBatch> => {
    let refs: readonly AccountUsageProfileRef[] = [];
    try {
      refs = (await options.listProfiles?.()) ?? [];
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return latest ?? materializeBatch(now());
    }
    const wanted = new Set<string>();
    let added = false;
    for (const provider of providers) {
      const owned = refs.filter((ref) => ref.provider === provider.id);
      if (owned.length === 0) {
        wanted.add(accountUsageEntryKey(provider.id));
        if (!states.has(accountUsageEntryKey(provider.id))) added = true;
        addState(provider);
        continue;
      }
      for (const profile of owned) {
        const key = accountUsageEntryKey(provider.id, profile.id);
        wanted.add(key);
        if (!states.has(key)) added = true;
        addState(provider, profile);
      }
    }
    let removed = false;
    for (const key of [...states.keys()]) {
      if (wanted.has(key)) continue;
      states.delete(key);
      removed = true;
    }
    if (added && poll) {
      // A refresh started before the registry answered is fetching the rows
      // this reconcile has just replaced; let it finish so the new accounts are
      // polled now rather than at the provider's next interval.
      if (inFlight) await inFlight.catch(() => undefined);
      return refresh();
    }
    if (added || removed) return materializeBatch(now());
    return latest ?? materializeBatch(now());
  };

  return {
    snapshot: () => (latest ? Promise.resolve(latest) : refresh()),
    refresh,
    refreshProfiles({ poll = true } = {}) {
      if (profilesInFlight) return profilesInFlight;
      const request = reconcileProfiles(poll);
      profilesInFlight = request;
      const release = (): void => {
        if (profilesInFlight === request) profilesInFlight = undefined;
      };
      void request.then(release, release);
      return request;
    },
    async invalidateProfileAuthentication(profileId) {
      // A reading that started before login completed must settle before its
      // old result is discarded, or it can put the account back into failure.
      while (inFlight) await inFlight;
      for (const state of states.values()) {
        if (state.profile?.id !== profileId) continue;
        const entry = state.entry;
        const failure = entry?.refreshFailure ?? (entry?.result.status !== 'available' ? entry?.result : undefined);
        const retryAt = failure?.retryAt ? Date.parse(failure.retryAt) : Number.NaN;
        // A login can switch accounts. Never retain the previous account's
        // meters, even when a server refusal still prevents another reading.
        delete state.lastAvailable;
        delete state.lastPolled;
        if (
          failure &&
          (failure.status !== 'unauthenticated' || failure.code === 'rate-limited' || retryAt > now().valueOf())
        ) {
          state.entry = {
            provider: state.provider,
            ...identify(state),
            result: failure,
          };
          continue;
        }
        delete state.entry;
        delete state.lastCompletedAtMs;
        state.consecutiveFailures = 0;
        state.nextRefreshAtMs = Number.NEGATIVE_INFINITY;
      }
      return materializeBatch(now());
    },
    ingest(providerId, result) {
      const provider = providerById.get(providerId);
      if (!provider) throw new Error(`unknown account usage provider: ${providerId}`);
      const completedAt = now();
      const profileId = result.status === 'available' ? result.snapshot.profileId : undefined;
      applyPushed(ingestState(provider, profileId), result, completedAt.valueOf());
      return materializeBatch(completedAt);
    },
    start() {
      if (started) return;
      started = true;
      wake();
    },
    stop() {
      started = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
