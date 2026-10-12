import type { MonitorPastSpan, MonitorPastSpanKind } from '@vibefield/puppeteer-view-sdk';
import { spanIndexAt, type LaneStatus, type TimelineLane, type TimelineLaneKind } from './timeline-lanes.js';

// A lane's wake: one closed, variable-width outline that swells into work and
// narrows through a short S-curve into a wait (DESIGN §8, "Godview's timeline
// is the swarm through time"). Produced as plain path commands so the shape is
// testable without a canvas; `toPath2D` is the thin adapter the painter uses.
//
// Runtime only (MV-6), a lane's wake is its current state alone, one segment.
// With the record's past (`history`, T3) it is the same wake: worked stretches
// at work's width, quiet ones at rest's hair, then the current state. Time the
// record does not cover breaks the wake into runs, each its own outline, with
// the dotted unrecorded thread between them.

/** What a stretch of wake shows: a lane's state, or `bounds`, the record's bounds alone (the floor), flat and faint. */
export type WakeStatus = LaneStatus | 'bounds';

/** Half the wake's thickness: work is wide, a wait you owe is a thread, the record's bounds a flat band, rest a hair. */
export function wakeRadius(kind: TimelineLaneKind, status: WakeStatus, laneHeight: number): number {
  if (kind === 'terminal') return status === 'working' ? 1.8 : 0.6;
  if (status === 'working') return Math.min(7.5, Math.max(4, laneHeight * 0.22));
  if (status === 'blocked' || status === 'unseen' || status === 'bounds') {
    return Math.min(3.8, Math.max(2.2, laneHeight * 0.115));
  }
  return 0.85;
}

export interface WakeSegment {
  /** The span's visible start and end, in ms. */
  readonly a: number;
  readonly b: number;
  /** The same in the canvas's x, the window's left edge at 0. */
  readonly x0: number;
  readonly x1: number;
  readonly status: WakeStatus;
  readonly r: number;
}

/** How each recorded stretch is drawn: work as work, a quiet stretch as rest's hair, the bounds flat (never the swell). */
const RECORDED: Readonly<Record<Exclude<MonitorPastSpanKind, 'unrecorded'>, WakeStatus>> = {
  worked: 'working',
  quiet: 'idle',
  bounds: 'bounds',
};

/** The recorded stretches that reach `[lo, end)`, in px from `t0`, onto `out`. An unrecorded one is no wake. */
function recordedSegments(
  out: WakeSegment[],
  past: readonly MonitorPastSpan[],
  kind: TimelineLaneKind,
  lo: number,
  end: number,
  t0: number,
  pxPerMs: number,
  laneHeight: number,
): WakeSegment[] {
  // Only the spans that reach the window: a lane may carry a day of them.
  for (let index = Math.max(0, spanIndexAt(past, lo)); index < past.length; index += 1) {
    const span = past[index]!;
    if (span.from >= end) break;
    if (span.kind === 'unrecorded') continue;
    const a = Math.max(span.from, lo);
    const b = Math.min(span.to, end);
    if (b <= a) continue;
    const status = RECORDED[span.kind];
    out.push({ a, b, x0: (a - t0) * pxPerMs, x1: (b - t0) * pxPerMs, status, r: wakeRadius(kind, status, laneHeight) });
  }
  return out;
}

/**
 * The lane between `t0` and `t1` (the head), in px from `t0`: its recorded stretches, then its current state (an
 * ended run's record stops at its last activity). Each starts no earlier than it does and a little before the window,
 * so the wake enters from off-canvas rather than starting at the edge.
 */
