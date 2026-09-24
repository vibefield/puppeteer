import { describe, expect, it } from 'vitest';
import {
  AccountUsageFetchResultSchema,
  AccountUsageProviderSchema,
  AccountUsageSnapshotSchema,
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
