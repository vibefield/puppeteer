import { describe, expect, it } from 'vitest';
import type { AccountUsageFetchResult, AccountUsageProvider } from '@vibecook/puppeteer-core';
import type { AccountUsageEntry } from '../protocol.js';
import { accountUsageView, accountUsageViews, formatUsageReset } from './account-usage.js';

const NOW = Date.parse('2026-07-23T20:00:00.000Z');
const PROVIDER: AccountUsageProvider = {
  id: 'example-agent',
  label: 'Example Agent',
  refresh: { pollIntervalMs: 60_000 },
};

function entry(result: AccountUsageFetchResult): AccountUsageEntry {
  return { provider: PROVIDER, result };
}

describe('account usage display model', () => {
  it('renders adapter-normalized metrics in supplied order without interpreting provider ids', () => {
    const view = accountUsageView(
      entry({
        status: 'available',
        snapshot: {
          provider: PROVIDER.id,
          fetchedAt: '2026-07-23T20:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-protocol', stability: 'documented' },
          metrics: [
            {
              id: 'opaque-native-z',
              label: 'SHORT',
              description: 'Short rolling window',
              kind: 'window',
              usedPercent: 12.5,
              resetsAt: '2026-07-23T21:30:00.000Z',
            },
            {
              id: 'opaque-native-a',
              label: 'LONG',
              description: 'Long rolling window',
              kind: 'window',
              usedPercent: 34,
              resetsAt: '2026-07-26T20:00:00.000Z',
            },
            {
              id: 'opaque-budget',
              label: 'BUDGET',
              kind: 'budget',
              usedPercent: 80,
            },
          ],
        },
      }),
      NOW,
    );

    expect(view).toMatchObject({ providerId: 'example-agent', label: 'EXAMPLE AGENT', state: 'available' });
    expect(view.metrics.map(({ key, label, value, resetLabel }) => ({ key, label, value, resetLabel }))).toEqual([
      { key: 'opaque-native-z', label: 'SHORT', value: '13%', resetLabel: '1h 30m' },
      { key: 'opaque-native-a', label: 'LONG', value: '34%', resetLabel: '3d' },
      { key: 'opaque-budget', label: 'BUDGET', value: '80%', resetLabel: undefined },
    ]);
  });

  it('shows generic actionable failure states without leaking adapter messages', () => {
    const unsupported = accountUsageView(
      entry({
        status: 'unsupported',
        provider: PROVIDER.id,
        message: 'private implementation detail',
        retryable: false,
      }),
      NOW,
    );
    expect(unsupported).toMatchObject({ state: 'unsupported', statusText: 'NOT EXPOSED' });

    const unauthenticated = accountUsageView(
      entry({
        status: 'unauthenticated',
        provider: PROVIDER.id,
        message: 'private credential path',
        retryable: false,
      }),
      NOW,
    );
    expect(unauthenticated.statusText).toBe('SIGN IN REQUIRED');
    expect(JSON.stringify(unauthenticated)).not.toContain('private');

    const rateLimited = accountUsageView(
      entry({
        status: 'unavailable',
        provider: PROVIDER.id,
        message: 'private HTTP 429 body',
        retryable: true,
        code: 'rate-limited',
        retryAt: '2026-07-23T20:47:00.000Z',
      }),
      NOW,
    );
    expect(rateLimited).toMatchObject({ state: 'rate-limited', statusText: 'RATE LIMITED · 47m' });
  });

  it('keeps stale normalized metrics visible while refresh is rate-limited', () => {
    const stale = accountUsageView(
      {
        provider: PROVIDER,
        stale: true,
        result: {
          status: 'available',
          snapshot: {
            provider: PROVIDER.id,
            fetchedAt: '2026-07-23T19:55:00.000Z',
            scope: 'subscription',
            source: { kind: 'native-protocol', stability: 'documented' },
            metrics: [{ id: 'opaque', label: 'NOW', kind: 'window', usedPercent: 25 }],
          },
        },
        refreshFailure: {
          status: 'unavailable',
          provider: PROVIDER.id,
          message: 'private rate-limit detail',
          retryable: true,
          code: 'rate-limited',
          retryAt: '2026-07-23T20:47:00.000Z',
        },
      },
      NOW,
    );

    expect(stale).toMatchObject({
      state: 'rate-limited',
      badgeText: 'RATE LIMITED',
      badgeTitle: 'Retrying in 47m',
      metrics: [{ label: 'NOW', value: '25%' }],
    });
  });

  it('formats reset countdowns compactly', () => {
    expect(formatUsageReset('2026-07-23T20:00:30.000Z', NOW)).toBe('1m');
    expect(formatUsageReset('2026-07-24T21:00:00.000Z', NOW)).toBe('1d 1h');
    expect(formatUsageReset('invalid', NOW)).toBeUndefined();
  });
});

describe('per-account usage rows', () => {
  const SECOND: AccountUsageProvider = { id: 'other-agent', label: 'Other Agent', refresh: { pollIntervalMs: 60_000 } };

  const reading = (provider: AccountUsageProvider, profileId?: string, profileLabel?: string): AccountUsageEntry => ({
    provider,
    ...(profileId ? { profileId } : {}),
    ...(profileLabel ? { profileLabel } : {}),
    result: {
      status: 'available',
      snapshot: {
        provider: provider.id,
        fetchedAt: '2026-07-23T20:00:00.000Z',
        scope: 'subscription',
        source: { kind: 'native-protocol', stability: 'documented' },
        metrics: [],
        ...(profileId ? { profileId } : {}),
      },
    },
  });

  it('names the account only where a provider holds more than one', () => {
    const views = accountUsageViews(
      {
        refreshedAt: '2026-07-23T20:00:00.000Z',
        entries: [
          reading(PROVIDER, 'example-agent:native-default', 'Default'),
          reading(PROVIDER, '9a7f', 'Second seat'),
          reading(SECOND, 'other-agent:native-default', 'Default'),
        ],
      },
      NOW,
    );

    expect(views.map((view) => [view.key, view.accountLabel])).toEqual([
      ['example-agent:example-agent:native-default', 'DEFAULT'],
      ['example-agent:9a7f', 'SECOND SEAT'],
      ['other-agent:other-agent:native-default', undefined],
    ]);
  });

  it('falls back to the provider id as the row key when no account is known', () => {
    const views = accountUsageViews({ refreshedAt: '2026-07-23T20:00:00.000Z', entries: [reading(PROVIDER)] }, NOW);
    expect(views[0]?.key).toBe('example-agent');
    expect(views[0]?.accountLabel).toBeUndefined();
  });
});
