import { describe, expect, it } from 'vitest';
import type { AccountUsageFetchResult, AccountUsageProvider } from '@vibefield/puppeteer-core';
import type { AccountUsageEntry } from '@vibefield/puppeteer-core';
import { accountUsageView, accountUsageViews, formatUsageAge, formatUsageReset, usageTiles } from './account-usage.js';

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

describe('the usage column', () => {
  const at = (iso: string) => iso;
  function available(
    id: string,
    metrics: { label: string; used: number; resetsAt?: string }[],
    extra: Partial<AccountUsageEntry> = {},
  ): AccountUsageEntry {
    return {
      provider: { ...PROVIDER, id, label: id },
      result: {
        status: 'available',
        snapshot: {
          provider: id,
          fetchedAt: at('2026-07-23T19:59:48.000Z'),
          scope: 'subscription',
          source: { kind: 'native-protocol', stability: 'documented' },
          metrics: metrics.map((metric, index) => ({
            id: `${id}-${index}`,
            label: metric.label,
            kind: 'window' as const,
            usedPercent: metric.used,
            ...(metric.resetsAt ? { resetsAt: metric.resetsAt } : {}),
          })),
        },
      },
      ...extra,
    };
  }
  function failed(
    id: string,
    status: 'unauthenticated' | 'unsupported' | 'unavailable',
    code?: 'rate-limited',
  ): AccountUsageEntry {
    return {
      provider: { ...PROVIDER, id, label: id },
      result: { status, provider: id, message: 'native detail', retryable: true, ...(code ? { code } : {}) },
    };
  }

  it('places windows in fixed ring slots by kind and keeps every window for the popup', () => {
    const [tile] = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [
          available('claude', [
            { label: '5H', used: 12, resetsAt: '2026-07-23T23:31:00.000Z' },
            { label: '7D', used: 25 },
            { label: 'FABLE', used: 58 },
            { label: 'OPUS', used: 71 },
          ]),
        ],
      },
      NOW,
    );
    expect(tile?.rings.map((ring) => [ring.slot, ring.label])).toEqual([
      [0, '5H'],
      [1, '7D'],
      [2, 'OPUS'],
    ]);
    expect(tile?.windows.map((window) => window.label)).toEqual(['5H', '7D', 'FABLE', 'OPUS']);
    expect(tile?.figure).toBe('71%');
    expect(tile?.hot).toBe(false);
    expect(tile?.foot).toEqual({ lead: 'FETCHED', strong: '12s AGO', count: '4 WINDOWS' });
    expect(tile?.windows[0]?.resetLabel).toBe('3h 31m');
  });

  it('orders by pressure: rate limited, then the tightest window, then the unmeasured states', () => {
    const tiles = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [
          failed('grok', 'unsupported'),
          available('pi', []),
          available('codex', [{ label: '5H', used: 33 }]),
          failed('hermes', 'unauthenticated'),
          available('opencode', [
            { label: '5H', used: 88 },
            { label: '7D', used: 52 },
          ]),
          available('antigravity', [{ label: '5H', used: 100 }], {
            refreshFailure: {
              status: 'unavailable',
              provider: 'antigravity',
              message: 'native detail',
              retryable: true,
              code: 'rate-limited',
              retryAt: '2026-07-23T20:42:00.000Z',
            },
          }),
          failed('kimi', 'unavailable'),
        ],
      },
      NOW,
    );
    expect(tiles.map((tile) => [tile.key, tile.state, tile.figure])).toEqual([
      ['antigravity', 'rate-limited', 'RL'],
      ['opencode', 'available', '88%'],
      ['codex', 'available', '33%'],
      ['hermes', 'unauthenticated', 'SIGN IN'],
      ['grok', 'unsupported', 'N/A'],
      ['pi', 'no-data', 'NO DATA'],
      ['kimi', 'unavailable', 'RETRY'],
    ]);
    expect(tiles[0]?.hot).toBe(true);
    expect(tiles[0]?.foot).toEqual({ lead: 'RETRYING', strong: 'IN 42m', count: '1 WINDOW' });
    expect(tiles[1]?.hot).toBe(true);
    expect(tiles[1]?.rings.map((ring) => ring.hot)).toEqual([true, false]);
    expect(tiles[3]?.figureFaint).toBe(true);
    expect(tiles[3]?.note).toMatch(/Sign in/);
    expect(tiles[3]?.foot).toEqual({ lead: 'CHECKED', strong: '0s AGO' });
    expect(tiles.map((tile) => tile.aria)).not.toContainEqual(expect.stringContaining('native detail'));
  });

  it('keeps named model windows out of an absent base-account short-window ring', () => {
    const [tile] = usageTiles(
      {
        refreshedAt: '2026-07-23T20:00:00.000Z',
        entries: [
          available('codex', [
            { label: '7D', used: 96 },
            { label: 'SPARK 5H', used: 0 },
            { label: 'SPARK 7D', used: 0 },
          ]),
        ],
      },
      NOW,
    );
    expect(tile?.windows.map(({ label }) => label)).toEqual(['7D', 'SPARK 5H', 'SPARK 7D']);
    expect(tile?.rings.map(({ slot, label }) => ({ slot, label }))).toEqual([
      { slot: 1, label: '7D' },
      { slot: 2, label: 'SPARK 5H' },
    ]);
    expect(tile?.figure).toBe('96%');
  });

  it('formats fetch ages compactly', () => {
    expect(formatUsageAge('2026-07-23T19:59:50.000Z', NOW)).toBe('10s AGO');
    expect(formatUsageAge('2026-07-23T19:57:00.000Z', NOW)).toBe('3m AGO');
    expect(formatUsageAge('2026-07-23T17:00:00.000Z', NOW)).toBe('3h AGO');
    expect(formatUsageAge('2026-07-21T20:00:00.000Z', NOW)).toBe('2d AGO');
    expect(formatUsageAge(undefined, NOW)).toBeUndefined();
  });
});
