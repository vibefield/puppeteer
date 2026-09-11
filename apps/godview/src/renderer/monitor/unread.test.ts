import { describe, expect, it } from 'vitest';
import { EMPTY_UNREAD_LEDGER, reconcileUnread, type UnreadCandidate } from './unread.js';

const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const at = (seconds: number): number => T0 + seconds * 1000;

function row(id: string, status: UnreadCandidate['status'], overrides: Partial<UnreadCandidate> = {}): UnreadCandidate {
  return { id, status, active: false, hasAgent: true, statusSinceMs: at(-60), ...overrides };
}

describe('reconcileUnread', () => {
  it('never marks an agent on first sight, whatever its history', () => {
    const ledger = reconcileUnread(EMPTY_UNREAD_LEDGER, [row('a', 'idle', { statusSinceMs: at(-1) })], at(0));
    expect([...ledger.unreadIds]).toEqual([]);
  });

  it('marks an agent whose idle began after it was last in front of the user', () => {
    const seen = reconcileUnread(EMPTY_UNREAD_LEDGER, [row('a', 'working')], at(0));
    const finished = reconcileUnread(seen, [row('a', 'idle', { statusSinceMs: at(30) })], at(31));
    expect([...finished.unreadIds]).toEqual(['a']);
    const later = reconcileUnread(finished, [row('a', 'idle', { statusSinceMs: at(30) })], at(90));
    expect([...later.unreadIds]).toEqual(['a']);
  });

  it('marks a turn that began and ended between two projections', () => {
    const seen = reconcileUnread(EMPTY_UNREAD_LEDGER, [row('a', 'idle', { statusSinceMs: at(-60) })], at(0));
    const coalesced = reconcileUnread(seen, [row('a', 'idle', { statusSinceMs: at(5) })], at(6));
    expect([...coalesced.unreadIds]).toEqual(['a']);
  });

  it('clears the mark the moment the agent is the active pane, and stays clear after', () => {
    const seen = reconcileUnread(EMPTY_UNREAD_LEDGER, [row('a', 'working')], at(0));
    const finished = reconcileUnread(seen, [row('a', 'idle', { statusSinceMs: at(30) })], at(31));
    const looked = reconcileUnread(finished, [row('a', 'idle', { statusSinceMs: at(30), active: true })], at(40));
    expect([...looked.unreadIds]).toEqual([]);
    const away = reconcileUnread(looked, [row('a', 'idle', { statusSinceMs: at(30) })], at(50));
    expect([...away.unreadIds]).toEqual([]);
  });

  it('is not unread while working, and does not mark a turn finished in the active pane', () => {
    const seen = reconcileUnread(EMPTY_UNREAD_LEDGER, [row('a', 'working', { active: true })], at(0));
    const stillActive = reconcileUnread(seen, [row('a', 'idle', { statusSinceMs: at(30), active: true })], at(31));
    expect([...stillActive.unreadIds]).toEqual([]);
    const busy = reconcileUnread(seen, [row('a', 'working', { statusSinceMs: at(30) })], at(31));
    expect([...busy.unreadIds]).toEqual([]);
  });

  it('ignores bare terminals and forgets removed agents', () => {
    const seen = reconcileUnread(
      EMPTY_UNREAD_LEDGER,
      [row('t', 'working', { hasAgent: false, statusSinceMs: undefined }), row('a', 'working')],
      at(0),
    );
    const done = reconcileUnread(
      seen,
      [row('t', 'idle', { hasAgent: false, statusSinceMs: undefined }), row('a', 'idle', { statusSinceMs: at(10) })],
      at(11),
    );
    expect([...done.unreadIds]).toEqual(['a']);
    const gone = reconcileUnread(done, [], at(12));
    expect([...gone.unreadIds]).toEqual([]);
    expect(gone.seenAtById.size).toBe(0);
  });
});
