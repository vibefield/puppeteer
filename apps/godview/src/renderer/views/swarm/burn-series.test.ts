import { describe, expect, it } from 'vitest';
import { BURN_HOT, BURN_SAMPLE_COUNT, burnIntensity, burnSeries, burnSides } from './burn-series.js';

const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

describe('burnIntensity', () => {
  it('rests on the floor below 500 tok/min and reaches the top two decades above it', () => {
    expect(burnIntensity(undefined)).toBe(0);
    expect(burnIntensity(0)).toBe(0);
    expect(burnIntensity(500)).toBe(0);
    expect(burnIntensity(5_000)).toBeCloseTo(0.5, 6);
    expect(burnIntensity(50_000)).toBe(1);
    expect(burnIntensity(500_000)).toBe(1);
  });

  it('puts the redline at the last fifth of the scale', () => {
    expect(burnIntensity(20_000)).toBeGreaterThan(BURN_HOT);
    expect(burnIntensity(15_000)).toBeLessThan(BURN_HOT);
  });
});

describe('burnSeries', () => {
  it('is forty buckets of nothing with no evidence', () => {
    const series = burnSeries({ samples: [], nowMs: NOW });
    expect(series).toHaveLength(BURN_SAMPLE_COUNT);
    expect([...series].every((value) => value === 0)).toBe(true);
  });

  it('spreads a steady burn evenly and stays flat after the last sample', () => {
    // 5 000 tok/min for the first five minutes of the window, then silence.
    const series = burnSeries({
      samples: [
        { at: minutesAgo(10), cumulativeTokens: 0 },
        { at: minutesAgo(5), cumulativeTokens: 25_000 },
      ],
      nowMs: NOW,
    });
    for (let index = 0; index < 20; index += 1) expect(series[index]).toBeCloseTo(0.5, 3);
    for (let index = 20; index < BURN_SAMPLE_COUNT; index += 1) expect(series[index]).toBe(0);
  });

  it('reports no burn before the first sample and never a negative rate after a correction', () => {
    const series = burnSeries({
      samples: [
        { at: minutesAgo(2), cumulativeTokens: 10_000 },
        { at: minutesAgo(1), cumulativeTokens: 4_000 },
      ],
      nowMs: NOW,
    });
    expect(series[0]).toBe(0);
    expect([...series].every((value) => value >= 0)).toBe(true);
  });

  it('ends on the live rate when Core reports one', () => {
    const series = burnSeries({ samples: [], burnRatePerMin: 50_000, nowMs: NOW });
    expect(series[BURN_SAMPLE_COUNT - 1]).toBe(1);
    expect(series[BURN_SAMPLE_COUNT - 2]).toBe(0);
  });

  it('ignores samples it cannot read', () => {
    const series = burnSeries({
      samples: [
        { at: 'not a date', cumulativeTokens: 1 },
        { at: minutesAgo(1), cumulativeTokens: Number.NaN },
      ],
      nowMs: NOW,
    });
    expect([...series].every((value) => value === 0)).toBe(true);
  });
});

describe('burnSides', () => {
  it('puts output up and input down when the samples split usage', () => {
    const sides = burnSides({
      samples: [
        { at: new Date(NOW - 600_000).toISOString(), cumulativeTokens: 0, inputTokens: 0, outputTokens: 0 },
        { at: new Date(NOW).toISOString(), cumulativeTokens: 60_000, inputTokens: 50_000, outputTokens: 10_000 },
      ],
      nowMs: NOW,
    });
    expect(sides.split).toBe(true);
    expect(sides.up).toHaveLength(BURN_SAMPLE_COUNT);
    // 10k over ten minutes is 1000 tok/min on the completion side, 5000 on the prompt side.
    expect(sides.up[0]).toBeCloseTo(burnIntensity(1000), 5);
    expect(sides.down[0]).toBeCloseTo(burnIntensity(5000), 5);
  });

  it('puts the whole burn up and nothing down without a split', () => {
    const sides = burnSides({ samples: [], burnRatePerMin: 50_000, nowMs: NOW });
    expect(sides.split).toBe(false);
    expect(sides.up[BURN_SAMPLE_COUNT - 1]).toBe(1);
    expect(Math.max(...sides.down)).toBe(0);
  });
});
