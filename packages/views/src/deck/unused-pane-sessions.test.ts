import { describe, expect, it } from 'vitest';
import { UnusedPaneSessions } from './unused-pane-sessions.js';
describe('fresh pane session ownership', () => {
  it('reaps a fresh unused session exactly once', () => {
    const sessions = new UnusedPaneSessions();
    sessions.created('new');
    expect(sessions.closed('new', [], false)).toBe(true);
    expect(sessions.closed('new', [], false)).toBe(false);
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

  it('checks input at detach and remembers earlier foreground or agent work', () => {
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
