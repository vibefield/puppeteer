import { SWARM_WEIGHT } from '../weight.js';
import type { Rgba } from '@vibecook/puppeteer-view-sdk/toolkit';
import type { SwarmClearing, SwarmFrame } from './swarm-renderer.js';

// The frame uniform, float for float: what `common.wgsl`'s `Frame` struct
// reads. Pure, so the layout is testable without a GPU; the renderer packs
// through it once a frame. Every member is a vec4, so each sits on a 16-byte
// boundary and the offsets below are the struct's own, in floats.

export const FRAME_LAYOUT = {
  /** width, height (CSS px), device pixel ratio, time (s) */
  viewport: 0,
  /** body fill opacity, motion (0/1), grid pitch (px), veil (0..1) */
  params: 4,
  grid: 8,
  shadow: 12,
  shadowPeak: 16,
  /** the hold ring or the hub: x, y, progress (1 when frozen), opacity (0: none) */
  pointer: 20,
  orange: 24,
  holdRim: 28,
  holdFill: 32,
  holdInk: 36,
  /** the ring's rim width and dot radius (px), unused ×2 */
  holdShape: 40,
  /** the state glow's shape: inner, full, strength, unused */
  glowBand: 44,
  /** and its motion: count, speed, depth, unused */
  glowWave: 48,
  /** how many clearings are set, unused ×3 */
  clearing: 52,
  /** `MAX_CLEARINGS` × `Clearing`: shape (centre x, y, radius | half w, half h), edge (feather, kind, opacity, 0) */
  clearings: 56,
} as const;

/** The hold ring while a press is in flight: a 1 px rim and a 2 px dot. */
export const HOLD_RING = { rim: 1, dot: 2 } as const;
/** The spawn bloom's hub, the ring frozen at full size: heavier, as the prototype's v2 draws it (1.5 px, 2.5 px). */
export const HUB_RING = { rim: 1.5, dot: 2.5 } as const;

/** The most clearings a frame draws; the rest are ignored. `erase.wgsl` loops to the same bound. */
export const MAX_CLEARINGS = 4;
export const CLEARING_FLOATS = 8;
export const FRAME_FLOATS = FRAME_LAYOUT.clearings + MAX_CLEARINGS * CLEARING_FLOATS;

/** Where a frame is drawn: the canvas in CSS px, its pixel ratio, and the renderer's held clock (s). */
export interface FrameView {
  width: number;
  height: number;
  dpr: number;
  time: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function writeRgba(target: Float32Array, offset: number, colour: Rgba, alphaScale = 1): void {
  target[offset] = colour[0];
  target[offset + 1] = colour[1];
  target[offset + 2] = colour[2];
  target[offset + 3] = colour[3] * alphaScale;
}

/** Packs `frame` into `target` (at least `FRAME_FLOATS` long), every float of it. */
export function packFrame(target: Float32Array, frame: SwarmFrame, view: FrameView): void {
  const L = FRAME_LAYOUT;
  const theme = frame.theme;
  target[L.viewport] = view.width;
  target[L.viewport + 1] = view.height;
  target[L.viewport + 2] = view.dpr;
  target[L.viewport + 3] = view.time;
  target[L.params] = frame.fillOpacity;
  target[L.params + 1] = frame.motion ? 1 : 0;
  target[L.params + 2] = frame.gridPitch;
  target[L.params + 3] = clamp01(frame.veil ?? 0);
  writeRgba(target, L.grid, theme.grid);
  writeRgba(target, L.shadow, theme.shadow, frame.fillOpacity);
  writeRgba(target, L.shadowPeak, theme.shadowPeak, frame.fillOpacity);
  // The hub is the ring's final look — full size, full ink — held while the
  // bloom is open and faded by its opacity as the bloom closes.
  const hold = frame.hold;
  target[L.pointer] = hold?.x ?? 0;
  target[L.pointer + 1] = hold?.y ?? 0;
  target[L.pointer + 2] = hold ? (hold.frozen ? 1 : clamp01(hold.progress)) : 0;
  target[L.pointer + 3] = hold ? clamp01(hold.opacity ?? 1) : 0;
  writeRgba(target, L.orange, theme.orange);
  writeRgba(target, L.holdRim, [theme.ink[0], theme.ink[1], theme.ink[2], SWARM_WEIGHT.supporting]);
  writeRgba(target, L.holdFill, theme.surface, 0.74);
  writeRgba(target, L.holdInk, theme.ink);
  const ring = hold?.frozen ? HUB_RING : HOLD_RING;
  target[L.holdShape] = ring.rim;
  target[L.holdShape + 1] = ring.dot;
  target[L.holdShape + 2] = 0;
  target[L.holdShape + 3] = 0;
  target[L.glowBand] = frame.stateGlow.inner;
  target[L.glowBand + 1] = frame.stateGlow.full;
  target[L.glowBand + 2] = frame.stateGlow.strength;
  target[L.glowBand + 3] = 0;
  target[L.glowWave] = frame.stateGlow.count;
  target[L.glowWave + 1] = frame.stateGlow.speed;
  target[L.glowWave + 2] = frame.stateGlow.depth;
  target[L.glowWave + 3] = 0;
  const clearings = frame.clearings ?? [];
  const count = Math.min(clearings.length, MAX_CLEARINGS);
  target[L.clearing] = count;
  target[L.clearing + 1] = 0;
  target[L.clearing + 2] = 0;
  target[L.clearing + 3] = 0;
  for (let index = 0; index < MAX_CLEARINGS; index += 1) {
    packClearing(target, L.clearings + index * CLEARING_FLOATS, index < count ? clearings[index] : undefined);
  }
}

/** One clearing as the shader reads it: a rect by its centre and half extents. */
function packClearing(target: Float32Array, offset: number, clearing: SwarmClearing | undefined): void {
  if (!clearing) {
    target.fill(0, offset, offset + CLEARING_FLOATS);
    return;
  }
  if (clearing.kind === 'circle') {
    target[offset] = clearing.x;
    target[offset + 1] = clearing.y;
    target[offset + 2] = Math.max(0, clearing.radius);
    target[offset + 3] = 0;
  } else {
    const halfWidth = Math.max(0, clearing.width) / 2;
    const halfHeight = Math.max(0, clearing.height) / 2;
    target[offset] = clearing.x + halfWidth;
    target[offset + 1] = clearing.y + halfHeight;
    target[offset + 2] = halfWidth;
    target[offset + 3] = halfHeight;
  }
  target[offset + 4] = Math.max(0, clearing.feather);
  target[offset + 5] = clearing.kind === 'rect' ? 1 : 0;
  target[offset + 6] = clamp01(clearing.opacity ?? 1);
  target[offset + 7] = 0;
}
