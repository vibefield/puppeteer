import { describe, expect, it } from 'vitest';
import { createMemoryProjectIdentityStore } from './identity.js';

// The two shipping dealers, as their sources spell them, so the replay below
// compares the store against each rather than against a paraphrase.

/** VibeField `project-ledger.ts`: `dealProjectSeqs` over a ledger `{ seqByKey, next }`. */
function vibefieldDeal(ledger: { seqByKey: Map<string, number>; next: number }, keys: readonly string[]) {
  let next = ledger.next;
  let seqByKey: Map<string, number> | undefined;
  for (const key of keys) {
    if (ledger.seqByKey.has(key) || seqByKey?.has(key)) continue;
    seqByKey ??= new Map(ledger.seqByKey);
    seqByKey.set(key, next);
    next += 1;
  }
  return seqByKey === undefined ? ledger : { seqByKey, next };
}

/** VibeField `loadProjectLedger`: `next` is the larger of what was saved and what the dealt sequences imply. */
function vibefieldLoad(saved: { next: number; seqs: [string, number][] }) {
  const seqByKey = new Map(saved.seqs);
  const dealt = seqByKey.size === 0 ? -1 : Math.max(...seqByKey.values());
  return { seqByKey, next: Math.max(saved.next, dealt + 1) };
}

/** Godview `project-registry.ts`: `nextProjectSequence` = one past the highest ever dealt; `dealRoot` keeps a known key. */
function godviewDeal(projects: Array<{ key: string; seq: number }>, key: string): number {
  const existing = projects.find((project) => project.key === key);
  if (existing) return existing.seq;
  const seq = projects.reduce((highest, project) => Math.max(highest, project.seq + 1), 0);
  projects.push({ key, seq });
  return seq;
}

describe('createMemoryProjectIdentityStore', () => {
  it('deals from 0 in first-seen order and keeps a known key its sequence', () => {
    const store = createMemoryProjectIdentityStore();
    expect(store.seq('/a')).toBeUndefined();
    expect(store.deal('/a')).toBe(0);
    expect(store.deal('/b')).toBe(1);
    expect(store.deal('/a')).toBe(0);
    expect(store.seq('/b')).toBe(1);
    expect([...store.entries()]).toEqual([
      ['/a', 0],
      ['/b', 1],
    ]);
    expect(store.next()).toBe(2);
  });

  it('comes back from what a host wrote down and never deals a sequence twice', () => {
    const store = createMemoryProjectIdentityStore([
      ['/a', 0],
      ['/c', 4],
      ['/bad', -1],
      ['/also-bad', 1.5],
      ['/a', 9],
    ]);
    expect(store.seq('/a')).toBe(0);
    expect(store.seq('/c')).toBe(4);
    expect(store.seq('/bad')).toBeUndefined();
    expect(store.deal('/d')).toBe(5);
  });

  it("honours VibeField's persisted next, so a truncated record never rewinds", () => {
    const store = createMemoryProjectIdentityStore([['/kept', 300]], { next: 302 });
    expect(store.deal('/new')).toBe(302);
    expect(createMemoryProjectIdentityStore([['/kept', 300]], { next: 3 }).deal('/new')).toBe(301);
    expect(createMemoryProjectIdentityStore([], { next: -2 }).deal('/new')).toBe(0);
  });

  it('deals exactly as both shipping dealers do, fresh and after a reload', () => {
    const keys = ['/repo', '/notes', '/repo', '/site', '/notes', '/game', '/repo'];
    const store = createMemoryProjectIdentityStore();
    let vibefield = { seqByKey: new Map<string, number>(), next: 0 };
    const godview: Array<{ key: string; seq: number }> = [];
    for (const key of keys) {
      vibefield = vibefieldDeal(vibefield, [key]);
      expect(store.deal(key)).toBe(vibefield.seqByKey.get(key));
      expect(godviewDeal(godview, key)).toBe(store.seq(key));
    }
    expect([...store.entries()]).toEqual([...vibefield.seqByKey]);
    expect(godview.map((project) => [project.key, project.seq])).toEqual([...store.entries()]);

    // A reload with the oldest key dropped (VibeField's cap): its `next` floor keeps the old sequence retired.
    const saved = { next: vibefield.next, seqs: [...vibefield.seqByKey].filter(([key]) => key !== '/repo') };
    const reloaded = vibefieldLoad(saved);
    const restored = createMemoryProjectIdentityStore(saved.seqs, { next: saved.next });
    expect(restored.next()).toBe(reloaded.next);
    expect(restored.deal('/repo')).toBe(vibefieldDeal(reloaded, ['/repo']).seqByKey.get('/repo'));
    expect(restored.deal('/repo')).toBe(4);
    // Godview's registry has no cap and deals max + 1 from the file: the same number for the same file.
    const file = saved.seqs.map(([key, seq]) => ({ key, seq }));
    expect(godviewDeal(file, '/repo')).toBe(4);
  });
});
