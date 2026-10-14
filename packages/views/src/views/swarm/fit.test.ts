import { describe, expect, it } from 'vitest';
import { fitScale, floorScale, freeArea, packedScale, settleScale, SWARM_FIT } from './fit.js';
import { CHROME_OBSTACLE_PADDING, PHYSICAL_GAP } from './physics/spawn-clamp.js';

/** VibeField's default stage: a 1164 × 288 field under its head, a full-width obstacle 56 tall. */
const FIELD = { width: 1164, height: 288 };
const HEAD = { x: 0, y: 0, width: 1164, height: 56 };
const FLOOR = floorScale(50);

describe('the free area', () => {
  it('is the field less each obstacle as the physics pads it, clipped to the field', () => {
    // The head padded by 7 reaches 63 down; its overhang above and beside the field is not the field's.
    expect(freeArea(FIELD, [HEAD])).toBe(1164 * (288 - 56 - CHROME_OBSTACLE_PADDING));
    expect(freeArea(FIELD, [])).toBe(1164 * 288);
  });

  it('takes two overlapping obstacles out once', () => {
    // Godview's usage column, padded to x 6..66 and y 4..289: under the head's padded strip (0..63) only its part
    // below 63 is new, and it is clipped at the field's floor.
    const column = { x: 13, y: 11, width: 46, height: 271 };
    expect(freeArea(FIELD, [HEAD, column])).toBeCloseTo(1164 * 288 - 1164 * 63 - 60 * (288 - 63), 6);
  });

  it('ignores an obstacle outside the field', () => {
    expect(freeArea(FIELD, [{ x: 2000, y: 0, width: 50, height: 50 }])).toBe(1164 * 288);
  });
});

describe('the packed scale', () => {
  it('solves Σ π (k·r + gap)² = ρ · free: the collision discs cover ρ of the free area at k', () => {
    const radii = [50, 50, 60, 73, 80];
    const free = freeArea(FIELD, [HEAD]);
    const k = packedScale(free, radii, 0.5);
    const covered = radii.reduce((sum, r) => sum + Math.PI * (k * r + PHYSICAL_GAP) ** 2, 0);
    expect(covered).toBeCloseTo(0.5 * free, 6);
  });

  it('is √(ρ · free / Σ π r²) with no gap', () => {
    const radii = [50, 60, 70];
    const sum = radii.reduce((total, r) => total + Math.PI * r * r, 0);
    expect(packedScale(100_000, radii, 0.6, 0)).toBeCloseTo(Math.sqrt((0.6 * 100_000) / sum), 9);
  });

  it('has room for no crowd at all, and none for gaps that overfill the field', () => {
    expect(packedScale(1000, [])).toBe(Number.POSITIVE_INFINITY);
    expect(packedScale(10, [50, 50, 50], 0.5)).toBe(0);
  });
});

describe('the floor', () => {
  it('stops the smallest body at r 28: 0.56 of today’s 50', () => {
    expect(floorScale(50)).toBeCloseTo(28 / 50, 9);
    expect(SWARM_FIT.floorRadius * (1 / floorScale(50))).toBeCloseTo(50, 9);
  });

  it('never asks a body already at or under the floor to grow', () => {
    expect(floorScale(28)).toBe(1);
    expect(floorScale(20)).toBe(1);
  });
});

describe('settling the scale: the grid and the dead band', () => {
  it('never grows past today’s sizes, never shrinks below the floor', () => {
    expect(settleScale(3, FLOOR, 1)).toBe(1);
    expect(settleScale(0.1, FLOOR, 1)).toBeCloseTo(0.56, 9);
    expect(settleScale(0, FLOOR, 0.8)).toBeCloseTo(0.56, 9);
  });

  it('shrinks at once to the step under the packed scale', () => {
    expect(settleScale(0.79, FLOOR, 1)).toBeCloseTo(0.76, 9);
    expect(settleScale(0.7999, FLOOR, 0.88)).toBeCloseTo(0.76, 9);
  });

  it('grows only once the packed scale clears the next step by the dead band', () => {
    expect(settleScale(0.81, FLOOR, 0.76)).toBeCloseTo(0.76, 9);
    expect(settleScale(0.8 + SWARM_FIT.deadBand - 0.001, FLOOR, 0.76)).toBeCloseTo(0.76, 9);
    expect(settleScale(0.8 + SWARM_FIT.deadBand + 0.001, FLOOR, 0.76)).toBeCloseTo(0.8, 9);
    // A wide room at once is several steps at once.
    expect(settleScale(0.95, FLOOR, 0.6)).toBeCloseTo(0.92, 9);
  });

  it('is idempotent: the same packing asks for the scale it already holds', () => {
    for (const packed of [0.3, 0.57, 0.61, 0.799, 0.8, 0.83, 0.97, 1.5]) {
      const held = settleScale(packed, FLOOR, 1);
      expect(settleScale(packed, FLOOR, held)).toBe(held);
    }
  });
});