export function wakeSegments(
  lane: TimelineLane,
  t0: number,
  t1: number,
  pxPerMs: number,
  laneHeight: number,
  nowMs: number,
): WakeSegment[] {
  const lo = t0 - 30 / pxPerMs;
  if (lane.ended !== undefined) {
    const end = Math.min(lane.ended.endedAt, t1);
    return lane.past === undefined ? [] : recordedSegments([], lane.past, lane.kind, lo, end, t0, pxPerMs, laneHeight);
  }
  const out: WakeSegment[] =
    lane.past === undefined
      ? []
      : recordedSegments([], lane.past, lane.kind, lo, Math.min(lane.sinceMs, t1, nowMs), t0, pxPerMs, laneHeight);
  const end = Math.min(nowMs, t1);
  const span = lane.current;
  if (span.fromMs >= end) return out;
  const a = Math.max(span.fromMs, lane.sinceMs, t0 - 30 / pxPerMs);
  if (end <= a) return out;
  out.push({
    a,
    b: end,
    x0: (a - t0) * pxPerMs,
    x1: (end - t0) * pxPerMs,
    status: span.status,
    r: wakeRadius(lane.kind, span.status, laneHeight),
  });
  return out;
}

/** The wake as the record breaks it: one run per stretch of segments with no gap between them. */
export function wakeRuns(segments: readonly WakeSegment[]): WakeSegment[][] {
  const runs: WakeSegment[][] = [];
  let run: WakeSegment[] = [];
  for (const segment of segments) {
    const last = run[run.length - 1];
    if (last !== undefined && segment.a > last.b) {
      runs.push(run);
      run = [];
    }
    run.push(segment);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * The time in the lane's life between `t0` and `t1` that no recorded stretch covers (an unrecorded one included):
 * drawn as the dotted thread, the same as before a runtime lane's current state (T3). A row's life runs to its
 * current status; an ended run's to its last activity.
 */
export function unrecordedStretches(lane: TimelineLane, t0: number, t1: number): { a: number; b: number }[] {
  const from = Math.max(lane.bornMs, t0);
  const to = Math.min(lane.ended === undefined ? lane.sinceMs : lane.ended.endedAt, t1);
  const out: { a: number; b: number }[] = [];
  if (to <= from) return out;
  const past = lane.past ?? [];
  let cursor = from;
  for (let index = Math.max(0, spanIndexAt(past, from)); index < past.length && cursor < to; index += 1) {
    const span = past[index]!;
    if (span.from >= to) break;
    if (span.kind === 'unrecorded' || span.to <= cursor) continue;
    if (span.from > cursor) out.push({ a: cursor, b: span.from });
    cursor = span.to;
  }
  if (cursor < to) out.push({ a: cursor, b: to });
  return out;
}

/**
 * Where the runtime takes over a row's recorded past: its current state's start, when the record runs up to it
 * unbroken (a gap there is already the dotted thread). The x and the wake's half-thickness either side of it.
 */
export function wakeSeam(lane: TimelineLane, segments: readonly WakeSegment[]): { x: number; r: number } | undefined {
  if (lane.ended !== undefined || lane.past === undefined || segments.length < 2) return undefined;
  const current = segments[segments.length - 1]!;
  const before = segments[segments.length - 2]!;
  if (current.a !== lane.sinceMs || before.b !== current.a) return undefined;
  return { x: current.x0, r: Math.max(before.r, current.r) };
}

/** How far either side of a change the S-curve runs: never more than 5 px, never more than 40% of either span. */
export function neck(segments: readonly WakeSegment[], index: number): number {
  const a = segments[index]!;
  const b = segments[index + 1]!;
  return Math.max(0.5, Math.min(5, (a.x1 - a.x0) * 0.4, (b.x1 - b.x0) * 0.4));
}

export type PathCommand =
  | { readonly op: 'M' | 'L'; readonly x: number; readonly y: number }
  | {
      readonly op: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly op: 'A';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly op: 'Z' };

/** Whether the wake begins with a round cap: it starts where the lane's current state does, inside the window. */
export function capsStart(lane: TimelineLane, first: WakeSegment): boolean {
  const start = lane.ended === undefined ? Math.max(lane.bornMs, lane.sinceMs) : lane.bornMs;
  return first.a <= start + 1000 && first.x0 > -20;
}

/** Whether a run of a recorded wake begins with a round cap: where its first stretch begins, inside the window. */
export function capsRun(first: WakeSegment): boolean {
  return first.x0 > -20;
}

/** The outline: the top edge left to right, the bottom edge back, each change of thickness a short S-curve. */
export function wakeOutline(segments: readonly WakeSegment[], cy: number, capStart: boolean): PathCommand[] {
  const count = segments.length;
  if (count === 0) return [];
  const first = segments[0]!;
  const last = segments[count - 1]!;
  const out: PathCommand[] = [];
  if (capStart) {
    out.push({ op: 'M', x: first.x0 + first.r, y: cy + first.r });
    out.push({ op: 'A', cx: first.x0 + first.r, cy, r: first.r, start: Math.PI / 2, end: Math.PI * 1.5 });
  } else {
    out.push({ op: 'M', x: first.x0, y: cy + first.r });
    out.push({ op: 'L', x: first.x0, y: cy - first.r });
  }
  for (let index = 0; index < count - 1; index += 1) {
    const a = segments[index]!;
    const b = segments[index + 1]!;
    const n = neck(segments, index);
    const x = a.x1;
    out.push({ op: 'L', x: x - n, y: cy - a.r });
    if (a.r !== b.r) out.push({ op: 'C', x1: x, y1: cy - a.r, x2: x, y2: cy - b.r, x: x + n, y: cy - b.r });
    else out.push({ op: 'L', x: x + n, y: cy - b.r });
  }
  out.push({ op: 'L', x: last.x1, y: cy - last.r });
  out.push({ op: 'L', x: last.x1, y: cy + last.r });
  for (let index = count - 2; index >= 0; index -= 1) {
    const a = segments[index]!;
    const b = segments[index + 1]!;
    const n = neck(segments, index);
    const x = a.x1;
    out.push({ op: 'L', x: x + n, y: cy + b.r });
    if (a.r !== b.r) out.push({ op: 'C', x1: x, y1: cy + b.r, x2: x, y2: cy + a.r, x: x - n, y: cy + a.r });
    else out.push({ op: 'L', x: x - n, y: cy + a.r });
  }
  out.push({ op: 'Z' });
  return out;
}

export interface GradientStop {
  readonly offset: number;
  readonly color: string;
}

/**
 * The colours along the wake as a horizontal gradient: each change of colour
 * blends across its neck, so the hue turns where the shape does.
 */
export function wakeGradient(
  segments: readonly WakeSegment[],
  colorOf: (segment: WakeSegment) => string,
): GradientStop[] {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return [];
  const width = Math.max(1, last.x1 - first.x0);
  const at = (x: number): number => Math.min(1, Math.max(0, (x - first.x0) / width));
  const stops: GradientStop[] = [{ offset: 0, color: colorOf(first) }];
  let previous = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const a = segments[index]!;
    const b = segments[index + 1]!;
    const from = colorOf(a);
    const to = colorOf(b);
    if (from === to) continue;
    const n = neck(segments, index);
    const o1 = Math.max(previous, at(a.x1 - n));
    const o2 = Math.max(o1, at(a.x1 + n));
    stops.push({ offset: o1, color: from }, { offset: o2, color: to });
    previous = o2;
  }
  stops.push({ offset: 1, color: colorOf(last) });
  return stops;
}

/** The sheen along each stretch of work long enough to carry one: a 1 px line in the tube's upper half. */
export function wakeSheens(segments: readonly WakeSegment[], cy: number): { x0: number; x1: number; y: number }[] {
  const out: { x0: number; x1: number; y: number }[] = [];
  segments.forEach((segment, index) => {
    if (segment.status !== 'working' || segment.x1 - segment.x0 < 12 || segment.r < 3) return;
    const left = index > 0 ? neck(segments, index - 1) : segment.r;
    const right = index < segments.length - 1 ? neck(segments, index) : 0;
    const x0 = Math.max(segment.x0 + left + 2, -4);
    const x1 = segment.x1 - right - 2;
    if (x1 > x0) out.push({ x0, x1, y: cy - segment.r * 0.45 });
  });
  return out;
}

/** Replay commands into a canvas path. */
export function toPath2D(commands: readonly PathCommand[]): Path2D {
  const path = new Path2D();
  for (const command of commands) {
    if (command.op === 'M') path.moveTo(command.x, command.y);
    else if (command.op === 'L') path.lineTo(command.x, command.y);
    else if (command.op === 'C')
      path.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
    else if (command.op === 'A') path.arc(command.cx, command.cy, command.r, command.start, command.end);
    else path.closePath();
  }
  return path;
}
