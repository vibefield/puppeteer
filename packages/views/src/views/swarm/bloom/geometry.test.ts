import { describe, expect, it } from 'vitest';
import { BLOOM, type BloomTextMeasure } from './constants.js';
import {
  angDiff,
  arcFits,
  arcPoints,
  budsCost,
  labelBox,
  labelCost,
  labelSize,
  layoutArc,
  rectGap,
  seatLabel,
  segGap,
  turnAt,
  type BloomArcSpec,
  type BloomRoom,
} from './geometry.js';

// The deterministic measure every bloom test uses: characters × font px × 0.6
// (a monospace advance), read from the font shorthand the bloom passes.
const measure: BloomTextMeasure = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 0) * 0.6;

describe('the distance helpers', () => {
  it('angDiff is unsigned and wraps', () => {
    expect(angDiff(170, -170)).toBe(20);
    expect(angDiff(-90, 90)).toBe(180);
    expect(angDiff(10, 10)).toBe(0);
  });

  it('rectGap is 0 inside a box and the corner distance outside it', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectGap(box, 5, 5)).toBe(0);
    expect(rectGap(box, 13, 14)).toBe(5);
  });

  it('segGap is 0 when a segment crosses a box, else the nearest approach', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(segGap(box, { x: -5, y: 5 }, { x: 15, y: 5 })).toBe(0);
    expect(segGap(box, { x: -5, y: 13 }, { x: 15, y: 13 })).toBe(3);
  });

  it('turnAt alternates outward in 15° steps', () => {
    expect([0, 1, 2, 3, 4, 5].map(turnAt)).toEqual([0, 15, -15, 30, -30, 45]);
  });
});

describe('labels', () => {
  it('measure a name (9.5 px) and a state line (7.5 px), plus the letter spacing', () => {
    // MINI: 4 × 9.5 × 0.6 + 4 × 0.57 = 25.08 → 26 + 4
    expect(labelSize({ name: 'MINI' }, measure)).toEqual({ w: 30, h: 12 });
    // 2 RUNNING: 9 × 7.5 × 0.6 + 9 × 0.75 = 47.25 → 48 + 4, two lines tall
    expect(labelSize({ name: 'MINI', sub: '2 RUNNING' }, measure)).toEqual({ w: 52, h: 23 });
  });

  it('sit beside a sideways spoke and over or under an upright one', () => {
    const size = { w: 30, h: 12 };
    expect(labelBox(100, 100, 0, 48, size)).toMatchObject({ x: 132, y: 94, align: 'left' });
    expect(labelBox(100, 100, 180, 48, size)).toMatchObject({ x: 38, y: 94, align: 'right' });
    expect(labelBox(100, 100, -90, 48, size)).toMatchObject({ x: 85, y: 56, align: 'center' });
    expect(labelBox(100, 100, 90, 48, size)).toMatchObject({ x: 85, y: 132, align: 'center' });
  });
});

describe('seatLabel', () => {
  const field = { w: 400, h: 400 };
  const full = { w: 52, h: 23 };
  const short = { w: 30, h: 12 };

  it('keeps the natural place when it is clear', () => {
    const natural = labelBox(200, 200, 0, 48, full);
    const seat = seatLabel(200, 200, 48, natural, [full, short], { field });
    expect(seat).toEqual({ box: natural, cost: 0, short: false });
  });

  it('turns round its own bud to the nearest clear place', () => {
    const natural = labelBox(200, 200, 0, 48, full);
    // another bud sits right where the words would go
    const room: BloomRoom = { field, discs: [{ x: 262, y: 200, r: 24 }] };
    expect(labelCost(natural, room)).toBeGreaterThan(0);
    const seat = seatLabel(200, 200, 48, natural, [full, short], room);
    expect(seat.cost).toBe(0);
    expect(seat.short).toBe(false);
    expect(labelCost(seat.box, room)).toBe(0);
    expect(seat.box).not.toEqual(natural);
  });

  it('keeps just the name when only that fits', () => {
    // a 20 px corridor (after the words' 4 px clearance) runs through the bud:
    // the name (12 px) fits beside it, the name with its state line (23) nowhere
    const room: BloomRoom = {
      field,
      rects: [
        { x: 0, y: 0, width: 400, height: 186 },
        { x: 0, y: 214, width: 400, height: 186 },
      ],
    };
    const natural = labelBox(200, 200, 0, 48, full);
    const seat = seatLabel(200, 200, 48, natural, [full, short], room);
    expect(seat.cost).toBe(0);
    expect(seat.short).toBe(true);
    expect(seat.box.h).toBe(12);
  });

  it('returns the least crowded place, with its cost, when nothing is clear', () => {
    const room: BloomRoom = { field, rects: [{ x: 0, y: 0, width: 400, height: 400 }] };
    const natural = labelBox(200, 200, 0, 48, full);
    const seat = seatLabel(200, 200, 48, natural, [full, short], room);
    expect(seat.cost).toBeGreaterThan(0);
  });
});