describe('a window drag does not make the crowd shimmer', () => {
  /** The corpus a 20-agent VibeField draws: idle and blocked at 50, working from 60 to 80. */
  const radii = [80, 60, 50, 50, 50, 60, 73, 50, 60, 50, 50, 50, 50, 50, 60, 50, 50, 50, 66, 60];

  const scaleAt = (width: number, previous: number) =>
    fitScale({ field: { width, height: 288 }, obstacles: [{ ...HEAD, width }], radii, smallestBase: 50 }, previous);

  it('holds one scale while the edge trembles across a step', () => {
    // Find a width where the scale steps, then tremble the window's edge ±3 px around it for 200 frames.
    let k = scaleAt(1600, 1);
    let edge = 1600;
    for (let width = 1600; width >= 400; width -= 1) {
      const next = scaleAt(width, k);
      if (next < k) {
        edge = width;
        k = next;
        break;
      }
      k = next;
    }
    const changes = new Set<number>([k]);
    let flips = 0;
    for (let frame = 0; frame < 200; frame += 1) {
      const width = edge + Math.round(3 * Math.sin(frame * 0.7));
      const next = scaleAt(width, k);
      if (next !== k) flips += 1;
      k = next;
      changes.add(k);
    }
    // At most one step down as the edge first crosses back; never back and forth.
    expect(flips).toBeLessThanOrEqual(1);
    expect(changes.size).toBeLessThanOrEqual(2);
  });

  it('moves one way through a drag that goes one way', () => {
    let k = 1;
    const seen: number[] = [];
    for (let width = 1800; width >= 500; width -= 2) {
      k = scaleAt(width, k);
      seen.push(k);
    }
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]!).toBeLessThanOrEqual(seen[index - 1]!);
    // And it did move: the crowd shrank with the field, down to the floor.
    expect(seen[0]).toBeGreaterThan(seen.at(-1)!);
    expect(seen.at(-1)).toBeCloseTo(FLOOR, 9);
  });

  it('is on the grid, so a drag steps it rather than streaming it', () => {
    let k = 1;
    for (let width = 1800; width >= 500; width -= 7) {
      k = scaleAt(width, k);
      const steps = k / SWARM_FIT.step;
      expect(Math.abs(steps - Math.round(steps)) < 1e-6 || k === FLOOR).toBe(true);
    }
  });
});

describe('the fit', () => {
  it('leaves a crowd with room at today’s sizes', () => {
    expect(fitScale({ field: FIELD, obstacles: [HEAD], radii: [60], smallestBase: 50 })).toBe(1);
    expect(fitScale({ field: FIELD, obstacles: [HEAD], radii: [], smallestBase: 50 })).toBe(1);
  });

  it('shrinks a crowd bigger than its field, and stops at the floor', () => {
    const crowd = Array.from({ length: 27 }, (_, index) => [50, 60, 73][index % 3]!);
    const k = fitScale({ field: FIELD, obstacles: [HEAD], radii: crowd, smallestBase: 50 });
    expect(k).toBeLessThan(1);
    expect(k).toBeGreaterThanOrEqual(FLOOR);
    const huge = Array.from({ length: 200 }, () => 50);
    expect(fitScale({ field: FIELD, obstacles: [HEAD], radii: huge, smallestBase: 50 })).toBeCloseTo(FLOOR, 9);
  });
});
