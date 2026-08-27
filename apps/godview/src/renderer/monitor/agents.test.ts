import { describe, expect, it } from 'vitest';
import type { SessionActivity, SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState, AgentMonitorStatus } from '@vibecook/puppeteer-core';
import type { AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import {
  assembleMonitorAgents,
  mergeMonitorTerminals,
  monitorAgentCounts,
  nextMonitorAgentForStatus,
  type MonitorAgentRecord,
} from './agents.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, exited: false, createdAtMs: 0, cwd: '/project/godview', ...overrides } as SessionSummary;
}

function monitorState(
  runtimeRunId: string,
  status: AgentMonitorStatus,
  overrides: Partial<AgentMonitorState> = {},
): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeRunId,
    runtimeEpoch: 1,
    revision: 1,
    status,
    statusSince: '2026-08-17T00:00:00.000Z',
    blockers: [],
    ...(status === 'working'
      ? { activity: { kind: 'responding' as const, line: 'Responding', since: '2026-08-17T00:00:00.000Z' } }
      : {}),
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    tasks: [],
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: '2026-08-17T00:00:00.000Z', level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

function monitorMessage(state: AgentMonitorState, terminalSessionId: string): AgentMonitorStateMessage {
  return { runtimeRunId: state.runtimeRunId, terminalSessionId, state };
}

function agentRecord(
  runtimeSessionId: string,
  terminalId: string,
  overrides: Partial<AgentMonitorState> = {},
  createdAtMs = 0,
): MonitorAgentRecord {
  const runtimeRunId = `run-${runtimeSessionId}`;
  return {
    info: {
      provider: { id: 'codex', label: 'Codex' },
      agent: 'codex',
      runtimeRunId,
      runtimeEpoch: 1,
      sessionId: `native-${runtimeSessionId}`,
      runtimeSessionId,
      workspace: { mode: 'direct', root: '/project/godview', sourcePath: '/project/godview' },
      session: session(terminalId, { createdAtMs }),
    } as AgentSessionInfo,
    monitor: monitorMessage(monitorState(runtimeRunId, overrides.status ?? 'idle', overrides), terminalId),
  };
}

