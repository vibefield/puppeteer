import type { MonitorHistorySpan, MonitorHistoryStatus } from '../../monitor/status-history.js';
import type { TimelineLane, TimelineLaneKind } from './timeline-lanes.js';

// A lane's wake: one closed, variable-width outline that swells into work and
// narrows through a short S-curve into a wait (DESIGN §8, "Godview's timeline
// is the swarm through time"). Produced as plain path commands so the shape is
// testable without a canvas; `toPath2D` is the thin adapter the painter uses.

/** Half the wake's thickness: work is wide, a wait you owe is a thread, rest is a hair. */
export function wakeRadius(kind: TimelineLaneKind, status: MonitorHistoryStatus, laneHeight: number): number {
  if (kind === 'terminal') return status === 'working' ? 1.8 : 0.6;
  if (status === 'working') return Math.min(7.5, Math.max(4, laneHeight * 0.22));
  if (status === 'blocked' || status === 'unseen') return Math.min(3.8, Math.max(2.2, laneHeight * 0.115));
  return 0.85;
}

export interface WakeSegment {
  /** The span's visible start and end, in ms. */
  readonly a: number;
  readonly b: number;
  /** The same in the canvas's x, the window's left edge at 0. */
  readonly x0: number;
  readonly x1: number;
  readonly span: MonitorHistorySpan;
  readonly status: MonitorHistoryStatus;
  readonly r: number;
  /** Still going: the head says its length, so the lit lane prints none for it. */
  readonly open: boolean;
}

/**
 * The lane's spans between `t0` and `t1` (the head), in px from `t0`. A span
 * starts no earlier than the record and a little before the window, so the
 * wake enters from off-canvas rather than starting at the edge.
 */
export function wakeSegments(
  lane: TimelineLane,
  t0: number,
  t1: number,
  pxPerMs: number,
  laneHeight: number,
  nowMs: number,
): WakeSegment[] {
  const end = Math.min(lane.endedAtMs ?? nowMs, t1);
  const lo = t0 - 30 / pxPerMs;
  const out: WakeSegment[] = [];
  for (const span of lane.spans) {
    const a = Math.max(span.fromMs, lane.recordedFromMs, lo);
    const b = Math.min(span.toMs ?? end, end);
    if (b <= a) continue;
    out.push({
      a,
      b,
      x0: (a - t0) * pxPerMs,
      x1: (b - t0) * pxPerMs,
      span,
      status: span.status,
      r: wakeRadius(lane.kind, span.status, laneHeight),
      open: span.toMs === undefined && lane.endedAtMs === undefined,
    });
  }
  return out;
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

/** Whether the wake begins with a round cap: it starts where the lane's record does, inside the window. */
export function capsStart(lane: TimelineLane, first: WakeSegment): boolean {
  return first.a <= Math.max(lane.bornMs, lane.recordedFromMs) + 1000 && first.x0 > -20;
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

export interface WakeLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** Inside the work (ground-coloured), or above a wait (in the state's ink, haloed). */
  readonly inside: boolean;
  readonly status: MonitorHistoryStatus;
}

/**
 * The lit lane speaks: each closed span's length, inside the work when the
 * tube is tall enough, above a wait otherwise, wherever it fits between `left`
 * (past the floating name) and `right` (short of the head).
 */
export function wakeLabels(
  segments: readonly WakeSegment[],
  cy: number,
  left: number,
  right: number,
  measure: (text: string) => number,
  format: (ms: number) => string,
): WakeLabel[] {
  const out: WakeLabel[] = [];
  for (const segment of segments) {
    if (segment.open) continue;
    const vx0 = Math.max(segment.x0, left);
    const vx1 = Math.min(segment.x1, right);
    const text = format((segment.span.toMs ?? segment.b) - segment.span.fromMs);
    if (vx1 - vx0 < measure(text) + 10) continue;
    const inside = segment.status === 'working' && segment.r * 2 >= 9;
    out.push({ text, x: (vx0 + vx1) / 2, y: inside ? cy + 0.5 : cy - segment.r - 6.5, inside, status: segment.status });
  }
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
