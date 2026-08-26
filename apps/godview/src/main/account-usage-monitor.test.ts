import { describe, expect, it, vi } from 'vitest';
import type { AccountUsageFetchResult, AccountUsageProvider, AccountUsageSource } from '@vibecook/puppeteer-core';
import { createAccountUsageMonitor } from './account-usage-monitor.js';

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
