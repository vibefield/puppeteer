import { SWARM_WEIGHT } from '../weight.js';
import type { Rgba } from './color.js';
import type { SwarmFrame } from './swarm-renderer.js';

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
  /** the state glow's shape: inner, full, strength, unused */
  glowBand: 40,
  /** and its motion: count, speed, depth, unused */
  glowWave: 44,
} as const;

export const FRAME_FLOATS = 48;

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
  target[L.glowBand] = frame.stateGlow.inner;
  target[L.glowBand + 1] = frame.stateGlow.full;
  target[L.glowBand + 2] = frame.stateGlow.strength;
  target[L.glowBand + 3] = 0;
  target[L.glowWave] = frame.stateGlow.count;
  target[L.glowWave + 1] = frame.stateGlow.speed;
  target[L.glowWave + 2] = frame.stateGlow.depth;
  target[L.glowWave + 3] = 0;
}
