import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState, type MonitorBlocker } from '@vibecook/puppeteer-core';
import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk';
import { remoteWriteLabel } from '../monitor/remote-write.js';
import { EMPTY_STATUS_LEDGER, observeStatuses } from '../monitor/status-ledger.js';
import type { MonitorAgent } from '../monitor/types.js';
import { USAGE_STEP_MS } from '../monitor/usage-ledger.js';
import { rainDataString } from '../views/rain/rain-streams.js';
import { bubbleModel } from '../views/swarm/bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from '../views/swarm/swarm-parameters.js';
import { laneFromRow } from '../views/timeline/timeline-lanes.js';
import { toMonitorAgent, toMonitorAgents, viewReadProjection, type LegacyShimOptions } from './index.js';

const NOW = Date.parse('2026-10-03T22:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Each host's options, as it will pass them (M4, M9). */
const VIBEFIELD: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'omit' };
const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };

/** Core's headline for the fixture's working run: the backend's `detail` (M4). */
const HEADLINE = 'Reading src/app.ts';
/** What puppeteer's Godview appends to it today for the fixture's cost: ~$1.20 so far, $6 an hour. */
const COST_WORDS = '~$1.20 estimated API cost · $0.10/min';

function agentView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'run-a',
    kind: 'agent',
    createdAt: NOW - 600_000,
    status: 'working',
    statusSince: NOW - 60_000,
    stale: false,
    alive: true,
    observed: true,
    detail: HEADLINE,
    project: { name: 'puppeteer', branch: 'mv/land', seq: 2 },
    provider: { id: 'imposter', label: 'Imposter' },
    model: 'Opus 5.5',
    effort: { value: 'high' },
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

