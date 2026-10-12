import { describe, expect, it } from 'vitest';
import type { MonitorUsageState } from '@vibefield/puppeteer-core';
import { USAGE_STEP_MS, UsageLedger } from './usage-ledger.js';

// The window's former `views/monitor/usage-ledger.test.ts` (deleted at MV-8b), less the persistence it no longer has.

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
    const ledger = new UsageLedger();
    ledger.observe({ id: 'a', usage: { samples: [], cumulativeTokens: 1_000_000 } }, T0);
    ledger.observe({ id: 'shell' }, T0);
    expect(ledger.history('a')).toMatchObject({ coverage: 'unavailable' });
    expect(ledger.history('a')?.total).toBeUndefined();
    expect(ledger.history('shell')).toBeUndefined();
  });

  it('reflects corrections immediately, including zero, in their original bucket', () => {
    const ledger = new UsageLedger();
    ledger.observe(reading(2), T0);
    ledger.observe(reading(1), T0 + USAGE_STEP_MS);
    expect(ledger.history('a')?.total).toBe(1);
    expect(ledger.history('a')?.steps.slice(-2)).toEqual([1, 0]);
    ledger.observe(reading(3), T0 + USAGE_STEP_MS * 2);
    expect(ledger.history('a')?.steps.slice(-3)).toEqual([3, 0, 0]);
    ledger.observe(reading(0), T0 + USAGE_STEP_MS * 3);
    expect(ledger.history('a')?.total).toBe(0);
    expect(ledger.history('a')?.steps.every((step) => step === 0)).toBe(true);
  });

  it('ages event buckets on the step clock without interpolating', () => {
    const ledger = new UsageLedger();
    ledger.observe(reading(2), T0);
    expect(ledger.history('a')?.steps.at(-1)).toBe(2);
    expect(ledger.step(T0 + 60 * 60_000)).toEqual(['a']);
    expect(ledger.history('a')?.total).toBe(2);
    expect(ledger.history('a')?.steps.every((step) => step === 0)).toBe(true);
    expect(ledger.history('a')?.lastStepAt).toBe(T0 + 60 * 60_000);
  });

  it('deduplicates the same run and adds a new observed run of the same conversation once', () => {
    const ledger = new UsageLedger();
    ledger.observe(reading(2), T0);
    ledger.observe(reading(2), T0);
    expect(ledger.history('a')?.total).toBe(2);
    ledger.observe(reading(0.5, 'run-2'), T0);
    ledger.observe(reading(0.5, 'run-2'), T0);
    expect(ledger.history('a')?.total).toBe(2.5);
    expect(ledger.history('a')?.steps.at(-1)).toBe(2.5);
  });

  it('marks missing observations partial', () => {
    const ledger = new UsageLedger();
    ledger.observe({ id: 'a', usage: { ...usage(0.2), costCoverage: 'partial' } }, T0);
    expect(ledger.history('a')).toMatchObject({ total: 0.2, coverage: 'partial' });
  });

  it('isolates a different conversation reusing the same visual identity', () => {
    const ledger = new UsageLedger();
    ledger.observe(reading(2), T0);
    const nextSession = { ...session, nativeSessionId: 'different-session' };
    ledger.observe({ ...reading(0.5, 'run-2'), session: nextSession }, T0);
    expect(ledger.history('a')?.total).toBe(0.5);
  });

  it('fills in an unknown native id for the same live run, and resets for a different run without one', () => {
    const ledger = new UsageLedger();
    ledger.observe({ id: 'a', runId: 'run-1', usage: usage(1) }, T0);
    ledger.observe({ id: 'a', runId: 'run-1', session, usage: usage(1.5) }, T0);
    expect(ledger.history('a')?.total).toBe(1.5);
    ledger.observe({ id: 'a', runId: 'run-2', usage: usage(0.25) }, T0);
    expect(ledger.history('a')?.total).toBe(0.25);
  });

  it('keeps a history object until its content changes', () => {
    const ledger = new UsageLedger();
    expect(ledger.observe(reading(2), T0)).toBe(true);
    const first = ledger.history('a');
    expect(ledger.observe(reading(2), T0 + 1_000)).toBe(false);
    expect(ledger.history('a')).toBe(first);
    expect(ledger.step(T0 + 2_000)).toEqual([]);
    expect(ledger.history('a')).toBe(first);
    expect(ledger.step(T0 + USAGE_STEP_MS)).toEqual(['a']);
    expect(ledger.history('a')).not.toBe(first);
    expect(Object.isFrozen(ledger.history('a'))).toBe(true);
    expect(ledger.forget('a')).toBe(true);
    expect(ledger.history('a')).toBeUndefined();
  });
});
