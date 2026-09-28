import { describe, expect, it } from 'vitest';
import {
  freshSessionIds,
  launcherCwds,
  launcherFolderPath,
  launcherSessionUsed,
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

  it('keeps its launcher through a foreground job alone: the shell’s own startup is not use', () => {
    const starting = session('s', { activity: { kind: 'foreground-job' } });
    expect(paneSessionUsed(starting, NOTHING)).toBe(true);
    expect(launcherSessionUsed(starting, NOTHING)).toBe(false);
    expect(launcherSessionUsed(starting, { ...NOTHING, hasInput: () => true })).toBe(true);
    for (const facts of [{ hasAgent: () => true }, { isRemote: () => true }]) {
      expect(launcherSessionUsed(session('s'), { ...NOTHING, ...facts })).toBe(true);
    }
    expect(launcherSessionUsed(session('s', { exited: true }), NOTHING)).toBe(true);
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

describe('a shell’s reported folder as a path', () => {
  it.each<[string | null | undefined, string | undefined]>([
    // OSC 7, as Ghosttea keeps it: the host is the machine's, the path is URL-encoded.
    ['file://Jamess-MacBook-Pro-9.local/Users/j/My%20Code', '/Users/j/My Code'],
    ['FILE:///tmp/x', '/tmp/x'],
    ['/Users/j/app', '/Users/j/app'],
    ['  /Users/j/app ', '/Users/j/app'],
    ['file://host/%E0%A4%A', undefined],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s → %s', (value, expected) => {
    expect(launcherFolderPath(value)).toBe(expected);
  });

  it('gives a launch the path, never the URL', () => {
    const cwds = launcherCwds(
      new Set(['osc7']),
      [{ session: session('osc7', { cwd: 'file://mac.local/Users/j/app' }) }],
      new Map(),
    );
    expect([...cwds]).toEqual([['osc7', '/Users/j/app']]);
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

  it('ends a shell whose receipt the reaper already gave up, even when it is idle again', () => {
    const panes = [pane('p1', 'fresh')];
    expect(planLauncherReplace(panes, 'fresh', unused, 'p1', () => false)).toEqual({ place: 'mount', terminate: true });
    expect(planLauncherReplace(panes, 'fresh', unused, 'p1', () => true)).toEqual({ place: 'mount', terminate: false });
    expect(planLauncherReplace(panes, 'fresh', used, 'p1', () => true)).toEqual({ place: 'mount', terminate: true });
    // Another pane still shows it: never.
    expect(planLauncherReplace([...panes, pane('p2', 'fresh')], 'fresh', unused, 'p1', () => false).terminate).toBe(
      false,
    );
  });

  it('selects again the pane the person moved to during the launch', () => {
    const panes = [pane('p1', 'fresh'), pane('p2', 'other')];
    expect(planLauncherReplace(panes, 'fresh', unused, 'p2')).toEqual({
      place: 'mount',
      terminate: false,
      restoreSessionId: 'other',
    });
    // Still on the launcher's pane, or none known: nothing to restore.
    expect(planLauncherReplace(panes, 'fresh', unused, 'p1')).toEqual({ place: 'mount', terminate: false });
    expect(planLauncherReplace(panes, 'fresh', unused, undefined)).toEqual({ place: 'mount', terminate: false });
    // The pane closed and the agent is split in: the selection stays where the person put it.
    expect(planLauncherReplace([pane('p2', 'other')], 'fresh', unused, 'p2')).toEqual({
      place: 'add',
      terminate: false,
      restoreSessionId: 'other',
    });
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
