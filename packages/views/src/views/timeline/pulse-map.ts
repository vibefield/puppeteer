import type { MonitorHistorySpan } from '../../monitor/status-history.js';
import type { TimelineLane } from './timeline-lanes.js';

// The map of the day, drawn as Pulse (TL-D15): the whole field summed into one
// ridge. Work stacks above a line in each project's colour, its height the
// number of agents working; what waited on you hangs below it, orange then
// blue. Counts are drawn as a shape, never printed (FC-D18). Pure: buckets in,
// band outlines out, so the painter only fills what this hands it.

export interface PulseRow {
  /** The project's colour; rows that share it share a band. */
  readonly color: string;
  readonly recordedFromMs: number;
  /** Where the row's record stops: its end, or now. */
  readonly endMs: number;
  readonly spans: readonly MonitorHistorySpan[];
}

/**
 * The map's rows: every agent lane on the record (not only those in view),
 * except a receded one — the host is showing another group, and the map
 * counts what the stage counts.
 */
export function pulseRowsFor(lanes: readonly TimelineLane[], nowMs: number): PulseRow[] {
  return lanes
    .filter((lane) => lane.kind === 'agent' && !lane.receded)
    .map((lane) => ({
      color: lane.agent.color,
      recordedFromMs: lane.recordedFromMs,
      endMs: lane.endedAtMs ?? nowMs,
      spans: lane.spans,
    }));
}

export interface PulseGeometry {
  /** The map's drawn width and height, px. */
  readonly width: number;
  readonly height: number;
  /** Work's zone above the line, and the waits' below it. */
  readonly up: number;
  readonly down: number;
}

export const PULSE_GEOMETRY: Omit<PulseGeometry, 'width'> = { height: 34, up: 21, down: 10 };

export interface PulseBand {
  readonly color: string;
  /** Per bucket, the band's two edges in px (top < bottom). */
  readonly top: Float32Array;
  readonly bottom: Float32Array;
}

export interface PulseMap {
  /** Bucket centres, px. */
  readonly xs: Float32Array;
  /** Work bands from the line up: the project that worked most lies on the line. */
  readonly work: readonly PulseBand[];
  readonly blocked: PulseBand;
  readonly unseen: PulseBand;
  /** The line between the agents' time and yours. */
  readonly base: number;
  /** px per agent, above and below; the waits are never drawn at a larger scale than the work. */
  readonly kUp: number;
  readonly kDn: number;
}

/** Fraction of each bucket [start + i·dt, start + (i+1)·dt) that [a, b) covers, added into `into`. */
export function addCoverage(into: Float32Array, startMs: number, dt: number, a: number, b: number): void {
  if (b <= a) return;
  const count = into.length;
  const i0 = Math.max(0, Math.floor((a - startMs) / dt));
  const i1 = Math.min(count - 1, Math.floor((b - startMs) / dt));
  for (let index = i0; index <= i1; index += 1) {
    const s0 = startMs + index * dt;
    into[index]! += Math.max(0, Math.min(b, s0 + dt) - Math.max(a, s0)) / dt;
  }
}

const SMOOTH_RADIUS = 10;
const SMOOTH_SIGMA = 4;
const KERNEL = Array.from({ length: 2 * SMOOTH_RADIUS + 1 }, (_, index) =>
  Math.exp(-((index - SMOOTH_RADIUS) ** 2) / (2 * SMOOTH_SIGMA * SMOOTH_SIGMA)),
);
const KERNEL_SUM = KERNEL.reduce((sum, value) => sum + value, 0);

/** A normalised gaussian over buckets (σ 4 buckets ≈ 8 px), edges held, so the ridge rolls instead of stepping. */
export function smooth(values: Float32Array): Float32Array {
  const count = values.length;
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    let sum = 0;
    for (let offset = -SMOOTH_RADIUS; offset <= SMOOTH_RADIUS; offset += 1) {
      const at = Math.min(count - 1, Math.max(0, index + offset));
      sum += KERNEL[offset + SMOOTH_RADIUS]! * values[at]!;
    }
    out[index] = sum / KERNEL_SUM;
  }
  return out;
}

/** The two scales: work fills its zone (at most 6 px an agent), the waits theirs, never larger than work's. */
export function pulseScales(maxUp: number, maxDown: number, up: number, down: number): { kUp: number; kDn: number } {
  const kUp = Math.min(up / Math.max(0.5, maxUp), 6);
  return { kUp, kDn: Math.min(down / Math.max(0.5, maxDown), kUp) };
}

export function pulseMap(rows: readonly PulseRow[], startMs: number, nowMs: number, geometry: PulseGeometry): PulseMap {
  const { width, up, down } = geometry;
  const count = Math.max(40, Math.round(width / 2));
  const dt = Math.max(1, nowMs - startMs) / count;
  const colors: string[] = [];
  const work: Float32Array[] = [];
  const blocked = new Float32Array(count);
  const unseen = new Float32Array(count);
  for (const row of rows) {
    let band = colors.indexOf(row.color);
    if (band < 0) {
      band = colors.length;
      colors.push(row.color);
      work.push(new Float32Array(count));
    }
    for (const span of row.spans) {
      const a = Math.max(span.fromMs, row.recordedFromMs, startMs);
      const b = Math.min(span.toMs ?? row.endMs, row.endMs);
      const into =
        span.status === 'working'
          ? work[band]!
          : span.status === 'blocked'
            ? blocked
            : span.status === 'unseen'
              ? unseen
              : undefined;
      if (into) addCoverage(into, startMs, dt, a, b);
    }
  }
  // The project that worked most lies on the line, the least at the crest.
  const sums = work.map((values) => values.reduce((sum, value) => sum + value, 0));
  const rank = colors.map((_, index) => index).sort((a, b) => sums[b]! - sums[a]! || a - b);
  const bands = rank.map((index) => smooth(work[index]!));
  const blockedS = smooth(blocked);
  const unseenS = smooth(unseen);
  const upAt = (index: number): number => bands.reduce((sum, values) => sum + values[index]!, 0);
  const downAt = (index: number): number => blockedS[index]! + unseenS[index]!;
  let maxUp = 0;
  let maxDown = 0;
  for (let index = 0; index < count; index += 1) {
    maxUp = Math.max(maxUp, upAt(index));
    maxDown = Math.max(maxDown, downAt(index));
  }
  const { kUp, kDn } = pulseScales(maxUp, maxDown, up, down);
  const base = 1.5 + up;
  const xs = new Float32Array(count);
  for (let index = 0; index < count; index += 1) xs[index] = ((index + 0.5) / count) * width;

  const cumulative = new Float32Array(count);
  const workBands: PulseBand[] = bands.map((values, position) => {
    const top = new Float32Array(count);
    const bottom = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      bottom[index] = base - cumulative[index]! * kUp;
      cumulative[index]! += values[index]!;
      top[index] = base - cumulative[index]! * kUp;
    }
    return { color: colors[rank[position]!]!, top, bottom };
  });
  const hang = (lower: Float32Array, values: Float32Array): { top: Float32Array; bottom: Float32Array } => {
    const top = new Float32Array(count);
    const bottom = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      top[index] = base + lower[index]! * kDn;
      bottom[index] = base + (lower[index]! + values[index]!) * kDn;
    }
    return { top, bottom };
  };
  const none = new Float32Array(count);
  const blockedBand = { color: 'blocked', ...hang(none, blockedS) };
  const unseenBand = { color: 'unseen', ...hang(blockedS, unseenS) };

  return {
    xs,
    work: workBands,
    blocked: blockedBand,
    unseen: unseenBand,
    base,
    kUp,
    kDn,
  };
}