/** The same run, on another desktop. */
function peerView(overrides: Partial<AgentView> = {}): AgentView {
  return agentView({
    id: 'run-p',
    device: { id: 'desk-2', name: 'Laptop', os: 'linux', self: false },
    tier: 'remote',
    attachment: undefined,
    active: false,
    ...overrides,
  });
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
    observed: true,
    detail: 'Unassigned terminal',
    activity: { kind: 'unknown' },
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
function todaysRow(state: AgentMonitorState = coreState(), detail = `${HEADLINE} · ${COST_WORDS}`): MonitorAgent {
  return {
    id: 'run-a',
    session: { id: 'pty-7', createdAtMs: NOW - 600_000, cwd: '/work/puppeteer' },
    visualId: 'run-a',
    createdAtMs: NOW - 600_000,
    status: state.status,
    project: 'puppeteer',
    detail,
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
    expect(toMonitorAgent(agentView(), GODVIEW)).toEqual({
      id: 'run-a',
      createdAtMs: NOW - 600_000,
      status: 'working',
      project: 'puppeteer',
      detail: `${HEADLINE} · ${COST_WORDS}`,
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
      GODVIEW,
    );
    expect(legacy).toMatchObject({ stale: true, unread: true, receded: true, spawnHint: { x: 3, y: 4 } });
    expect(legacy.attachment).toBeUndefined();
    expect(legacy.visualId).toBeUndefined();
    expect(legacy.cwd).toBeUndefined();
    expect(legacy.session).toBeUndefined();
    expect(legacy.remote).toBeUndefined();
    expect(legacy.agent?.recency).toBeUndefined();
    const plain = toMonitorAgent(agentView(), GODVIEW);
    expect('stale' in plain || 'unread' in plain || 'receded' in plain).toBe(false);
  });

  it('says a terminal: no agent facet, its activity as the session’s, `terminal` where it has no folder', () => {
    for (const options of [VIBEFIELD, GODVIEW]) {
      const legacy = toMonitorAgent(terminalView(), options);
      expect(legacy.agent).toBeUndefined();
      expect(legacy.project).toBe('terminal');
      expect(legacy.session?.activity?.kind).toBe('unknown');
    }
    expect(toMonitorAgent(terminalView({ id: 'shell-2', project: { name: 'notes' } }), GODVIEW).project).toBe('notes');
    expect(toMonitorAgent(terminalView({ id: 'shell-3', activity: undefined }), GODVIEW).session).toBeUndefined();
  });

  it('names an agent with no folder by its provider, as both hosts do', () => {
    expect(toMonitorAgent(agentView({ id: 'run-f', project: { name: '' } }), GODVIEW).project).toBe('Imposter');
  });

  it('says a row on another desktop as the remote facet, its write policy following attachable', () => {
    const peer = toMonitorAgent(peerView(), GODVIEW);
    expect(peer.remote).toEqual({
      deviceId: 'desk-2',
      deviceName: 'Laptop',
      attachable: true,
      hostWritable: true,
      cwdLabel: 'puppeteer',
    });
    expect(remoteWriteLabel(peer.remote!)).toBe('writable host');
    const shut = toMonitorAgent(peerView({ id: 'run-q', attachable: false }), GODVIEW);
    expect(shut.remote).toMatchObject({ attachable: false, hostWritable: false });
    expect(remoteWriteLabel(shut.remote!)).toBe('read-only host');
  });

  it('says the three waits the views draw, and no blocker for any other word', () => {
    const since = NOW - 5_000;
    const blockers = (wait: AgentView['wait'], id: string) =>
      toMonitorAgent(agentView({ id, status: 'blocked', wait }), GODVIEW).agent?.monitor?.blockers;
    expect(blockers({ kind: 'permission', since, tool: 'Bash', detail: 'rm -rf build' }, 'w1')).toEqual([
      { kind: 'permission', since: iso(since), detail: 'rm -rf build', permission: { tool: 'Bash' } },
    ]);
    expect(blockers({ kind: 'question', since, header: 'Deploy', question: 'Ship it?' }, 'w2')).toEqual([
      { kind: 'question', since: iso(since), questions: [{ header: 'Deploy', prompt: 'Ship it?' }] },
    ]);
    expect(blockers({ kind: 'failure', since, code: 'E_TOOL' }, 'w3')).toEqual([
      { kind: 'failure', since: iso(since), failure: { code: 'E_TOOL' } },
    ]);
    expect(blockers({ kind: 'approval', since }, 'w4')).toEqual([]);
    // A cut that carries no content: the blocker, and no words of its own.
    expect(blockers({ kind: 'question', since }, 'w5')).toEqual([
      { kind: 'question', since: iso(since), questions: [] },
    ]);
    // A header with no prompt still gives the swarm a prompt to trim.
    expect(blockers({ kind: 'question', since, header: '  ' }, 'w6')).toEqual([
      { kind: 'question', since: iso(since), questions: [{ header: '  ', prompt: '' }] },
    ]);
  });

  it('says an agent’s activity as the monitor’s, and its effort with the intent', () => {
    const facts = toMonitorAgent(
      agentView({
        id: 'run-act',
        activity: { kind: 'tool', line: 'Running the tests', since: NOW - 30_000 },
        effort: { value: 'max', intent: 'configured' },
      }),
      GODVIEW,
    ).agent?.monitor;
    expect(facts?.activity).toEqual({ kind: 'tool', line: 'Running the tests', since: iso(NOW - 30_000) });
    expect(facts?.effort).toEqual({ value: 'max', intent: 'configured' });
    // A cut with no line: the kind alone.
    expect(
      toMonitorAgent(agentView({ id: 'run-act2', activity: { kind: 'reasoning' } }), GODVIEW).agent?.monitor?.activity,
    ).toEqual({ kind: 'reasoning' });
  });

  it('says cost: no total where nothing was priced, the rate per minute from the burn per hour', () => {
    const unpriced = toMonitorAgent(
      agentView({ id: 'run-u', cost: { usd: 0, coverage: 'unavailable' } }),
      GODVIEW,
    ).agent;
    expect(unpriced?.usage).toEqual({ coverage: 'unavailable', steps: [], stepMs: USAGE_STEP_MS });
    expect(unpriced?.monitor?.usage).toEqual({ costCoverage: 'unavailable' });
    const none = toMonitorAgent(agentView({ id: 'run-n', cost: undefined }), GODVIEW).agent;
    expect(none?.usage).toBeUndefined();
    expect(none?.monitor?.usage).toEqual({});
  });

  it('keeps identity per view and per model, under each host’s options however they are passed', () => {
    const a = agentView();
    const b = agentView({ id: 'run-b', createdAt: NOW - 500_000 });
    const first = model([a, b]);
    const second = model([a, { ...b, status: 'idle' }]);
    expect(toMonitorAgent(a, GODVIEW)).toBe(toMonitorAgent(a, GODVIEW));
    expect(toMonitorAgents(first, GODVIEW)).toBe(toMonitorAgents(first, GODVIEW));
    expect(toMonitorAgents(second, GODVIEW)).not.toBe(toMonitorAgents(first, GODVIEW));
    expect(toMonitorAgents(second, GODVIEW)[0]).toBe(toMonitorAgents(first, GODVIEW)[0]);
    expect(toMonitorAgents(second, GODVIEW)[1]).not.toBe(toMonitorAgents(first, GODVIEW)[1]);
    expect(toMonitorAgents(second, GODVIEW).map((row) => row.id)).toEqual(['run-a', 'run-b']);
    // A host that writes its options inline each time keeps identity: the memo goes by their values.
    expect(toMonitorAgents(first, { detail: 'headline-cost', peerMonitor: 'map' })).toBe(
      toMonitorAgents(first, GODVIEW),
    );
    // Another host's options are another row.
    expect(toMonitorAgent(a, VIBEFIELD)).not.toBe(toMonitorAgent(a, GODVIEW));
    expect(Object.isFrozen(toMonitorAgent(a, GODVIEW))).toBe(true);
    expect(Object.isFrozen(toMonitorAgents(first, GODVIEW))).toBe(true);
  });
});

