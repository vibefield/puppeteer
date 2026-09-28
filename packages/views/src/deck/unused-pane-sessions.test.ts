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
    expect(sessions.closed('used', [], false)).toBe(false);
    sessions.created('mirrored');
    expect(sessions.closed('mirrored', ['mirrored'], false)).toBe(false);
    expect(sessions.closed('mirrored', [], false)).toBe(true);
  });
});
