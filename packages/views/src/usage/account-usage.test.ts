import { describe, expect, it } from 'vitest';
import type { AccountUsageFailure, AccountUsageFetchResult, AccountUsageProvider } from '@vibefield/puppeteer-core';
import type { AccountUsageEntry, AccountUsageMetricGroup, AccountUsageMetricKind } from '@vibefield/puppeteer-core';
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

  it('lets a refused sign-in name a kept reading, and says a failed read is retrying over its metrics', () => {
    const kept = (refreshFailure: AccountUsageFailure): AccountUsageEntry => ({
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
      refreshFailure,
    });

    const signedOut = accountUsageView(
      kept({ status: 'unauthenticated', provider: PROVIDER.id, message: 'private credential path', retryable: false }),
      NOW,
    );
    expect(signedOut).toMatchObject({ state: 'unauthenticated', statusText: 'SIGN IN REQUIRED', metrics: [] });
    expect(JSON.stringify(signedOut)).not.toContain('private');

    const retrying = accountUsageView(
      kept({ status: 'unavailable', provider: PROVIDER.id, message: 'private HTTP 503 body', retryable: true }),
      NOW,
    );
    expect(retrying).toMatchObject({
      state: 'available',
      badgeText: 'RETRYING',
      metrics: [{ label: 'NOW', value: '25%' }],
    });
    expect(JSON.stringify(retrying)).not.toContain('private');
  });

  it('keeps an untouched standby allowance out of the panel, so it never takes one of the three rows', () => {
    const reading = (reserve: number): AccountUsageEntry =>
      entry({
        status: 'available',
        snapshot: {
          provider: PROVIDER.id,
          fetchedAt: '2026-07-23T20:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-protocol', stability: 'documented' },
          metrics: [
            { id: 'plan-5h', label: '5H', kind: 'window', usedPercent: 10 },
            { id: 'plan-7d', label: '7D', kind: 'window', usedPercent: 25 },
            {
              id: 'reserve-7d',
              label: 'GPT RESERVE 7D',
              kind: 'window',
              usedPercent: reserve,
              group: { id: 'gpt-reserve', label: 'Luna Reserve', standby: true },
            },
            { id: 'spark-7d', label: 'SPARK 7D', kind: 'window', usedPercent: 5 },
          ],
        },
      });
    const labels = (reserve: number) => accountUsageView(reading(reserve), NOW).metrics.map(({ label }) => label);
    expect(labels(0)).toEqual(['5H', '7D', 'SPARK 7D']);
    expect(labels(10)).toEqual(['5H', '7D', 'GPT RESERVE 7D']);
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
    metrics: {
      label: string;
      used: number;
      resetsAt?: string;
      kind?: AccountUsageMetricKind;
      group?: AccountUsageMetricGroup;
    }[],
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
            kind: metric.kind ?? ('window' as const),
            usedPercent: metric.used,
            ...(metric.resetsAt ? { resetsAt: metric.resetsAt } : {}),
            ...(metric.group ? { group: metric.group } : {}),
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
  const RESERVE: AccountUsageMetricGroup = { id: 'gpt-reserve', label: 'Luna Reserve', standby: true };

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

  it('a kept reading under a refused sign-in is the sign-in tile, never AVAILABLE', () => {
    const signedOut = available('claude', [{ label: '5H', used: 42 }], {
      stale: true,
      refreshFailure: { status: 'unauthenticated', provider: 'claude', message: 'native detail', retryable: false },
    });
    const tiles = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [signedOut, available('codex', [{ label: '5H', used: 10 }])],
      },
      NOW,
    );
    expect(tiles.map((tile) => [tile.key, tile.state])).toEqual([
      ['codex', 'available'],
      ['claude', 'unauthenticated'],
    ]);
    const tile = tiles[1];
    expect(tile).toMatchObject({
      state: 'unauthenticated',
      hot: false,
      rings: [],
      windows: [],
      figure: 'SIGN IN',
      figureFaint: true,
      stateText: 'SIGN IN REQUIRED',
      foot: { lead: 'CHECKED', strong: '0s AGO' },
      aria: 'CLAUDE, sign in required',
    });
    expect(tile?.note).toMatch(/Sign in/);
    expect(JSON.stringify(tile)).not.toContain('native detail');
  });

  it('a kept reading under a failed read keeps its numbers and says it is retrying', () => {
    const retrying = available('claude', [{ label: '5H', used: 42 }], {
      stale: true,
      refreshFailure: { status: 'unavailable', provider: 'claude', message: 'native detail', retryable: true },
    });
    const tiles = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [available('codex', [{ label: '5H', used: 10 }]), retrying],
      },
      NOW,
    );
    expect(tiles.map((tile) => tile.key)).toEqual(['claude', 'codex']);
    const tile = tiles[0];
    expect(tile).toMatchObject({
      state: 'available',
      hot: false,
      figure: '42%',
      figureFaint: false,
      stateText: 'RETRYING',
      foot: { lead: 'FETCHED', strong: '12s AGO', count: '1 WINDOW' },
      aria: 'CLAUDE, 5H 42%, retrying',
    });
    expect(tile?.rings.map(({ label }) => label)).toEqual(['5H']);
    expect(JSON.stringify(tile)).not.toContain('native detail');
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

  it('a window past its reset is kept: never hot, never the figure, no pressure', () => {
    const tiles = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [
          available('claude', [
            { label: '5H', used: 100, resetsAt: '2026-07-23T19:59:00.000Z' },
            { label: '7D', used: 40, resetsAt: '2026-07-26T20:00:00.000Z' },
          ]),
          available('codex', [{ label: '5H', used: 60, resetsAt: '2026-07-23T22:00:00.000Z' }]),
          available('kimi', [{ label: '5H', used: 95, resetsAt: '2026-07-23T20:00:00.000Z' }]),
        ],
      },
      NOW,
    );
    expect(tiles.map((tile) => [tile.key, tile.figure, tile.hot])).toEqual([
      ['codex', '60%', false],
      ['claude', '40%', false],
      ['kimi', '—', false],
    ]);
    const claude = tiles[1]!;
    expect(claude.windows).toMatchObject([
      { label: '5H', kept: true, hot: false, resetLabel: 'NOW' },
      { label: '7D', kept: false, hot: false },
    ]);
    expect(claude.rings).toMatchObject([
      { slot: 0, kept: true },
      { slot: 1, kept: false },
    ]);
    expect(claude.aria).toBe('CLAUDE, 5H reset, 7D 40%');
    expect(tiles[2]?.aria).toBe('KIMI, 5H reset');
  });

  it('rings a window still current over a fuller one past its reset in the same slot', () => {
    const [tile] = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [
          available('claude', [
            { label: 'OPUS', used: 90, resetsAt: '2026-07-23T19:00:00.000Z' },
            { label: 'FABLE', used: 30, resetsAt: '2026-07-24T20:00:00.000Z' },
          ]),
        ],
      },
      NOW,
    );
    expect(tile?.rings).toMatchObject([{ slot: 2, label: 'FABLE', kept: false }]);
    expect(tile?.figure).toBe('30%');
  });

  it('keeps an untouched standby allowance out of sight until it is in play', () => {
    const codex = (plan: number, reserve: number) =>
      usageTiles(
        {
          refreshedAt: at('2026-07-23T20:00:00.000Z'),
          entries: [
            available('codex', [
              { label: '7D', used: plan },
              { label: 'GPT RESERVE 7D', used: reserve, group: RESERVE },
            ]),
          ],
        },
        NOW,
      )[0];

    const untouched = codex(25, 0);
    expect(untouched?.rings.map(({ label }) => label)).toEqual(['7D']);
    expect(untouched?.windows.map(({ label }) => label)).toEqual(['7D']);
    expect(untouched?.foot.count).toBe('1 WINDOW');
    expect(untouched?.aria).toBe('CODEX, 7D 25%');

    const used = codex(25, 10);
    expect(used?.rings.map(({ slot, label }) => [slot, label])).toEqual([
      [1, '7D'],
      [2, 'GPT RESERVE 7D'],
    ]);
    expect(used?.windows.map(({ label }) => label)).toEqual(['7D', 'GPT RESERVE 7D']);
    expect(used?.foot.count).toBe('2 WINDOWS');

    const spent = codex(100, 0);
    expect(spent?.rings.map(({ slot, label }) => [slot, label])).toEqual([
      [1, '7D'],
      [2, 'GPT RESERVE 7D'],
    ]);
    expect(spent?.windows.map(({ label }) => label)).toEqual(['7D', 'GPT RESERVE 7D']);
  });

  it('keeps an untouched standby allowance out of sight beside a spent budget, which is no window of the plan', () => {
    const [tile] = usageTiles(
      {
        refreshedAt: at('2026-07-23T20:00:00.000Z'),
        entries: [
          available('codex', [
            { label: '7D', used: 25 },
            { label: 'CREDIT', used: 100, kind: 'budget' },
            { label: 'GPT RESERVE 7D', used: 0, group: RESERVE },
          ]),
        ],
      },
      NOW,
    );
    expect(tile?.windows.map(({ label }) => label)).toEqual(['7D', 'CREDIT']);
    expect(tile?.foot.count).toBe('2 WINDOWS');
  });

  it('formats fetch ages compactly', () => {
    expect(formatUsageAge('2026-07-23T19:59:50.000Z', NOW)).toBe('10s AGO');
    expect(formatUsageAge('2026-07-23T19:57:00.000Z', NOW)).toBe('3m AGO');
    expect(formatUsageAge('2026-07-23T17:00:00.000Z', NOW)).toBe('3h AGO');
    expect(formatUsageAge('2026-07-21T20:00:00.000Z', NOW)).toBe('2d AGO');
    expect(formatUsageAge(undefined, NOW)).toBeUndefined();
  });
});