describe('the line under the name (M4)', () => {
  const line = (view: AgentView, options: LegacyShimOptions) => toMonitorAgent(view, options).detail;
  const since = NOW - 5_000;
  const permission = { kind: 'permission', since, tool: 'Bash' } as const;

  it('reply-first is VibeField’s agentDetail (field-app godview/monitor/agent-status.ts:111-124)', () => {
    expect(line(agentView({ id: 'v1', pending: true, observed: false, status: 'idle' }), VIBEFIELD)).toBe(
      'unobserved · resumes when idle',
    );
    expect(line(agentView({ id: 'v2', observed: false }), VIBEFIELD)).toBe('starting');
    expect(line(agentView({ id: 'v3', status: 'blocked', wait: permission }), VIBEFIELD)).toBe('permission · Bash');
    expect(
      line(agentView({ id: 'v4', status: 'blocked', wait: { kind: 'question', since, question: 'Ship?' } }), VIBEFIELD),
    ).toBe('question');
    expect(line(agentView({ id: 'v5', status: 'blocked' }), VIBEFIELD)).toBe('blocked');
    expect(line(agentView({ id: 'v6', status: 'blocked', wait: { kind: 'approval', since } }), VIBEFIELD)).toBe(
      'approval',
    );
    // The whole reply, trimmed: VibeField's line is not the swarm's first line.
    expect(
      line(agentView({ id: 'v7', status: 'idle', reply: { text: '  All green.\nNext: docs  ' } }), VIBEFIELD),
    ).toBe('All green.\nNext: docs');
    expect(line(agentView({ id: 'v8', status: 'idle', reply: { text: '   ' } }), VIBEFIELD)).toBe('idle');
    // The status word, never the backend's headline.
    expect(line(agentView({ id: 'v9' }), VIBEFIELD)).toBe('working');
  });

  it('reply-first words a peer as remoteDetail after its desktop’s name (mesh-rows.ts:72-84, agents.ts:364)', () => {
    expect(
      line(peerView({ id: 'p1', status: 'blocked', wait: { ...permission, question: ' Ship it? ' } }), VIBEFIELD),
    ).toBe('Laptop · Ship it?');
    expect(line(peerView({ id: 'p2', status: 'blocked', wait: permission }), VIBEFIELD)).toBe(
      'Laptop · permission · Bash',
    );
    expect(line(peerView({ id: 'p3', status: 'blocked' }), VIBEFIELD)).toBe('Laptop · blocked');
    expect(line(peerView({ id: 'p4', status: 'idle', reply: { text: 'All green. ' } }), VIBEFIELD)).toBe(
      'Laptop · All green.',
    );
    expect(line(peerView({ id: 'p5', pending: true, observed: false, status: 'idle' }), VIBEFIELD)).toBe(
      'Laptop · unobserved · resumes when idle',
    );
    // A peer has no "starting" branch: its owner's row is read as it stands.
    expect(line(peerView({ id: 'p6', observed: false }), VIBEFIELD)).toBe('Laptop · working');
  });

  it('headline-cost is puppeteer Godview’s line (apps/godview/src/renderer/monitor/agents.ts:112-124)', () => {
    expect(line(agentView({ id: 'g1' }), GODVIEW)).toBe(`${HEADLINE} · ${COST_WORDS}`);
    const blocked = { status: 'blocked', detail: 'permission: Bash' } as const;
    expect(line(agentView({ id: 'g2', ...blocked, wait: { ...permission, count: 3 } }), GODVIEW)).toBe(
      `permission: Bash · +2 blockers · ${COST_WORDS}`,
    );
    expect(line(agentView({ id: 'g3', ...blocked, wait: { ...permission, count: 1 } }), GODVIEW)).toBe(
      `permission: Bash · ${COST_WORDS}`,
    );
    expect(line(agentView({ id: 'g4', ...blocked, wait: permission }), GODVIEW)).toBe(
      `permission: Bash · ${COST_WORDS}`,
    );
    expect(line(agentView({ id: 'g5', cost: { usd: 1.2, coverage: 'partial', burnPerHour: 6 } }), GODVIEW)).toBe(
      `${HEADLINE} · ~$1.20 estimated API cost (partial) · $0.10/min`,
    );
    expect(
      line(agentView({ id: 'g6', status: 'idle', detail: 'idle', cost: { usd: 0, coverage: 'unavailable' } }), GODVIEW),
    ).toBe('idle · cost unavailable');
    expect(line(agentView({ id: 'g7', status: 'idle', detail: 'idle', cost: undefined }), GODVIEW)).toBe(
      'idle · cost unavailable',
    );
    expect(line(agentView({ id: 'g8', cost: { usd: 0.0005, coverage: 'complete' } }), GODVIEW)).toBe(
      `${HEADLINE} · ~<$0.001 estimated API cost`,
    );
  });

  it('a terminal’s line is the backend’s under either option', () => {
    for (const options of [VIBEFIELD, GODVIEW]) {
      expect(line(terminalView(), options)).toBe('Unassigned terminal');
    }
  });
});

