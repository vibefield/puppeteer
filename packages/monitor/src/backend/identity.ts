import type { ProjectIdentityStore } from './ports.js';

export interface MemoryProjectIdentityStore extends ProjectIdentityStore {
  /** Every dealt key and its sequence: what a host writes down. */
  entries(): ReadonlyMap<string, number>;
  /** The next sequence to deal: VibeField's `next`, persisted beside the keys so a truncated record never rewinds. */
  next(): number;
}

/**
 * The in-memory identity store: sequences dealt from 0 in first-seen order,
 * never rewound, never reused. Both shipping dealers agree on this — VibeField's
 * `dealProjectSeqs` keeps a `next` counter, Godview's registry deals
 * `max(seq) + 1` — so this is the rule either host persists behind its port.
 * `initial` is what a host hands back; `next` is VibeField's floor (its cache
 * keeps the newest 256 keys but `next` keeps counting), and the larger of the
 * floor and the dealt sequences wins, as `loadProjectLedger` does.
 */
export function createMemoryProjectIdentityStore(
  initial: Iterable<readonly [string, number]> = [],
  options: { next?: number | undefined } = {},
): MemoryProjectIdentityStore {
  const seqByKey = new Map<string, number>();
  let next = Number.isSafeInteger(options.next) && (options.next as number) >= 0 ? (options.next as number) : 0;
  for (const [key, seq] of initial) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seqByKey.has(key)) continue;
    seqByKey.set(key, seq);
    next = Math.max(next, seq + 1);
  }
  return {
    seq: (key) => seqByKey.get(key),
    deal(key) {
      const known = seqByKey.get(key);
      if (known !== undefined) return known;
      const seq = next;
      next += 1;
      seqByKey.set(key, seq);
      return seq;
    },
    entries: () => seqByKey,
    next: () => next,
  };
}
