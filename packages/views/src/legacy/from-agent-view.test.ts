import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibecook/puppeteer-core';
import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk';
import { remoteWriteLabel } from '../monitor/remote-write.js';
import { EMPTY_STATUS_LEDGER, observeStatuses } from '../monitor/status-ledger.js';
import type { MonitorAgent } from '../monitor/types.js';
import { USAGE_STEP_MS } from '../monitor/usage-ledger.js';
import { rainDataString } from '../views/rain/rain-streams.js';
import { bubbleModel } from '../views/swarm/bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from '../views/swarm/swarm-parameters.js';
import { laneFromRow } from '../views/timeline/timeline-lanes.js';
import { toMonitorAgent, toMonitorAgents, viewReadProjection } from './index.js';

const NOW = Date.parse('2026-10-03T22:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function agentView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'run-a',
    kind: 'agent',
    createdAt: NOW - 600_000,
    status: 'working',
    statusSince: NOW - 60_000,
    stale: false,
    alive: true,
    detail: 'Reading src/app.ts · ~$1.20 estimated API cost',
    project: { name: 'puppeteer', branch: 'mv/land', seq: 2 },
    provider: { id: 'imposter', label: 'Imposter' },
    model: 'Opus 5.5',
    effort: 'high',
    account: 'work',
    context: { usedPercent: 42.6 },
    cost: {
      usd: 1.2,
      coverage: 'complete',
      burnPerHour: 6,
      series: { stepMs: USAGE_STEP_MS, steps: [0, 0.1, 0.2], lastStepAt: NOW - 10_000 },
    },
    unread: false,
    device: { id: 'desk-1', name: 'Studio', os: 'mac', self: true },
    tier: 'managed',
    profileSet: 'native',
    attachable: true,
    colour: 'oklch(70% 0.1 200)',
    active: true,
    receded: false,
    attachment: { panes: 2, colour: 'pane-blue' },
    ...overrides,
  };
}

function terminalView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'shell-1',
    kind: 'terminal',
    createdAt: NOW - 120_000,
    status: 'idle',
    statusSince: NOW - 120_000,
    stale: false,
    alive: true,
    detail: 'Unassigned terminal',
    activity: 'unknown',
    project: { name: '' },
    unread: false,
    device: { id: 'desk-1', name: 'Studio', os: 'mac', self: true },
    attachable: true,
    colour: 'ramp',
    active: false,
    receded: false,
    ...overrides,
  };
}

function model(agents: readonly AgentView[]): MonitorModel {
  return { revision: 1, agents, byId: new Map(agents.map((view) => [view.id, view])) };
}

/** A run's state the way Core reports it, for a row built the way today's hosts build one. */
function coreState(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId: 'runtime-a',
    runtimeEpoch: 1,
    revision: 9,
    status: 'working',
    statusSince: iso(NOW - 60_000),
    blockers: [],
    lastAssistantMessage: { text: 'Done with the first pass.', at: iso(NOW - 90_000), final: true },
    usage: { samples: [], costUsd: 1.2, costCoverage: 'complete', costRatePerMin: 0.1 },
    context: { usedPercent: 42.6, percentageSource: 'provider', asOf: iso(NOW - 5_000) },
    model: { id: 'opus-5-5', displayName: 'Opus 5.5' },
    effort: { value: 'high', intent: 'observed' },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],
    compaction: { active: false, count: 0 },
    environment: { cwd: '/work/puppeteer', worktrees: [] },
    session: { nativeSessionId: 'native-1' },
    freshness: { lastEvidenceAt: iso(NOW - 5_000), level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

/** Today's row for the same run: what puppeteer's Godview seam assembles (`monitorAgentFromSession` + decorate). */
function todaysRow(state: AgentMonitorState = coreState()): MonitorAgent {
  return {
    id: 'run-a',
    session: { id: 'pty-7', createdAtMs: NOW - 600_000, cwd: '/work/puppeteer' },
    visualId: 'run-a',
    createdAtMs: NOW - 600_000,
    status: state.status,
    project: 'puppeteer',
    detail: 'Reading src/app.ts · ~$1.20 estimated API cost',
    color: 'oklch(70% 0.1 200)',
    active: true,
    cwd: '/work/puppeteer',
    tier: 'managed',
    profileSet: 'native',
    attachment: { primaryPaneId: 'pane-3', paneIds: ['pane-3', 'pane-9'], color: 'pane-blue' },
    agent: {
      provider: { id: 'imposter', label: 'Imposter' },
      model: 'Opus 5.5',
      account: 'work',
      branch: 'mv/land',
      ...(state.context ? { contextWindow: state.context } : {}),
      monitor: state,
      usage: { total: 1.2, coverage: 'complete', steps: Array(20).fill(0.05), stepMs: USAGE_STEP_MS },
      recency: 'fresh',
      nativeSessionId: 'native-1',
    },
  };
}

/** Every JSON path at which two values differ. */
function differingPaths(left: unknown, right: unknown, path = ''): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return [path];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) =>
    differingPaths(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    ),
  );
}

