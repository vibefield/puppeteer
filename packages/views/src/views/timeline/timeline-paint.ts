import { laneAlpha, type LaneStatus, type TimelineLane } from './timeline-lanes.js';
import { css, type TimelineInks } from './timeline-inks.js';
import type { PulseBand, PulseMap } from './pulse-map.js';
import { ticksBetween, tickStep } from './timeline-scale.js';
import { capsStart, toPath2D, wakeGradient, wakeOutline, wakeSegments, wakeSheens } from './wake-geometry.js';

// The timeline's two canvases: the wakes behind the lanes, and the map of the
// day. Every colour here comes from the palette the host hands the view (the
// swarm's own resolved orange and blue, the instrument ramp, `timeline-inks.ts`)
// or from a row's project colour; the only other values are alphas of those.

const HOUR = 3_600_000;

export interface PlacedLane {
  readonly lane: TimelineLane;
  readonly y: number;
  readonly h: number;
}

export interface WakePaint {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly lanes: readonly PlacedLane[];
  /** The window: its left edge and the head. */
  readonly t0: number;
  readonly t1: number;
  readonly nowMs: number;
  /** The lit lane, or -1 when all are lit. */
  readonly lit: number;
  readonly glow: number;
}

function wakeColour(inks: TimelineInks, lane: TimelineLane, status: LaneStatus): string {
  if (lane.kind === 'terminal') return css(status === 'working' ? inks.muted : inks.border);
  if (status === 'working') return css(inks.project(lane.row.colour));
  if (status === 'blocked') return css(inks.orange);
  if (status === 'unseen') return css(inks.blue);
  return css(inks.faint);
}

/** The wakes: the grid, then each lane's dotted unrecorded thread and its outline, with its light and its sheen. */
export function paintWakes(ctx: CanvasRenderingContext2D, paint: WakePaint, inks: TimelineInks): void {
  const { width, height, ratio, t0, t1, nowMs, lit } = paint;
  const k = width / Math.max(1, t1 - t0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const X = (t: number): number => (t - t0) * k;

  // The ticks' hairlines, behind everything; the hours a little firmer.
  const step = tickStep(k);
  for (const tick of ticksBetween(t0 - step, t1, step)) {
    ctx.fillStyle = tick.hour ? css(inks.ink, inks.dark ? 0.09 : 0.07) : css(inks.grid);
    ctx.fillRect(Math.round(X(tick.t)), 0, 1, height);
  }

  const blur = 'filter' in ctx;
  paint.lanes.forEach((placed, index) => {
    const { lane, y, h } = placed;
    const cy = y + h / 2;
    const fade = laneAlpha(lane, index, lit);
    ctx.globalAlpha = fade;
    // From its birth to its current state the lane claims nothing (runtime only): a dotted thread, never a state.
    if (lane.sinceMs > lane.bornMs) {
      const a = Math.max(lane.bornMs, t0);
      const b = Math.min(lane.sinceMs, t1, nowMs);
      if (b > a) {
        ctx.save();
        ctx.setLineDash([1.2, 3.4]);
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = css(inks.faint);
        ctx.beginPath();
        ctx.moveTo(X(a), cy);
        ctx.lineTo(X(b), cy);
        ctx.stroke();
        ctx.restore();
      }
    }
    const segments = wakeSegments(lane, t0, t1, k, h, nowMs);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!first || !last) return;
    const path = toPath2D(wakeOutline(segments, cy, capsStart(lane, first)));
    const gradient = ctx.createLinearGradient(first.x0, 0, Math.max(first.x0 + 1, last.x1), 0);
    for (const stop of wakeGradient(segments, (segment) => wakeColour(inks, lane, segment.status))) {
      gradient.addColorStop(stop.offset, stop.color);
    }
    // The light around it first (the outline's own blur), then the wake.
    if (blur && lane.kind === 'agent' && paint.glow > 0) {
      ctx.save();
      ctx.filter = `blur(${inks.dark ? 6 : 5}px)`;
      ctx.globalAlpha = fade * Math.min(1, (inks.dark ? 0.62 : 0.24) * paint.glow);
      ctx.fillStyle = gradient;
      ctx.fill(path);
      ctx.restore();
      ctx.globalAlpha = fade;
    }
    ctx.fillStyle = gradient;
    ctx.fill(path);
    // A sheen along the work, so it reads as a lit tube rather than a bar.
    if (lane.kind === 'agent') {
      ctx.strokeStyle = inks.dark ? css(inks.ink, 0.28) : css(inks.ground, 0.4);
      ctx.lineWidth = 1;
      for (const sheen of wakeSheens(segments, cy)) {
        ctx.beginPath();
        ctx.moveTo(sheen.x0, sheen.y);
        ctx.lineTo(sheen.x1, sheen.y);
        ctx.stroke();
      }
    }
  });
  ctx.globalAlpha = 1;
  // The head's light: a soft column the bodies sit in.
  const light = ctx.createLinearGradient(width - 44, 0, width, 0);
  light.addColorStop(0, css(inks.ink, 0));
  light.addColorStop(1, css(inks.ink, inks.dark ? 0.09 : 0.06));
  ctx.fillStyle = light;
  ctx.fillRect(width - 44, 0, 44, height);
}

