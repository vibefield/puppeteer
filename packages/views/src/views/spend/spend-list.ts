// The watchlist beside the chart (design B): its order and what fits. Rows run
// most spent first and hold still while the pointer is on the list (SV-D12);
// while you point back in time the list holds now's order (SV-D16 lean, with
// 'sink' and 'rank' kept as options); with more rows than fit, the list scrolls
// by whole rows and the waiting rows the scroll leaves out dock at its foot
// (SV-D19). Ported from the prototype's `render()` order and `paintWatch()`.

export type ScrubOrder = 'hold' | 'sink' | 'rank';

export interface OrderEntry {
  readonly id: string;
  /** What it had spent at the head (most first). */
  readonly value: number;
  readonly bornMs: number;
}

/** Most spent first; equal spend, the elder first. */
export function bySpend(entries: readonly OrderEntry[]): string[] {
  return [...entries].sort((a, b) => b.value - a.value || a.bornMs - b.bornMs).map((entry) => entry.id);
}

/**
 * The order the list shows. `held` is the order it showed while the pointer
 * rests on it (rows never move under the pointer); otherwise most spent at the
 * head. While scrubbing at `t`, 'hold' keeps that order, 'sink' sends the rows
 * not yet started below the rest (by start), 'rank' re-ranks by `valueAt(t)`.
 */
export function listOrder(
  entries: readonly OrderEntry[],
  options: {
    held?: readonly string[] | null | undefined;
    scrub?: { t: number; order: ScrubOrder; valueAt(id: string): number | undefined } | undefined;
  } = {},
): string[] {
  let order = bySpend(entries);
  if (options.held) {
    const index = new Map(options.held.map((id, i) => [id, i]));
    order = [...order].sort((a, b) => (index.get(a) ?? 1e9) - (index.get(b) ?? 1e9));
    return order;
  }
  const scrub = options.scrub;
  if (!scrub || scrub.order === 'hold') return order;
  const born = new Map(entries.map((entry) => [entry.id, entry.bornMs]));
  const at = new Map(order.map((id, i) => [id, i]));
  const started = (id: string): number => (scrub.t >= (born.get(id) ?? 0) ? 1 : 0);
  return [...order].sort((a, b) => {
    const s = started(b) - started(a);
    if (s) return s;
    if (!started(a)) return (born.get(a) ?? 0) - (born.get(b) ?? 0);
    if (scrub.order === 'rank') {
      const d = (scrub.valueAt(b) ?? 0) - (scrub.valueAt(a) ?? 0);
      if (d) return d;
    }
    return at.get(a)! - at.get(b)!;
  });
}

export interface ListFit {
  /** How many ordered rows show in sequence, from `offset`. */
  readonly fits: number;
  readonly offset: number;
  /** The most `offset` can be. */
  readonly maxOffset: number;
  /** Waiting rows out of sight, docked at the foot, longest wait first. */
  readonly docked: readonly string[];
  /** Whether a "more" row is shown, and what it counts. */
  readonly more: boolean;
  readonly below: number;
  readonly above: number;
  /** Waiting rows out of sight that did not dock. */
  readonly waitingUnshown: number;
}

/**
 * What fits in `cap` row slots. With more rows than slots one slot says how
 * many more; waiting rows the scroll leaves out dock under the sequence, at
 * most ⌊(cap−1)/3⌋ of them (a first cut docked all five and ate the list), the
 * longest wait first.
 */
export function fitList(
  order: readonly string[],
  cap: number,
  offset: number,
  waiting: ReadonlyMap<string, number>,
  dock = true,
): ListFit {
  const slots = Math.max(1, cap);
  const more = order.length > slots;
  /** The slots the sequence and the dock share: all but the "more" row's. */
  const shared = more ? slots - 1 : slots;
  let fits = shared;
  const max = Math.max(1, Math.floor((slots - 1) / 3));
  const out = (count: number, off: number): string[] =>
    dock && more ? order.filter((id, i) => (i < off || i >= off + count) && waiting.has(id)) : [];
  const dockOf = (count: number, off: number): string[] =>
    out(count, off)
      .sort((a, b) => waiting.get(a)! - waiting.get(b)!)
      .slice(0, max);
  const offOf = (count: number): number => Math.min(Math.max(0, offset), Math.max(0, order.length - count));
  let off = offOf(fits);
  let docked = dockOf(fits, off);
  // Each docked row takes a slot from the sequence, and a shorter sequence can leave another waiting row out:
  // shorten until the dock fits beside it (one pass overflowed the list by a row).
  while (docked.length && fits > 1 && fits + docked.length > shared) {
    fits = Math.max(1, shared - docked.length);
    off = offOf(fits);
    docked = dockOf(fits, off);
  }
  // The smallest lists: what still does not fit beside one row stays out of sight, counted as waiting.
  docked = docked.slice(0, Math.max(0, shared - fits));
  const dockSet = new Set(docked);
  const below = order.filter((id, i) => i >= off + fits && !dockSet.has(id)).length;
  const above = order.filter((id, i) => i < off && !dockSet.has(id)).length;
  return {
    fits: Math.min(fits, order.length),
    offset: off,
    maxOffset: Math.max(0, order.length - fits),
    docked,
    more,
    below,
    above,
    waitingUnshown: out(fits, off).length - docked.length,
  };
}

/** The "more" row's words. */
export function moreWords(fit: ListFit): string {
  if (fit.below > 0) return `${fit.below} more below${fit.above ? `, ${fit.above} above` : ''} · scroll`;
  return `${fit.above} above · scroll back`;
}
