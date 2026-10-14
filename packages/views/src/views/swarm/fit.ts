import { CHROME_OBSTACLE_PADDING, PHYSICAL_GAP } from './physics/spawn-clamp.js';

// The crowd fits its field: "Shrink together" (James, 2026-10-13).
//
// A crowd bigger than its field cannot be held by any wall. Measured on
// VibeField's default window (1164 × 288 under a 56 px head), 27 bodies at
// today's sizes left 9 standing in the head's band however solid it was made:
// under that pressure Matter's contacts yield at every edge. So the crowd
// shrinks instead. ONE scale k multiplies every body's base radius (a working
// body's growth by cost share included), the physics and the drawing both take
// the scaled radius, and the visual eases to it on the swarm's radius spring.
//
// k solves Σ π (k·rᵢ + gap)² = ρ · free: the bodies' collision discs (the drawn
// radius plus the physics' fixed gap, which does not scale) cover the fraction ρ
// of the free area, which is the field less the obstacles the physics pads.
// With the gap scaled too that is k = √(ρ · free / Σ π (rᵢ + gap)²); solving it
// exactly keeps a small crowd from being overstated at the floor, where the
// fixed gap is a seventh of the disc. ρ is MEASURED (`SWARM_FIT.packing`): the
// densest packing whose settled crowd still keeps off every edge and obstacle.
//
// Two bounds. k is never above 1: the fit only ever shrinks today's sizes. And
// no body is solved or drawn below the floor radius, so k is never below
// `floor / the smallest base radius`; past that (a very large crowd) the crowd
// spills as it always did, under the host's fade, and every agent stays visible.
//
// A window drag must not make the crowd shimmer, so k moves on a grid and only
// grows past a dead band (`settleScale`): it shrinks to the step under the
// packed scale at once, and grows only when the packed scale clears the next
// step by the dead band.

/** A rectangle of the host's chrome, in field coordinates, unpadded (as `StageGeometry.obstacles`). */
export interface FitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FitField {
  readonly width: number;
  readonly height: number;
}

export const SWARM_FIT = Object.freeze({
  /**
   * ρ: the densest packing of collision discs that settles clean. Measured (SWF, 2026-10-13) with this view's own
   * physics, headless, default parameters, 8 s settled, on 1164 × 288 under a 56 px head, 1164 × 520, and 600 × 288
   * under the head, at 8, 20, 27 and 40 of the lab world's bodies: no body crosses an edge or enters the padded head
   * by more than 2 px. Without the grid the tightest case above the floor (40 bodies on 1164 × 520) is clean at 0.45
   * and not at 0.46 (3 seeds); with it, every case above the floor is clean up to 0.52 on 8 seeds, with the first
   * reds at 0.56. A crowd at the floor may spill, as ruled.
   */
  packing: 0.45,
  /** No body is solved or drawn below this radius, in CSS px. */
  floorRadius: 28,
  /** k moves in steps of this, 1/25: 0.56 (the floor at today's sizes) and 1 are both on the grid. */
  step: 0.04,
  /** …and grows only once the packed scale clears the next step by this much. */
  deadBand: 0.02,
});

/**
 * The field's area less the union of its obstacles, each padded as the physics
 * pads it and clipped to the field. A union, not a sum: two pieces of chrome
 * that overlap take their shared corner from the field once.
 */
export function freeArea(field: FitField, obstacles: readonly FitRect[], padding = CHROME_OBSTACLE_PADDING): number {
  const width = Math.max(0, field.width);
  const height = Math.max(0, field.height);
  const boxes = obstacles
    .map((rect) => ({
      left: Math.max(0, rect.x - padding),
      right: Math.min(width, rect.x + rect.width + padding),
      top: Math.max(0, rect.y - padding),
      bottom: Math.min(height, rect.y + rect.height + padding),
    }))
    .filter((box) => box.right > box.left && box.bottom > box.top);
  const xs = [...new Set(boxes.flatMap((box) => [box.left, box.right]))].sort((a, b) => a - b);
  let covered = 0;
  for (let index = 0; index + 1 < xs.length; index += 1) {
    const left = xs[index]!;
    const right = xs[index + 1]!;
    const spans = boxes
      .filter((box) => box.left <= left && box.right >= right)
      .map((box) => [box.top, box.bottom] as const)
      .sort((a, b) => a[0] - b[0]);
    let reach = Number.NEGATIVE_INFINITY;
    let tall = 0;
    for (const [top, bottom] of spans) {
      if (bottom <= reach) continue;
      tall += bottom - Math.max(top, reach);
      reach = bottom;
    }
    covered += (right - left) * tall;
  }
  return width * height - covered;
}

/**
 * The scale at which the crowd's collision discs cover `packing` of `free`:
 * the positive root of Σ π (k·rᵢ + gap)² = packing · free. Unclamped, so above 1
 * for a crowd with room to spare; 0 when the gaps alone would overfill it.
 */
export function packedScale(
  free: number,
  radii: readonly number[],
  packing: number = SWARM_FIT.packing,
  gap: number = PHYSICAL_GAP,
): number {
  if (radii.length === 0) return Number.POSITIVE_INFINITY;
  let squares = 0;
  let sum = 0;
  for (const radius of radii) {
    squares += radius * radius;
    sum += radius;
  }
  const a = Math.PI * squares;
  const b = 2 * Math.PI * gap * sum;
  const c = Math.PI * radii.length * gap * gap - packing * Math.max(0, free);
  if (a <= 0) return Number.POSITIVE_INFINITY;
  if (c >= 0) return 0;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** The lowest scale: the smallest base radius at the floor. 1 when even that body is at or under the floor. */
export function floorScale(smallestBase: number, floorRadius: number = SWARM_FIT.floorRadius): number {
  return smallestBase > floorRadius ? floorRadius / smallestBase : 1;
}

/** `value` on the grid, rounded down, within [floor, 1]. */
function onGrid(value: number, floor: number): number {
  const steps = Math.floor(value / SWARM_FIT.step + 1e-9);
  const gridded = Math.round(steps * SWARM_FIT.step * 1e6) / 1e6;
  return Math.min(1, Math.max(floor, gridded));
}

/**
 * The scale the crowd takes, from the packed scale and the one it holds now.
 * Shrinking is at once, to the step under the packed scale: an overpacked
 * crowd spills. Growing waits until the packed scale clears a step by the dead
 * band, so a field held near a step's edge (a window drag) does not flip
 * between two sizes.
 */
export function settleScale(packed: number, floor: number, previous: number): number {
  if (packed < previous) return onGrid(packed, floor);
  const grown = onGrid(packed - SWARM_FIT.deadBand, floor);
  return grown > previous ? grown : Math.min(1, Math.max(floor, previous));
}

export interface FitInput {
  readonly field: FitField;
  readonly obstacles: readonly FitRect[];
  /** Every body's base radius: what it is drawn at with room to spare. */
  readonly radii: readonly number[];
  /** The smallest base radius a body can have (the idle, working and blocked sizes' least). */
  readonly smallestBase: number;
}

/** One shared scale for the crowd, from the scale it holds now (1 before the first fit). */
export function fitScale(input: FitInput, previous = 1): number {
  const packed = packedScale(freeArea(input.field, input.obstacles), input.radii);
  return settleScale(packed, floorScale(input.smallestBase), previous);
}