describe('monitor agent assembly', () => {
  it('lists agents in launch order ahead of the terminals nothing has claimed', () => {
    const assembled = assembleMonitorAgents({
      agents: [agentRecord('runtime-b', 'terminal-b', {}, 20), agentRecord('runtime-a', 'terminal-a', {}, 10)],
      terminals: [{ session: session('terminal-c') }],
    });
    expect(assembled.map((agent) => agent.id)).toEqual(['terminal-a', 'terminal-b', 'terminal-c']);
    expect(assembled.map((agent) => Boolean(agent.agent))).toEqual([true, true, false]);
  });

  it('drops a terminal placeholder once an agent claims its session', () => {
    const assembled = assembleMonitorAgents({
      agents: [agentRecord('runtime-a', 'terminal-a')],
      terminals: [{ session: session('terminal-a') }],
    });
    expect(assembled).toHaveLength(1);
    // The same body, so a view's placement survives the promotion.
    expect(assembled[0]!.id).toBe('terminal-a');
    expect(assembled[0]!.agent?.provider).toEqual({ id: 'codex', label: 'Codex' });
  });

  it('shows only records backed by the canonical monitor projection', () => {
    const pending = agentRecord('runtime-a', 'terminal-a');
    pending.monitor = undefined;
    const assembled = assembleMonitorAgents({
      agents: [pending, agentRecord('runtime-b', 'terminal-b')],
      terminals: [],
    });
    expect(assembled.map((agent) => agent.id)).toEqual(['terminal-b']);
  });

  it('folds the shell-owned pane facts in, so no view looks them up itself', () => {
    const attachment = { primary: 'hsl(10 72% 48%)', mirrors: ['hsl(60 72% 48%)'] };
    const [agent] = assembleMonitorAgents({
      agents: [agentRecord('runtime-a', 'terminal-a')],
      terminals: [],
      attachments: new Map([['terminal-a', attachment]]),
      activeSessionId: 'terminal-a',
    });
    expect(agent).toMatchObject({ active: true, attachment });
  });

  it('refreshes a terminal placeholder from the live session summary', () => {
    const [terminal] = assembleMonitorAgents({
      agents: [],
      terminals: [{ session: session('terminal-a'), cwd: '/project/godview' }],
      sessions: new Map([
        ['terminal-a', session('terminal-a', { activity: { kind: 'foreground-job' } as SessionActivity })],
      ]),
    });
    expect(terminal).toMatchObject({ status: 'working', project: 'godview' });
    expect(terminal!.agent).toBeUndefined();
  });

  it('keeps monitor identity through a shell handoff and rejects dead terminal placeholders', () => {
    const assembled = assembleMonitorAgents({
      agents: [],
      terminals: [{ session: session('shell') }, { session: session('dead', { exited: true }) }],
      identities: new Map([['shell', 'restored-agent']]),
      activeSessionId: 'shell',
    });
    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toMatchObject({
      id: 'restored-agent',
      session: { id: 'shell' },
      status: 'idle',
      active: true,
    });
  });

  it('discovers restored workspace shells without a creation-only terminal record', () => {
    expect(
      mergeMonitorTerminals({
        explicit: [{ session: session('gesture'), spawnHint: { x: 10, y: 20 } }],
        workspaceSessions: [session('gesture'), session('restored'), session('stale')],
        exitedSessionIds: new Set(['stale']),
        identities: new Map([['restored', 'ended-agent']]),
      }),
    ).toMatchObject([
      { session: { id: 'gesture' }, spawnHint: { x: 10, y: 20 } },
      { id: 'ended-agent', session: { id: 'restored' }, cwd: '/project/godview' },
    ]);
  });

  it('cycles and counts agent-backed sessions only', () => {
    const assembled = assembleMonitorAgents({
      agents: [
        agentRecord('runtime-a', 'terminal-a', { status: 'blocked' }, 10),
        agentRecord('runtime-b', 'terminal-b', { status: 'blocked' }, 20),
      ],
      terminals: [{ session: session('terminal-c') }],
    });
    expect(nextMonitorAgentForStatus(assembled, 'blocked', undefined)?.id).toBe('terminal-a');
    expect(nextMonitorAgentForStatus(assembled, 'blocked', 'terminal-a')?.id).toBe('terminal-b');
    expect(nextMonitorAgentForStatus(assembled, 'blocked', 'terminal-b')?.id).toBe('terminal-a');
    // The idle terminal is visible to views but is not an agent to navigate to.
    expect(nextMonitorAgentForStatus(assembled, 'idle', undefined)).toBeUndefined();
    expect(monitorAgentCounts(assembled)).toEqual({ idle: 0, working: 0, blocked: 2 });
  });

  it('uses the core v2 status directly, so an open task at rest remains idle', () => {
    const record = agentRecord('runtime-a', 'terminal-a');
    const monitor = monitorState('run-runtime-a', 'idle', {
      tasks: [{ id: 'task-1', description: 'Open task', status: 'pending' }],
      usage: { cumulativeTokens: 120, burnRatePerMin: 12, burnRateWindowMs: 60_000, samples: [] },
    });
    record.monitor = monitorMessage(monitor, 'terminal-a');

    const [agent] = assembleMonitorAgents({
      agents: [record],
      terminals: [],
      nowMs: Date.parse('2026-08-17T00:00:01.000Z'),
    });
    expect(agent).toMatchObject({ status: 'idle', detail: 'idle · 120 tokens · 12 tok/min' });
  });

  it('retains a dead question-blocked monitor with choices until monitor removal', () => {
    const record = agentRecord('runtime-a', 'terminal-a');
    record.info = { ...record.info, session: session('terminal-a', { exited: true }) };
    const monitor = monitorState('run-runtime-a', 'blocked', {
      alive: false,
      blockers: [
        {
          id: 'question-1',
          kind: 'question',
          since: '2026-08-17T00:00:00.000Z',
          questions: [{ prompt: 'Choose a database', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
        },
        { id: 'failure-1', kind: 'failure', since: '2026-08-17T00:00:01.000Z' },
      ],
    });
    record.monitor = monitorMessage(monitor, 'terminal-a');

    const [agent] = assembleMonitorAgents({
      agents: [record],
      terminals: [],
      nowMs: Date.parse('2026-08-17T00:01:00.000Z'),
    });
    expect(agent).toMatchObject({
      status: 'blocked',
      detail: 'question · Choose a database · +1 blockers',
      stale: true,
    });
    expect(agent?.agent?.monitor?.blockers).toHaveLength(2);
    expect(agent?.agent?.monitor?.blockers[0]).toMatchObject({ kind: 'question' });
  });

  it('uses the shared distinct-run team aggregate without adding child rows', () => {
    const root = agentRecord('runtime-a', 'terminal-a');
    const peer = agentRecord('runtime-b', 'terminal-b');
    const rootState = monitorState('run-runtime-a', 'working', {
      usage: { cumulativeTokens: 100, burnRatePerMin: 10, samples: [] },
      subagents: [{ id: 'child-1', active: true, cumulativeTokens: 40 }],
      team: { id: 'team-1', teammates: [{ id: 'peer', runtimeRunId: 'run-runtime-b' }] },
    });
    const peerState = monitorState('run-runtime-b', 'idle', {
      usage: { cumulativeTokens: 20, burnRatePerMin: 2, samples: [] },
      team: { id: 'team-1', teammates: [] },
    });
    root.monitor = monitorMessage(rootState, 'terminal-a');
    peer.monitor = monitorMessage(peerState, 'terminal-b');

    const [agent] = assembleMonitorAgents({
      agents: [root, peer],
      terminals: [],
      nowMs: Date.parse('2026-08-17T00:00:01.000Z'),
    });
    expect(agent?.agent?.teamAggregate).toMatchObject({
      totalRuns: 2,
      usage: { cumulativeTokens: 120, burnRatePerMin: 12 },
    });
  });
});
