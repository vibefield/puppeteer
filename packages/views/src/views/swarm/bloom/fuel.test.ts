import { describe, expect, it } from 'vitest';
import type { MonitorSpawnFuel, MonitorSpawnFuelDrawing, MonitorSpawnProfile } from '@vibefield/puppeteer-view-sdk';
import { arcD, budFuel, type BloomFuel } from './fuel.js';
import { FUEL_42, FUEL_48 } from './fuel-specimens.js';

// A bud's fuel as data: which drawing a bud picks, how tolerantly it reads a host's strokes, the paths it builds, and
// that a host that draws nothing reads as 0.4.0 read it. The view's own files, the SDK's types and vitest (MV-W1).

const profile = (fuel: unknown): MonitorSpawnProfile => ({ id: 'work', label: 'Work', fuel: fuel as MonitorSpawnFuel });
/** A one-arc drawing for a disc `size` across, to tell which size was picked. */
const ring = (size: number): MonitorSpawnFuelDrawing => ({
  size,
  arcs: [{ r: size / 2 - 2, width: 2, from: -90, to: 0, tone: 'ink', percent: 64 }],
});
const sizeOf = (fuel: BloomFuel | null): number | null => (fuel?.kind === 'drawn' ? fuel.size : null);
/** What a 48 bud makes of one arc alone, or null when it skips it. */
const oneArc = (arc: Readonly<Record<string, unknown>>) => {
  const fuel = budFuel(profile({ drawn: [{ size: 48, arcs: [arc] }] }), 48);
  if (fuel?.kind !== 'drawn') return null;
  return fuel.arcs[0] ?? null;
};
/** What a 48 bud makes of one notch alone, or null when it skips it. */
const oneNotch = (notch: Readonly<Record<string, unknown>>) => {
  const fuel = budFuel(profile({ drawn: [{ size: 48, notches: [notch] }] }), 48);
  if (fuel?.kind !== 'drawn') return null;
  return fuel.notches[0] ?? null;
};

