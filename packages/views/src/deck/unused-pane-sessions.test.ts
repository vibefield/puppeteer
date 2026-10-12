import { describe, expect, it } from 'vitest';
import { UnusedPaneSessions } from './unused-pane-sessions.js';
describe('fresh pane session ownership', () => {
  it('reaps a fresh unused session exactly once', () => {
    const sessions = new UnusedPaneSessions();
    sessions.created('new');
    expect(sessions.closed('new', [], false)).toBe(true);
    expect(sessions.closed('new', [], false)).toBe(false);
  });
  it('says whether it still holds a receipt: born here, never seen used, not yet reaped', () => {
    const sessions = new UnusedPaneSessions();
    expect(sessions.holds('restored')).toBe(false);
    sessions.created('fresh');
    sessions.created('busy');
    expect(sessions.holds('fresh')).toBe(true);
    // Use seen once consumes the receipt, even after the work finishes.
    sessions.update([{ id: 'fresh' }, { id: 'busy' }], (session) => session.id === 'busy');
    sessions.update([{ id: 'fresh' }, { id: 'busy' }], () => false);
    expect(sessions.holds('busy')).toBe(false);
    expect(sessions.holds('fresh')).toBe(true);
    sessions.update([{ id: 'busy' }], () => false);
    expect(sessions.holds('fresh')).toBe(false);
  });
  it('retains restored sessions, used sessions, and a remaining mirror', () => {
    const sessions = new UnusedPaneSessions();
    expect(sessions.closed('restored', [], false)).toBe(false);
    sessions.created('used');
    expect(sessions.closed('used', [], true)).toBe(false);
    sessions.created('used');
    expect(sessions.closed('used', [], false)).toBe(false);
    sessions.created('mirrored');
    expect(sessions.closed('mirrored', ['mirrored'], false)).toBe(false);
    expect(sessions.closed('mirrored', [], false)).toBe(true);
  });
});

describe('attachment changes', () => {
  it('reaps a replaced empty shell exactly once, retaining the new attachment', () => {
    const sessions = new UnusedPaneSessions();
    sessions.created('empty');
    expect(sessions.update([{ id: 'empty' }], () => false)).toEqual([]);
    expect(sessions.update([{ id: 'agent' }], () => false)).toEqual([{ id: 'empty' }]);
    expect(sessions.update([{ id: 'agent' }], () => false)).toEqual([]);
    expect(sessions.update([], () => false)).toEqual([]);
  });

  it('waits for the last mirror and handles close without a separate callback', () => {
    const sessions = new UnusedPaneSessions();
    sessions.created('empty');
    sessions.update([{ id: 'empty' }, { id: 'empty' }], () => false);
    expect(sessions.update([{ id: 'empty' }], () => false)).toEqual([]);
    expect(sessions.update([], () => false)).toEqual([{ id: 'empty' }]);
  });

  it('checks input at detach and remembers earlier input or agent work', () => {
    const sessions = new UnusedPaneSessions<{ id: string; used: boolean }>();
    sessions.created('typed');
    sessions.created('worked');
    sessions.update(
      [
        { id: 'typed', used: false },
        { id: 'worked', used: true },
      ],
      (s) => s.used,
    );
    sessions.update(
      [
        { id: 'typed', used: false },
        { id: 'worked', used: false },
      ],
      (s) => s.used,
    );
    expect(sessions.update([], (s) => s.id === 'typed')).toEqual([]);
  });

  it('does not reap restored sessions, unmounted births, or a pane moving between slots', () => {
    const sessions = new UnusedPaneSessions();
    sessions.created('pending');
    sessions.created('moving');
    sessions.update([{ id: 'restored' }, { id: 'moving' }], () => false);
    expect(sessions.update([{ id: 'moving' }, { id: 'restored' }], () => false)).toEqual([]);
    expect(sessions.update([{ id: 'moving' }], () => false)).toEqual([]);
  });
});

describe('startup is transient, input is lifetime evidence', () => {
  const used = (session: { input: boolean }) => session.input;
  const busy = (session: { busy: boolean }) => session.busy;
  const starting = { id: 'shell', input: false, busy: true };
  const idle = { ...starting, busy: false };
  it('retains the receipt through startup and reaps on final detach', () => {
    const receipts = new UnusedPaneSessions<typeof starting>();
    receipts.created('shell');
    receipts.update([starting], used, busy);
    receipts.update([idle], used, busy);
    expect(receipts.update([], used, busy)).toEqual([idle]);
  });
  it('reaps once when a detached startup job returns to idle', () => {
    const receipts = new UnusedPaneSessions<typeof starting>();
    receipts.created('shell');
    receipts.update([starting], used, busy);
    expect(receipts.update([], used, busy)).toEqual([]);
    expect(receipts.holds('shell')).toBe(true);
    expect(receipts.observe(idle, false, false)).toEqual([idle]);
    expect(receipts.observe(idle, false, false)).toEqual([]);
  });
  it.each(['input', 'reattach', 'handoff'])('cancels pending cleanup on %s', (cause) => {
    const receipts = new UnusedPaneSessions<typeof starting>();
    receipts.created('shell');
    receipts.update([starting], used, busy);
    receipts.update([], used, busy);
    if (cause === 'input') receipts.observe(starting, true, true);
    if (cause === 'reattach') receipts.update([starting], used, busy);
    if (cause === 'handoff') receipts.release('shell');
    expect(receipts.observe(idle, false, false)).toEqual([]);
  });
});
