import { describe, expect, it } from 'vitest';
import { USAGE_STEP_COUNT, USAGE_STEP_MS } from '../../monitor/usage-ledger.js';
import { BURN_BAR_COUNT, burnBars, scaledBars } from './burn-bars.js';

const steps = (...values: number[]): number[] => [
  ...new Array<number>(USAGE_STEP_COUNT - values.length).fill(0),
  ...values,
];

describe('scaledBars', () => {
  it('scales every column to the tallest and rests when nothing burned', () => {
    expect(BURN_BAR_COUNT).toBe(USAGE_STEP_COUNT);
    const bars = scaledBars(steps(100, 400, 200));
    expect(bars).toHaveLength(BURN_BAR_COUNT);
    expect(bars[BURN_BAR_COUNT - 2]).toBe(1);
    expect(bars[BURN_BAR_COUNT - 3]).toBeCloseTo(0.25, 6);
    expect(bars[BURN_BAR_COUNT - 1]).toBeCloseTo(0.5, 6);
    expect([...scaledBars(steps())].every((value) => value === 0)).toBe(true);
  });
});

describe('burnBars', () => {
  it('puts output up and input down when the source splits its usage', () => {
    const bars = burnBars({
      total: 6_000,
      steps: steps(600, 300),
      sides: { output: steps(100, 50), input: steps(500, 250) },
      stepMs: USAGE_STEP_MS,
    });
    expect(bars.split).toBe(true);
    expect(bars.up[BURN_BAR_COUNT - 2]).toBe(1);
    expect(bars.up[BURN_BAR_COUNT - 1]).toBe(0.5);
    expect(bars.down[BURN_BAR_COUNT - 1]).toBe(0.5);
  });

  it('puts the whole burn up and nothing down without a split', () => {
    const bars = burnBars({ total: 900, steps: steps(300, 600), stepMs: USAGE_STEP_MS });
    expect(bars.split).toBe(false);
    expect(bars.up[BURN_BAR_COUNT - 1]).toBe(1);
    expect(Math.max(...bars.down)).toBe(0);
  });
});