describe('toMonitorAgent', () => {
  it('says an agent row in the legacy shape, each fact under its old name', () => {
    expect(toMonitorAgent(agentView())).toEqual({
      id: 'run-a',
      createdAtMs: NOW - 600_000,
      status: 'working',
      project: 'puppeteer',
      detail: 'Reading src/app.ts · ~$1.20 estimated API cost',
      color: 'oklch(70% 0.1 200)',
      active: true,
      tier: 'managed',
      profileSet: 'native',
      attachment: { primaryPaneId: 'run-a:pane:0', paneIds: ['run-a:pane:0', 'run-a:pane:1'], color: 'pane-blue' },
      agent: {
        provider: { id: 'imposter', label: 'Imposter' },
        model: 'Opus 5.5',
        account: 'work',
        branch: 'mv/land',
        contextWindow: { usedPercent: 42.6 },
        usage: { total: 1.2, coverage: 'complete', steps: [0, 0.1, 0.2], stepMs: USAGE_STEP_MS },
        monitor: {
          statusSince: iso(NOW - 60_000),
          blockers: [],
          effort: { value: 'high' },
          usage: { costCoverage: 'complete', costRatePerMin: 0.1 },
        },
      },
    });
  });

  it('carries the flags only when set, and says nothing it does not know', () => {
    const legacy = toMonitorAgent(
      agentView({ stale: true, unread: true, receded: true, spawnHint: { x: 3, y: 4 }, attachment: undefined }),
    );
    expect(legacy).toMatchObject({ stale: true, unread: true, receded: true, spawnHint: { x: 3, y: 4 } });
    expect(legacy.attachment).toBeUndefined();
    expect(legacy.visualId).toBeUndefined();
    expect(legacy.cwd).toBeUndefined();
    expect(legacy.session).toBeUndefined();
    expect(legacy.remote).toBeUndefined();
    expect(legacy.agent?.recency).toBeUndefined();
    const plain = toMonitorAgent(agentView());
    expect('stale' in plain || 'unread' in plain || 'receded' in plain).toBe(false);
  });

  it('says a terminal: no agent facet, its activity as the session’s, `terminal` where it has no folder', () => {
    const legacy = toMonitorAgent(terminalView());
    expect(legacy.agent).toBeUndefined();
    expect(legacy.project).toBe('terminal');
    expect(legacy.session?.activity?.kind).toBe('unknown');
    expect(toMonitorAgent(terminalView({ id: 'shell-2', project: { name: 'notes' } })).project).toBe('notes');
    expect(toMonitorAgent(terminalView({ id: 'shell-3', activity: undefined })).session).toBeUndefined();
  });

  it('names an agent with no folder by its provider, as both hosts do', () => {
    expect(toMonitorAgent(agentView({ id: 'run-f', project: { name: '' } })).project).toBe('Imposter');
  });

  it('says a row on another desktop as the remote facet, its write policy following attachable', () => {
    const peer = toMonitorAgent(
      agentView({ id: 'run-p', device: { id: 'desk-2', name: 'Laptop', os: 'linux', self: false }, tier: 'remote' }),
    );
    expect(peer.remote).toEqual({
      deviceId: 'desk-2',
      deviceName: 'Laptop',
      attachable: true,
      hostWritable: true,
      cwdLabel: 'puppeteer',
    });
    expect(remoteWriteLabel(peer.remote!)).toBe('writable host');
    const shut = toMonitorAgent(
      agentView({ id: 'run-q', device: { id: 'desk-2', name: 'Laptop', self: false }, attachable: false }),
    );
    expect(shut.remote).toMatchObject({ attachable: false, hostWritable: false });
    expect(remoteWriteLabel(shut.remote!)).toBe('read-only host');
  });

  it('says the three waits the views draw, and no blocker for any other word', () => {
    const since = NOW - 5_000;
    const blockers = (wait: AgentView['wait'], id: string) =>
      toMonitorAgent(agentView({ id, status: 'blocked', wait })).agent?.monitor?.blockers;
    expect(blockers({ kind: 'permission', since, tool: 'Bash' }, 'w1')).toEqual([
      { kind: 'permission', since: iso(since), permission: { tool: 'Bash' } },
    ]);
    expect(blockers({ kind: 'question', since, question: 'Ship it?' }, 'w2')).toEqual([
      { kind: 'question', since: iso(since), questions: [{ prompt: 'Ship it?' }] },
    ]);
    expect(blockers({ kind: 'failure', since }, 'w3')).toEqual([{ kind: 'failure', since: iso(since) }]);
    expect(blockers({ kind: 'approval', since }, 'w4')).toEqual([]);
  });

  it('says cost: no total where nothing was priced, the rate per minute from the burn per hour', () => {
    const unpriced = toMonitorAgent(agentView({ id: 'run-u', cost: { usd: 0, coverage: 'unavailable' } })).agent;
    expect(unpriced?.usage).toEqual({ coverage: 'unavailable', steps: [], stepMs: USAGE_STEP_MS });
    expect(unpriced?.monitor?.usage).toEqual({ costCoverage: 'unavailable' });
    const none = toMonitorAgent(agentView({ id: 'run-n', cost: undefined })).agent;
    expect(none?.usage).toBeUndefined();
    expect(none?.monitor?.usage).toEqual({});
  });

  it('keeps identity: the same view the same row, the same model the same list, an unchanged row in a new model too', () => {
    const a = agentView();
    const b = agentView({ id: 'run-b', createdAt: NOW - 500_000 });
    const first = model([a, b]);
    const second = model([a, { ...b, status: 'idle' }]);
    expect(toMonitorAgent(a)).toBe(toMonitorAgent(a));
    expect(toMonitorAgents(first)).toBe(toMonitorAgents(first));
    expect(toMonitorAgents(second)).not.toBe(toMonitorAgents(first));
    expect(toMonitorAgents(second)[0]).toBe(toMonitorAgents(first)[0]);
    expect(toMonitorAgents(second)[1]).not.toBe(toMonitorAgents(first)[1]);
    expect(toMonitorAgents(second).map((row) => row.id)).toEqual(['run-a', 'run-b']);
    expect(Object.isFrozen(toMonitorAgent(a))).toBe(true);
    expect(Object.isFrozen(toMonitorAgents(first))).toBe(true);
  });
});

