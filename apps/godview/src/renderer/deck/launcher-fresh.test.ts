import { describe, expect, it } from 'vitest';
import { firstPaneBirth, freshSessionIds, launcherCwds, paneCountOf, type FreshPane } from './launcher-fresh.js';

function pane(id: string, sessionId: string, extra: Partial<FreshPane['session']> = {}): FreshPane {
  return { id, session: { id: sessionId, exited: false, createdAtMs: 2_000, cwd: null, ...extra } };
}

describe('the first pane', () => {
  const BOOT = 1_000;

  it('is born here when the window opened on no document and Ghosttea created its one shell', () => {
    expect(firstPaneBirth({ savedAtBoot: false, bootAtMs: BOOT, panes: [pane('p', 's')] })).toBe('s');
  });

  it('is never born here in a restored, reloaded or seeded window', () => {
    expect(firstPaneBirth({ savedAtBoot: true, bootAtMs: BOOT, panes: [pane('p', 's')] })).toBeUndefined();
  });

  it('is never a claimed session, which is older than the window', () => {
    expect(
      firstPaneBirth({ savedAtBoot: false, bootAtMs: BOOT, panes: [pane('p', 's', { createdAtMs: 999 })] }),
    ).toBeUndefined();
    expect(
      firstPaneBirth({ savedAtBoot: false, bootAtMs: BOOT, panes: [pane('a', 's1'), pane('b', 's2')] }),
    ).toBeUndefined();
  });
});

describe('fresh sessions', () => {
  const born = new Set(['shell', 'exited', 'agent', 'gone']);

  it('keeps the shells born here that are on screen, running and no agent’s', () => {
    const panes = [
      pane('a', 'shell'),
      pane('b', 'exited', { exited: true }),
      pane('c', 'agent'),
      pane('d', 'restored'),
      pane('e', 'shell'),
    ];
    const fresh = freshSessionIds(born, panes, (sessionId) => sessionId === 'agent');
    expect([...fresh]).toEqual(['shell']);
  });

  it('picks the folder the shell reported, then its birth folder, then the frame’s', () => {
    const fresh = new Set(['live', 'born', 'fallback', 'none']);
    const panes = [
      pane('a', 'live', { cwd: '/w/live' }),
      pane('b', 'born'),
      pane('c', 'fallback', { cwd: '' }),
      pane('d', 'none'),
      pane('e', 'other', { cwd: '/w/other' }),
    ];
    const cwds = launcherCwds(
      fresh,
      panes,
      new Map([
        ['live', '/w/born-live'],
        ['born', '/w/born'],
      ]),
      new Map([
        ['fallback', '/w/fallback'],
        ['other', '/w/x'],
      ]),
    );
    expect([...cwds]).toEqual([
      ['live', '/w/live'],
      ['born', '/w/born'],
      ['fallback', '/w/fallback'],
    ]);
  });

  it('counts the panes that still show a session', () => {
    const panes = [pane('a', 's'), pane('b', 's'), pane('c', 't')];
    expect(paneCountOf(panes, 's')).toBe(2);
    expect(paneCountOf(panes, 't')).toBe(1);
    expect(paneCountOf(panes, 'u')).toBe(0);
  });
});
