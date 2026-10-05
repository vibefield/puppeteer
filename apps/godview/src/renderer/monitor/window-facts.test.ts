import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentView, MonitorAgentRow, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import { buildPaneAttachments } from '../pane-attachments.js';
import {
  agentSessionsByRow,
  mergeMonitorTerminals,
  rowIdForSession,
  sameVisualIds,
  sessionIdForRow,
  terminalReport,
  visualIdsForRows,
  windowLocal,
  windowTerminalIds,
} from './window-facts.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, exited: false, createdAtMs: 10, cwd: '/project/app', ...overrides } as SessionSummary;
}

function model(rows: ReadonlyArray<Pick<MonitorAgentRow, 'id' | 'kind'>>): MonitorModel {
  const agents = rows.map((row) => ({ ...row }) as AgentView);
  return { revision: 1, agents, byId: new Map(agents.map((agent) => [agent.id, agent] as const)) };
}

const everyRow = (): boolean => true;

describe("this window's terminals", () => {
  it("discovers restored workspace shells without a creation-only record, and keeps an explicit one's hint", () => {
    const terminals = mergeMonitorTerminals({
      explicit: [{ session: session('sh-1'), spawnHint: { x: 4, y: 5 } }],
      workspaceSessions: [session('sh-1', { cwd: '/moved' }), session('sh-2')],
    });
    expect(terminals.map((terminal) => [terminal.session.id, terminal.cwd, terminal.spawnHint])).toEqual([
      ['sh-1', '/moved', { x: 4, y: 5 }],
      ['sh-2', '/project/app', undefined],
    ]);
  });

  it('hides a terminal that exited or that the window is closing, and carries a handoff identity', () => {
    const terminals = mergeMonitorTerminals({
      explicit: [],
      workspaceSessions: [session('sh-1'), session('sh-2'), session('sh-3'), session('sh-4', { exited: true })],
      exitedSessionIds: new Set(['sh-2']),
      closingSessionIds: new Set(['sh-3']),
      identities: new Map([['sh-1', 'pty-0']]),
    });
    expect(terminals.map((terminal) => [terminal.id, terminal.session.id])).toEqual([['pty-0', 'sh-1']]);
  });

  it('reports each terminal to the host port with its live facts and its identity, never a title', () => {
    const live = new Map([['sh-1', session('sh-1', { cwd: '/live', activity: { kind: 'foreground-job' } } as never)]]);
    const report = terminalReport(
      [
        { session: session('sh-1'), cwd: '/remembered' },
        { session: session('sh-2', { cwd: null, title: 'zsh' } as never), cwd: '/remembered' },
        { session: session('sh-3', { exited: true }) },
      ],
      live,
      new Map([['sh-2', 'pty-0']]),
    );
    expect(report).toEqual([
      { sessionId: 'sh-1', createdAt: 10, cwd: '/live', activity: { kind: 'foreground-job' } },
      { sessionId: 'sh-2', identity: 'pty-0', createdAt: 10, cwd: '/remembered' },
    ]);
  });

  it('names rows by the handoff identity, else the session', () => {
    const identities = new Map([['sh-2', 'pty-1']]);
    expect(rowIdForSession('sh-1', identities)).toBe('sh-1');
    expect(rowIdForSession('sh-2', identities)).toBe('pty-1');
    expect([...windowTerminalIds([{ session: session('sh-1') }, { session: session('sh-2') }], identities)]).toEqual([
      'sh-1',
      'pty-1',
    ]);
  });
});

