import { describe, expect, it, vi } from 'vitest';
import type { AccountUsageFailure, AccountUsageFetchResult, AccountUsageProvider } from '@vibefield/puppeteer-core';
import { createAccountUsageMonitor } from './account-usage-monitor.js';

const T0 = Date.parse('2026-07-23T20:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const at = (ms: number): string => new Date(ms).toISOString();

/** One agent polled every 30 minutes, so a failed poll waits 30 minutes unless its failure names a retry time. */
const PROVIDER: AccountUsageProvider = {
  id: 'press-agent',
  label: 'Press Agent',
  refresh: { pollIntervalMs: 30 * MINUTE },
};

/** Names the account, no server refusal: nothing was asked of the provider's limits. */
const SIGNED_OUT: AccountUsageFailure = {
  status: 'unauthenticated',
  provider: PROVIDER.id,
  message: 'Sign in required',
  retryable: false,
};

/** A read that failed in passing, with no retry time. */
const UNREACHABLE: AccountUsageFailure = {
  status: 'unavailable',
  provider: PROVIDER.id,
  message: 'The usage endpoint did not answer',
  retryable: true,
};

/** A server refusal by its code alone. */
const RATE_LIMITED: AccountUsageFailure = {
  status: 'unavailable',
  provider: PROVIDER.id,
  message: 'Please wait',
  retryable: true,
  code: 'rate-limited',
};

/** A server refusal by its retry time alone, ten minutes after the first poll. */
const RETRY_AFTER: AccountUsageFailure = {
  status: 'unavailable',
  provider: PROVIDER.id,
  message: 'Please wait',
  retryable: true,
  retryAt: at(T0 + 10 * MINUTE),
};

const reading = (fetchedAtMs: number): AccountUsageFetchResult => ({
  status: 'available',
  snapshot: {
    provider: PROVIDER.id,
    fetchedAt: at(fetchedAtMs),
    scope: 'subscription',
    source: { kind: 'oauth-endpoint', stability: 'experimental' },
    metrics: [],
  },
});

/** The agent alone, on a clock the test moves; a read answers with a fresh reading unless a result is queued. */
const monitorOn = () => {
  const clock = { ms: T0 };
  const fetchUsage = vi.fn(async (): Promise<AccountUsageFetchResult> => reading(clock.ms));
  const monitor = createAccountUsageMonitor({
    providers: [PROVIDER],
    fetchUsage,
    publish: () => undefined,
    now: () => new Date(clock.ms),
  });
  return { clock, fetchUsage, monitor };
};

describe('a forced refresh after a failure', () => {
  it('reads again past the wait of a failure that names no server refusal', async () => {
    for (const failure of [SIGNED_OUT, UNREACHABLE]) {
      const { clock, fetchUsage, monitor } = monitorOn();
      fetchUsage.mockResolvedValueOnce(failure);
      const failed = await monitor.refresh();
      expect(failed.entries[0]?.result).toEqual(failure);
      expect(fetchUsage).toHaveBeenCalledTimes(1);

      // The failure's own wait ends at T0 + 30 minutes; a person's Refresh a minute in reads past it.
      clock.ms = T0 + MINUTE;
      const read = await monitor.refresh({ force: true });
      expect(fetchUsage).toHaveBeenCalledTimes(2);
      expect(read.entries[0]?.result).toEqual(reading(T0 + MINUTE));
      expect(read.entries[0]?.stale).toBeUndefined();
      expect(read.entries[0]?.refreshFailure).toBeUndefined();
    }
  });

  it('reads such a row at most once inside the manual guard', async () => {
    const { clock, fetchUsage, monitor } = monitorOn();
    fetchUsage.mockResolvedValueOnce(UNREACHABLE).mockResolvedValueOnce(UNREACHABLE);
    await monitor.refresh();

    clock.ms = T0 + MINUTE;
    const again = await monitor.refresh({ force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(again.entries[0]?.result).toEqual(UNREACHABLE);

    // Ten seconds after that read the guard still holds: nothing is fetched, and the batch is the one it left.
    clock.ms = T0 + MINUTE + 10 * SECOND;
    expect(await monitor.refresh({ force: true })).toBe(again);
    expect(fetchUsage).toHaveBeenCalledTimes(2);

    clock.ms = T0 + MINUTE + 31 * SECOND;
    const read = await monitor.refresh({ force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(read.entries[0]?.result.status).toBe('available');
  });

  it('still waits out a rate limit', async () => {
    const { clock, fetchUsage, monitor } = monitorOn();
    fetchUsage.mockResolvedValueOnce(RATE_LIMITED);
    const limited = await monitor.refresh();
    expect(limited.entries[0]?.result).toEqual(RATE_LIMITED);

    clock.ms = T0 + MINUTE;
    expect(await monitor.refresh({ force: true })).toBe(limited);
    clock.ms = T0 + 29 * MINUTE;
    expect(await monitor.refresh({ force: true })).toBe(limited);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    // The wait is the failure's backoff, one poll interval; at its end the row reads again.
    clock.ms = T0 + 30 * MINUTE;
    await monitor.refresh({ force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('still waits out a Retry-After', async () => {
    const { clock, fetchUsage, monitor } = monitorOn();
    fetchUsage.mockResolvedValueOnce(RETRY_AFTER);
    const refused = await monitor.refresh();
    expect(refused.entries[0]?.result).toEqual(RETRY_AFTER);

    clock.ms = T0 + MINUTE;
    expect(await monitor.refresh({ force: true })).toBe(refused);
    clock.ms = T0 + 10 * MINUTE - SECOND;
    expect(await monitor.refresh({ force: true })).toBe(refused);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    clock.ms = T0 + 10 * MINUTE;
    const read = await monitor.refresh({ force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(read.entries[0]?.result.status).toBe('available');
  });

  it('leaves an unforced refresh waiting out every failure', async () => {
    for (const failure of [SIGNED_OUT, UNREACHABLE, RATE_LIMITED, RETRY_AFTER]) {
      const { clock, fetchUsage, monitor } = monitorOn();
      fetchUsage.mockResolvedValueOnce(failure);
      const failed = await monitor.refresh();

      clock.ms = T0 + MINUTE;
      expect(await monitor.refresh()).toBe(failed);
      expect(fetchUsage).toHaveBeenCalledTimes(1);
    }
  });
});