describe('peers (M9)', () => {
  const rich = {
    status: 'blocked',
    wait: { kind: 'permission', since: NOW - 5_000, tool: 'Bash' },
    reply: { text: 'Need a hand.' },
    activity: { kind: 'tool', line: 'Running the tests', since: NOW - 30_000 },
  } as const;

  it('omit: a peer carries what VibeField’s peers carry today, so nothing a peer shows changes', () => {
    const peer = toMonitorAgent(peerView({ id: 'm1', ...rich }), VIBEFIELD);
    expect(peer.agent).toEqual({
      provider: { id: 'imposter', label: 'Imposter' },
      model: 'Opus 5.5',
      branch: 'mv/land',
      usage: { total: 1.2, coverage: 'complete', steps: [0, 0.1, 0.2], stepMs: USAGE_STEP_MS },
    });
    // Including where its timeline lane starts: at first sight, as today, not at the owner's statusSince.
    expect(laneFromRow(peer, NOW, NOW - 10_000).spans[0]?.fromMs).toBe(NOW - 10_000);
    // The line still says what the owner's row says.
    expect(peer.detail).toBe('Laptop · permission · Bash');
    // This desktop's own rows keep their Core facts under the same options.
    expect(toMonitorAgent(agentView({ id: 'm2', ...rich }), VIBEFIELD).agent?.monitor?.blockers).toHaveLength(1);
  });

  it('map: a peer carries the row’s facts', () => {
    const peer = toMonitorAgent(peerView({ id: 'm3', ...rich }), GODVIEW);
    expect(peer.agent?.monitor?.blockers).toEqual([
      { kind: 'permission', since: iso(NOW - 5_000), permission: { tool: 'Bash' } },
    ]);
    expect(peer.agent?.contextWindow).toEqual({ usedPercent: 42.6 });
    expect(peer.agent?.account).toBe('work');
    expect(laneFromRow(peer, NOW, NOW - 10_000).spans[0]?.fromMs).toBe(NOW - 60_000);
  });
});

