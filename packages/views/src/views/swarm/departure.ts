// A body leaving the field (DESIGN.md §6 "The departure", under M4: depart is not vanish; Q12, ruled 2026-10-27),
// pure: how far through its departure a body is, and which bodies are leaving once the rows change. The swarm keeps
// the ledger and the clock; nothing here reads the DOM or a GPU.
//
// With motion a leaving body shrinks where it stands, about its own centre, over the pop's own length on DESIGN's
// retract curve: it accelerates away, the arrival's pop run backwards, and it never fades (only cancelled ghosts
// fade). Under reduced motion (M6) it fades where it stands, at its size, in half the time on plain ease-out, and one
// whose row comes back fades up again from where its fade got to. With
// the host's animations switch off the stage is held still and the body is gone at once: nothing moves on a still
// stage.

/** The departure's length with motion: the pop's own 280ms (DESIGN §6's table), run backwards. */
export const DEPARTURE_MS = 280;
/** Under reduced motion (M6) durations halve. */
export const DEPARTURE_REDUCED_MS = DEPARTURE_MS / 2;

/** How the field moves now: with motion, under reduced motion (M6), or held still by the host's switch. */
export type DepartureMotion = 'motion' | 'reduced' | 'still';

/** The field's motion from the theme's two switches (MV-W4): the host's switch first, then the person's preference. */
export function departureMotion(switches: {
  readonly animations: boolean;
  readonly reducedMotion: boolean;
}): DepartureMotion {
  if (!switches.animations) return 'still';
  return switches.reducedMotion ? 'reduced' : 'motion';
}

/** CSS's `cubic-bezier(x1, y1, x2, y2)`, solved for y at x (both curves here are monotone in x). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const at = (s: number, p1: number, p2: number): number =>
    3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    if (at(middle, x1, x2) < x) low = middle;
    else high = middle;
  }
  return at((low + high) / 2, y1, y2);
}

/** DESIGN §6's retract, `cubic-bezier(0.4, 0, 1, 1)`: an ease-in, a hair sharper off the mark than CSS's. */
export function retractEase(x: number): number {
  return cubicBezier(0.4, 0, 1, 1, x);
}

/** CSS's `ease-out`, `cubic-bezier(0, 0, 0.58, 1)`. */
export function easeOut(x: number): number {
  return cubicBezier(0, 0, 0.58, 1, x);
}

/** How long a departure takes under the field's motion: none on a still stage. */
export function departureLength(motion: DepartureMotion): number {
  if (motion === 'motion') return DEPARTURE_MS;
  return motion === 'reduced' ? DEPARTURE_REDUCED_MS : 0;
}

/**
 * A leaving body `elapsedMs` into its departure: what its scale and its opacity are multiplied by, 1 → 0. With
 * motion it shrinks at full opacity; under reduced motion it fades at its size. Undefined once it has gone.
 */
export function leaving(elapsedMs: number, motion: DepartureMotion): { scale: number; opacity: number } | undefined {
  const length = departureLength(motion);
  if (elapsedMs >= length) return undefined;
  const t = Math.max(0, elapsedMs) / length;
  return motion === 'motion' ? { scale: 1 - retractEase(t), opacity: 1 } : { scale: 1, opacity: 1 - easeOut(t) };
}

/**
 * A body put back under reduced motion while it was fading (DESIGN §6, the departure's put-back), `elapsedMs` after:
 * what its opacity is multiplied by, up from the opacity its fade had reached (`from`) to whole, on plain ease-out over
 * that opacity's share of the reduced departure. Nothing pops. Undefined once it is whole again.
 */
export function fadingBack(elapsedMs: number, from: number): number | undefined {
  const length = DEPARTURE_REDUCED_MS * (1 - from);
  if (elapsedMs >= length) return undefined;
  return from + (1 - from) * easeOut(Math.max(0, elapsedMs) / length);
}

/** A body on its way out: when it began to leave, and the model it is drawn with until it has gone (its row has). */
export interface Departure<Model> {
  readonly at: number;
  readonly model: Model;
}

/**
 * The bodies leaving once the rows change, from the ones leaving before. Every body the field has drawn (`drawn`)
 * whose id the rows no longer ask for begins to leave at `now`, drawn with the model it had (`models`, the models
 * the field drew from until now); one already leaving keeps its start; one the rows ask for again is no longer
 * leaving, and is `returned` with the departure it was in, for the swarm to put back where it stands. A body never
 * drawn just goes.
 */
export function departuresAfter<Model>(
  before: ReadonlyMap<string, Departure<Model>>,
  models: ReadonlyMap<string, Model>,
  rows: ReadonlySet<string>,
  now: number,
  drawn: (id: string) => boolean,
): { readonly departing: Map<string, Departure<Model>>; readonly returned: ReadonlyMap<string, Departure<Model>> } {
  const departing = new Map<string, Departure<Model>>();
  const returned = new Map<string, Departure<Model>>();
  for (const [id, departure] of before) {
    if (rows.has(id)) returned.set(id, departure);
    else departing.set(id, departure);
  }
  for (const [id, model] of models) {
    if (rows.has(id) || departing.has(id) || !drawn(id)) continue;
    departing.set(id, { at: now, model });
  }
  return { departing, returned };
}
