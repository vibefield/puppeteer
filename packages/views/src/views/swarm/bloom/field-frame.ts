// The field under a bloom (SB §2.8), pure: the veil over every body, what the
// bloom points at eased back above it, the clearings faded in and out, and a
// birth's arrival from the bud it grew from. The render loop owns the clock and
// keeps the memory; nothing here reads the DOM or a GPU.

import type { MonitorAgent } from '../../../monitor/types.js';
import type { SwarmClearing } from '../gpu/swarm-renderer.js';
import { BLOOM } from './constants.js';
import { bloomView, litOf, type BloomState } from './model.js';

/** The veil and the clearings ease with this time constant (the prototype's 60 ms)… */
export const VEIL_TAU_MS = 60;
/** …and what the bloom points at rises above the veil, or sinks back, with this one (70 ms). */
export const LIT_TAU_MS = 70;

/** The prototype's ease: `1 − exp(−dt/τ)` of the way to the target each frame, snapping
 * the last 0.004. Reduced motion (or τ ≤ 0) arrives at once. */
export function approach(value: number, target: number, dtMs: number, tauMs: number, reduced = false): number {
  if (reduced || tauMs <= 0) return target;
  const next = value + (target - value) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
  return Math.abs(target - next) < 0.004 ? target : next;
}

type ClearingKey = 'ring' | 'desktop' | 'words';

interface KeptClearing {
  clearing: SwarmClearing;
  alpha: number;
  on: boolean;
}

/** What the field keeps between frames. */
export interface BloomFieldMemory {
  veil: number;
  readonly lit: Map<string, number>;
  readonly clearings: Map<ClearingKey, KeptClearing>;
}

export function bloomFieldMemory(): BloomFieldMemory {
  return { veil: 0, lit: new Map(), clearings: new Map() };
}

export interface BloomFieldStep {
  readonly state: BloomState | null;
  /** When the bloom closed, on `now`'s clock: after a commit the words' clearing stays `sayHold`. */
  readonly closedAt: number;
  readonly now: number;
  readonly dtMs: number;
  readonly reduced: boolean;
  /** The view's motion scale (the core's `motionScale`), 1 by default. */
  readonly motionScale?: number | undefined;
}

/** A clearing as it is drawn this frame, and how far it has faded in (0..1). */
export interface BloomFieldClearing {
  readonly clearing: SwarmClearing;
  readonly opacity: number;
}

export interface BloomFieldFrame {
  /** The field's quiet: the grid at (1 − veil), a body at (1 − veil × (1 − its lit)). */
  readonly veil: number;
  readonly clearings: readonly BloomFieldClearing[];
  /** Which rows the bloom lights now (SB-D8); none once it has closed. */
  readonly lit: (agent: MonitorAgent) => boolean;
}

/** Which of the view's clearings this is: ring one's circle stands at the hub, ring two's elsewhere, the words' is a rect. */
function keyOf(state: BloomState, clearing: SwarmClearing): ClearingKey {
  if (clearing.kind === 'rect') return 'words';
  return clearing.x === state.P.x && clearing.y === state.P.y ? 'ring' : 'desktop';
}

/** One frame of the field under the bloom: the veil eased toward `BLOOM.veil` while
 * it is open and back to 0 after; each clearing eased in while the view has it and
 * out (in its last place) once it has gone — after a commit the words' own stays
 * `sayHold`, then goes. */
export function stepBloomField(memory: BloomFieldMemory, step: BloomFieldStep): BloomFieldFrame {
  const scale = step.motionScale ?? 1;
  const state = step.state;
  const view = state ? bloomView(state) : null;
  memory.veil = approach(memory.veil, view?.veil ?? 0, step.dtMs, VEIL_TAU_MS * scale, step.reduced);
  const shown = new Set<ClearingKey>();
  if (state && view) {
    const closed = view.closed;
    const holding = !closed || step.now - step.closedAt < closed.sayHold;
    for (const clearing of holding ? view.clearings : []) {
      const key = keyOf(state, clearing);
      shown.add(key);
      const kept = memory.clearings.get(key);
      memory.clearings.set(key, { clearing, alpha: kept?.alpha ?? 0, on: true });
    }
  }
  const clearings: BloomFieldClearing[] = [];
  for (const [key, kept] of memory.clearings) {
    if (!shown.has(key)) kept.on = false;
    kept.alpha = approach(kept.alpha, kept.on ? 1 : 0, step.dtMs, VEIL_TAU_MS * scale, step.reduced);
    if (!kept.on && kept.alpha < 0.01) {
      memory.clearings.delete(key);
      continue;
    }
    clearings.push({ clearing: kept.clearing, opacity: kept.alpha });
  }
  return { veil: memory.veil, clearings, lit: state ? litOf(state) : () => false };
}

/** A body's lit mix one frame on (0 under the veil, 1 above it); forgotten once it is back at 0. */
export function stepLit(
  memory: BloomFieldMemory,
  id: string,
  lit: boolean,
  dtMs: number,
  reduced: boolean,
  motionScale = 1,
): number {
  const value = approach(memory.lit.get(id) ?? 0, lit ? 1 : 0, dtMs, LIT_TAU_MS * motionScale, reduced);
  if (value === 0) memory.lit.delete(id);
  else memory.lit.set(id, value);
  return value;
}

/** A body's opacity under the veil: the rest of the field recedes, what is lit keeps its own. */
export function veiledOpacity(opacity: number, veil: number, lit: number): number {
  return opacity * (1 - veil * (1 - lit));
}

/** The swarm's arrival (0 → 1.2 → 0.96 → 1.035 → 1 over `durationMs`), started from the size a
 * bud already had: `from` is its diameter over the body's. From 0 it is AgentSwarm's own curve;
 * from a bud, the body is whole at once and grows on from there (the prototype's `arrival`). */
export function arrivalFrom(elapsedMs: number, from: number, durationMs: number): { scale: number; opacity: number } {
  const t = elapsedMs / durationMs;
  const s0 = Math.max(0, from);
  if (t >= 1) return { scale: 1, opacity: 1 };
  if (t <= 0) return { scale: s0, opacity: s0 > 0 ? 1 : 0 };
  const outQuint = (u: number): number => 1 - (1 - u) ** 5;
  const outQuad = (u: number): number => 1 - (1 - u) ** 2;
  const inOut = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
  if (t < 0.52) {
    const u = outQuint(t / 0.52);
    return { scale: s0 + (1.2 - s0) * u, opacity: s0 > 0 ? 1 : u };
  }
  if (t < 0.72) return { scale: 1.2 + (0.96 - 1.2) * outQuint((t - 0.52) / 0.2), opacity: 1 };
  if (t < 0.88) return { scale: 0.96 + (1.035 - 0.96) * outQuad((t - 0.72) / 0.16), opacity: 1 };
  return { scale: 1.035 + (1 - 1.035) * inOut((t - 0.88) / 0.12), opacity: 1 };
}

/** A birth that never came (refused, or no row in time) goes back the way it came: it shrinks
 * away over the retract (M4: depart is not vanish). 1 → 0. */
export function departure(elapsedMs: number, motionScale = 1): { scale: number; opacity: number } {
  const t = Math.min(1, Math.max(0, elapsedMs / Math.max(1, BLOOM.retract * motionScale)));
  const k = 1 - t * t;
  return { scale: k, opacity: k };
}