describe('the shipping views draw the shim', () => {
  const draw = (view: AgentView, unread = false) =>
    bubbleModel({ agent: toMonitorAgent(view), parameters: DEFAULT_SWARM_PARAMETERS, nowMs: NOW, unread });

  it('the swarm: a working body’s figures, branch, name and model line', () => {
    const body = draw(agentView());
    expect(body.state).toBe('working');
    expect(body.figures?.top?.text).toBe('42%');
    expect(body.figures?.bottom?.text).toBe('~$1.20');
    expect(body.burn).toMatchObject({ priced: true });
    expect(body.copy.map((line) => line.text)).toEqual(['mv/land', 'puppeteer', 'Opus 5.5 · high']);
    expect(body.accent).toBe('oklch(70% 0.1 200)');
    expect(body.linked).toBe('pane-blue');
  });

  it('the swarm: what a blocked or unread body says', () => {
    const since = NOW - 5_000;
    const words = (view: AgentView, unread = false) =>
      draw(view, unread).copy.find((line) => line.key === 'state')?.text;
    expect(words(agentView({ id: 'b1', status: 'blocked', wait: { kind: 'permission', since, tool: 'Bash' } }))).toBe(
      'Bash',
    );
    expect(
      words(agentView({ id: 'b2', status: 'blocked', wait: { kind: 'question', since, question: 'Ship?' } })),
    ).toBe('Ship?');
    expect(
      words(
        agentView({ id: 'b3', status: 'idle', reply: { text: 'All green.\nNext: docs', at: NOW, final: true } }),
        true,
      ),
    ).toBe('All green.');
    expect(draw(terminalView()).state).toBe('terminal-empty');
  });

  it('the rain and the timeline', () => {
    expect(rainDataString(toMonitorAgent(agentView()))).toBe(' puppeteer mv land Opus 5.5 CTX 43% ');
    const lane = laneFromRow(
      toMonitorAgent(agentView({ id: 't1', status: 'blocked', wait: { kind: 'failure', since: NOW - 5_000 } })),
      NOW,
    );
    expect(lane.spans).toEqual([{ status: 'blocked', fromMs: NOW - 60_000, blocker: { kind: 'failure' } }]);
  });

  it('the status ledger (L10) folds the shim’s rows', () => {
    const ledger = observeStatuses(EMPTY_STATUS_LEDGER, toMonitorAgents(model([agentView(), terminalView()])), NOW);
    expect(ledger.lanes.get('run-a')?.changes).toEqual([{ status: 'working', atMs: NOW - 60_000 }]);
    // A terminal has no run whose state began somewhere: its lane starts at first sight, as today.
    expect(ledger.lanes.get('shell-1')?.changes).toEqual([{ status: 'idle', atMs: NOW }]);
  });
});

