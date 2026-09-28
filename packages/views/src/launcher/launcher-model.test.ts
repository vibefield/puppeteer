import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_LATEST_LIMIT,
  LAUNCHER_MAX_AGENTS,
  LauncherKeyReleases,
  ageWords,
  agentKeyLabel,
  agentKeyShortcut,
  agentPreview,
  buildLauncherResults,
  consumesKey,
  digitCodeIndex,
  formatCount,
  historyStatusLine,
  historyUnavailable,
  historyUnavailableSentence,
  launcherFolder,
  launcherKeyAction,
  launcherKeyDecision,
  launcherPaneForTarget,
  markTerms,
  moveHighlight,
  noMatchSentence,
  noSessionsSentence,
  orderAgents,
  showsLauncher,
  toggleScope,
  type LauncherKeyDecision,
  type LauncherKeyEvent,
  type LauncherKeyPane,
  type LauncherKeyState,
} from './launcher-model.js';
import type { LauncherAgent, LauncherSession } from './launcher-port.js';

// Local-time clock, so the calendar words hold in any timezone the suite runs in.
const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function agent(providerId: string, label: string, extra: Partial<LauncherAgent> = {}): LauncherAgent {
  return { providerId, label, ...extra };
}

const AGENTS: LauncherAgent[] = [
  agent('p-a', 'Alpha'),
  agent('p-b', 'Bravo', { lastLaunchedAt: NOW - HOUR }),
  agent('p-c', 'Charlie'),
  agent('p-d', 'Delta', { lastLaunchedAt: NOW - MINUTE }),
];

function session(key: string, extra: Partial<LauncherSession> = {}): LauncherSession {
  return {
    key,
    providerId: 'p-a',
    nativeSessionId: `native-${key}`,
    title: `session ${key}`,
    cwd: '/Users/j/Projects/puppeteer',
    here: true,
    lastAt: NOW - HOUR,
    resumable: true,
    ...extra,
  };
}

describe('orderAgents', () => {
  it('lists the last launched first and keeps the host order for the rest and for ties', () => {
    expect(orderAgents(AGENTS).map((a) => a.providerId)).toEqual(['p-d', 'p-b', 'p-a', 'p-c']);
    const tied = [agent('x', 'X', { lastLaunchedAt: 5 }), agent('y', 'Y', { lastLaunchedAt: 5 }), agent('z', 'Z')];
    expect(orderAgents(tied).map((a) => a.providerId)).toEqual(['x', 'y', 'z']);
  });

  it('keeps ten rows at most and treats a non-finite stamp as never launched', () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(`p${i}`, `P${i}`));
    expect(orderAgents(many)).toHaveLength(LAUNCHER_MAX_AGENTS);
    const odd = [agent('a', 'A', { lastLaunchedAt: Number.NaN }), agent('b', 'B', { lastLaunchedAt: 1 })];
    expect(orderAgents(odd).map((a) => a.providerId)).toEqual(['b', 'a']);
  });

  it('previews with the host words, else the label', () => {
    expect(agentPreview(agent('a', 'Alpha'))).toBe('Alpha');
    expect(agentPreview(agent('a', 'Alpha', { preview: 'Alpha · work' }))).toBe('Alpha · work');
  });
});

describe('keys', () => {
  it('labels rows ⌥1…⌥9 then ⌥0, and says them as Alt+n', () => {
    expect(Array.from({ length: 10 }, (_, i) => agentKeyLabel(i))).toEqual([
      '⌥1',
      '⌥2',
      '⌥3',
      '⌥4',
      '⌥5',
      '⌥6',
      '⌥7',
      '⌥8',
      '⌥9',
      '⌥0',
    ]);
    expect(agentKeyShortcut(0)).toBe('Alt+1');
    expect(agentKeyShortcut(9)).toBe('Alt+0');
  });

  it('reads the row from the physical digit', () => {
    expect(digitCodeIndex('Digit1')).toBe(0);
    expect(digitCodeIndex('Digit9')).toBe(8);
    expect(digitCodeIndex('Digit0')).toBe(9);
    expect(digitCodeIndex('Numpad1')).toBeUndefined();
    expect(digitCodeIndex('KeyA')).toBeUndefined();
  });
});

