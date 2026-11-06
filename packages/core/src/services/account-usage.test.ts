import { describe, expect, it } from 'vitest';
import {
  accountUsageMetricInPlay,
  AccountUsageFetchResultSchema,
  AccountUsageProviderSchema,
  AccountUsageSnapshotSchema,
  type AccountUsageMetric,
  type AccountUsageMetricGroup,
} from './account-usage.js';

describe('account usage contracts', () => {
  it('accepts an ordered provider-neutral metric snapshot', () => {
    expect(
      AccountUsageSnapshotSchema.parse({
        provider: 'example',
        fetchedAt: '2026-08-26T12:00:00.000Z',
        scope: 'subscription',
        source: { kind: 'native-protocol', stability: 'documented' },
        metrics: [
          {
            id: 'primary-window',
            label: '5H',
            description: '5-hour usage',
            kind: 'window',
            usedPercent: 12.5,
            durationMinutes: 300,
            resetsAt: '2026-08-26T17:00:00.000Z',
          },
        ],
      }).metrics[0],
    ).toMatchObject({ label: '5H', usedPercent: 12.5 });
  });

  it('names the part of a plan a meter measures, and marks an allowance held in standby', () => {
    const snapshot = AccountUsageSnapshotSchema.parse({
      provider: 'example',
      fetchedAt: '2026-08-26T12:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'documented' },
      metrics: [
        { id: 'plan', label: '7D', kind: 'window', usedPercent: 25, durationMinutes: 10_080 },
        {
          id: 'reserve',
          label: 'RESERVE 7D',
          kind: 'window',
          usedPercent: 0,
          durationMinutes: 10_080,
          group: { id: 'reserve', label: 'Luna Reserve', standby: true },
        },
      ],
    });
    expect(snapshot.metrics[0]!.group).toBeUndefined();
    expect(snapshot.metrics[1]!.group).toEqual({ id: 'reserve', label: 'Luna Reserve', standby: true });
    // standby is a mark, not a switch: only `true` is written
    const falseStandby = {
      ...snapshot,
      metrics: [{ ...snapshot.metrics[1]!, group: { id: 'reserve', label: 'Luna Reserve', standby: false } }],
    };
    expect(AccountUsageSnapshotSchema.safeParse(falseStandby).success).toBe(false);
  });

  it('dates a meter a later, partial reading did not carry by when it was read', () => {
    const snapshot = AccountUsageSnapshotSchema.parse({
      provider: 'example',
      fetchedAt: '2026-08-26T12:01:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-statusline', stability: 'documented' },
      metrics: [
        { id: 'session', label: '5H', kind: 'window', usedPercent: 15 },
        { id: 'scoped', label: 'SONNET 7D', kind: 'window', usedPercent: 50, fetchedAt: '2026-08-26T12:00:00.000Z' },
      ],
    });
    expect(snapshot.metrics[0]!.fetchedAt).toBeUndefined();
    expect(snapshot.metrics[1]!.fetchedAt).toBe('2026-08-26T12:00:00.000Z');
    const misdated = { ...snapshot, metrics: [{ ...snapshot.metrics[1]!, fetchedAt: 'earlier' }] };
    expect(AccountUsageSnapshotSchema.safeParse(misdated).success).toBe(false);
  });

  it('rejects malformed timestamps and duplicate metric ids at the boundary', () => {
    const base = {
      provider: 'example',
      fetchedAt: 'not-a-timestamp',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'documented' },
      metrics: [
        { id: 'same', label: '5H', kind: 'window', usedPercent: 10 },
        { id: 'same', label: '7D', kind: 'window', usedPercent: 20 },
      ],
    };
    expect(AccountUsageSnapshotSchema.safeParse(base).success).toBe(false);
    expect(AccountUsageSnapshotSchema.safeParse({ ...base, fetchedAt: '2026-08-26T12:00:00.000Z' }).success).toBe(
      false,
    );
  });

  it('validates failures and adapter refresh descriptors', () => {
    expect(
      AccountUsageFetchResultSchema.safeParse({
        status: 'unavailable',
        provider: 'example',
        message: 'temporarily unavailable',
        retryable: true,
        code: 'rate-limited',
        retryAt: '2026-08-26T12:05:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      AccountUsageProviderSchema.safeParse({
        id: 'example',
        label: 'Example',
        refresh: { pollIntervalMs: 60_000, pushUpdatePollIntervalMs: 300_000 },
      }).success,
    ).toBe(true);
    expect(
      AccountUsageProviderSchema.safeParse({
        id: 'example',
        label: 'Example',
        refresh: { pollIntervalMs: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('accountUsageMetricInPlay', () => {
  const RESERVE: AccountUsageMetricGroup = { id: 'gpt-reserve', label: 'Luna Reserve', standby: true };
  const SPARK: AccountUsageMetricGroup = { id: 'spark', label: 'Spark' };
  const meter = (label: string, usedPercent: number, group?: AccountUsageMetricGroup): AccountUsageMetric => ({
    id: label,
    label,
    kind: 'window',
    usedPercent,
    ...(group ? { group } : {}),
  });

  it('keeps an untouched standby allowance out of play while the plan has room', () => {
    const untouched = meter('GPT RESERVE 7D', 0, RESERVE);
    expect(accountUsageMetricInPlay(untouched, [meter('7D', 25), untouched])).toBe(false);
  });

  it('brings a standby allowance into play once any meter of its group is used', () => {
    const used = meter('GPT RESERVE 7D', 3, RESERVE);
    expect(accountUsageMetricInPlay(used, [meter('7D', 25), used])).toBe(true);
    const untouched = meter('GPT RESERVE 7D', 0, RESERVE);
    const reading = [meter('7D', 25), meter('GPT RESERVE 5H', 4, RESERVE), untouched];
    expect(accountUsageMetricInPlay(untouched, reading)).toBe(true);
  });

  it('brings a standby allowance into play once a plan window is spent, never a budget or a family', () => {
    const untouched = meter('GPT RESERVE 7D', 0, RESERVE);
    expect(accountUsageMetricInPlay(untouched, [meter('7D', 100), untouched])).toBe(true);
    const credit: AccountUsageMetric = { ...meter('CREDIT', 100), kind: 'budget' };
    expect(accountUsageMetricInPlay(untouched, [credit, untouched])).toBe(false);
    const family = [meter('7D', 25), meter('SPARK 7D', 100, SPARK), untouched];
    expect(accountUsageMetricInPlay(untouched, family)).toBe(false);
  });

  it('keeps every other meter in play, used or not', () => {
    const plan = meter('7D', 0);
    const model = meter('SPARK 7D', 0, SPARK);
    expect(accountUsageMetricInPlay(plan, [plan, model])).toBe(true);
    expect(accountUsageMetricInPlay(model, [plan, model])).toBe(true);
  });
});
