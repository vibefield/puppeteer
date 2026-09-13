import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import type { MonitorAgent, MonitorAgentFacet } from '../monitor/types.js';
import { formatTurnElapsed, paneFrameModel, zoomKeyEvent } from './pane-frame.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'term-1',
    handle: 'h1',
    executable: '/bin/zsh',
    cols: 120,
    rows: 40,
    exited: false,
    readWrite: true,
    title: 'a title the badge must ignore',
    cwd: '/Users/james/Projects/rosetta',
    bellCount: 0,
    pid: 100,
    createdAtMs: NOW - 60_000,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: 'terminate-with-app',
    activity: { kind: 'idle' } as unknown as SessionSummary['activity'],
    ...overrides,
  };
}

function monitor(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeEpoch: 1,
    revision: 1,
    runtimeRunId: 'run-1',
    status: 'idle',
    statusSince: new Date(NOW - 42_000).toISOString(),
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' } as unknown as AgentMonitorState['modes'],
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {} } as unknown as AgentMonitorState['freshness'],
    alive: true,
    ...overrides,
  } as AgentMonitorState;
}

function agent(facetOverrides: Partial<MonitorAgentFacet> = {}, overrides: Partial<MonitorAgent> = {}): MonitorAgent {
  const state = facetOverrides.monitor ?? monitor();
  return {
    id: 'term-1',
    session: session(),
    createdAtMs: 0,
    status: state.status,
    project: 'rosetta',
    detail: '',
    color: 'hsl(268 58% 56%)',
    active: false,
    cwd: '/Users/james/Projects/rosetta',
    agent: {
      provider: { id: 'codex', label: 'Codex' } as MonitorAgentFacet['provider'],
      model: 'gpt-5.3-codex',
      monitor: state,
      recency: 'live' as MonitorAgentFacet['recency'],
      info: {} as MonitorAgentFacet['info'],
      ...facetOverrides,
    },
    ...overrides,
  };
}

describe('paneFrameModel', () => {
  it('draws a shell as its badge alone, named by the folder and never the title', () => {
    expect(paneFrameModel({ session: session(), nowMs: NOW })).toEqual({ name: 'rosetta' });
    expect(paneFrameModel({ session: session({ cwd: null }), nowMs: NOW })).toEqual({ name: 'terminal' });
  });

  it('carries the agent mark, the lowercase readout with effort intent, and the stop verb', () => {
    const model = paneFrameModel({
      session: session(),
      agent: agent({ monitor: monitor({ effort: { value: 'high', intent: 'configured' } }) }),
      nowMs: NOW,
    });
    expect(model.providerId).toBe('codex');
    expect(model.readout).toEqual({ model: 'gpt-5.3-codex', effort: 'high', configured: true });
    expect(model.verb).toEqual({ kind: 'stop' });
    expect(model.context).toBeUndefined();
  });

  it('times the turn from the working status and says when the context runs hot', () => {
    const model = paneFrameModel({
      session: session(),
      agent: agent({
        monitor: monitor({
          status: 'working',
          statusSince: new Date(NOW - 4_320_000).toISOString(),
          context: { usedPercent: 88.6, percentageSource: 'provider', asOf: new Date(NOW).toISOString() },
        }),
        contextWindow: { usedPercent: 88.6, percentageSource: 'provider', asOf: new Date(NOW).toISOString() },
      }),
      nowMs: NOW,
    });
    expect(model.verb).toEqual({ kind: 'stop', elapsed: '1h 12m' });
    expect(model.context).toEqual({ percent: 88, hot: true });
  });

  it('shows no meter while the provider cannot say, and resume once the process has ended', () => {
    const unavailable = paneFrameModel({
      session: session(),
      agent: agent({ contextWindow: { percentageSource: 'unavailable', asOf: new Date(NOW).toISOString() } }),
      nowMs: NOW,
    });
    expect(unavailable.context).toBeUndefined();

    const ended = paneFrameModel({
      session: session({ exited: true }),
      agent: agent({ monitor: monitor({ alive: false }) }),
      nowMs: NOW,
    });
    expect(ended.verb).toEqual({ kind: 'resume' });
  });

  it('names the device a remote session lives on', () => {
    expect(paneFrameModel({ session: session(), remoteDevice: 'studio', nowMs: NOW }).remote).toBe('studio');
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

describe('zoomKeyEvent', () => {
  it('presses the platform default for toggle_split_zoom', () => {
    expect(zoomKeyEvent(undefined, 'darwin')).toMatchObject({ key: 'Enter', metaKey: true, shiftKey: true });
  });

  it('follows a rebinding and an unbind from the configuration', () => {
    const rebound = zoomKeyEvent(
      { clearKeybindings: false, keybindings: [{ trigger: 'ctrl+shift+z', action: 'toggle_split_zoom' }] } as never,
      'darwin',
    );
    expect(rebound).toMatchObject({ key: 'Z', ctrlKey: true, shiftKey: true, metaKey: false });
    expect(
      zoomKeyEvent(
        { clearKeybindings: false, keybindings: [{ trigger: 'super+shift+enter', action: 'unbind' }] } as never,
        'darwin',
      ),
    ).toBeNull();
  });
});