describe("a bud's drawn fuel, read", () => {
  it('picks the drawing made for the bud, else the nearest, the larger on a tie', () => {
    const both = profile({ drawn: [FUEL_48, FUEL_42] });
    expect(sizeOf(budFuel(both, 48))).toBe(48);
    expect(sizeOf(budFuel(both, 42))).toBe(42);
    expect(sizeOf(budFuel(profile({ drawn: [FUEL_48] }), 42))).toBe(48);
    expect(sizeOf(budFuel(profile({ drawn: [ring(40), ring(60)] }), 48))).toBe(40);
    expect(sizeOf(budFuel(profile({ drawn: [ring(44), ring(52)] }), 48))).toBe(52);
    expect(sizeOf(budFuel(profile({ drawn: [ring(52), ring(44)] }), 48))).toBe(52);
    const drawn = budFuel(profile({ drawn: [FUEL_48], usedPercent: 42, unread: true, hot: true }), 48);
    expect(drawn).toMatchObject({ kind: 'drawn', size: 48 });
    expect(drawn?.kind === 'drawn' ? [drawn.arcs.length, drawn.notches.length] : null).toEqual([4, 1]);
  });

  it('reads each stroke tolerantly: a bad one is skipped, a share and an opacity clamp, an unknown cap is butt', () => {
    const base = { r: 20, width: 2, from: -90, to: 0, tone: 'ink', percent: 64 };
    expect(oneArc(base)).toEqual({
      r: 20,
      width: 2,
      from: -90,
      to: 0,
      circle: false,
      tone: 'ink',
      percent: 64,
      opacity: 1,
      cap: 'butt',
      dash: null,
    });
    const skipped = [
      { tone: 'attention' },
      { tone: undefined },
      { r: 0 },
      { r: -1 },
      { width: 0 },
      { to: -90 },
      { to: -100 },
      { r: Number.NaN },
      { from: Number.NEGATIVE_INFINITY },
      { percent: '64' },
      { opacity: Number.NaN },
      { opacity: '1' },
      // 25.1 + 1 is past 2 beyond a 48 disc's rim
      { r: 25.1 },
    ];
    for (const bad of skipped) expect([bad, oneArc({ ...base, ...bad })]).toEqual([bad, null]);
    expect(oneArc({ ...base, r: 25 })).toMatchObject({ r: 25 });
    // the slack is 2 of the bud's own px, whatever size the drawing was made for: 52 of 96 is 26 of 48, 4 of 4 is 48
    const scaled = (size: number, r: number) => budFuel(profile({ drawn: [{ size, arcs: [{ ...base, r }] }] }), 48);
    expect(sizeOf(scaled(96, 51))).toBe(96);
    expect(scaled(96, 51.1)).toBeNull();
    expect(sizeOf(scaled(4, 1))).toBe(4);
    expect(scaled(4, 3)).toBeNull();
    // a list is read no further than 4 entries for each the bud may keep: 192 arcs, 16 drawings
    const junk = Array.from({ length: 192 }, () => ({ ...base, tone: 'attention' }));
    expect(budFuel(profile({ drawn: [{ size: 48, arcs: [...junk, base] }] }), 48)).toBeNull();
    expect(sizeOf(budFuel(profile({ drawn: [{ size: 48, arcs: [...junk.slice(1), base] }] }), 48))).toBe(48);
    const nulls = Array.from({ length: 16 }, () => null);
    expect(budFuel(profile({ drawn: [...nulls, FUEL_48] }), 48)).toBeNull();
    expect(sizeOf(budFuel(profile({ drawn: [...nulls.slice(1), FUEL_48] }), 48))).toBe(48);
    expect(oneArc({ ...base, percent: 140, opacity: 2 })).toMatchObject({ percent: 100, opacity: 1 });
    expect(oneArc({ ...base, percent: -5, opacity: -1 })).toMatchObject({ percent: 0, opacity: 0 });
    expect(oneArc({ ...base, r: 20.123, width: 2.346, percent: 64.456 })).toMatchObject({
      r: 20.12,
      width: 2.35,
      percent: 64.46,
    });
    expect(oneArc({ ...base, cap: 'round' })).toMatchObject({ cap: 'round' });
    expect(oneArc({ ...base, cap: 'square' })).toMatchObject({ cap: 'butt' });
    expect(oneArc({ ...base, to: 269.9 })).toMatchObject({ circle: true });
    expect(oneArc({ ...base, to: 269.8 })).toMatchObject({ circle: false });
    expect(oneArc({ ...base, dash: [0.01, 4.64] })).toMatchObject({ dash: [0.01, 4.64] });
    for (const dash of [[1], [1, 2, 3], [-1, 2], [0, 0], [Number.NaN, 2], ['1', 2], 'x', null]) {
      expect([dash, oneArc({ ...base, dash })?.dash]).toEqual([dash, null]);
    }
    const notch = { x1: 42, y1: 24, x2: 49, y2: 24, width: 1.25, tone: 'hot', percent: 84 };
    expect(oneNotch(notch)).toEqual({
      x1: 42,
      y1: 24,
      x2: 49,
      y2: 24,
      width: 1.25,
      tone: 'hot',
      percent: 84,
      opacity: 1,
    });
    // an end past 2 beyond the rim, as an arc's
    const skippedNotches = [
      { width: 0 },
      { tone: 'light' },
      { x2: 50.1 },
      { y1: -2.1 },
      { x1: Number.NaN },
      { percent: null },
    ];
    for (const bad of skippedNotches) expect([bad, oneNotch({ ...notch, ...bad })]).toEqual([bad, null]);
    // a drawing needs a size, and a stroke the bud can draw
    for (const size of [0, -48, Number.NaN, '48']) {
      expect([size, budFuel(profile({ drawn: [{ size, arcs: FUEL_48.arcs }] }), 48)]).toEqual([size, null]);
    }
    expect(budFuel(profile({ drawn: [{ size: 48 }] }), 48)).toBeNull();
  });

  it('builds a path clockwise from the top: a quarter turn is one arc, three quarters two halves', () => {
    expect(arcD(24, 21.6, -90, 0)).toBe('M24 2.4A21.6 21.6 0 0 1 45.6 24');
    expect(arcD(24, 17.6, -90, 180)).toBe('M24 6.4A17.6 17.6 0 0 1 24 41.6A17.6 17.6 0 0 1 6.4 24');
  });

  it('with no drawing, reads the one-arc fields as 0.4.0 did, whatever the bud', () => {
    for (const d of [48, 42]) {
      expect(budFuel(profile({ usedPercent: 42, elapsedPercent: 25 }), d)).toEqual({
        kind: 'reading',
        used: 42,
        elapsed: 25,
        hot: false,
        stale: false,
      });
      expect(budFuel(profile({ usedPercent: 130, elapsedPercent: -5, hot: true, stale: true }), d)).toEqual({
        kind: 'reading',
        used: 100,
        elapsed: 0,
        hot: true,
        stale: true,
      });
      expect(budFuel(profile({ usedPercent: 42, hot: 'false', stale: 1 }), d)).toEqual({
        kind: 'reading',
        used: 42,
        elapsed: null,
        hot: false,
        stale: false,
      });
      expect(budFuel(profile({ unread: true }), d)).toEqual({ kind: 'unread' });
      expect(budFuel(profile({ unread: true, usedPercent: 42 }), d)?.kind).toBe('reading');
      const nothing = [
        undefined,
        null,
        42,
        true,
        'full',
        { usedPercent: Number.NaN },
        { usedPercent: '42' },
        { usedPercent: Number.POSITIVE_INFINITY },
        { unread: 1 },
        { unread: 'true' },
        { word: 'Plan: 42% of 5 hours' },
      ];
      for (const fuel of nothing) expect([fuel, budFuel(profile(fuel), d)]).toEqual([fuel, null]);
    }
  });
});