describe('viewReadProjection', () => {
  it('is exactly the audited reads, as plain JSON', () => {
    const reads = viewReadProjection(toMonitorAgent(agentView({ unread: true })));
    expect(reads).toEqual({
      id: 'run-a',
      visualId: 'run-a',
      createdAtMs: NOW - 600_000,
      status: 'working',
      project: 'puppeteer',
      detail: 'Reading src/app.ts · ~$1.20 estimated API cost',
      color: 'oklch(70% 0.1 200)',
      stale: false,
      active: true,
      unread: true,
      receded: false,
      attachment: { color: 'pane-blue', panes: 2 },
      profileSet: 'native',
      agent: {
        provider: { id: 'imposter', label: 'Imposter' },
        model: 'Opus 5.5',
        account: 'work',
        branch: 'mv/land',
        contextWindow: { usedPercent: 42.6 },
        usage: { total: 1.2, coverage: 'complete' },
        monitor: {
          statusSince: NOW - 60_000,
          effort: { value: 'high' },
          usage: { costCoverage: 'complete', costRatePerMin: 0.1 },
        },
      },
    });
    expect(JSON.parse(JSON.stringify(reads))).toEqual(reads);
    expect(viewReadProjection(toMonitorAgent(terminalView()))).toEqual({
      id: 'shell-1',
      visualId: 'shell-1',
      createdAtMs: NOW - 120_000,
      status: 'idle',
      project: 'terminal',
      detail: 'Unassigned terminal',
      color: 'ramp',
      stale: false,
      active: false,
      unread: false,
      receded: false,
      session: { activity: { kind: 'unknown' } },
    });
  });

  it('round trip: today’s row and the shim’s row of the same facts read the same', () => {
    const shim = viewReadProjection(toMonitorAgent(agentView({ reply: { text: 'Done with the first pass.' } })));
    const today = viewReadProjection(todaysRow());
    expect(differingPaths(today, shim)).toEqual([]);
    expect(shim).toEqual(today);
  });

  it('pins what the model cannot say yet: the blocker detail, an effort’s intent, an agent’s activity line', () => {
    const blocked = coreState({
      status: 'blocked',
      blockers: [
        {
          id: 'b',
          kind: 'permission',
          since: iso(NOW - 5_000),
          detail: 'rm -rf build',
          permission: { requestId: 'r' },
        },
      ],
      effort: { value: 'high', intent: 'configured' },
      activity: { kind: 'tool', line: 'Running the tests', since: iso(NOW - 30_000) },
    });
    const today = viewReadProjection(todaysRow(blocked));
    const shim = viewReadProjection(
      toMonitorAgent(
        agentView({
          status: 'blocked',
          wait: { kind: 'permission', since: NOW - 5_000 },
          reply: { text: 'Done with the first pass.' },
        }),
      ),
    );
    expect(differingPaths(today, shim)).toEqual([
      'agent.monitor.blockers.0.detail',
      'agent.monitor.activity',
      'agent.monitor.effort.intent',
    ]);
  });

  it('reads identity as the views do, and a row with no facets without failing', () => {
    expect(viewReadProjection({ ...todaysRow(), visualId: 'pty-7' }).visualId).toBe('pty-7');
    const bare: MonitorAgent = {
      id: 'x',
      createdAtMs: 0,
      status: 'idle',
      project: 'p',
      detail: '',
      color: 'c',
      active: false,
    };
    expect(viewReadProjection(bare)).toEqual({
      id: 'x',
      visualId: 'x',
      createdAtMs: 0,
      status: 'idle',
      project: 'p',
      detail: '',
      color: 'c',
      stale: false,
      active: false,
      unread: false,
      receded: false,
    });
  });
});
