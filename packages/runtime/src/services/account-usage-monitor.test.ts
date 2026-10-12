import { describe, expect, it, vi } from 'vitest';
import type { AccountUsageFetchResult, AccountUsageProvider, AccountUsageSource } from '@vibefield/puppeteer-core';
import {
  accountUsageEntryKey,
  createAccountUsageMonitor,
  type AccountUsageProfileRef,
} from './account-usage-monitor.js';

const PROVIDERS: readonly AccountUsageProvider[] = [
  {
    id: 'push-agent',
    label: 'Push Agent',
    refresh: { pollIntervalMs: 30 * 60_000, pushUpdatePollIntervalMs: 30 * 60_000 },
  },
  { id: 'fast-agent', label: 'Fast Agent', refresh: { pollIntervalMs: 60_000 } },
  { id: 'slow-agent', label: 'Slow Agent', refresh: { pollIntervalMs: 15 * 60_000 } },
];

const available = (
  provider: string,
  source: AccountUsageSource = { kind: 'native-protocol', stability: 'documented' },
): AccountUsageFetchResult => ({
  status: 'available',
  snapshot: {
    provider,
    fetchedAt: '2026-07-23T20:00:00.000Z',
    scope: 'subscription',
    source,
    metrics: [],
  },
});

describe('createAccountUsageMonitor', () => {
  it('coalesces refreshes and preserves runtime provider order', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchUsage = vi.fn(async (providerId: string) => {
      await gate;
      return available(providerId);
    });
    const publish = vi.fn();
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage,
      publish,
      now: () => new Date('2026-07-23T20:01:00.000Z'),
    });

    const first = monitor.refresh();
    const second = monitor.refresh();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(3));
    release?.();

    const batch = await first;
    expect(batch.refreshedAt).toBe('2026-07-23T20:01:00.000Z');
    expect(batch.entries.map((entry) => entry.provider.id)).toEqual(PROVIDERS.map((provider) => provider.id));
    expect(publish).toHaveBeenCalledOnce();
    await expect(monitor.snapshot()).resolves.toBe(batch);
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('keeps a complete batch when one provider rejects', async () => {
    const onError = vi.fn();
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage: async (providerId) => {
        if (providerId === 'fast-agent') throw new Error('private native detail');
        return available(providerId);
      },
      publish: () => undefined,
      onError,
    });

    const batch = await monitor.refresh();
    expect(batch.entries).toHaveLength(3);
    expect(batch.entries.find((entry) => entry.provider.id === 'fast-agent')?.result).toEqual({
      status: 'unavailable',
      provider: 'fast-agent',
      message: 'Fast Agent account usage could not be refreshed',
      retryable: true,
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('polls every provider at a uniform product override and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const fetchUsage = vi.fn(async (providerId: string) => available(providerId));
      const publish = vi.fn();
      const monitor = createAccountUsageMonitor({ providers: PROVIDERS, fetchUsage, publish, refreshMs: 1_000 });

      monitor.start();
      await monitor.snapshot();
      expect(fetchUsage).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchUsage).toHaveBeenCalledTimes(6);
      expect(publish).toHaveBeenCalledTimes(2);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchUsage).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the last good snapshot and honors a provider Retry-After', async () => {
    let nowMs = Date.parse('2026-07-23T20:00:00.000Z');
    let pushAgentCalls = 0;
    const fetchUsage = vi.fn(async (providerId: string): Promise<AccountUsageFetchResult> => {
      if (providerId !== 'push-agent' || pushAgentCalls++ === 0) return available(providerId);
      return {
        status: 'unavailable',
        provider: providerId,
        message: 'private provider HTTP 429 response',
        retryable: true,
        code: 'rate-limited',
        retryAt: '2026-07-23T20:10:00.000Z',
      };
    });
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage,
      publish: () => undefined,
      refreshMs: 1_000,
      now: () => new Date(nowMs),
    });

    await monitor.refresh();
    nowMs += 1_000;
    const rateLimited = await monitor.refresh();
    expect(rateLimited.entries.find((entry) => entry.provider.id === 'push-agent')).toMatchObject({
      stale: true,
      result: { status: 'available' },
      refreshFailure: { status: 'unavailable', retryAt: '2026-07-23T20:10:00.000Z' },
    });

    fetchUsage.mockClear();
    nowMs += 1_000;
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([providerId]) => providerId)).toEqual(['fast-agent', 'slow-agent']);

    fetchUsage.mockClear();
    nowMs = Date.parse('2026-07-23T20:10:00.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([providerId]) => providerId)).toEqual(['push-agent', 'fast-agent', 'slow-agent']);
  });

  it('uses the adapter-declared push deferral without inspecting source kind', async () => {
    let nowMs = Date.parse('2026-07-23T20:00:00.000Z');
    const fetchUsage = vi.fn(async (providerId: string) => available(providerId));
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage,
      publish: () => undefined,
      refreshMs: 1_000,
      now: () => new Date(nowMs),
    });

    await monitor.refresh();
    fetchUsage.mockClear();
    monitor.ingest('push-agent', available('push-agent'));

    nowMs = Date.parse('2026-07-23T20:10:00.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([providerId]) => providerId)).toEqual(['fast-agent', 'slow-agent']);

    fetchUsage.mockClear();
    nowMs = Date.parse('2026-07-23T20:30:00.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([providerId]) => providerId)).toEqual(['push-agent', 'fast-agent', 'slow-agent']);
  });
});

