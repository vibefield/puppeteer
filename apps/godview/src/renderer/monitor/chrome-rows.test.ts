import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import type { AgentSessionInfo } from '../../protocol.js';
import { buildPaneAttachments } from '../pane-attachments.js';
import { chromeDetail, chromeRows } from './chrome-rows.js';

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

const NOW = Date.parse('2026-10-03T22:00:00.000Z');

/** A row as the replica gives it (the backend's, with this window's join). */
function view(id: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id,
    kind: 'agent',
    createdAt: 10,
    status: 'working',
    statusSince: NOW - 60_000,
    stale: false,
    alive: true,
    observed: true,
    detail: 'Edit · x',
    project: { name: 'app', branch: 'main', seq: 1 },
    provider: { id: 'codex', label: 'Codex' },
    model: 'gpt',
    cost: { usd: 1.5, coverage: 'complete' },
    unread: false,
    device: { id: 'mac', name: 'Mac', self: true },
    attachable: true,
    writable: true,
    colour: '#f00',
    active: false,
    receded: false,
    ...overrides,
  };
}

const terminalView = (id: string, overrides: Partial<AgentView> = {}): AgentView =>
  view(id, {
    kind: 'terminal',
    createdAt: 5,
    status: 'idle',
    detail: '/notes',
    project: { name: 'notes' },
    provider: undefined,
    model: undefined,
    cost: undefined,
    colour: '#999',
    active: true,
    ...overrides,
  });

function modelOf(rows: readonly AgentView[]): MonitorModel {
  return { revision: 1, agents: rows, byId: new Map(rows.map((row) => [row.id, row] as const)) };
}

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
      model: modelOf([view('pty-1')]),
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
      detail: 'Edit · x · ~$1.50 estimated API cost',
      color: '#f00',
      session: { id: 'pty-1' },
      cwd: '/project/app/pkg',
      attachment: { primaryPaneId: 'pane-a', paneIds: ['pane-a'] },
      agent: {
        provider: { id: 'codex', label: 'Codex' },
        model: 'gpt',
        branch: 'main',
        contextWindow: { usedPercent: 40, percentageSource: 'provider' },
        recency: 'fresh',
        nativeSessionId: 'native-pty-1',
        info: { runtimeRunId: 'run-pty-1' },
      },
    });
    expect(row?.agent?.monitor).toBe(monitor);
  });

  it("shows the run's terminal until the chrome's state arrives, and a terminal row with its live summary", () => {
    const rows = chromeRows({
      model: modelOf([view('pty-1', { stale: true }), terminalView('sh-9')]),
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
        model: modelOf([view('pty-1'), terminalView('sh-9')]),
        agentSessions: new Map(),
        records: new Map(),
        terminals: [],
        sessions: new Map(),
        attachments: new Map(),
      }),
    ).toEqual([]);
  });

  it('one row per body, as the views draw them: the earlier row (agents first) speaks for a shared visual identity', () => {
    const rows = chromeRows({
      model: modelOf([view('ag-r', { visualId: 'sh-f' }), terminalView('sh-f', { visualId: 'sh-f' })]),
      agentSessions: new Map([['ag-r', 'ag-r']]),
      records: new Map([['ag-r', { info: info('ag-r') }]]),
      terminals: [{ session: session('sh-f') }],
      sessions: new Map(),
      attachments: new Map(),
    });
    expect(rows.map((row) => row.id)).toEqual(['ag-r']);
  });

  it('names a row with no folder as the seam did: an agent by its provider, a terminal `terminal`', () => {
    const rows = chromeRows({
      model: modelOf([view('pty-1', { project: { name: '' } }), terminalView('sh-9', { project: { name: '' } })]),
      agentSessions: new Map([['pty-1', 'pty-1']]),
      records: new Map([['pty-1', { info: info('pty-1') }]]),
      terminals: [{ session: session('sh-9') }],
      sessions: new Map(),
      attachments: new Map(),
    });
    expect(rows.map((row) => row.project)).toEqual(['Codex', 'terminal']);
  });
});

/** Godview's line as its seam composed it (agents.ts monitorAgentFromSession before MV), carried from the shim's tests. */
describe('the words Find matches a row on (Godview’s line, kept by the chrome)', () => {
  const HEADLINE = 'Reading src/app.ts';
  const COST_WORDS = '~$1.20 estimated API cost · $0.10/min';
  const permission = { kind: 'permission', since: NOW - 5_000, tool: 'Bash' } as const;
  const working = (overrides: Partial<AgentView> = {}): AgentView =>
    view('g', { detail: HEADLINE, cost: { usd: 1.2, coverage: 'complete', burnPerHour: 6 }, ...overrides });

  it('the headline, the blockers beyond the first, the cost and the burn', () => {
    expect(chromeDetail(working())).toBe(`${HEADLINE} · ${COST_WORDS}`);
    const blocked = { status: 'blocked', detail: 'permission: Bash' } as const;
    expect(chromeDetail(working({ ...blocked, wait: { ...permission, count: 3 } }))).toBe(
      `permission: Bash · +2 blockers · ${COST_WORDS}`,
    );
    expect(chromeDetail(working({ ...blocked, wait: { ...permission, count: 1 } }))).toBe(
      `permission: Bash · ${COST_WORDS}`,
    );
    expect(chromeDetail(working({ ...blocked, wait: permission }))).toBe(`permission: Bash · ${COST_WORDS}`);
    expect(chromeDetail(working({ cost: { usd: 1.2, coverage: 'partial', burnPerHour: 6 } }))).toBe(
      `${HEADLINE} · ~$1.20 estimated API cost (partial) · $0.10/min`,
    );
    expect(chromeDetail(working({ status: 'idle', detail: 'idle', cost: { usd: 0, coverage: 'unavailable' } }))).toBe(
      'idle · cost unavailable',
    );
    expect(chromeDetail(working({ status: 'idle', detail: 'idle', cost: undefined }))).toBe('idle · cost unavailable');
    expect(chromeDetail(working({ cost: { usd: 0.0005, coverage: 'complete' } }))).toBe(
      `${HEADLINE} · ~<$0.001 estimated API cost`,
    );
  });

  it('restores the per-minute burn the backend multiplied by 60, so a half cent does not flip (M27)', () => {
    expect((0.015 * 60) / 60).not.toBe(0.015);
    expect(chromeDetail(working({ cost: { usd: 1.2, coverage: 'complete', burnPerHour: 0.015 * 60 } }))).toBe(
      `${HEADLINE} · ~$1.20 estimated API cost · $0.02/min`,
    );
  });

  it('a terminal’s line is the backend’s own', () => {
    expect(chromeDetail(terminalView('sh', { detail: 'Unassigned terminal' }))).toBe('Unassigned terminal');
  });
});