function key(code: string, keyValue: string, mods: Partial<LauncherKeyEvent> = {}): LauncherKeyEvent {
  return { code, key: keyValue, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods };
}

const CLOSED: LauncherKeyState = { open: false, agentCount: 4, highlight: -1, highlightResumable: false };
const OPEN: LauncherKeyState = { open: true, agentCount: 4, highlight: 0, highlightResumable: true };

describe('launcherKeyAction · closed', () => {
  const table: Array<[string, LauncherKeyEvent, ReturnType<typeof launcherKeyAction>]> = [
    // macOS types ¡ ™ £ for ⌥1 ⌥2 ⌥3: the code decides.
    ['⌥1 launches row 0', key('Digit1', '¡', { altKey: true }), { kind: 'launch', index: 0 }],
    ['⌥4 launches row 3', key('Digit4', '¢', { altKey: true }), { kind: 'launch', index: 3 }],
    ['⌥5 past the last row holds', key('Digit5', '∞', { altKey: true }), { kind: 'hold' }],
    ['⌥0 past the last row holds', key('Digit0', 'º', { altKey: true }), { kind: 'hold' }],
    ['⌥↵ opens the field', key('Enter', 'Enter', { altKey: true }), { kind: 'open' }],
    ['⌥ numpad enter opens the field', key('NumpadEnter', 'Enter', { altKey: true }), { kind: 'open' }],
    ['⎋ dismisses the launcher', key('Escape', 'Escape'), { kind: 'dismiss' }],
    ['a bare ⌥ passes', key('AltLeft', 'Alt', { altKey: true }), { kind: 'ignore' }],
    ['a bare ⇧ passes', key('ShiftLeft', 'Shift', { shiftKey: true }), { kind: 'ignore' }],
    ['a bare ⌘ passes', key('MetaLeft', 'Meta', { metaKey: true }), { kind: 'ignore' }],
    ['a bare ⌃ passes', key('ControlLeft', 'Control', { ctrlKey: true }), { kind: 'ignore' }],
    ['caps lock passes', key('CapsLock', 'CapsLock'), { kind: 'ignore' }],
    ['⌘1 is the host’s', key('Digit1', '1', { metaKey: true }), { kind: 'ignore' }],
    ['⌘⌥1 is the host’s', key('Digit1', '¡', { metaKey: true, altKey: true }), { kind: 'ignore' }],
    ['⌃C is the host’s', key('KeyC', 'c', { ctrlKey: true }), { kind: 'ignore' }],
    ['⌘V passes (the paste event marks the pane used)', key('KeyV', 'v', { metaKey: true }), { kind: 'ignore' }],
    ['a letter is the shell’s', key('KeyC', 'c'), { kind: 'used' }],
    ['a bare digit is the shell’s', key('Digit1', '1'), { kind: 'used' }],
    ['⇧⌥1 is the shell’s', key('Digit1', '⁄', { altKey: true, shiftKey: true }), { kind: 'used' }],
    ['⌥e (a dead key) is the shell’s', key('KeyE', 'Dead', { altKey: true }), { kind: 'used' }],
    ['↵ is the shell’s', key('Enter', 'Enter'), { kind: 'used' }],
    ['⇥ is the shell’s', key('Tab', 'Tab'), { kind: 'used' }],
    ['↑ is the shell’s', key('ArrowUp', 'ArrowUp'), { kind: 'used' }],
    ['space is the shell’s', key('Space', ' '), { kind: 'used' }],
    ['an IME composition is the shell’s', key('KeyA', 'a', { isComposing: true }), { kind: 'used' }],
    ['an IME process key is the shell’s', key('KeyA', 'Process'), { kind: 'used' }],
  ];
  it.each(table)('%s', (_name, event, expected) => {
    expect(launcherKeyAction(event, CLOSED)).toEqual(expected);
  });

  it('holds every ⌥ digit when there are no agents at all', () => {
    expect(launcherKeyAction(key('Digit1', '¡', { altKey: true }), { ...CLOSED, agentCount: 0 })).toEqual({
      kind: 'hold',
    });
  });
});

