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

describe('usage persistence', () => {
  const start = T0 - (T0 % USAGE_STEP_MS);
  const key = { id: 'a', providerId: 'claude', nativeSessionId: 'native-a' };

  it('exports one record per conversation with a number to keep, and seeds it back rebased to now', async () => {
    const { exportUsage, seedUsage } = await import('./usage-ledger.js');
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 1_000, { inputTokens: 800, outputTokens: 200 });
    ledger = fold(ledger, start + USAGE_STEP_MS, 1_600, { inputTokens: 1_300, outputTokens: 300 });
    ledger = fold(ledger, start + 2 * USAGE_STEP_MS, 1_900, { inputTokens: 1_500, outputTokens: 400 });
    const records = exportUsage(ledger, [key, { id: 'ghost', providerId: 'claude', nativeSessionId: 'x' }], start);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerId: 'claude',
      nativeSessionId: 'native-a',
      boundary: Math.floor((start + 2 * USAGE_STEP_MS) / USAGE_STEP_MS),
      total: { held: 1_900, snapshots: [1_000, 1_600, 1_900] },
      output: { held: 400 },
      input: { held: 1_500 },
    });

    // Resumed three steps later with the same number: the old bars shift left, the gap is silent.
    const later = start + 5 * USAGE_STEP_MS;
    const seeded = seedUsage(EMPTY_USAGE_LEDGER, 'b', records[0]!, later);
    expect(history({ ...seeded, histories: new Map([['a', seeded.histories.get('b')!]]) }).total).toBe(1_900);
    expect(seeded.histories.get('b')!.steps.slice(-5)).toEqual([600, 300, 0, 0, 0]);
    expect(seeded.histories.get('b')!.sides?.output.slice(-5)).toEqual([100, 100, 0, 0, 0]);

    // Resumed with a live number already higher: the growth is spread over the gap.
    const live = fold(EMPTY_USAGE_LEDGER, later, 2_200);
    const grown = seedUsage(live, 'a', records[0]!, later);
    expect(grown.histories.get('a')!.total).toBe(2_200);
    expect(grown.histories.get('a')!.steps.slice(-5)).toEqual([600, 300, 100, 100, 100]);
  });

  it('reads a lower live number through the hold rule and leaves a ledger that already has its own steps alone', async () => {
    const { exportUsage, seedUsage } = await import('./usage-ledger.js');
    let ledger = fold(EMPTY_USAGE_LEDGER, start, 1_000);
    ledger = fold(ledger, start + USAGE_STEP_MS, 1_600);
    const [record] = exportUsage(ledger, [key], start + USAGE_STEP_MS);
    // A source still catching up reports less than was shown: the saved figure stands.
    const partial = fold(EMPTY_USAGE_LEDGER, start + 3 * USAGE_STEP_MS, 900);
    const seeded = seedUsage(partial, 'a', record!, start + 3 * USAGE_STEP_MS);
    expect(seeded.histories.get('a')!.total).toBe(1_600);
    // A ledger that has recorded a burn of its own is already the record; one
    // that has only sat through silent boundaries still takes the seed.
    let settled = fold(EMPTY_USAGE_LEDGER, start + 3 * USAGE_STEP_MS, 5_000);
    settled = fold(settled, start + 4 * USAGE_STEP_MS, 5_500);
    expect(seedUsage(settled, 'a', record!, start + 4 * USAGE_STEP_MS)).toBe(settled);
    let silent = fold(EMPTY_USAGE_LEDGER, start + 3 * USAGE_STEP_MS, 1_600);
    silent = fold(silent, start + 4 * USAGE_STEP_MS, 1_600);
    expect(
      seedUsage(silent, 'a', record!, start + 4 * USAGE_STEP_MS)
        .histories.get('a')!
        .steps.slice(-4),
    ).toEqual([600, 0, 0, 0]);
  });

  it('survives a resume hours later without walking every step in between', async () => {
    const { exportUsage, seedUsage } = await import('./usage-ledger.js');
    const ledger = fold(EMPTY_USAGE_LEDGER, start, 1_000);
    const [record] = exportUsage(ledger, [key], start);
    const seeded = seedUsage(EMPTY_USAGE_LEDGER, 'a', record!, start + 6 * 60 * 60_000);
    expect(seeded.histories.get('a')!.steps).toHaveLength(USAGE_STEP_COUNT);
    expect(seeded.histories.get('a')!.total).toBe(1_000);
  });
});