describe('per-account readings', () => {
  const PROFILES: readonly AccountUsageProfileRef[] = [
    { id: 'push-agent:native-default', provider: 'push-agent', label: 'Default' },
    { id: 'e2f0a1b2', provider: 'push-agent', label: 'Second seat' },
    { id: 'fast-agent:native-default', provider: 'fast-agent', label: 'Default' },
  ];

  const availableFor = (providerId: string, profileId?: string): AccountUsageFetchResult => {
    const base = available(providerId);
    if (base.status !== 'available' || !profileId) return base;
    return { ...base, snapshot: { ...base.snapshot, profileId } };
  };

  it('polls every registered account of a provider and keys entries by the pair', async () => {
    const fetchUsage = vi.fn(async (providerId: string, profileId?: string) => availableFor(providerId, profileId));
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage,
      listProfiles: () => Promise.resolve(PROFILES),
      publish: () => undefined,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });

    const batch = await monitor.refreshProfiles();
    expect(fetchUsage.mock.calls).toEqual([
      ['push-agent', 'push-agent:native-default'],
      ['push-agent', 'e2f0a1b2'],
      ['fast-agent', 'fast-agent:native-default'],
      ['slow-agent', undefined],
    ]);
    expect(batch.entries.map((entry) => [entry.provider.id, entry.profileId, entry.profileLabel])).toEqual([
      ['push-agent', 'push-agent:native-default', 'Default'],
      ['push-agent', 'e2f0a1b2', 'Second seat'],
      ['fast-agent', 'fast-agent:native-default', 'Default'],
      ['slow-agent', undefined, undefined],
    ]);
    expect(accountUsageEntryKey('push-agent', 'e2f0a1b2')).not.toBe(accountUsageEntryKey('push-agent'));
  });

  it('routes a push update to the account its snapshot names', async () => {
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage: async (providerId: string, profileId?: string) => availableFor(providerId, profileId),
      listProfiles: () => Promise.resolve(PROFILES),
      publish: () => undefined,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });
    await monitor.refreshProfiles();

    const pushed = monitor.ingest('push-agent', {
      status: 'unauthenticated',
      provider: 'push-agent',
      message: 'sign in required',
      retryable: false,
    });
    // Without a profile in the payload an ambiguous provider keeps its rows and
    // gains one unkeyed row rather than overwriting a registered account.
    expect(pushed.entries.filter((entry) => entry.provider.id === 'push-agent')).toHaveLength(3);

    const targeted = monitor.ingest('push-agent', availableFor('push-agent', 'e2f0a1b2'));
    const second = targeted.entries.find((entry) => entry.profileId === 'e2f0a1b2');
    expect(second?.profileLabel).toBe('Second seat');
    expect(second?.result.status).toBe('available');
  });

  it('drops rows for accounts the registry no longer reports', async () => {
    let profiles = PROFILES;
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage: async (providerId: string, profileId?: string) => availableFor(providerId, profileId),
      listProfiles: () => Promise.resolve(profiles),
      publish: () => undefined,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });
    await monitor.refreshProfiles();

    profiles = PROFILES.filter((profile) => profile.id !== 'e2f0a1b2');
    const batch = await monitor.refreshProfiles();
    expect(batch.entries.map((entry) => entry.profileId)).toEqual([
      'push-agent:native-default',
      'fast-agent:native-default',
      undefined,
    ]);
  });

  it('keeps one unkeyed reading per provider when no registry is injected', async () => {
    const fetchUsage = vi.fn(async (providerId: string, _profileId?: string) => available(providerId));
    const monitor = createAccountUsageMonitor({
      providers: PROVIDERS,
      fetchUsage,
      publish: () => undefined,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });

    const batch = await monitor.refresh();
    expect(batch.entries.map((entry) => entry.profileId)).toEqual([undefined, undefined, undefined]);
    expect(fetchUsage.mock.calls.map(([providerId, profileId]) => [providerId, profileId])).toEqual([
      ['push-agent', undefined],
      ['fast-agent', undefined],
      ['slow-agent', undefined],
    ]);
  });
});