export interface MapPaint {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly startMs: number;
  readonly nowMs: number;
  readonly font: string;
}

function fillBand(ctx: CanvasRenderingContext2D, xs: Float32Array, band: PulseBand, width: number): void {
  const count = xs.length;
  ctx.beginPath();
  ctx.moveTo(0, band.top[0]!);
  for (let index = 0; index < count; index += 1) ctx.lineTo(xs[index]!, band.top[index]!);
  ctx.lineTo(width, band.top[count - 1]!);
  ctx.lineTo(width, band.bottom[count - 1]!);
  for (let index = count - 1; index >= 0; index -= 1) ctx.lineTo(xs[index]!, band.bottom[index]!);
  ctx.lineTo(0, band.bottom[0]!);
  ctx.closePath();
  ctx.fill();
}

function traceEdge(ctx: CanvasRenderingContext2D, xs: Float32Array, edge: Float32Array, colour: string): void {
  ctx.beginPath();
  for (let index = 0; index < xs.length; index += 1) ctx.lineTo(xs[index]!, edge[index]!);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

/** Pulse: the ridge, its light copied from itself, and the hours behind it. */
export function paintPulse(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  map: PulseMap,
  paint: MapPaint,
  inks: TimelineInks,
): void {
  const { width, height, ratio, startMs, nowMs } = paint;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  const edge = css(inks.ground, 0.7);
  map.work.forEach((band, index) => {
    ctx.fillStyle = css(inks.project(band.color));
    fillBand(ctx, map.xs, band, width);
    // Each band's upper edge, traced in the ground, keeps the layers crisp.
    if (index < map.work.length - 1) traceEdge(ctx, map.xs, band.top, edge);
  });
  ctx.fillStyle = css(inks.orange);
  fillBand(ctx, map.xs, map.blocked, width);
  traceEdge(ctx, map.xs, map.blocked.bottom, edge);
  ctx.fillStyle = css(inks.blue);
  fillBand(ctx, map.xs, map.unseen, width);
  // The line between the agents' time and yours.
  ctx.fillStyle = css(inks.ink, inks.dark ? 0.32 : 0.28);
  ctx.fillRect(0, map.base - 0.25, width, 0.5);
  // The light around it, behind it: the same blur as the wakes', copied from what was just drawn.
  if ('filter' in ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.filter = `blur(${inks.dark ? 2.5 : 2}px)`;
    ctx.globalAlpha = inks.dark ? 0.75 : 0.4;
    ctx.drawImage(canvas, 0, 0, width, height);
    ctx.restore();
  }
  // The hours, behind everything: a hairline and the hour's number, which the day's work rises over.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.font = `700 7.5px ${paint.font}`;
  ctx.textBaseline = 'top';
  const range = Math.max(1, nowMs - startMs);
  const X = (t: number): number => ((t - startMs) / range) * width;
  const hourPx = (HOUR / range) * width;
  const first = new Date(startMs);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + HOUR; t < nowMs; t += HOUR) {
    const x = Math.round(X(t));
    if (hourPx >= 30 && x < width - 18) {
      ctx.fillStyle = css(inks.ink, inks.dark ? 0.34 : 0.36);
      ctx.fillText(String(new Date(t).getHours()).padStart(2, '0'), x + 3, 2);
    }
    ctx.fillStyle = css(inks.ink, inks.dark ? 0.08 : 0.07);
    ctx.fillRect(x, 0, 1, height);
  }
  ctx.restore();
}
