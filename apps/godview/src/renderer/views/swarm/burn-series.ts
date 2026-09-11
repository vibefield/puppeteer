import type { MonitorUsageSample } from '@vibecook/puppeteer-core';

// The burn graph's data: the last ten minutes of token rate as forty buckets
// of intensity, oldest first, the newest being the live rate. The decided
// swarm design (proposals pass 9) draws this as the line across a working
// body, so the shape here is exactly what the body shader samples.

export const BURN_SAMPLE_COUNT = 40;
export const BURN_WINDOW_MS = 10 * 60_000;
/** 500 tok/min is the floor of the scale: below it the line rests on the bottom. */
export const BURN_FLOOR_PER_MIN = 500;
/** Two decades above the floor, 50 000 tok/min, is the top of the body. */
export const BURN_DECADES = 2;
/** The redline: the last fifth of the scale, where the end point turns orange. */
export const BURN_HOT = 0.8;

/** Intensity on the log scale, `clamp((log10(rate) − log10(500)) / 2, 0, 1)`. */
export function burnIntensity(ratePerMin: number | undefined): number {
  if (ratePerMin === undefined || !(ratePerMin > 0)) return 0;
  const value = (Math.log10(ratePerMin) - Math.log10(BURN_FLOOR_PER_MIN)) / BURN_DECADES;
  return Math.max(0, Math.min(1, value));
}

export interface BurnSeriesInput {
  samples: readonly MonitorUsageSample[];
  /** Core's corrected live rate; when present it is the newest bucket verbatim. */
  burnRatePerMin?: number;
  nowMs: number;
}

interface Point {
  at: number;
  tokens: number;
}

function orderedPoints(
  samples: readonly MonitorUsageSample[],
  field: 'cumulativeTokens' | 'inputTokens' | 'outputTokens' = 'cumulativeTokens',
): Point[] {
  const points: Point[] = [];
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    const tokens = sample[field];
    if (!Number.isFinite(at) || tokens === undefined || !Number.isFinite(tokens)) continue;
    points.push({ at, tokens });
  }
  return points.sort((left, right) => left.at - right.at);
}

/** Cumulative tokens at `at`, linear between samples, flat after the last, and
 * zero-growth before the first: no sample is no evidence of any burn. */
function cumulativeAt(points: readonly Point[], at: number): number {
  const first = points[0];
  if (!first) return 0;
  if (at <= first.at) return first.tokens;
  const last = points[points.length - 1]!;
  if (at >= last.at) return last.tokens;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle]!.at <= at) low = middle;
    else high = middle;
  }
  const from = points[low]!;
  const to = points[high]!;
  const span = to.at - from.at;
  if (span <= 0) return to.tokens;
  return from.tokens + ((to.tokens - from.tokens) * (at - from.at)) / span;
}

function bucketed(points: readonly Point[], nowMs: number): Float32Array {
  const series = new Float32Array(BURN_SAMPLE_COUNT);
  const bucketMs = BURN_WINDOW_MS / BURN_SAMPLE_COUNT;
  const start = nowMs - BURN_WINDOW_MS;
  if (points.length > 0) {
    for (let index = 0; index < BURN_SAMPLE_COUNT; index += 1) {
      const from = start + index * bucketMs;
      const to = from + bucketMs;
      const tokens = Math.max(0, cumulativeAt(points, to) - cumulativeAt(points, from));
      series[index] = burnIntensity(tokens / (bucketMs / 60_000));
    }
  }
  return series;
}

/** Forty intensities, oldest first. Source corrections may move the cumulative
 * count down; a bucket never reports a negative rate for it. */
export function burnSeries(input: BurnSeriesInput): Float32Array {
  const series = bucketed(orderedPoints(input.samples), input.nowMs);
  if (input.burnRatePerMin !== undefined) series[BURN_SAMPLE_COUNT - 1] = burnIntensity(input.burnRatePerMin);
  return series;
}

/** The two-sided chart's data: the completion side (`up`, output and
 * reasoning) and the prompt side (`down`, input and cache) as forty
 * intensities each, oldest first. */
export interface BurnSides {
  up: Float32Array;
  down: Float32Array;
  /** Whether the source split its usage; without a split `up` is the total and `down` rests. */
  split: boolean;
}

/** Output up, input down, from the samples' sides; a source that does not
 * split its usage puts the whole burn up, with the live rate as the newest
 * bucket, and nothing down. */
export function burnSides(input: BurnSeriesInput): BurnSides {
  const outputs = orderedPoints(input.samples, 'outputTokens');
  const inputs = orderedPoints(input.samples, 'inputTokens');
  if (outputs.length === 0 && inputs.length === 0) {
    return { up: burnSeries(input), down: new Float32Array(BURN_SAMPLE_COUNT), split: false };
  }
  return { up: bucketed(outputs, input.nowMs), down: bucketed(inputs, input.nowMs), split: true };
}
