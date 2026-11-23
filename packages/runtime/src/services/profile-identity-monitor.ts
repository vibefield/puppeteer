import type { AgentProfile, ProfileFailure, ProfileIdentity } from '@vibefield/puppeteer-core';

/**
 * Keeping a sign-in's recorded identity true (RFC 006, "Identity freshness").
 *
 * A profile's identity is a reading of the agent's own status surface, stored on the profile: who is signed in, and
 * the plan and tier that account is on. The account changes without a sign-in (a plan is upgraded, a sign-in is
 * replaced in the agent's own app), so a reading taken once goes stale while the account's usage, polled beside it,
 * stays current. This monitor reads each sign-in again when its reading has aged, and whenever a host asks.
 *
 * It owns no identity and no store. A reading's age is the registry's own stamp (`identity.verifiedAt`), so a host
 * that restarts reads nothing it read a moment ago, and a sign-in another path has just verified (a login pane
 * closing) waits a whole interval from that reading.
 */

/** How long a reading is taken to hold. A plan changes rarely; a read is one short vendor process or request. */
export const PROFILE_IDENTITY_REFRESH_MS = 60 * 60_000;
// A product guard against repeated clicks, as the usage monitor's is.
const MANUAL_REFRESH_INTERVAL_MS = 30_000;
/** A read that failed and may pass is tried again after this, doubling to the interval. */
const RETRY_BASE_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;

