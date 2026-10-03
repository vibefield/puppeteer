import type { ProjectIdentityStore } from './ports.js';

/**
 * The in-memory identity store: sequences dealt from 0 in first-seen order,
 * never rewound, never reused. Both shipping dealers agree on this — VibeField's
 * `dealProjectSeqs` keeps a `next` counter, Godview's registry deals
 * `max(seq) + 1` — so this is the rule either host persists behind its port.
 * `entries()` is what a host writes down; `initial` is what it hands back.
 */
export function createMemoryProjectIdentityStore(
  initial: Iterable<readonly [string, number]> = [],
): ProjectIdentityStore & { entries(): ReadonlyMap<string, number> } {
  const seqByKey = new Map<string, number>();
  let next = 0;
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
  };
}
