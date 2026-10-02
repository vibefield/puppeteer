import { STATUS_HISTORY_HORIZON_MS } from '../../monitor/status-history.js';

// The timeline's clock face: how much time the window spans, where its right
// edge (the head) stands, and whether it follows now. Pure, so the view keeps
// one of these in a ref and the tests drive it without a frame.
//
// Following now until you look away (a drag, a key, the map); looking back
// holds the head still while now runs on; NOW glides back (600 ms, island).
// A zoom keeps the moment under the pointer where it is (240 ms, island).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ZoomPreset {
  readonly id: string;
  readonly label: string;
  readonly spanMs: number;
  readonly title: string;
}

export const ZOOM_PRESETS: readonly ZoomPreset[] = [
  { id: '15m', label: '15M', spanMs: 15 * MINUTE, title: 'Show 15 minutes' },
  { id: '1h', label: '1H', spanMs: HOUR, title: 'Show an hour' },
  { id: '4h', label: '4H', spanMs: 4 * HOUR, title: 'Show 4 hours' },
  { id: '12h', label: '12H', spanMs: 12 * HOUR, title: 'Show 12 hours' },
];

/** The window opens on the last hour (TL-D5). */
export const DEFAULT_SPAN_MS = HOUR;
export const SPAN_MIN_MS = 5 * MINUTE;
export const SPAN_MAX_MS = STATUS_HISTORY_HORIZON_MS;
export const ZOOM_TWEEN_MS = 240;
export const GLIDE_TWEEN_MS = 600;
/** A head this close to now is following it. */
const LIVE_SNAP_MS = 400;

export interface TimelineScale {
  readonly spanMs: number;
  /** The head: the window's right edge. */
  readonly endMs: number;
  readonly live: boolean;
}

export const clampSpan = (spanMs: number): number => Math.min(SPAN_MAX_MS, Math.max(SPAN_MIN_MS, spanMs));

export function initialScale(nowMs: number, spanMs = DEFAULT_SPAN_MS): TimelineScale {
  return { spanMs: clampSpan(spanMs), endMs: nowMs, live: true };
}

/** A following head moves with now; a held one stays where it was put. */
export function followNow(scale: TimelineScale, nowMs: number): TimelineScale {
  return scale.live && scale.endMs !== nowMs ? { ...scale, endMs: nowMs } : scale;
}

/** The earliest the head may stand: a quarter window past an hour before the first birth. */
export function earliestEnd(firstMs: number, spanMs: number, nowMs: number): number {
  return Math.max(firstMs - HOUR, nowMs - STATUS_HISTORY_HORIZON_MS) + spanMs * 0.25;
}

/** Put the head at `endMs`, clamped; within 400 ms of now it follows now again. */
export function headAt(scale: TimelineScale, endMs: number, nowMs: number, earliestMs: number): TimelineScale {
  const end = Math.min(nowMs, Math.max(Math.min(earliestMs, nowMs), endMs));
  const live = nowMs - end < LIVE_SNAP_MS;
  return { spanMs: scale.spanMs, endMs: live ? nowMs : end, live };
}

export function panBy(scale: TimelineScale, deltaMs: number, nowMs: number, earliestMs: number): TimelineScale {
  return headAt(scale, scale.endMs + deltaMs, nowMs, earliestMs);
}

/**
 * Zoom to `spanMs`, keeping the moment under the anchor in place. The anchor
 * is its distance in px from the head; a following head keeps following, so
 * only a held one moves its end.
 */
export function zoomAt(
  scale: TimelineScale,
  spanMs: number,
  anchorFromHeadPx: number,
  widthPx: number,
  nowMs: number,
): TimelineScale {
  const span = clampSpan(spanMs);
  if (scale.live || widthPx <= 0) return { ...scale, spanMs: span, endMs: scale.live ? nowMs : scale.endMs };
  const before = scale.spanMs / widthPx;
  const after = span / widthPx;
  const anchorMs = scale.endMs - anchorFromHeadPx * before;
  return { spanMs: span, endMs: Math.min(nowMs, anchorMs + anchorFromHeadPx * after), live: false };
}

/** DESIGN §6's island curve, cubic-bezier(0.25, 1, 0.3, 1), solved for y at x. */
export function islandEase(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    const bx = 3 * (1 - middle) * (1 - middle) * middle * 0.25 + 3 * (1 - middle) * middle * middle * 0.3 + middle ** 3;
    if (bx < x) low = middle;
    else high = middle;
  }
  const m = (low + high) / 2;
  return 3 * (1 - m) * (1 - m) * m + 3 * (1 - m) * m * m + m ** 3;
}

export interface ScaleTween {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly fromSpanMs: number;
  readonly toSpanMs: number;
  readonly fromEndMs: number;
  /** `'now'` chases now while it runs: the glide back. */
  readonly toEndMs: number | 'now';
  /** The scale follows now once the tween lands. */
  readonly live: boolean;
}

export function zoomTween(scale: TimelineScale, spanMs: number, at: number): ScaleTween {
  return {
    startedAt: at,
    durationMs: ZOOM_TWEEN_MS,
    fromSpanMs: scale.spanMs,
    toSpanMs: clampSpan(spanMs),
    fromEndMs: scale.endMs,
    toEndMs: scale.live ? 'now' : scale.endMs,
    live: scale.live,
  };
}

export function glideTween(scale: TimelineScale, at: number): ScaleTween {
  return {
    startedAt: at,
    durationMs: GLIDE_TWEEN_MS,
    fromSpanMs: scale.spanMs,
    toSpanMs: scale.spanMs,
    fromEndMs: scale.endMs,
    toEndMs: 'now',
    live: true,
  };
}

/** The scale `at` into a tween; reduced motion lands it at once. */
export function tweenAt(
  tween: ScaleTween,
  at: number,
  nowMs: number,
  reduced: boolean,
): { scale: TimelineScale; done: boolean } {
  const progress =
    reduced || tween.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (at - tween.startedAt) / tween.durationMs));
  const eased = islandEase(progress);
  const toEnd = tween.toEndMs === 'now' ? nowMs : tween.toEndMs;
  const done = progress >= 1;
  return {
    scale: {
      spanMs: tween.fromSpanMs + (tween.toSpanMs - tween.fromSpanMs) * eased,
      endMs: done ? toEnd : tween.fromEndMs + (toEnd - tween.fromEndMs) * eased,
      live: done ? tween.live : false,
    },
    done,
  };
}

const TICK_STEPS = [
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
] as const;

/** The finest step whose ticks stand at least `minPx` apart. */
export function tickStep(pxPerMs: number, minPx = 76): number {
  return TICK_STEPS.find((step) => step * pxPerMs >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

export interface TimelineTick {
  readonly t: number;
  readonly hour: boolean;
}

/** Ticks on local wall-clock multiples of `step` covering [from, to]. */
export function ticksBetween(fromMs: number, toMs: number, step: number): TimelineTick[] {
  const offset = new Date(fromMs).getTimezoneOffset() * MINUTE;
  const first = Math.ceil((fromMs - offset) / step) * step + offset;
  const out: TimelineTick[] = [];
  for (let t = first; t <= toMs; t += step) out.push({ t, hour: new Date(t).getMinutes() === 0 });
  return out;
}
