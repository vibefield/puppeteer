import { describe, expect, it } from 'vitest';
import type { MonitorUsageState } from '@vibecook/puppeteer-core';
import {
  EMPTY_USAGE_LEDGER,
  USAGE_CORRECTION_GRACE_MS,
  USAGE_STEP_COUNT,
  USAGE_STEP_MS,
  reconcileUsage,
  type UsageLedger,
} from './usage-ledger.js';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const usage = (cumulativeTokens?: number, rest: Partial<MonitorUsageState> = {}): MonitorUsageState => ({
  samples: [],
  ...(cumulativeTokens === undefined ? {} : { cumulativeTokens }),
  ...rest,
});
const fold = (ledger: UsageLedger, at: number, total?: number, rest?: Partial<MonitorUsageState>): UsageLedger =>
  reconcileUsage(ledger, [{ id: 'a', usage: usage(total, rest) }], at);
const history = (ledger: UsageLedger) => ledger.histories.get('a')!;
const steps = (ledger: UsageLedger, count = 3) => history(ledger).steps.slice(-count);

describe('reconcileUsage', () => {
  it('keeps no ledger for a terminal without an agent and drops agents that left', () => {
    let ledger = reconcileUsage(EMPTY_USAGE_LEDGER, [{ id: 'shell' }, { id: 'a', usage: usage(10) }], T0);
    expect(ledger.histories.has('shell')).toBe(false);
    expect(history(ledger).total).toBe(10);
    ledger = reconcileUsage(ledger, [{ id: 'b', usage: usage(1) }], T0 + 1000);
    expect(ledger.histories.has('a')).toBe(false);
  });

  it('holds the last number when the source blanks or falls to nothing', () => {
    let ledger = fold(EMPTY_USAGE_LEDGER, T0, 1_200);
    ledger = fold(ledger, T0 + 1_000, undefined);
    expect(history(ledger).total).toBe(1_200);
    ledger = fold(ledger, T0 + 2_000, 0);
    ledger = fold(ledger, T0 + USAGE_STEP_MS * 3, 0);
    expect(history(ledger).total).toBe(1_200);
    ledger = fold(ledger, T0 + USAGE_STEP_MS * 3 + 1, 1_300);
    expect(history(ledger).total).toBe(1_300);
  });

  it('shows a lower number only once the source has stood behind it for a step', () => {
    let ledger = fold(EMPTY_USAGE_LEDGER, T0, 5_000);
    ledger = fold(ledger, T0 + 1_000, 4_000);
    expect(history(ledger).total).toBe(5_000);
    // A passing excursion: the source agrees again before the grace ends.
    ledger = fold(ledger, T0 + 2_000, 5_100);
    expect(history(ledger).total).toBe(5_100);
    ledger = fold(ledger, T0 + 3_000, 4_000);
    ledger = fold(ledger, T0 + 3_000 + USAGE_CORRECTION_GRACE_MS - 1, 4_100);
    expect(history(ledger).total).toBe(5_100);
    ledger = fold(ledger, T0 + 3_000 + USAGE_CORRECTION_GRACE_MS, 4_100);
    expect(history(ledger).total).toBe(4_100);
  });

  it('snapshots the total at every step and reports what each step burned, oldest first', () => {
    const start = T0 - (T0 % USAGE_STEP_MS) + 5_000;
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 1_000);
    expect(history(ledger).steps).toHaveLength(USAGE_STEP_COUNT);
    expect(history(ledger).steps.every((step) => step === 0)).toBe(true);
    ledger = fold(ledger, start + 10_000, 1_400);
    expect(steps(ledger)).toEqual([0, 0, 0]);
    ledger = fold(ledger, start + USAGE_STEP_MS, 1_600);
    expect(steps(ledger)).toEqual([0, 0, 600]);
    ledger = fold(ledger, start + 2 * USAGE_STEP_MS + 100, 1_900);
    expect(steps(ledger)).toEqual([0, 600, 300]);
    ledger = fold(ledger, start + 3 * USAGE_STEP_MS + 100, 1_900);
    expect(steps(ledger)).toEqual([600, 300, 0]);
  });

  it('spreads growth evenly over steps a throttled clock missed', () => {
    const start = T0 - (T0 % USAGE_STEP_MS);
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 0);
    ledger = fold(ledger, start + 4 * USAGE_STEP_MS, 1_200);
    expect(steps(ledger, 4)).toEqual([300, 300, 300, 300]);
  });

  it('keeps ten minutes: the oldest step falls off the left', () => {
    const start = T0 - (T0 % USAGE_STEP_MS);
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 0);
    for (let step = 1; step <= USAGE_STEP_COUNT + 5; step += 1) {
      ledger = fold(ledger, start + step * USAGE_STEP_MS, step * 100);
    }
    expect(history(ledger).steps).toHaveLength(USAGE_STEP_COUNT);
    expect(history(ledger).steps.every((step) => step === 100)).toBe(true);
    expect(history(ledger).total).toBe((USAGE_STEP_COUNT + 5) * 100);
  });

  it('never reports a negative step for a correction downward', () => {
    const start = T0 - (T0 % USAGE_STEP_MS);
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 5_000);
    ledger = fold(ledger, start + USAGE_STEP_MS, 4_000);
    ledger = fold(ledger, start + 2 * USAGE_STEP_MS, 4_000);
    expect(steps(ledger).every((step) => step >= 0)).toBe(true);
    expect(history(ledger).total).toBe(4_000);
  });

  it('keeps both sides once the source splits the burn, from the aggregate or the last sample', () => {
    const start = T0 - (T0 % USAGE_STEP_MS);
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 1_000, {
      inputTokens: 500,
      cacheReadTokens: 300,
      outputTokens: 150,
      reasoningTokens: 50,
    });
    expect(history(ledger).sides).toBeDefined();
    ledger = fold(ledger, start + USAGE_STEP_MS, 2_000, {
      inputTokens: 1_200,
      cacheReadTokens: 500,
      outputTokens: 250,
      reasoningTokens: 50,
    });
    expect(history(ledger).sides?.input.at(-1)).toBe(900);
    expect(history(ledger).sides?.output.at(-1)).toBe(100);
    // A reading without the split keeps the sides at their last value.
    ledger = fold(ledger, start + 2 * USAGE_STEP_MS, 2_400);
    expect(history(ledger).sides?.input.at(-1)).toBe(0);
    expect(history(ledger).steps.at(-1)).toBe(400);

    const sampled = reconcileUsage(
      EMPTY_USAGE_LEDGER,
      [
        {
          id: 'a',
          usage: {
            cumulativeTokens: 80,
            samples: [{ at: new Date(start).toISOString(), cumulativeTokens: 80, inputTokens: 60, outputTokens: 20 }],
          },
        },
      ],
      start,
    );
    expect(history(sampled).sides).toBeDefined();
  });
});
