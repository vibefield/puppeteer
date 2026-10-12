import { describe, expect, it } from 'vitest';
import {
  easeTop,
  heldIn,
  momentIn,
  moneyScale,
  moneyTicks,
  niceStep,
  SPEND_STEP_COUNT,
  SPEND_STEP_MS,
  SPEND_WINDOW_MS,
  spendWindow,
  timeTicks,
} from './spend-scale.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-02T17:00:00.000Z');

describe('the spend scales', () => {
  it('rounds the top up to a nice step, linear from $0 (SV-D8)', () => {
    expect(niceStep(70, 7)).toBe(10);
    expect(niceStep(0.9, 7)).toBe(0.2);
    expect(moneyScale(62.87, false)).toEqual({ step: 10, max: 70 });
    expect(moneyScale(0, false).max).toBeGreaterThanOrEqual(0.5);
    expect(moneyTicks(70, 10)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  it('eases a new high in, and lands on it', () => {
    expect(easeTop(null, 70)).toBe(70);
    const next = easeTop(60, 70);
    expect(next).toBeGreaterThan(60);
    expect(next).toBeLessThan(70);
    expect(easeTop(69.99, 70)).toBe(70);
  });

  it("is the last ten minutes Core holds, ending at now: the stretch every row's buckets always cover", () => {
    expect(SPEND_WINDOW_MS).toBe(9.5 * MIN);
    expect(spendWindow(NOW)).toEqual({ ta: NOW - 9.5 * MIN, tb: NOW });
    // Wherever now falls in a bucket, the oldest bucket began at or before the window's left edge.
    for (let into = 0; into < SPEND_STEP_MS; into += 5_000) {
      const now = NOW + into;
      const oldest = Math.floor(now / SPEND_STEP_MS) * SPEND_STEP_MS - (SPEND_STEP_COUNT - 1) * SPEND_STEP_MS;
      expect(oldest).toBeLessThanOrEqual(spendWindow(now).ta);
    }
  });

  it('bounds a moment to the window, and lets a set moment go once the window has slid past it', () => {
    const span = spendWindow(NOW);
    expect(momentIn(NOW - HOUR, span)).toBe(span.ta);
    expect(momentIn(NOW + MIN, span)).toBe(NOW);
    expect(momentIn(NOW - 3 * MIN, span)).toBe(NOW - 3 * MIN);
    expect(heldIn(NOW - 3 * MIN, span)).toBe(NOW - 3 * MIN);
    expect(heldIn(NOW - 3 * MIN, spendWindow(NOW + 7 * MIN))).toBeNull();
    expect(heldIn(NOW - HOUR, span)).toBeNull();
    expect(heldIn(null, span)).toBeNull();
  });

  it('ticks every two minutes, clear of the left edge and of a chip; every four where two would touch', () => {
    const { ta, tb } = spendWindow(NOW);
    const ticks = timeTicks(ta, tb, 0, 760, [760]);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!.t - ticks[i - 1]!.t).toBe(2 * MIN);
    expect(ticks.every((tick) => tick.t % (2 * MIN) === 0)).toBe(true);
    expect(ticks.every((tick) => tick.x >= 18 && Math.abs(tick.x - 760) >= 46)).toBe(true);
    const narrow = timeTicks(ta, tb, 0, 164, []);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.every((tick) => tick.t % (4 * MIN) === 0)).toBe(true);
  });
});