describe('a row the runtime has not spoken for (observed: false; mv-review)', () => {
  // Today such a run has no mirror, so neither host's row carries `agent.monitor` or a usage history. The backend
  // dates a starting row's statusSince at the host's createdAt; a monitor carrying it would start the status
  // ledger's lane at the birth (status-ledger.ts:146-152) instead of at first sight.
  const starting = (overrides: Partial<AgentView> = {}): AgentView =>
    agentView({
      id: 'run-s',
      observed: false,
      detail: 'starting',
      statusSince: NOW - 600_000,
      model: undefined,
      effort: undefined,
      context: undefined,
      activity: undefined,
      ...overrides,
    });

  it('carries no Core facts and no usage while starting, under either host’s options', () => {
    for (const options of [VIBEFIELD, GODVIEW]) {
      const legacy = toMonitorAgent(starting(), options);
      expect(legacy.agent?.monitor).toBeUndefined();
      expect(legacy.agent?.usage).toBeUndefined();
      expect(legacy.agent?.provider).toEqual({ id: 'imposter', label: 'Imposter' });
    }
    expect(toMonitorAgent(starting(), VIBEFIELD).detail).toBe('starting');
  });

  it('nor while pending (AR-4): nothing drives the run yet', () => {
    const pending = starting({ pending: true, status: 'idle', detail: 'unobserved · resumes when idle' });
    for (const options of [VIBEFIELD, GODVIEW]) {
      const legacy = toMonitorAgent(pending, options);
      expect(legacy.agent?.monitor).toBeUndefined();
      expect(legacy.agent?.usage).toBeUndefined();
    }
  });

  it('so the status ledger starts its lane at first sight, as today, and at the state once the runtime speaks', () => {
    const before = observeStatuses(EMPTY_STATUS_LEDGER, toMonitorAgents(model([starting()]), VIBEFIELD), NOW);
    expect(before.lanes.get('run-s')?.changes).toEqual([{ status: 'working', atMs: NOW }]);
    const spoken = toMonitorAgent(starting({ observed: true, statusSince: NOW - 30_000 }), VIBEFIELD);
    expect(spoken.agent?.monitor?.statusSince).toBe(iso(NOW - 30_000));
    expect(spoken.agent?.usage).toMatchObject({ total: 1.2 });
  });
});