describe('startup ordering', () => {
  it('polls newly registered accounts once the first unkeyed refresh has finished', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = false;
    const fetchUsage = vi.fn(async (providerId: string, profileId?: string) => {
      if (!opened) await gate;
      return available(providerId);
    });
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: () =>
        Promise.resolve([{ id: 'push-agent:native-default', provider: 'push-agent', label: 'Default' }]),
      publish: () => undefined,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });

    monitor.start();
    const reconciled = monitor.refreshProfiles();
    opened = true;
    release?.();
    const batch = await reconciled;
    monitor.stop();

    expect(fetchUsage.mock.calls.map(([, profileId]) => profileId)).toEqual([undefined, 'push-agent:native-default']);
    expect(batch.entries.map((entry) => entry.profileId)).toEqual(['push-agent:native-default']);
  });
});

describe('account usage after sign-in', () => {
  const PROFILES: AccountUsageProfileRef[] = [
    { id: 'personal', provider: 'push-agent', label: 'Personal' },
    { id: 'work', provider: 'push-agent', label: 'Work' },
  ];
  const signedOut: AccountUsageFetchResult = {
    provider: 'push-agent',
    status: 'unauthenticated',
    retryable: false,
    message: 'Sign in required',
  };

  it('drops a pre-login failure only for the signed-in account and makes it due immediately', async () => {
    const fetchUsage = vi.fn(async (): Promise<AccountUsageFetchResult> => signedOut);
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => PROFILES,
      publish: () => undefined,
      now: () => new Date(0),
    });
    await monitor.refreshProfiles();
    await monitor.refresh({ force: true, profileIds: ['work'] });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    const invalidated = await monitor.invalidateProfileAuthentication('work');
    expect(fetchUsage).toHaveBeenCalledTimes(2); // invalidating is not a network request
    expect(invalidated.entries.map((entry) => entry.result.status)).toEqual(['unauthenticated', 'unavailable']);
    fetchUsage.mockResolvedValue(available('push-agent'));
    const recovered = await monitor.refresh({ profileIds: ['work'] });
    expect(fetchUsage.mock.calls.slice(2)).toEqual([['push-agent', 'work']]);
    expect(recovered.entries.map((entry) => entry.result.status)).toEqual(['unauthenticated', 'available']);
  });

  it('waits for a pre-login reading so it cannot restore the old authentication failure', async () => {
    let release!: (result: AccountUsageFetchResult) => void;
    const fetchUsage = vi.fn(
      () =>
        new Promise<AccountUsageFetchResult>((resolve) => {
          release = resolve;
        }),
    );
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => [PROFILES[1]!],
      publish: () => undefined,
      now: () => new Date(0),
    });
    await monitor.refreshProfiles({ poll: false });
    const reading = monitor.refresh();
    const signedIn = monitor.invalidateProfileAuthentication('work');
    release(signedOut);
    await reading;
    await signedIn;
    fetchUsage.mockResolvedValue(available('push-agent'));
    expect((await monitor.refresh({ profileIds: ['work'] })).entries[0]?.result.status).toBe('available');
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      status: 'unavailable' as const,
      code: 'rate-limited' as const,
      retryable: true,
    },
    { status: 'unavailable' as const, retryable: true },
    {
      status: 'unauthenticated' as const,
      retryable: false,
      retryAt: new Date(60_000).toISOString(),
    },
  ])('keeps server backoff after sign-in and drops old account metrics: %j', async (refusal) => {
    let nowMs = 0;
    const fetchUsage = vi.fn(async (): Promise<AccountUsageFetchResult> => available('push-agent'));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => [PROFILES[1]!],
      publish: () => undefined,
      now: () => new Date(nowMs),
    });
    await monitor.refreshProfiles();
    nowMs = 30_000;
    fetchUsage.mockResolvedValueOnce({
      provider: 'push-agent',
      message: 'Please wait',
      ...refusal,
    });
    const failed = await monitor.refresh({ force: true });
    expect(failed.entries[0]?.stale).toBe(true);
    const invalidated = await monitor.invalidateProfileAuthentication('work');
    expect(invalidated.entries[0]?.result.status).toBe(refusal.status);
    expect(invalidated.entries[0]?.stale).toBeUndefined();
    await monitor.refresh({ force: true, profileIds: ['work'] });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    nowMs = 'retryAt' in refusal ? 60_000 : 30_000 + 30 * 60_000;
    expect((await monitor.refresh()).entries[0]?.result.status).toBe('available');
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('discards a recent successful reading when login may have switched accounts', async () => {
    const fetchUsage = vi.fn(async (): Promise<AccountUsageFetchResult> => available('push-agent'));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => [PROFILES[1]!],
      publish: () => undefined,
      now: () => new Date(0),
    });
    await monitor.refreshProfiles();
    expect((await monitor.invalidateProfileAuthentication('work')).entries[0]?.result.status).toBe('unavailable');
    await monitor.refresh({ profileIds: ['work'] });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });
});