export interface ProfileIdentityMonitorOptions {
  /**
   * The sign-ins to keep read, as the registry holds them now. The host narrows the list to what it wants asked
   * (an agent that is not installed has no status surface to ask); a retired profile is never read.
   */
  listProfiles(): Promise<readonly AgentProfile[]>;
  /** One reading, recorded where it is read: the runtime's `verifyProfile`. */
  verify(profileId: string): Promise<ProfileIdentity | ProfileFailure>;
  /** How long a reading holds before it is read again. Defaults to an hour. */
  refreshMs?: number;
  /** The longest the started monitor sleeps; it wakes sooner when a reading falls due. Defaults to `refreshMs`. */
  tickMs?: number;
  /** How many sign-ins are read at once; each read may start a vendor process. Defaults to two. */
  concurrency?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface ProfileIdentityRefreshOptions {
  /**
   * Read now whatever the reading's age, and past the wait after a failure. One sign-in is still read at most once
   * in 30 seconds.
   */
  force?: boolean;
  /** Only these sign-ins. */
  profileIds?: readonly string[];
}

/** What one refresh did: the sign-ins it read, and those of them whose read failed. */
export interface ProfileIdentityRefresh {
  read: string[];
  failed: string[];
}

export interface ProfileIdentityMonitor {
  /** Read every sign-in whose reading has aged, or (`force`) every one asked for. Reads already running are joined. */
  refresh(options?: ProfileIdentityRefreshOptions): Promise<ProfileIdentityRefresh>;
  start(): void;
  stop(): void;
}

interface ProfileState {
  /** The registry's stamp this state was last set against; a newer one is another path's reading. */
  verifiedAtMs: number;
  nextDueAtMs: number;
  consecutiveFailures: number;
  lastAttemptAtMs?: number;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function isFailure(outcome: ProfileIdentity | ProfileFailure): outcome is ProfileFailure {
  return 'status' in outcome;
}

function stampOf(profile: AgentProfile): number {
  const stamp = profile.identity ? Date.parse(profile.identity.verifiedAt) : Number.NaN;
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY;
}

export function createProfileIdentityMonitor(options: ProfileIdentityMonitorOptions): ProfileIdentityMonitor {
  const refreshMs = finitePositive(options.refreshMs ?? PROFILE_IDENTITY_REFRESH_MS, 'profile identity interval');
  const tickMs = finitePositive(options.tickMs ?? refreshMs, 'profile identity polling interval');
  const concurrency = Math.max(
    1,
    Math.floor(finitePositive(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency')),
  );
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const states = new Map<string, ProfileState>();
  let inFlight: Promise<ProfileIdentityRefresh> | undefined;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The registry could not be listed by the last run: what is due stays due, and the next wake waits. */
  let unlisted = false;

  /**
   * The registry is the authority on which sign-ins exist and when each was last read. A stamp newer than the one a
   * state was set against is a reading this monitor did not take: the wait starts again from it, and a failure that
   * stood before it is forgotten.
   */
  const reconcile = async (): Promise<string[] | undefined> => {
    let profiles: readonly AgentProfile[];
    try {
      profiles = await options.listProfiles();
    } catch (error) {
      report(error);
      unlisted = true;
      return undefined;
    }
    unlisted = false;
    const present = new Set<string>();
    for (const profile of profiles) {
      if (profile.retiredAt !== undefined) continue;
      present.add(profile.id);
      const stamp = stampOf(profile);
      const state = states.get(profile.id);
      if (state && stamp <= state.verifiedAtMs) continue;
      states.set(profile.id, {
        verifiedAtMs: stamp,
        nextDueAtMs: stamp + refreshMs,
        consecutiveFailures: 0,
        ...(state?.lastAttemptAtMs !== undefined ? { lastAttemptAtMs: state.lastAttemptAtMs } : {}),
      });
    }
    for (const id of [...states.keys()]) if (!present.has(id)) states.delete(id);
    // The registry's order, so a refresh reads in the order a person sees.
    return profiles.filter((profile) => present.has(profile.id)).map((profile) => profile.id);
  };

  const readOne = async (profileId: string): Promise<boolean> => {
    const state = states.get(profileId);
    if (!state) return true;
    let outcome: ProfileIdentity | ProfileFailure;
    try {
      outcome = await options.verify(profileId);
    } catch (error) {
      report(error);
      outcome = { status: 'unavailable', message: 'profile identity could not be read', retryable: true };
    }
    const completedAtMs = now().valueOf();
    state.lastAttemptAtMs = completedAtMs;
    if (!isFailure(outcome)) {
      const stamp = Date.parse(outcome.verifiedAt);
      state.verifiedAtMs = Number.isFinite(stamp) ? Math.max(stamp, state.verifiedAtMs) : state.verifiedAtMs;
      state.consecutiveFailures = 0;
      state.nextDueAtMs = completedAtMs + refreshMs;
      return true;
    }
    // A failure that may pass (the agent's command did not answer) is retried sooner, doubling up to the interval;
    // one that will not (the agent has no status surface) waits the interval like a reading.
    const wait = outcome.retryable
      ? Math.min(RETRY_BASE_MS * 2 ** Math.min(state.consecutiveFailures, 10), refreshMs)
      : refreshMs;
    state.consecutiveFailures += 1;
    state.nextDueAtMs = completedAtMs + wait;
    return false;
  };

  const run = async (request: ProfileIdentityRefreshOptions): Promise<ProfileIdentityRefresh> => {
    const order = await reconcile();
    const result: ProfileIdentityRefresh = { read: [], failed: [] };
    if (!order) return result;
    const startedAtMs = now().valueOf();
    const targets = request.profileIds === undefined ? undefined : new Set(request.profileIds);
    const due = order.filter((id) => {
      if (targets && !targets.has(id)) return false;
      const state = states.get(id)!;
      if (request.force !== true) return state.nextDueAtMs <= startedAtMs;
      return state.lastAttemptAtMs === undefined || startedAtMs - state.lastAttemptAtMs >= MANUAL_REFRESH_INTERVAL_MS;
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const id = due[next++];
        if (id === undefined) return;
        result.read.push(id);
        if (!(await readOne(id))) result.failed.push(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    return result;
  };

  /**
   * One run at a time. A plain refresh joins the run in flight; a forced one waits for it and runs again, since the
   * run in flight may not have covered the sign-ins it names (those it did are held by the 30-second guard).
   */
  const refresh = (request: ProfileIdentityRefreshOptions = {}): Promise<ProfileIdentityRefresh> => {
    if (inFlight) {
      const running = inFlight;
      return request.force === true ? running.then(() => refresh(request)) : running;
    }
    const current = run(request).finally(() => {
      if (inFlight === current) inFlight = undefined;
      arm();
    });
    inFlight = current;
    return current;
  };

  /** The started monitor's one timer: it wakes at the soonest due reading, and at least every tick. */
  const arm = (): void => {
    if (!started) return;
    if (timer !== undefined) clearTimeout(timer);
    let dueAtMs = Number.POSITIVE_INFINITY;
    for (const state of states.values()) dueAtMs = Math.min(dueAtMs, state.nextDueAtMs);
    const soonest = unlisted ? RETRY_BASE_MS : 0;
    timer = setTimeout(wake, Math.min(tickMs, Math.max(soonest, dueAtMs - now().valueOf())));
    timer.unref?.();
  };

  const wake = (): void => {
    timer = undefined;
    // `refresh` re-arms when its run settles; a run that rejected (a programmer error) must not end the monitor.
    void refresh().catch(report);
  };

  return {
    refresh,
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