describe('the local join', () => {
  const panes = [
    { id: 'pane-a', session: { id: 'pty-1' } },
    { id: 'pane-b', session: { id: 'pty-1' } },
    { id: 'pane-c', session: { id: 'sh-9' } },
  ];
  const colours = new Map([
    ['pane-a', '#a'],
    ['pane-b', '#b'],
    ['pane-c', '#c'],
  ]);

  it('joins each pane to the row its session backs: how many show it, the colour it is worked in, the active one', () => {
    const local = windowLocal(
      {
        model: model([
          { id: 'pty-1', kind: 'agent' },
          { id: 'sh-9', kind: 'terminal' },
        ]),
        agentSessions: new Map([['pty-1', 'pty-1']]),
        attachments: buildPaneAttachments(panes, 'pane-b', colours),
        activeSessionId: 'pty-1',
        terminals: [],
      },
      everyRow,
    );
    expect([...local.attachments]).toEqual([
      ['pty-1', { panes: 2, colour: '#b' }],
      ['sh-9', { panes: 1, colour: '#c' }],
    ]);
    expect([...local.activeIds]).toEqual(['pty-1']);
  });

  it("lets a crashed agent keep its row while its pane shows the shell it was handed: that pane is the shell's", () => {
    // The agent's PTY pty-1 died; the pane now shows sh-2, which wears pty-1's identity. The agent's row (pty-1) stays
    // until acknowledged and speaks for both; the pane is neither the crashed row's attachment nor its activity.
    const local = windowLocal(
      {
        model: model([{ id: 'pty-1', kind: 'agent' }]),
        agentSessions: new Map([['pty-1', 'pty-1']]),
        attachments: buildPaneAttachments([{ id: 'pane-a', session: { id: 'sh-2' } }], 'pane-a', colours),
        activeSessionId: 'sh-2',
        terminals: [{ session: session('sh-2') }],
        identities: new Map([['sh-2', 'pty-1']]),
      },
      everyRow,
    );
    expect(local.attachments.size).toBe(0);
    expect(local.activeIds.size).toBe(0);
    // Once acknowledged the row is the shell's, and the pane joins it.
    const after = windowLocal(
      {
        model: model([{ id: 'pty-1', kind: 'terminal' }]),
        agentSessions: new Map(),
        attachments: buildPaneAttachments([{ id: 'pane-a', session: { id: 'sh-2' } }], 'pane-a', colours),
        activeSessionId: 'sh-2',
        terminals: [{ session: session('sh-2') }],
        identities: new Map([['sh-2', 'pty-1']]),
      },
      everyRow,
    );
    expect([...after.attachments.keys()]).toEqual(['pty-1']);
    expect([...after.activeIds]).toEqual(['pty-1']);
  });

  it("places only a terminal by where it was asked for, and passes the window's visibility through", () => {
    const visible = (row: MonitorAgentRow): boolean => row.kind === 'agent';
    const local = windowLocal(
      {
        model: model([{ id: 'sh-2', kind: 'agent' }]),
        agentSessions: new Map([['sh-2', 'sh-2']]),
        attachments: new Map(),
        terminals: [
          { session: session('sh-1'), spawnHint: { x: 1, y: 2 } },
          { session: session('sh-2'), spawnHint: { x: 3, y: 4 } },
        ],
      },
      visible,
    );
    expect([...local.spawnHints]).toEqual([['sh-1', { x: 1, y: 2 }]]);
    expect(local.visible).toBe(visible);
  });

  it("carries every row's spatial identity (M59): a launcher's agent wears the shell's body, and keeps it across joins", () => {
    const input = {
      model: model([
        { id: 'run-1', kind: 'agent' },
        { id: 'sh-9', kind: 'terminal' },
      ]),
      agentSessions: new Map([['run-1', 'ag-1']]),
      attachments: new Map(),
      terminals: [{ session: session('sh-9') }],
    } as const;
    // The window transferred the shell's body (sh-f) to the agent's session (ag-1).
    const first = windowLocal({ ...input, visualIds: new Map([['ag-1', 'sh-f']]) }, everyRow);
    expect([...(first.visualIds ?? [])]).toEqual([
      ['run-1', 'sh-f'],
      ['sh-9', 'sh-9'],
    ]);
    // The transfer forgotten by the window: the row keeps what it wore last time.
    const second = windowLocal({ ...input, visualIds: new Map(), previousVisualIds: first.visualIds }, everyRow);
    expect(second.visualIds?.get('run-1')).toBe('sh-f');
    // Nothing carried and nothing worn: the row's session, else its id.
    expect(windowLocal(input, everyRow).visualIds?.get('run-1')).toBe('ag-1');
  });

  it('takes a ready visual-id map as the join (M59, perf): the host computes it once and the join does no visual-id work', () => {
    const ready = new Map([['run-1', 'kept']]);
    const input = {
      model: model([{ id: 'run-1', kind: 'agent' }]),
      agentSessions: new Map([['run-1', 'ag-1']]),
      attachments: new Map(),
      terminals: [],
    } as const;
    // Given ready, the join forwards THAT exact map; it does not recompute from the row's session.
    const local = windowLocal({ ...input, readyVisualIds: ready, visualIds: new Map([['ag-1', 'other']]) }, everyRow);
    expect(local.visualIds).toBe(ready);
    expect(local.visualIds?.get('run-1')).toBe('kept');
  });

  it('keeps a window visual-id map identity across a state-only publish (M59, perf: the per-tick churn the gate caught)', () => {
    const rows = [
      { id: 'run-1', kind: 'agent' as const },
      { id: 'run-2', kind: 'agent' as const },
    ];
    const sessions = new Map([
      ['run-1', 'ag-1'],
      ['run-2', 'ag-2'],
    ]);
    const resolve = (row: { id: string; kind: 'agent' | 'terminal' }) => sessions.get(row.id);
    const first = visualIdsForRows(rows, resolve, new Map(), new Map());
    // A later publish, same row set and no transfer: content-equal, so the host keeps the first map object.
    const next = visualIdsForRows(rows, resolve, new Map(), first);
    expect(sameVisualIds(first, next)).toBe(true);
    const stable = sameVisualIds(first, next) ? first : next;
    expect(stable).toBe(first);
    // A real transfer moves one entry, so the map is a new identity.
    const moved = visualIdsForRows(rows, resolve, new Map([['ag-1', 'shell-9']]), first);
    expect(sameVisualIds(first, moved)).toBe(false);
    expect(moved.get('run-1')).toBe('shell-9');
  });
});

