import type { MonitorAgent } from './types.js';

// RECEDING (the VibeField agents-settings record's T3, Godview's profile tabs):
// a host that shows one group of sessions keeps every other one on the stage —
// where it was, in the physics, in the list — drawn faint. These are the numbers
// every view recedes by, and the one step the canvas views animate with; the
// list's stylesheet repeats them.

/** A receded body's weight while the shown ones are on the stage. */
export const RECEDED_OPACITY = 0.22;
/** Every body receded: the host has a sentence to say over the stage, so the rest step further back. */
export const RECEDED_EMPTY_OPACITY = 0.07;
/** How long a body takes to recede, or to come back. */
export const RECEDE_MS = 240;

/** Every row is receded: nothing the host chose is on the stage. */
export function everyReceded(agents: Iterable<MonitorAgent>): boolean {
  let any = false;
  for (const agent of agents) {
    if (agent.receded !== true) return false;
    any = true;
  }
  return any;
}

/** The weight a row is drawn at once it has settled: 1 when it is shown. */
export function recedeTarget(receded: boolean, every: boolean): number {
  if (!receded) return 1;
  return every ? RECEDED_EMPTY_OPACITY : RECEDED_OPACITY;
}

/** One frame's step toward the target: linear, the whole way back from 22 % in `RECEDE_MS`. */
export function approachRecede(current: number, target: number, deltaMs: number): number {
  const rate = ((1 - RECEDED_OPACITY) * Math.max(0, deltaMs)) / RECEDE_MS;
  if (Math.abs(target - current) <= rate) return target;
  return current + Math.sign(target - current) * rate;
}
