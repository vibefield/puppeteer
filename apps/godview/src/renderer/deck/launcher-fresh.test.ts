import { describe, expect, it } from 'vitest';
import {
  freshSessionIds,
  launcherCwds,
  paneSessionUsed,
  type PaneUseFacts,
  type PaneUseSession,
} from './launcher-fresh.js';

function session(id: string, extra: Partial<PaneUseSession> = {}): PaneUseSession {
  return { id, exited: false, activity: { kind: 'idle' }, cwd: null, ...extra };
}

const NOTHING: PaneUseFacts = { hasInput: () => false, hasAgent: () => false, isRemote: () => false };

describe('a used shell', () => {
  it.each<[string, PaneUseSession, Partial<PaneUseFacts>]>([
    ['input reached it', session('s'), { hasInput: () => true }],
    ['it exited', session('s', { exited: true }), {}],
    ['it runs a foreground job', session('s', { activity: { kind: 'foreground-job' } }), {}],
    ['an agent owns it', session('s'), { hasAgent: () => true }],
    ['it is remote', session('s'), { isRemote: () => true }],
  ])('is used when %s', (_why, candidate, facts) => {
    expect(paneSessionUsed(candidate, { ...NOTHING, ...facts })).toBe(true);
  });

  it('is unused otherwise', () => {
    expect(paneSessionUsed(session('s'), NOTHING)).toBe(false);
  });
});

describe('fresh sessions', () => {
  it('keeps the on-screen shells created here and still unused, once each', () => {
    const panes = [
      { session: session('fresh') },
      { session: session('restored') },
      { session: session('used', { exited: true }) },
      { session: session('fresh') },
    ];
    const createdHere = (id: string): boolean => id !== 'restored';
    const fresh = freshSessionIds(panes, createdHere, (candidate) => paneSessionUsed(candidate, NOTHING));
    expect([...fresh]).toEqual(['fresh']);
  });

  it('starts a launch in the folder the shell reported, else the frame’s fallback', () => {
    const panes = [
      { session: session('live', { cwd: '/w/live' }) },
      { session: session('fallback', { cwd: '' }) },
      { session: session('none') },
      { session: session('other', { cwd: '/w/other' }) },
    ];
    const cwds = launcherCwds(
      new Set(['live', 'fallback', 'none']),
      panes,
      new Map([
        ['live', '/w/ignored'],
        ['fallback', '/w/fallback'],
        ['other', '/w/x'],
      ]),
    );
    expect([...cwds]).toEqual([
      ['live', '/w/live'],
      ['fallback', '/w/fallback'],
    ]);
  });
});