describe('layoutArc', () => {
  const ring = { r: BLOOM.r1, d: BLOOM.bud1, step: BLOOM.step1, prefer: -90 };

  it('opens up when there is room, in reading order', () => {
    const field = { w: 800, h: 600 };
    const layout = layoutArc({
      cx: 400,
      cy: 300,
      ...ring,
      field,
      measure,
      labels: [{ name: 'STUDIO', sub: 'HERE' }, { name: 'MINI', sub: '2 RUNNING' }, { name: 'AIR' }],
      discs: [{ x: 400, y: 300, r: BLOOM.hubR + 2 }],
    });
    expect(layout.turn).toBe(0);
    expect(layout.cost).toBe(0);
    const xs = layout.items.map((item) => item.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(layout.items[1]?.y).toBeCloseTo(300 - BLOOM.r1);
  });

  it('keeps every bud on the field even when its caller would rather it did not (the strict turn order)', () => {
    // A hub 60 px under the top edge: up is off the field. The caller's cost
    // (`also`) charges any bud below y = 50, so turning to face sideways costs
    // 500 while stopping at +75° leaves one bud 1.8 px past the edge.
    const field = { w: 400, h: 400 };
    const base: BloomArcSpec = { cx: 200, cy: 60, ...ring, field, discs: [{ x: 200, y: 60, r: 18 }] };
    const also = (pts: readonly { y: number }[]) => (pts.some((p) => p.y > 50) ? 500 : 0);
    const hotR = (BLOOM.bud1 * BLOOM.hot) / 2;
    const at75 = arcPoints(base, -90 + 75, BLOOM.step1, 1);
    const at90 = arcPoints(base, -90 + 90, BLOOM.step1, 1);
    const sum75 = budsCost(at75, base, hotR) + also(at75);
    const sum90 = budsCost(at90, base, hotR) + also(at90);
    // a summed cost would take +75°: a bud past the edge
    expect(budsCost(at75, base, hotR)).toBeGreaterThan(0);
    expect(sum75).toBeLessThan(sum90);
    const layout = layoutArc({ ...base, measure, labels: [{ name: 'MINI' }], also });
    expect(layout.bud).toBe(0);
    expect(layout.turn).toBe(90);
    expect(layout.also).toBe(500);
  });

  it('leaves room for the open desktop’s words within 45° of the first clear turn', () => {
    const field = { w: 800, h: 600 };
    const at = { x: 400, y: 300 };
    const size = { w: 60, h: 23 };
    // the desktop's words sit where the profiles would bloom when facing right
    const natural = labelBox(at.x, at.y, 0, BLOOM.bud1, size);
    const layout = layoutArc({
      cx: at.x,
      cy: at.y,
      r: BLOOM.r2,
      d: BLOOM.bud2,
      step: BLOOM.step2,
      prefer: 0,
      field,
      measure,
      labels: [{ name: 'THIS MAC' }, { name: 'PERSONAL' }],
      discs: [{ x: at.x, y: at.y, r: (BLOOM.bud1 * BLOOM.hot) / 2 }],
      extra: { x: at.x, y: at.y, d: BLOOM.bud1, natural, sizes: [size, { w: 40, h: 12 }] },
    });
    expect(layout.cost).toBe(0);
    expect(layout.kept).toBe(true);
    expect(angDiff(layout.turn, 0)).toBeLessThanOrEqual(45);
  });

  it('arcFits asks whether a desktop’s profiles fit onward, within ±maxTurn', () => {
    const field = { w: 400, h: 400 };
    // a desktop 30 px from the right edge, facing right: its two profiles
    // only fit turned square to the spoke (±90°), never at ±45°
    const spec: BloomArcSpec = { cx: 370, cy: 200, r: BLOOM.r2, d: BLOOM.bud2, step: BLOOM.step2, prefer: 0, field };
    expect(arcFits(spec, 2, 45)).toBe(false);
    expect(arcFits(spec, 2, 180)).toBe(true);
  });
});
