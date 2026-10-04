import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorAgent as ViewsMonitorAgent } from '@vibecook/puppeteer-views';
import type { AgentSessionInfo } from '../../protocol.js';
import { buildPaneAttachments } from '../pane-attachments.js';
import { chromeRows } from './chrome-rows.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, exited: false, createdAtMs: 10, cwd: '/project/app/src', ...overrides } as SessionSummary;
}

function info(sessionId: string): AgentSessionInfo {
  return {
    provider: { id: 'codex', label: 'Codex' },
    runtimeRunId: `run-${sessionId}`,
    runtimeSessionId: sessionId,
    nativeSession: { id: `native-${sessionId}` },
    workspace: { mode: 'direct', root: '/project/app', sourcePath: '/project/app' },
    session: session(sessionId),
  } as AgentSessionInfo;
}

function state(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: 3,
    runtimeRunId: 'run-pty-1',
    runtimeEpoch: 1,
    revision: 1,
    status: 'working',
    statusSince: '2026-10-03T10:00:00.000Z',
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],
    compaction: { active: false, count: 0 },
    environment: { cwd: '/project/app/pkg', worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: '2026-10-03T10:00:00.000Z' },
    alive: true,
    context: { usedPercent: 40, percentageSource: 'provider' } as AgentMonitorState['context'],
    ...overrides,
  };
}

function modelOf(rows: ReadonlyArray<Pick<AgentView, 'id' | 'kind'>>): MonitorModel {
  const agents = rows.map((row) => ({ ...row }) as AgentView);
  return { revision: 1, agents, byId: new Map(agents.map((agent) => [agent.id, agent] as const)) };
}

const legacyAgent = (id: string, stale = false): ViewsMonitorAgent =>
  ({
    id,
    createdAtMs: 10,
    status: 'working',
    project: 'app',
    detail: 'Edit · x',
    color: '#f00',
    active: false,
    ...(stale ? { stale: true } : {}),
    attachment: { primaryPaneId: `${id}:pane:0`, paneIds: [`${id}:pane:0`] },
    agent: {
      provider: { id: 'codex', label: 'Codex' },
      model: 'gpt',
      branch: 'main',
      usage: { total: 1.5, coverage: 'complete', steps: [], stepMs: 30_000 },
      monitor: { blockers: [] },
    },
  }) as unknown as ViewsMonitorAgent;

const legacyTerminal = (id: string): ViewsMonitorAgent =>
  ({
    id,
    createdAtMs: 5,
    status: 'idle',
    project: 'notes',
    detail: '/notes',
    color: '#999',
    active: true,
    session: { activity: { kind: 'idle' } },
  }) as unknown as ViewsMonitorAgent;

describe("the chrome's rows (M19)", () => {
  const panes = buildPaneAttachments(
    [
      { id: 'pane-a', session: { id: 'pty-1' } },
      { id: 'pane-b', session: { id: 'sh-9' } },
    ],
    'pane-b',
  );

  it("joins an agent row with its record and the chrome feed's full state, by its terminal session", () => {
    const monitor = state();
    const [row] = chromeRows({
      model: modelOf([{ id: 'pty-1', kind: 'agent' }]),
      legacy: [legacyAgent('pty-1')],
      agentSessions: new Map([['pty-1', 'pty-1']]),
      records: new Map([
        [
          'pty-1',
          { info: info('pty-1'), monitor: { runtimeRunId: 'run-pty-1', terminalSessionId: 'pty-1', state: monitor } },
        ],
      ]),
      terminals: [],
      sessions: new Map(),
      attachments: panes,
    });
    expect(row).toMatchObject({
      id: 'pty-1',
      detail: 'Edit · x',
      color: '#f00',
      session: { id: 'pty-1' },
      cwd: '/project/app/pkg',
      attachment: { primaryPaneId: 'pane-a', paneIds: ['pane-a'] },
      agent: {
        provider: { id: 'codex', label: 'Codex' },
        model: 'gpt',
        branch: 'main',
        contextWindow: { usedPercent: 40, percentageSource: 'provider' },
        usage: { total: 1.5 },
        recency: 'fresh',
        nativeSessionId: 'native-pty-1',
        info: { runtimeRunId: 'run-pty-1' },
      },
    });
    expect(row?.agent?.monitor).toBe(monitor);
  });

  it("shows the run's terminal until the chrome's state arrives, and a terminal row with its live summary", () => {
    const rows = chromeRows({
      model: modelOf([
        { id: 'pty-1', kind: 'agent' },
        { id: 'sh-9', kind: 'terminal' },
      ]),
      legacy: [legacyAgent('pty-1', true), legacyTerminal('sh-9')],
      agentSessions: new Map([['pty-1', 'pty-1']]),
      records: new Map([['pty-1', { info: info('pty-1') }]]),
      terminals: [{ session: session('sh-9', { cwd: null } as never), cwd: '/notes' }],
      sessions: new Map([['sh-9', session('sh-9', { cwd: '/notes/live' })]]),
      attachments: panes,
    });
    expect(rows.map((row) => [row.id, row.agent === undefined, row.session.id, row.cwd])).toEqual([
      ['pty-1', true, 'pty-1', '/project/app/src'],
      ['sh-9', true, 'sh-9', '/notes/live'],
    ]);
    expect(rows[1]).toMatchObject({ active: true, attachment: { primaryPaneId: 'pane-b' } });
  });

  it('leaves out a row this window cannot back: an agent with no record, a terminal of another window', () => {
    expect(
      chromeRows({
        model: modelOf([
          { id: 'pty-1', kind: 'agent' },
          { id: 'sh-9', kind: 'terminal' },
        ]),
        legacy: [legacyAgent('pty-1'), legacyTerminal('sh-9')],
        agentSessions: new Map(),
        records: new Map(),
        terminals: [],
        sessions: new Map(),
        attachments: new Map(),
      }),
    ).toEqual([]);
  });
});
