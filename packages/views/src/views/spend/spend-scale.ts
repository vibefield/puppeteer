// The spend view's scales: money up the right of the plot, linear from $0 to a
// round top (SV-D8, no Log), and time along the foot over the last ten minutes
// Core holds, always ending at now (runtime only, §B′: no ranges, no pan, no
// zoom). Ported from the prototype's `niceStep` and the window logic of
// `SpendView` (`draft/godview-spend/site/sv-chart.js`).

const MINUTE = 60_000;

/** A cost series' step and its length, as the model carries them today (`MonitorCost.series`: 20 × 30 s). */
export const SPEND_STEP_MS = 30_000;
export const SPEND_STEP_COUNT = 20;

/**
 * The window: the last ten minutes Core holds, ending at now. Core keeps twenty
 * 30-second buckets, the last the one now is in, so the oldest began between
 * nine and a half and ten minutes ago; the window is the nine and a half that
 * every row's buckets always cover. A full ten would open a sliver at the left
 * edge that no bucket reaches, growing and vanishing every 30 seconds.
 */
export const SPEND_WINDOW_MS = (SPEND_STEP_COUNT - 1) * SPEND_STEP_MS;

export interface SpendWindow {
  readonly ta: number;
  readonly tb: number;
}

export const spendWindow = (nowMs: number): SpendWindow => ({ ta: nowMs - SPEND_WINDOW_MS, tb: nowMs });

/** A moment the pointer reads or a click sets: never outside the window. */
export const momentIn = (t: number, window: SpendWindow): number => Math.min(window.tb, Math.max(window.ta, t));

/** A moment a click set, while the window holds it: once the window has slid past it, it lets go. */
export const heldIn = (held: number | null, window: SpendWindow): number | null =>
  held !== null && held >= window.ta && held <= window.tb ? held : null;

/** The step that puts about `count` round lines under `max`: 1, 2, 2.5 or 5 of a power of ten. */
export function niceStep(max: number, count: number): number {
  const raw = Math.max(max, 1e-6) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** The scale's step and its round top for the highest line (at least half a dollar, 6% of air above it). */
export function moneyScale(top: number, compact: boolean): { step: number; max: number } {
  const high = Math.max(0.5, top) * 1.06;
  const step = niceStep(high, compact ? 3 : 7);
  return { step, max: Math.ceil(high / step) * step };
}

/** One frame of the eased top: a new high never jumps (the prototype's 0.18 a frame). */
export function easeTop(shown: number | null, target: number): number {
  if (shown === null) return target;
  const next = shown + (target - shown) * 0.18;
  return Math.abs(target - next) <= target * 0.002 ? target : next;
}

/** The money ticks from $0 to the top. */
export function moneyTicks(max: number, step: number): number[] {
  const out: number[] = [];
  for (let value = 0; value <= max + 1e-9; value += step) out.push(+value.toFixed(6));
  return out;
}

/** A tick every two minutes. */
export const TIME_TICK_MS = 2 * MINUTE;

/**
 * The time ticks inside [ta, tb]: every two minutes, every four where
 * two-minute labels would touch (the narrowest plate); none by the left edge
 * or within `clear` px of a chip.
 */
export function timeTicks(
  ta: number,
  tb: number,
  x0: number,
  x1: number,
  chips: readonly number[],
  clear = 46,
): { t: number; x: number }[] {
  const perMs = (x1 - x0) / Math.max(1, tb - ta);
  let step = TIME_TICK_MS;
  while (step * perMs < 48) step *= 2;
  const out: { t: number; x: number }[] = [];
  for (let t = Math.ceil(ta / step) * step; t <= tb; t += step) {
    const x = x0 + (t - ta) * perMs;
    if (x < x0 + 18 || chips.some((chip) => Math.abs(x - chip) < clear)) continue;
    out.push({ t, x });
  }
  return out;
}
