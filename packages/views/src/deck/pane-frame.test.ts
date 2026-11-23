import { describe, expect, it } from 'vitest';
import {
  formatRunTime,
  formatTurnElapsed,
  paneBadgeName,
  paneFrameModel,
  stopKeyLabel,
  type PaneFrameAgent,
  type PaneFrameSession,
} from './pane-frame.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function session(overrides: Partial<PaneFrameSession> = {}): PaneFrameSession {
  return { id: 'term-1', exited: false, cwd: '/Users/james/Projects/rosetta', ...overrides };
}

function agent(overrides: Partial<PaneFrameAgent> = {}): PaneFrameAgent {
  return {
    providerId: 'codex',
    providerLabel: 'Codex',
    status: 'idle',
    alive: true,
    statusSince: new Date(NOW - 42_000).toISOString(),
    project: 'rosetta',
    cwd: '/Users/james/Projects/rosetta',
    model: 'gpt-5.3-codex',
    ...overrides,
  };
}

describe('paneFrameModel', () => {
  it('draws a shell as its badge alone, named by the folder and never the title', () => {
    expect(paneFrameModel({ session: session(), nowMs: NOW })).toEqual({ name: 'rosetta' });
    expect(paneFrameModel({ session: session({ cwd: null }), nowMs: NOW })).toEqual({ name: 'terminal' });
  });

  it('names the badge by the agent project first, then the session cwd, then the agent cwd', () => {
    expect(paneBadgeName(session({ cwd: '/elsewhere/stale' }), agent({ project: 'godview' }))).toBe('godview');
    expect(paneBadgeName(session({ cwd: 'C:\\Users\\james\\project' }))).toBe('project');
    expect(paneBadgeName(session({ cwd: null }), agent({ project: '', cwd: '/workspace/project' }))).toBe('project');
  });

  it("names a bare shell with no cwd yet by the host's remembered folder, and only then 'terminal'", () => {
    expect(paneBadgeName(session({ cwd: null }), undefined, '/workspace/project')).toBe('project');
    expect(
      paneFrameModel({ session: session({ cwd: null }), fallbackCwd: '/Users/james/Projects/rosetta', nowMs: NOW }),
    ).toEqual({
      name: 'rosetta',
    });
    expect(paneFrameModel({ session: session({ cwd: null }), nowMs: NOW }).name).toBe('terminal');
  });

  it('carries the agent mark, the lowercase readout with effort intent, and the stop verb', () => {
    const model = paneFrameModel({
      session: session(),
      agent: agent({ effort: { value: 'high', configured: true } }),
      nowMs: NOW,
    });
    expect(model.providerId).toBe('codex');
    expect(model.readout).toEqual({ model: 'gpt-5.3-codex', effort: 'high', configured: true });
    expect(model.verb).toEqual({ kind: 'stop' });
    expect(model.context).toBeUndefined();
  });

  it('falls back to the provider label when the model is unknown', () => {
    const model = paneFrameModel({ session: session(), agent: agent({ model: undefined }), nowMs: NOW });
    expect(model.readout).toEqual({ model: 'Codex', configured: false });
  });

  it('times the turn from the working status and says when the context runs hot', () => {
    const model = paneFrameModel({
      session: session(),
      agent: agent({
        status: 'working',
        statusSince: new Date(NOW - 4_320_000).toISOString(),
        contextPercent: 88.6,
      }),
      nowMs: NOW,
    });
    expect(model.verb).toEqual({ kind: 'stop', elapsed: '1h 12m' });
    expect(model.context).toEqual({ percent: 88, hot: true });
  });

  it('keeps the stop verb bare when the working status has no clock', () => {
    const model = paneFrameModel({
      session: session(),
      agent: agent({ status: 'working', statusSince: undefined }),
      nowMs: NOW,
    });
    expect(model.verb).toEqual({ kind: 'stop' });
  });

  it("carries the stop's key as the title names it, and none while the host names none", () => {
    const working = agent({ status: 'working', statusSince: new Date(NOW - 65_000).toISOString() });
    expect(paneFrameModel({ session: session(), agent: { ...working, stopKey: 'escape' }, nowMs: NOW }).verb).toEqual({
      kind: 'stop',
      elapsed: '1:05',
      key: '⎋',
    });
    expect(paneFrameModel({ session: session(), agent: agent({ stopKey: 'ctrl-c' }), nowMs: NOW }).verb).toEqual({
      kind: 'stop',
      key: '⌃C',
    });
    expect(paneFrameModel({ session: session(), agent: working, nowMs: NOW }).verb).toEqual({
      kind: 'stop',
      elapsed: '1:05',
    });
    // an ended run offers resume, whatever its stop was
    expect(
      paneFrameModel({ session: session(), agent: agent({ alive: false, stopKey: 'escape' }), nowMs: NOW }).verb,
    ).toEqual({ kind: 'resume' });
  });

  it('shows no ring while the provider cannot say, and resume once the process has ended', () => {
    expect(
      paneFrameModel({ session: session(), agent: agent({ contextPercent: undefined }), nowMs: NOW }).context,
    ).toBeUndefined();
    expect(
      paneFrameModel({ session: session(), agent: agent({ contextPercent: Number.NaN }), nowMs: NOW }).context,
    ).toBeUndefined();
    expect(
      paneFrameModel({ session: session({ exited: true }), agent: agent({ alive: false }), nowMs: NOW }).verb,
    ).toEqual({
      kind: 'resume',
    });
    expect(paneFrameModel({ session: session(), agent: agent({ alive: false }), nowMs: NOW }).verb).toEqual({
      kind: 'resume',
    });
  });

  it('clamps the context share into the ring', () => {
    expect(paneFrameModel({ session: session(), agent: agent({ contextPercent: 140 }), nowMs: NOW }).context).toEqual({
      percent: 100,
      hot: true,
    });
    expect(paneFrameModel({ session: session(), agent: agent({ contextPercent: -3 }), nowMs: NOW }).context).toEqual({
      percent: 0,
      hot: false,
    });
  });

  it("reads the host's clock: the time before this terminal, and its own since its birth", () => {
    // no clock, no word
    expect(paneFrameModel({ session: session(), nowMs: NOW }).clock).toBeUndefined();
    // a terminal born 90 s ago, nothing before it
    expect(paneFrameModel({ session: session(), clock: { ms: 0, at: NOW - 90_000 }, nowMs: NOW }).clock).toEqual({
      text: '1m',
      running: true,
    });
    // a resumed session: 2 h 58 m before this terminal, 3 m in it
    expect(
      paneFrameModel({
        session: session(),
        agent: agent(),
        clock: { ms: 178 * 60_000, at: NOW - 3 * 60_000 },
        nowMs: NOW,
      }).clock,
    ).toEqual({ text: '3h 01m', running: true });
    // stopped: the whole of it, whatever the clock on the wall says
    expect(
      paneFrameModel({ session: session({ exited: true }), clock: { ms: 45 * 60_000 }, nowMs: NOW }).clock,
    ).toEqual({ text: '45m', running: false });
    // a birth the wall clock has not reached yet adds nothing
    expect(paneFrameModel({ session: session(), clock: { ms: 60_000, at: NOW + 5_000 }, nowMs: NOW }).clock?.text).toBe(
      '1m',
    );
    // a clock that names no time says none
    expect(paneFrameModel({ session: session(), clock: { ms: Number.NaN }, nowMs: NOW }).clock).toBeUndefined();
    expect(paneFrameModel({ session: session(), clock: { ms: -1 }, nowMs: NOW }).clock).toBeUndefined();
    expect(paneFrameModel({ session: session(), clock: { ms: 0, at: Number.NaN }, nowMs: NOW }).clock).toBeUndefined();
  });

  it('says a running time to the minute: minutes, then hours and minutes, then days and hours', () => {
    expect(formatRunTime(0)).toBe('0m');
    expect(formatRunTime(59_999)).toBe('0m');
    expect(formatRunTime(59 * 60_000 + 59_000)).toBe('59m');
    expect(formatRunTime(60 * 60_000)).toBe('1h 00m');
    expect(formatRunTime(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m');
    expect(formatRunTime(24 * 3_600_000)).toBe('1d 00h');
    expect(formatRunTime(75 * 3_600_000)).toBe('3d 03h');
    expect(formatRunTime(-5)).toBe('0m');
  });

  it('names the device a remote session lives on', () => {
    expect(paneFrameModel({ session: session(), remoteDevice: 'studio', nowMs: NOW }).remote).toBe('studio');
  });

  it("names the badge by the host's mark, draws its lead, and hides the provider mark only when told", () => {
    const lead = { kind: 'stencil', key: 'ada', path: 'M4 4h16v16H4z' } as const;
    const marked = paneFrameModel({
      session: session(),
      agent: agent({ mark: { name: 'Ada', lead, provider: 'hidden' } }),
      nowMs: NOW,
    });
    expect(marked.name).toBe('Ada');
    expect(marked.lead).toBe(lead);
    expect(marked).not.toHaveProperty('providerId');
    // the readout still says what runs the pane
    expect(marked.readout).toEqual({ model: 'gpt-5.3-codex', configured: false });

    const shown = paneFrameModel({ session: session(), agent: agent({ mark: { lead } }), nowMs: NOW });
    expect(shown).toMatchObject({ name: 'rosetta', providerId: 'codex', lead });
  });

  it("names the badge by the session's title, keeps the folder for the pointer, and gives way to a mark", () => {
    const titled = paneFrameModel({
      session: session(),
      agent: agent({ title: 'Mend the invoice writer' }),
      nowMs: NOW,
    });
    expect(titled).toMatchObject({ name: 'Mend the invoice writer', folder: 'rosetta', providerId: 'codex' });
    // No title, or a blank one: the folder names the pane, and nothing repeats it.
    for (const title of [undefined, '', '   ']) {
      const plain = paneFrameModel({ session: session(), agent: agent({ title }), nowMs: NOW });
      expect(plain.name).toBe('rosetta');
      expect(plain).not.toHaveProperty('folder');
    }
    const marked = paneFrameModel({
      session: session(),
      agent: agent({ title: 'Mend the invoice writer', mark: { name: 'Ada' } }),
      nowMs: NOW,
    });
    expect(marked.name).toBe('Ada');
    expect(marked).not.toHaveProperty('folder');
  });

  it('draws the badge as it ships for a row with no mark, or an empty one', () => {
    const bare = paneFrameModel({ session: session(), agent: agent(), nowMs: NOW });
    const empty = paneFrameModel({ session: session(), agent: agent({ mark: { name: '' } }), nowMs: NOW });
    for (const model of [bare, empty]) {
      expect(model).toMatchObject({ name: 'rosetta', providerId: 'codex' });
      expect(model).not.toHaveProperty('lead');
    }
  });
});

describe('stopKeyLabel', () => {
  it('draws the keys core names as glyphs, and names a key it has no glyph for by its own word', () => {
    expect(stopKeyLabel('escape')).toBe('⎋');
    expect(stopKeyLabel('ctrl-c')).toBe('⌃C');
    expect(stopKeyLabel('ctrl-g')).toBe('ctrl-g');
    expect(stopKeyLabel('toString')).toBe('toString');
  });
});

describe('formatTurnElapsed', () => {
  it('reads like a stopwatch under an hour and like a clock past it', () => {
    expect(formatTurnElapsed(42_000)).toBe('0:42');
    expect(formatTurnElapsed(725_000)).toBe('12:05');
    expect(formatTurnElapsed(4_320_000)).toBe('1h 12m');
    expect(formatTurnElapsed(-5)).toBe('0:00');
  });
});