describe('the shipping views draw the shim', () => {
  const draw = (view: AgentView, unread = false) =>
    bubbleModel({ agent: toMonitorAgent(view, GODVIEW), parameters: DEFAULT_SWARM_PARAMETERS, nowMs: NOW, unread });

  it('the swarm: a working body’s figures, branch, name and model line', () => {
    const body = draw(agentView());
    expect(body.state).toBe('working');
    expect(body.figures?.top?.text).toBe('42%');
    expect(body.figures?.bottom?.text).toBe('~$1.20');
    expect(body.burn).toMatchObject({ priced: true });
    expect(body.copy.map((entry) => entry.text)).toEqual(['mv/land', 'puppeteer', 'Opus 5.5 · high']);
    expect(body.accent).toBe('oklch(70% 0.1 200)');
    expect(body.linked).toBe('pane-blue');
  });

  it('the swarm: what a blocked or unread body says', () => {
    const since = NOW - 5_000;
    const words = (view: AgentView, unread = false) =>
      draw(view, unread).copy.find((entry) => entry.key === 'state')?.text;
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

  it('the swarm words a wait in its own order: header or prompt, detail, tool, code, then the reply, then the word', () => {
    const since = NOW - 5_000;
    const reply = { text: 'Waiting on you.\nmore', at: NOW, final: true };
    const words = (id: string, wait: NonNullable<AgentView['wait']>, withReply = false) =>
      draw(agentView({ id, status: 'blocked', wait, ...(withReply ? { reply } : {}) })).copy.find(
        (entry) => entry.key === 'state',
      )?.text;
    const all = { since, header: 'Deploy', question: 'Ship it?', detail: 'the detail', tool: 'Bash', code: 'E_TOOL' };
    expect(words('o1', { kind: 'question', ...all })).toBe('Deploy');
    expect(words('o2', { kind: 'question', ...all, header: undefined })).toBe('Ship it?');
    expect(words('o3', { kind: 'question', ...all, header: undefined, question: undefined })).toBe('the detail');
    expect(words('o4', { kind: 'permission', ...all })).toBe('the detail');
    expect(words('o5', { kind: 'permission', since, tool: 'Bash' })).toBe('Bash');
    expect(words('o6', { kind: 'failure', since, code: 'E_TOOL' })).toBe('E_TOOL');
    expect(words('o7', { kind: 'failure', since }, true)).toBe('Waiting on you.');
    expect(words('o8', { kind: 'failure', since })).toBe('failed');
    // A header that says nothing falls to the prompt, and an absent prompt to the detail: no crash on either.
    expect(words('o9', { kind: 'question', since, header: '  ', detail: 'the detail' })).toBe('the detail');
  });

  it('the ledger and the timeline word a wait in theirs: detail, then prompt', () => {
    const since = NOW - 5_000;
    const ledgerWords = (id: string, wait: NonNullable<AgentView['wait']>) =>
      observeStatuses(
        EMPTY_STATUS_LEDGER,
        [toMonitorAgent(agentView({ id, status: 'blocked', wait }), GODVIEW)],
        NOW,
      ).lanes.get(id)?.changes[0]?.blocker;
    expect(
      ledgerWords('l1', { kind: 'question', since, header: 'Deploy', question: 'Ship it?', detail: 'the detail' }),
    ).toEqual({ kind: 'question', detail: 'the detail' });
    expect(ledgerWords('l2', { kind: 'question', since, header: 'Deploy', question: 'Ship it?' })).toEqual({
      kind: 'question',
      detail: 'Ship it?',
    });
    expect(ledgerWords('l3', { kind: 'question', since, header: 'Deploy' })).toEqual({ kind: 'question' });
    expect(ledgerWords('l4', { kind: 'permission', since, tool: 'Bash' })).toEqual({ kind: 'permission' });
    const lane = laneFromRow(
      toMonitorAgent(
        agentView({ id: 'l5', status: 'blocked', wait: { kind: 'permission', since, detail: 'rm -rf build' } }),
        GODVIEW,
      ),
      NOW,
    );
    expect(lane.spans[0]?.blocker).toEqual({ kind: 'permission', detail: 'rm -rf build' });
  });

  it('a working agent’s activity line is what its stretch did, and a launch effort reads in italics', () => {
    const working = agentView({
      id: 'did',
      activity: { kind: 'tool', line: 'Running the tests', since: NOW - 30_000 },
      effort: { value: 'max', intent: 'configured' },
    });
    expect(laneFromRow(toMonitorAgent(working, GODVIEW), NOW).spans[0]?.did).toBe('Running the tests');
    expect(
      observeStatuses(EMPTY_STATUS_LEDGER, [toMonitorAgent(working, GODVIEW)], NOW).lanes.get('did')?.changes[0]?.did,
    ).toBe('Running the tests');
    const modelLine = (view: AgentView) => draw(view).copy.find((entry) => entry.key === 'model');
    expect(modelLine(working)).toMatchObject({ text: 'Opus 5.5 · max', style: { italic: true } });
    expect(
      modelLine(agentView({ id: 'seen', effort: { value: 'max', intent: 'observed' } }))?.style.italic,
    ).toBeUndefined();
  });

  it('the rain and the timeline', () => {
    expect(rainDataString(toMonitorAgent(agentView(), GODVIEW))).toBe(' puppeteer mv land Opus 5.5 CTX 43% ');
    const lane = laneFromRow(
      toMonitorAgent(
        agentView({ id: 't1', status: 'blocked', wait: { kind: 'failure', since: NOW - 5_000 } }),
        GODVIEW,
      ),
      NOW,
    );
    expect(lane.spans).toEqual([{ status: 'blocked', fromMs: NOW - 60_000, blocker: { kind: 'failure' } }]);
  });

  it('the status ledger (L10) folds the shim’s rows', () => {
    const ledger = observeStatuses(
      EMPTY_STATUS_LEDGER,
      toMonitorAgents(model([agentView(), terminalView()]), GODVIEW),
      NOW,
    );
    expect(ledger.lanes.get('run-a')?.changes).toEqual([{ status: 'working', atMs: NOW - 60_000 }]);
    // A terminal has no run whose state began somewhere: its lane starts at first sight, as today.
    expect(ledger.lanes.get('shell-1')?.changes).toEqual([{ status: 'idle', atMs: NOW }]);
  });
});

describe('viewReadProjection', () => {
  it('is exactly the audited reads, as plain JSON', () => {
    const reads = viewReadProjection(toMonitorAgent(agentView({ unread: true }), GODVIEW));
    expect(reads).toEqual({
      id: 'run-a',
      visualId: 'run-a',
      createdAtMs: NOW - 600_000,
      status: 'working',
      project: 'puppeteer',
      detail: `${HEADLINE} · ${COST_WORDS}`,
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
    expect(viewReadProjection(toMonitorAgent(terminalView(), GODVIEW))).toEqual({
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
    const shim = viewReadProjection(
      toMonitorAgent(agentView({ reply: { text: 'Done with the first pass.' } }), GODVIEW),
    );
    const today = viewReadProjection(todaysRow());
    expect(differingPaths(today, shim)).toEqual([]);
    expect(shim).toEqual(today);
  });

  it('round trip with every part of a wait, the effort’s intent and the activity line (M2)', () => {
    const since = NOW - 5_000;
    const cases: readonly (readonly [MonitorBlocker, NonNullable<AgentView['wait']>])[] = [
      [
        {
          id: 'b',
          kind: 'permission',
          since: iso(since),
          detail: 'rm -rf build',
          permission: { requestId: 'r', tool: 'Bash' },
        },
        { kind: 'permission', since, detail: 'rm -rf build', tool: 'Bash' },
      ],
      [
        {
          id: 'b',
          kind: 'question',
          since: iso(since),
          detail: 'asks',
          questions: [{ header: 'Deploy', prompt: 'Ship it?' }],
        },
        { kind: 'question', since, detail: 'asks', header: 'Deploy', question: 'Ship it?' },
      ],
      [
        { id: 'b', kind: 'failure', since: iso(since), failure: { code: 'E_TOOL', recoverable: true } },
        { kind: 'failure', since, code: 'E_TOOL' },
      ],
    ];
    for (const [blocker, wait] of cases) {
      const headline = `${blocker.kind}: ${blocker.detail ?? 'waits'}`;
      const today = viewReadProjection(
        todaysRow(
          coreState({
            status: 'blocked',
            blockers: [blocker],
            effort: { value: 'high', intent: 'configured' },
            activity: { kind: 'tool', line: 'Running the tests', since: iso(NOW - 30_000) },
          }),
          `${headline} · ${COST_WORDS}`,
        ),
      );
      const shim = viewReadProjection(
        toMonitorAgent(
          agentView({
            status: 'blocked',
            detail: headline,
            wait,
            effort: { value: 'high', intent: 'configured' },
            activity: { kind: 'tool', line: 'Running the tests', since: NOW - 30_000 },
            reply: { text: 'Done with the first pass.' },
          }),
          GODVIEW,
        ),
      );
      expect(differingPaths(today, shim)).toEqual([]);
    }
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