describe('launcherKeyAction · launching', () => {
  // A launch or a resume is in flight: the shell it replaces is about to close.
  const table: Array<[string, LauncherKeyEvent, ReturnType<typeof launcherKeyAction>]> = [
    ['a letter is held', key('KeyC', 'c'), { kind: 'hold' }],
    ['↵ is held', key('Enter', 'Enter'), { kind: 'hold' }],
    ['⎋ is held', key('Escape', 'Escape'), { kind: 'hold' }],
    ['another ⌥ digit is held', key('Digit2', '™', { altKey: true }), { kind: 'hold' }],
    ['⌥↵ is held', key('Enter', 'Enter', { altKey: true }), { kind: 'hold' }],
    ['⇥ is held', key('Tab', 'Tab'), { kind: 'hold' }],
    ['an IME key is held', key('KeyA', 'a', { isComposing: true }), { kind: 'hold' }],
    ['⌘V passes', key('KeyV', 'v', { metaKey: true }), { kind: 'ignore' }],
    ['⌃C passes', key('KeyC', 'c', { ctrlKey: true }), { kind: 'ignore' }],
    ['a bare ⇧ passes', key('ShiftLeft', 'Shift', { shiftKey: true }), { kind: 'ignore' }],
  ];
  it.each(table)('closed: %s', (_name, event, expected) => {
    expect(launcherKeyAction(event, { ...CLOSED, launching: true })).toEqual(expected);
  });
  it.each(table)('open: %s', (_name, event, expected) => {
    expect(launcherKeyAction(event, { ...OPEN, launching: true })).toEqual(expected);
  });

  it('behaves as before once the launch is refused and the launcher is at rest again', () => {
    expect(launcherKeyAction(key('KeyC', 'c'), { ...CLOSED, launching: false })).toEqual({ kind: 'used' });
    expect(launcherKeyAction(key('Escape', 'Escape'), { ...CLOSED, launching: false })).toEqual({ kind: 'dismiss' });
    expect(launcherKeyAction(key('Digit2', '™', { altKey: true }), { ...CLOSED, launching: false })).toEqual({
      kind: 'launch',
      index: 1,
    });
  });
});

