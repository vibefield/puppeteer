import { USAGE_STEP_COUNT, type UsageHistory } from '../../monitor/usage-ledger.js';

// The burn bars' data: the ledger's steps as column heights, oldest first,
// the newest at the right. Each side is scaled to its own tallest column, so
// the chart always fills the band and reads as the session's rhythm rather
// than its place on an absolute scale. The shape here is exactly what the body
// shader samples: one value per column, both sides.

/** One column per ledger step: twenty, ten minutes. */
export const BURN_BAR_COUNT = USAGE_STEP_COUNT;

export interface BurnBars {
  /** The completion side (output, reasoning), 0 to 1 against its tallest column. */
  up: Float32Array;
  /** The prompt side (input, cache), 0 to 1 against its tallest column. */
  down: Float32Array;
  /** Whether the source split its usage; without a split `up` is the total and `down` rests. */
  split: boolean;
}

/** Heights against the tallest step; all zero while nothing has burned. */
export function scaledBars(steps: readonly number[]): Float32Array {
  const bars = new Float32Array(BURN_BAR_COUNT);
  let tallest = 0;
  for (const step of steps) if (step > tallest) tallest = step;
  if (tallest <= 0) return bars;
  const offset = BURN_BAR_COUNT - steps.length;
  steps.forEach((step, index) => {
    if (offset + index >= 0) bars[offset + index] = Math.max(0, step) / tallest;
  });
  return bars;
}

/** Output up, input down when the source splits its usage; otherwise the whole burn up and nothing down. */
export function burnBars(history: UsageHistory): BurnBars {
  if (history.sides) {
    return { up: scaledBars(history.sides.output), down: scaledBars(history.sides.input), split: true };
  }
  return { up: scaledBars(history.steps), down: new Float32Array(BURN_BAR_COUNT), split: false };
}
