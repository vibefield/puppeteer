import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import { paneFrameModel } from '@vibecook/puppeteer-views';
import type { MonitorAgent, MonitorAgentFacet } from '../monitor/types.js';
import { paneFrameAgent, paneFrameAgents, zoomKeyEvent } from './pane-frame.js';

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

describe('paneFrameAgent', () => {
  it('projects the facet into the frame facts: provider, status, liveness, the readout, the effort intent', () => {
    expect(paneFrameAgent(agent({ monitor: monitor({ effort: { value: 'high', intent: 'configured' } }) }))).toEqual({
      providerId: 'codex',
      providerLabel: 'Codex',
      status: 'idle',
      alive: true,
      statusSince: new Date(NOW - 42_000).toISOString(),
      project: 'rosetta',
      cwd: '/Users/james/Projects/rosetta',
      model: 'gpt-5.3-codex',
      effort: { value: 'high', configured: true },
    });
  });

  it('hands over the context share only when the provider could say', () => {
    const asOf = new Date(NOW).toISOString();
    expect(
      paneFrameAgent(agent({ contextWindow: { usedPercent: 88.6, percentageSource: 'provider', asOf } }))?.contextPercent,
    ).toBe(88.6);
    expect(paneFrameAgent(agent({ contextWindow: { percentageSource: 'unavailable', asOf } }))?.contextPercent).toBeUndefined();
  });

  it('is nothing for a bare terminal row', () => {
    expect(paneFrameAgent(agent({}, { agent: undefined }))).toBeUndefined();
    expect(paneFrameAgents(new Map([['term-1', agent({}, { agent: undefined })]])).size).toBe(0);
  });

  it('composes with the package model as the app frame does', () => {
    const facts = paneFrameAgent(
      agent({
        monitor: monitor({ status: 'working', statusSince: new Date(NOW - 4_320_000).toISOString() }),
        contextWindow: { usedPercent: 88.6, percentageSource: 'provider', asOf: new Date(NOW).toISOString() },
      }),
    );
    const model = paneFrameModel({ session: session(), agent: facts, nowMs: NOW });
    expect(model.verb).toEqual({ kind: 'stop', elapsed: '1h 12m' });
    expect(model.context).toEqual({ percent: 88, hot: true });
    expect(model.name).toBe('rosetta');
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