describe('rows and sessions', () => {
  it('maps each agent row to its terminal session, the first record to carry an id winning', () => {
    const identities = new Map([['sh-2', 'pty-1']]);
    const sessions = agentSessionsByRow(['pty-1', 'sh-2', 'pty-3'], identities);
    expect([...sessions]).toEqual([
      ['pty-1', 'pty-1'],
      ['pty-3', 'pty-3'],
    ]);
    expect(sessionIdForRow({ id: 'pty-3', kind: 'agent' }, sessions, [], identities)).toBe('pty-3');
    expect(
      sessionIdForRow({ id: 'pty-1', kind: 'terminal' }, sessions, [{ session: session('sh-2') }], identities),
    ).toBe('sh-2');
    expect(sessionIdForRow({ id: 'nobody', kind: 'terminal' }, sessions, [], identities)).toBeUndefined();
  });

  it("carries the swarm's body: a launcher's agent wears the fresh shell's, a row keeps the one it wore", () => {
    const rows = [
      { id: 'agent-a', kind: 'agent' as const },
      { id: 'pty-1', kind: 'terminal' as const },
      { id: 'sh-3', kind: 'terminal' as const },
    ];
    const sessionOf = (row: { id: string }): string | undefined =>
      ({ 'agent-a': 'agent-a', 'pty-1': 'sh-2', 'sh-3': 'sh-3' })[row.id];
    const first = visualIdsForRows(rows, sessionOf, new Map([['agent-a', 'shell-f']]), new Map());
    expect([...first]).toEqual([
      ['agent-a', 'shell-f'],
      ['pty-1', 'sh-2'],
      ['sh-3', 'sh-3'],
    ]);
    // The next reading keeps what each row wore, even once the window no longer names it.
    const second = visualIdsForRows(rows, sessionOf, new Map(), first);
    expect(second.get('agent-a')).toBe('shell-f');
    expect(second.get('pty-1')).toBe('sh-2');
  });
});
