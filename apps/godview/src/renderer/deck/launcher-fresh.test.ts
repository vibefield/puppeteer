import { describe, expect, it } from 'vitest';
import {
  freshSessionIds,
  launcherCwds,
  paneSessionUsed,
  planLauncherReplace,
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

describe('replacing the fresh shell (QL-D8)', () => {
  const pane = (id: string, sessionId: string, extra: Partial<PaneUseSession> = {}) => ({
    id,
    session: session(sessionId, extra),
  });
  const unused = () => false;
  const used = () => true;

  it.each<[string, ReturnType<typeof pane>[], (candidate: PaneUseSession) => boolean, object]>([
    [
      'an unused shell is the reaper’s to end',
      [pane('p1', 'fresh'), pane('p2', 'other')],
      unused,
      { place: 'mount', terminate: false },
    ],
    [
      'a used shell is the launcher’s to end',
      [pane('p1', 'fresh'), pane('p2', 'other')],
      used,
      { place: 'mount', terminate: true },
    ],
    [
      'a used shell another pane still shows is left alone',
      [pane('p1', 'fresh'), pane('p2', 'fresh')],
      used,
      { place: 'mount', terminate: false },
    ],
    [
      'a pane that closed during the launch gets the agent split in',
      [pane('p2', 'other')],
      used,
      { place: 'add', terminate: false },
    ],
  ])('%s', (_name, panes, rule, expected) => {
    expect(planLauncherReplace(panes, 'fresh', rule)).toEqual(expected);
  });

  it('asks the reaper’s rule about the fresh shell itself', () => {
    const asked: string[] = [];
    planLauncherReplace([pane('p1', 'fresh', { exited: true })], 'fresh', (candidate) => {
      asked.push(candidate.id);
      return candidate.exited;
    });
    expect(asked).toEqual(['fresh']);
  });
});
