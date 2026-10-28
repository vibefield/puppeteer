import { describe, expect, it } from 'vitest';
import {
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

  it('shows no meter while the provider cannot say, and resume once the process has ended', () => {
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

  it('clamps the context share into the meter', () => {
    expect(paneFrameModel({ session: session(), agent: agent({ contextPercent: 140 }), nowMs: NOW }).context).toEqual({
      percent: 100,
      hot: true,
    });
    expect(paneFrameModel({ session: session(), agent: agent({ contextPercent: -3 }), nowMs: NOW }).context).toEqual({
      percent: 0,
      hot: false,
    });
  });

  it('names the device a remote session lives on', () => {
    expect(paneFrameModel({ session: session(), remoteDevice: 'studio', nowMs: NOW }).remote).toBe('studio');
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