describe('manual account usage refresh', () => {
  const PROFILES: AccountUsageProfileRef[] = [
    { id: 'one', provider: 'push-agent', label: 'One' },
    { id: 'two', provider: 'push-agent', label: 'Two' },
  ];

  it('reconciles without fetching, targets one account, and reuses recent readings', async () => {
    let nowMs = 0;
    const fetchUsage = vi.fn(async (id: string) => available(id));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => PROFILES,
      publish: () => undefined,
      now: () => new Date(nowMs),
    });
    await monitor.refreshProfiles({ poll: false });
    expect(fetchUsage).not.toHaveBeenCalled();
    await monitor.refresh();
    fetchUsage.mockClear();
    nowMs = 30_000;
    await monitor.refresh();
    expect(fetchUsage).not.toHaveBeenCalled();
    const batch = await monitor.refresh({ force: true, profileIds: ['one'] });
    expect(fetchUsage.mock.calls).toEqual([['push-agent', 'one']]);
    expect(batch.entries.map((entry) => entry.profileId)).toEqual(['one', 'two']);
    await monitor.refresh({ force: true, profileIds: ['one'] });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await monitor.refresh({ force: true, profileIds: [] });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    nowMs += 30_000;
    await monitor.refresh({ force: true, profileIds: ['one'] });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, new Date(120_000).toISOString()])('honors failure backoff and retryAt (%s)', async (retryAt) => {
    let nowMs = 0;
    const fetchUsage = vi.fn(async (): Promise<AccountUsageFetchResult> => available('fast-agent'));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[1]!],
      fetchUsage,
      publish: () => undefined,
      now: () => new Date(nowMs),
    });
    await monitor.refresh();
    nowMs = 30_000;
    fetchUsage.mockResolvedValueOnce({
      provider: 'fast-agent',
      status: 'unavailable',
      code: 'rate-limited',
      retryable: true,
      message: 'Please wait',
      ...(retryAt ? { retryAt } : {}),
    });
    const stale = await monitor.refresh({ force: true });
    expect(stale.entries[0]).toMatchObject({ stale: true, refreshFailure: { code: 'rate-limited' } });
    nowMs = 60_000;
    expect(await monitor.refresh({ force: true })).toBe(stale);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    nowMs = retryAt ? 120_000 : 90_000;
    expect((await monitor.refresh({ force: true })).entries[0]?.stale).toBeUndefined();
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent manual requests and preserves targets behind an unrelated poll', async () => {
    let nowMs = 0;
    let release: (() => void) | undefined;
    const fetchUsage = vi.fn(async (id: string, _profileId?: string) => available(id));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      listProfiles: async () => PROFILES,
      publish: () => undefined,
      now: () => new Date(nowMs),
    });
    await monitor.refreshProfiles();
    nowMs = 30_000;
    fetchUsage.mockClear();
    fetchUsage.mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return available(id);
    });
    const first = monitor.refresh({ force: true, profileIds: ['one'] });
    const duplicate = monitor.refresh({ force: true, profileIds: ['one'] });
    const other = monitor.refresh({ force: true, profileIds: ['two'] });
    release?.();
    await Promise.all([first, duplicate, other]);
    expect(fetchUsage.mock.calls).toEqual([
      ['push-agent', 'one'],
      ['push-agent', 'two'],
    ]);
  });

  it('does not replace a recent push with another network reading', async () => {
    let nowMs = 0;
    const fetchUsage = vi.fn(async (id: string) => available(id));
    const monitor = createAccountUsageMonitor({
      providers: [PROVIDERS[0]!],
      fetchUsage,
      publish: () => undefined,
      now: () => new Date(nowMs),
    });
    await monitor.refresh();
    nowMs = 60_000;
    monitor.ingest('push-agent', available('push-agent', { kind: 'native-statusline', stability: 'documented' }));
    await monitor.refresh({ force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });
});

it('manual clicks respect the 30s guard even with a shorter product polling override', async () => {
  let nowMs = 0;
  const fetchUsage = vi.fn(async (id: string) => available(id));
  const monitor = createAccountUsageMonitor({
    providers: [PROVIDERS[1]!],
    fetchUsage,
    publish: () => undefined,
    refreshMs: 1_000,
    now: () => new Date(nowMs),
  });
  await monitor.refresh({ force: true });
  nowMs = 1_000;
  await monitor.refresh({ force: true });
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  // The automatic cadence remains independent of the manual-click guard.
  await monitor.refresh();
  expect(fetchUsage).toHaveBeenCalledTimes(2);
});
