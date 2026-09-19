import { describe, expect, it } from 'vitest';
import type { MonitorUsageState } from '@vibecook/puppeteer-core';
import { EMPTY_USAGE_LEDGER, reconcileUsage, seedUsage, exportUsage, USAGE_STEP_MS } from './usage-ledger.js';
import { formatUsd } from './cost-format.js';

const T0 = Date.parse('2026-09-16T12:00:00Z');
const usage = (costUsd: number, at = T0): MonitorUsageState => ({
  samples: [],
  costUsd,
  costCoverage: 'complete',
  costHistory: [{ at: new Date(at).toISOString(), costUsd }],
});
const session = { providerId: 'claude', nativeSessionId: 'session' };
const reading = (costUsd: number, runId = 'run-1', at = T0) => ({ id: 'a', runId, session, usage: usage(costUsd, at) });

describe('USD display history', () => {
  it('never substitutes tokens for USD or invents a zero price', () => {
    const ledger = reconcileUsage(
      EMPTY_USAGE_LEDGER,
      [{ id: 'a', usage: { samples: [], cumulativeTokens: 1_000_000 } }, { id: 'shell' }],
      T0,
    );
    expect(ledger.histories.get('a')).toMatchObject({ coverage: 'unavailable' });
    expect(ledger.histories.get('a')?.total).toBeUndefined();
    expect(ledger.histories.has('shell')).toBe(false);
  });
  it('reflects corrections immediately, including zero, in their original bucket', () => {
    let ledger = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(2)], T0);
    ledger = reconcileUsage(ledger, [reading(1)], T0 + USAGE_STEP_MS);
    expect(ledger.histories.get('a')?.total).toBe(1);
    expect(ledger.histories.get('a')?.steps.slice(-2)).toEqual([1, 0]);
    ledger = reconcileUsage(ledger, [reading(3)], T0 + USAGE_STEP_MS * 2);
    expect(ledger.histories.get('a')?.steps.slice(-3)).toEqual([3, 0, 0]);
    ledger = reconcileUsage(ledger, [reading(0)], T0 + USAGE_STEP_MS * 3);
    expect(ledger.histories.get('a')?.total).toBe(0);
    expect(ledger.histories.get('a')?.steps.every((step) => step === 0)).toBe(true);
  });
  it('ages event buckets without interpolating a throttled UI or a resumed session', () => {
    const ledger = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(2)], T0);
    const [record] = exportUsage(ledger, [{ id: 'a', providerId: 'claude', nativeSessionId: 'session' }], T0);
    const seeded = seedUsage(EMPTY_USAGE_LEDGER, 'a', record!, T0 + 60 * 60_000);
    expect(seeded.histories.get('a')?.total).toBe(2);
    expect(seeded.histories.get('a')?.steps.every((step) => step === 0)).toBe(true);
  });
  it('deduplicates the same run, preserves a late live correction, and adds a new observed run once', () => {
    const old = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(2)], T0);
    const [record] = exportUsage(old, [{ id: 'a', providerId: 'claude', nativeSessionId: 'session' }], T0);
    const corrected = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(1)], T0);
    expect(seedUsage(corrected, 'a', record!, T0).histories.get('a')?.total).toBe(1);
    let resumed = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(0.5, 'run-2')], T0);
    resumed = seedUsage(resumed, 'a', record!, T0);
    resumed = seedUsage(resumed, 'a', record!, T0);
    expect(resumed.histories.get('a')?.total).toBe(2.5);
  });
  it('marks missing observations partial', () => {
    const ledger = reconcileUsage(
      EMPTY_USAGE_LEDGER,
      [{ id: 'a', usage: { ...usage(0.2), costCoverage: 'partial' } }],
      T0,
    );
    expect(ledger.histories.get('a')).toMatchObject({ total: 0.2, coverage: 'partial' });
  });
  it('isolates a different conversation reusing the same visual identity', () => {
    const old = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(2)], T0);
    const [cached] = exportUsage(old, [{ id: 'a', ...session }], T0);
    const nextSession = { ...session, nativeSessionId: 'different-session' };
    let next = reconcileUsage(old, [{ ...reading(0.5, 'run-2'), session: nextSession }], T0);
    expect(next.histories.get('a')?.total).toBe(0.5);
    next = seedUsage(next, 'a', cached!, T0);
    expect(next.histories.get('a')?.total).toBe(0.5);
    expect(exportUsage(next, [{ id: 'a', ...session }], T0)).toEqual([]);
  });
  it('exports only the authoritative live run, never stale copies of seeded runs', () => {
    const old = reconcileUsage(EMPTY_USAGE_LEDGER, [reading(2)], T0);
    const [cached] = exportUsage(old, [{ id: 'a', ...session }], T0);
    const live = reconcileUsage(EMPTY_USAGE_LEDGER, [{ ...reading(0.5, 'run-2'), revision: 4 }], T0);
    const seeded = seedUsage(live, 'a', cached!, T0);
    const [saved] = exportUsage(seeded, [{ id: 'a', ...session }], T0);
    expect(seeded.histories.get('a')?.total).toBe(2.5);
    expect(saved?.runs).toMatchObject([{ runId: 'run-2', costUsd: 0.5, revision: 4 }]);
  });
  it('distinguishes unavailable, zero, and sub-cent USD estimates', () => {
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0001)).toBe('<$0.001');
    expect(formatUsd(0.005)).toBe('$0.005');
  });
});