describe('launcherKeyAction · open', () => {
  const table: Array<[string, LauncherKeyEvent, ReturnType<typeof launcherKeyAction>]> = [
    ['↓ moves down', key('ArrowDown', 'ArrowDown'), { kind: 'move', delta: 1 }],
    ['↑ moves up', key('ArrowUp', 'ArrowUp'), { kind: 'move', delta: -1 }],
    ['↵ resumes the highlighted row', key('Enter', 'Enter'), { kind: 'resume', index: 0 }],
    ['⇥ toggles the scope', key('Tab', 'Tab'), { kind: 'toggle-scope' }],
    ['⇧⇥ toggles the scope', key('Tab', 'Tab', { shiftKey: true }), { kind: 'toggle-scope' }],
    ['⎋ closes the field', key('Escape', 'Escape'), { kind: 'close' }],
    ['⌥2 still launches', key('Digit2', '™', { altKey: true }), { kind: 'launch', index: 1 }],
    ['⌥9 past the last row holds', key('Digit9', 'ª', { altKey: true }), { kind: 'hold' }],
    ['a letter is typing', key('KeyF', 'f'), { kind: 'type' }],
    ['a digit is typing', key('Digit1', '1'), { kind: 'type' }],
    ['⌘A is the input’s', key('KeyA', 'a', { metaKey: true }), { kind: 'type' }],
    ['⌘↓ is the input’s', key('ArrowDown', 'ArrowDown', { metaKey: true }), { kind: 'type' }],
    ['⌥← is the input’s', key('ArrowLeft', 'ArrowLeft', { altKey: true }), { kind: 'type' }],
    ['⌥↵ is the input’s', key('Enter', 'Enter', { altKey: true }), { kind: 'type' }],
    ['⇧↵ is the input’s', key('Enter', 'Enter', { shiftKey: true }), { kind: 'type' }],
    ['backspace is typing', key('Backspace', 'Backspace'), { kind: 'type' }],
    ['↵ inside a composition commits it', key('Enter', 'Enter', { isComposing: true }), { kind: 'type' }],
    ['↓ inside a composition is the IME’s', key('ArrowDown', 'ArrowDown', { isComposing: true }), { kind: 'type' }],
    ['⎋ inside a composition cancels it', key('Escape', 'Escape', { isComposing: true }), { kind: 'type' }],
  ];
  it.each(table)('%s', (_name, event, expected) => {
    expect(launcherKeyAction(event, OPEN)).toEqual(expected);
  });

  it('holds ↵ on a row it withholds, and with nothing highlighted', () => {
    expect(launcherKeyAction(key('Enter', 'Enter'), { ...OPEN, highlightResumable: false })).toEqual({ kind: 'hold' });
    expect(launcherKeyAction(key('Enter', 'Enter'), { ...OPEN, highlight: -1 })).toEqual({ kind: 'hold' });
    expect(launcherKeyAction(key('Enter', 'Enter'), { ...OPEN, highlight: 3 })).toEqual({ kind: 'resume', index: 3 });
  });

  it('consumes only its own keys', () => {
    expect(consumesKey({ kind: 'ignore' })).toBe(false);
    expect(consumesKey({ kind: 'used' })).toBe(false);
    expect(consumesKey({ kind: 'type' })).toBe(false);
    for (const action of [
      { kind: 'launch', index: 0 },
      { kind: 'open' },
      { kind: 'dismiss' },
      { kind: 'close' },
      { kind: 'move', delta: 1 },
      { kind: 'resume', index: 0 },
      { kind: 'toggle-scope' },
      { kind: 'hold' },
    ] as const) {
      expect(consumesKey(action)).toBe(true);
    }
  });

  it('moves the highlight without wrapping, and toggles the scope', () => {
    expect(moveHighlight(0, -1, 3)).toBe(0);
    expect(moveHighlight(2, 1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(1, 1, 0)).toBe(-1);
    expect(toggleScope('here')).toBe('all');
    expect(toggleScope('all')).toBe('here');
  });
});

describe('ageWords', () => {
  it('says the age in the design’s words against a fixed clock', () => {
    expect(ageWords(NOW - 20_000, NOW)).toBe('just now');
    expect(ageWords(NOW + 5_000, NOW)).toBe('just now');
    expect(ageWords(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(ageWords(NOW - 5 * MINUTE, NOW)).toBe('5 minutes ago');
    expect(ageWords(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(ageWords(NOW - 2 * HOUR - 10 * MINUTE, NOW)).toBe('2 hours ago');
    expect(ageWords(NOW - 23 * HOUR, NOW)).toBe('23 hours ago');
    expect(ageWords(new Date(2026, 8, 27, 9, 0).getTime(), NOW)).toBe('yesterday');
    expect(ageWords(new Date(2026, 8, 26, 16, 0).getTime(), NOW)).toBe('2 days ago');
    expect(ageWords(new Date(2026, 8, 10, 15, 0).getTime(), NOW)).toBe('18 days ago');
    expect(ageWords(undefined, NOW)).toBeUndefined();
    expect(ageWords(Number.NaN, NOW)).toBeUndefined();
  });
});

describe('sentences', () => {
  it('counts the way the design prints them', () => {
    expect(formatCount(1204)).toBe('1,204');
    expect(formatCount(3880)).toBe('3,880');
  });

  it('names the pane folder, or says this folder', () => {
    expect(launcherFolder('/Users/j/Projects/puppeteer/')).toBe('puppeteer');
    expect(launcherFolder(undefined)).toBe('this folder');
  });

  it('shows readiness as it is', () => {
    expect(historyStatusLine({ readiness: 'catching-up', progress: { done: 1204, total: 3880 } })).toEqual({
      text: 'History is catching up · 1,204 of 3,880 sessions read',
      percent: 31,
    });
    expect(historyStatusLine({ readiness: 'catching-up' })).toEqual({ text: 'History is catching up' });
    expect(historyStatusLine({ readiness: 'building', progress: { done: 5, total: 10 } })).toEqual({
      text: 'History is being read · 5 of 10 sessions read',
      percent: 50,
    });
    expect(historyStatusLine({ readiness: 'stale', detail: 'last read 2 hours ago' })).toEqual({
      text: 'History may be behind · last read 2 hours ago',
    });
    expect(historyStatusLine({ readiness: 'ready' })).toBeUndefined();
    expect(historyStatusLine(undefined)).toBeUndefined();
  });

  it('says history is not answering, and that the digits still launch', () => {
    expect(historyUnavailable({ readiness: 'unreachable' })).toBe(true);
    expect(historyUnavailable({ readiness: 'failed' })).toBe(true);
    expect(historyUnavailable({ readiness: 'stale' })).toBe(false);
    expect(historyUnavailable(undefined)).toBe(false);
    expect(historyUnavailableSentence({ readiness: 'unreachable' })).toEqual({
      text: 'Past sessions can’t be searched: the history service isn’t answering.',
      hint: '⌥1–⌥0 still launch new agents · ⎋ back to the shell',
    });
    expect(historyUnavailableSentence({ readiness: 'failed' }).text).toBe(
      'Past sessions can’t be searched: the history index failed.',
    );
  });

  it('says nothing matched, here or anywhere', () => {
    expect(noMatchSentence(' xyzzy ', 'here', 'puppeteer')).toEqual({
      text: 'No session in puppeteer mentions “xyzzy”.',
      hint: '⇥ searches every folder · ⎋ back to the shell',
    });
    expect(noMatchSentence('xyzzy', 'all', 'puppeteer')).toEqual({
      text: 'No session mentions “xyzzy”.',
      hint: '⎋ back to the shell',
    });
    expect(noSessionsSentence('here', 'puppeteer').text).toBe('No past sessions in puppeteer yet.');
    expect(noSessionsSentence('all', 'puppeteer').text).toBe('No past sessions yet.');
  });
});

describe('buildLauncherResults', () => {
  const base = { hits: [], agents: AGENTS, folder: 'puppeteer', nowMs: NOW } as const;

  it('lists this folder’s latest five with nothing typed, newest first', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => session(`s${i}`, { lastAt: NOW - (i + 1) * HOUR }));
    sessions.push(session('far', { here: false, cwd: '/x/vibe-field', lastAt: NOW }));
    const { groups, rows } = buildLauncherResults({ ...base, sessions: sessions.reverse(), query: '', scope: 'here' });
    expect(groups.map((g) => g.label)).toEqual(['Latest in puppeteer']);
    expect(rows).toHaveLength(LAUNCHER_LATEST_LIMIT);
    expect(rows.map((r) => r.session.key)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(rows[0]?.meta).toBe('Alpha · 1 hour ago');
    expect(rows[0]?.titleSegments).toEqual([{ text: 'session s0', match: false }]);
  });

  it('adds the latest elsewhere in all, folder first', () => {
    const sessions = [
      session('h'),
      session('e', { here: false, cwd: '/x/vibe-field', branch: 'mt-2', providerId: 'p-b', lastAt: NOW - 30 * HOUR }),
    ];
    const { groups } = buildLauncherResults({ ...base, sessions, query: '', scope: 'all' });
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ['here', 'Latest in puppeteer'],
      ['elsewhere', 'Elsewhere'],
    ]);
    expect(groups[1]?.rows[0]?.meta).toBe('vibe-field · Bravo · mt-2 · yesterday');
  });

  it('matches the facts: title, folder, agent label and branch, every term on some fact', () => {
    const sessions = [
      session('title', { title: 'fold the bar into the record' }),
      session('branch', { title: 'unrelated', branch: 'fold-work' }),
      session('agent', { title: 'unrelated', providerId: 'p-d' }),
      session('none', { title: 'nothing here' }),
    ];
    const fold = buildLauncherResults({ ...base, sessions, query: 'fold', scope: 'here' });
    expect(fold.rows.map((r) => r.session.key)).toEqual(['title', 'branch']);
    expect(fold.groups[0]?.label).toBe('In puppeteer');
    expect(fold.rows[0]?.titleSegments).toEqual([
      { text: 'fold', match: true },
      { text: ' the bar into the record', match: false },
    ]);
    const byAgent = buildLauncherResults({ ...base, sessions, query: 'delta', scope: 'here' });
    expect(byAgent.rows.map((r) => r.session.key)).toEqual(['agent']);
    const byFolder = buildLauncherResults({ ...base, sessions, query: 'pupp', scope: 'here' });
    expect(byFolder.rows).toHaveLength(4);
    const both = buildLauncherResults({ ...base, sessions, query: 'fold xyzzy', scope: 'here' });
    expect(both.rows).toHaveLength(0);
  });

  it('keeps elsewhere out of here, and groups it after here in all', () => {
    const sessions = [
      session('far', { here: false, cwd: '/x/vibe-field', title: 'fold the minimal frame' }),
      session('near', { title: 'fold the bar' }),
    ];
    expect(
      buildLauncherResults({ ...base, sessions, query: 'fold', scope: 'here' }).rows.map((r) => r.session.key),
    ).toEqual(['near']);
    const all = buildLauncherResults({ ...base, sessions, query: 'fold', scope: 'all' });
    expect(all.groups.map((g) => g.label)).toEqual(['In puppeteer', 'Elsewhere']);
    expect(all.rows.map((r) => r.session.key)).toEqual(['near', 'far']);
  });

  it('joins a words hit onto a listed session as its evidence line, by key or native id', () => {
    const sessions = [
      session('a', { title: 'port the rain view parameters', providerId: 'p-b' }),
      session('b', { title: 'something else' }),
      session('c', { title: 'fold it' }),
    ];
    const hits = [
      { nativeSessionId: 'native-a', kind: 'user', snippet: 'then [fold] the gauge into the frame' },
      { sessionKey: 'b', kind: 'agent', snippet: 'I will [fold]  it' },
      { nativeSessionId: 'native-unlisted', kind: 'user', snippet: '[fold]' },
    ];
    const { rows } = buildLauncherResults({ ...base, sessions, hits, query: 'fold', scope: 'here' });
    // the title match ranks first; the words-only rows follow it
    expect(rows.map((r) => r.session.key)).toEqual(['c', 'a', 'b']);
    expect(rows[1]?.evidence).toEqual({
      who: 'you',
      segments: [
        { text: 'then ', match: false },
        { text: 'fold', match: true },
        { text: ' the gauge into the frame', match: false },
      ],
    });
    expect(rows[2]?.evidence?.who).toBe('Alpha');
    expect(rows[0]?.evidence).toBeUndefined();
  });

  it('never lets a words hit outlive its question: another query or scope leaves it out', () => {
    const sessions = [session('a', { title: 'port the rain view' }), session('b', { title: 'fold it' })];
    // Found for "gauge": session a said it, though no fact of a's mentions it.
    const hits = [{ sessionKey: 'a', kind: 'user', snippet: 'the [gauge]' }];
    const hitsFor = { query: 'gauge', scope: 'here' } as const;
    const keys = (query: string, scope: 'here' | 'all' = 'here') =>
      buildLauncherResults({ ...base, sessions, hits, hitsFor, query, scope }).rows.map((row) => row.session.key);
    expect(keys('gauge')).toEqual(['a']);
    expect(keys('  gauge ')).toEqual(['a']);
    // The query moved on (typed further, or a new word) before the words lane answered it: a stays out.
    expect(keys('gaug')).toEqual([]);
    expect(keys('fold')).toEqual(['b']);
    // The same words asked in another scope are another question.
    expect(keys('gauge', 'all')).toEqual([]);
    // No question named: the hits are the current question's (a static render).
    expect(buildLauncherResults({ ...base, sessions, hits, query: 'fold', scope: 'here' }).rows.length).toBe(2);
  });

  it('keeps a row it cannot resume, saying why', () => {
    const sessions = [
      session('gone', {
        here: false,
        cwd: '/x/vibe-field-old',
        resumable: false,
        unresumable: 'folder is gone',
        lastAt: new Date(2026, 8, 10, 12).getTime(),
        providerId: undefined,
      }),
    ];
    const { rows } = buildLauncherResults({ ...base, sessions, query: '', scope: 'all' });
    expect(rows[0]?.meta).toBe('vibe-field-old · folder is gone · 18 days ago');
    expect(rows[0]?.providerId).toBeUndefined();
  });

  it('names an agent the catalog does not list by its id', () => {
    const { rows } = buildLauncherResults({
      ...base,
      sessions: [session('x', { providerId: 'p-unknown' })],
      query: '',
      scope: 'here',
    });
    expect(rows[0]?.meta).toBe('p-unknown · 1 hour ago');
  });

  it('marks every occurrence of every term, case-insensitively', () => {
    expect(markTerms('Fold and refold', ['fold'])).toEqual([
      { text: 'Fold', match: true },
      { text: ' and re', match: false },
      { text: 'fold', match: true },
    ]);
    expect(markTerms('abc', [])).toEqual([{ text: 'abc', match: false }]);
  });
});

describe('showsLauncher', () => {
  const none = new Set<string>();
  const fresh = new Set(['s1', 's2']);

  it('draws on a fresh shell with no input, not put away', () => {
    expect(showsLauncher('s1', { freshSessionIds: fresh, used: none, dismissed: none })).toBe(true);
  });

  it('never draws on a session the host did not call fresh (restored, attached, an agent, exited)', () => {
    expect(showsLauncher('s9', { freshSessionIds: fresh, used: none, dismissed: none })).toBe(false);
  });

  it('goes once input reached the shell, from the launcher or the host, or once dismissed', () => {
    expect(showsLauncher('s1', { freshSessionIds: fresh, used: new Set(['s1']), dismissed: none })).toBe(false);
    expect(showsLauncher('s1', { freshSessionIds: fresh, used: none, dismissed: new Set(['s1']) })).toBe(false);
    expect(
      showsLauncher('s1', { freshSessionIds: fresh, used: none, dismissed: none, hasInput: (id) => id === 's1' }),
    ).toBe(false);
    expect(
      showsLauncher('s2', { freshSessionIds: fresh, used: none, dismissed: none, hasInput: (id) => id === 's1' }),
    ).toBe(true);
  });
});

describe('the mounter’s key routing', () => {
  // Stand-in nodes: a pane "contains" the nodes listed for it.
  const node = (name: string): Node => ({ name }) as unknown as Node;
  const terminalA = node('terminal A');
  const fieldB = node('field B');
  const terminalB = node('terminal B');
  const hostInput = node('the host’s own input');
  function pane(paneId: string, sessionId: string, holds: readonly Node[]): LauncherKeyPane {
    return { paneId, sessionId, element: { contains: (target) => target !== null && holds.includes(target) } };
  }
  const panes = [pane('A', 's-a', [terminalA]), pane('B', 's-b', [fieldB, terminalB])];

  it.each<[string, Node | null, string | undefined]>([
    ['a key in the active pane’s terminal', terminalA, 'A'],
    // The review's case: a click put the keyboard in B's field while A was still the active pane.
    ['a key in a resting pane’s field', fieldB, 'B'],
    ['a key in a resting pane’s terminal', terminalB, 'B'],
    ['a key in the host’s own input', hostInput, undefined],
    ['a key with no target', null, undefined],
  ])('%s → %s', (_name, target, expected) => {
    expect(launcherPaneForTarget(target, panes)?.paneId).toBe(expected);
  });

  it('routes nothing when no pane shows a launcher', () => {
    expect(launcherPaneForTarget(terminalA, [])).toBeUndefined();
  });

  const decided = (
    event: LauncherKeyEvent,
    state: LauncherKeyState,
  ): Omit<LauncherKeyDecision, 'action'> & {
    action: string;
  } => {
    const decision = launcherKeyDecision(event, state);
    return { ...decision, action: decision.action.kind };
  };
  const LAUNCHING: LauncherKeyState = { ...CLOSED, launching: true };

  it.each<[string, LauncherKeyEvent, LauncherKeyState, ReturnType<typeof decided>]>([
    [
      '⌥1 closed launches, taking press and release',
      key('Digit1', '¡', { altKey: true }),
      CLOSED,
      { consume: true, release: true, effect: 'apply', action: 'launch' },
    ],
    [
      '⌥↵ closed opens, taking press and release',
      key('Enter', 'Enter', { altKey: true }),
      CLOSED,
      { consume: true, release: true, effect: 'apply', action: 'open' },
    ],
    [
      '⎋ closed dismisses',
      key('Escape', 'Escape'),
      CLOSED,
      { consume: true, release: true, effect: 'dismiss', action: 'dismiss' },
    ],
    [
      'a letter closed is the shell’s and marks it used',
      key('KeyE', 'e'),
      CLOSED,
      { consume: false, release: false, effect: 'used', action: 'used' },
    ],
    [
      '⌘V closed passes untouched',
      key('KeyV', 'v', { metaKey: true }),
      CLOSED,
      { consume: false, release: false, effect: 'none', action: 'ignore' },
    ],
    [
      'bare ⌥ closed passes untouched',
      key('AltLeft', 'Alt', { altKey: true }),
      CLOSED,
      { consume: false, release: false, effect: 'none', action: 'ignore' },
    ],
    [
      '↓ open moves',
      key('ArrowDown', 'ArrowDown'),
      OPEN,
      { consume: true, release: true, effect: 'apply', action: 'move' },
    ],
    [
      '⇥ open flips the scope',
      key('Tab', 'Tab'),
      OPEN,
      { consume: true, release: true, effect: 'apply', action: 'toggle-scope' },
    ],
    [
      '⎋ open closes',
      key('Escape', 'Escape'),
      OPEN,
      { consume: true, release: true, effect: 'apply', action: 'close' },
    ],
    [
      'a letter open is the field’s typing',
      key('KeyE', 'e'),
      OPEN,
      { consume: false, release: false, effect: 'none', action: 'type' },
    ],
    [
      '⌥1 open still launches',
      key('Digit1', '¡', { altKey: true }),
      OPEN,
      { consume: true, release: true, effect: 'apply', action: 'launch' },
    ],
    [
      'a letter while launching is held, release too',
      key('KeyE', 'e'),
      LAUNCHING,
      { consume: true, release: true, effect: 'none', action: 'hold' },
    ],
    [
      'a digit past the rows is held, release too',
      key('Digit9', 'ª', { altKey: true }),
      CLOSED,
      { consume: true, release: true, effect: 'none', action: 'hold' },
    ],
  ])('%s', (_name, event, state, expected) => {
    expect(decided(event, state)).toEqual(expected);
  });

  it('takes a release once for each press it took, wherever the release lands', () => {
    const releases = new LauncherKeyReleases();
    expect(releases.released('Digit1')).toBe(false);
    releases.took('Digit1');
    expect(releases.released('KeyE')).toBe(false);
    expect(releases.released('Digit1')).toBe(true);
    expect(releases.released('Digit1')).toBe(false);
    releases.took('');
    expect(releases.released('')).toBe(false);
  });
});
