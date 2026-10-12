import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibefield/puppeteer-core';
import {
  createMemoryProjectIdentityStore,
  createMonitorBackend,
  type MonitorRunSource,
} from '@vibefield/puppeteer-monitor';
import type { AgentSessionInfo } from '../protocol.js';
import {
  createGodviewMonitorHost,
  monitorHostRun,
  parseMonitorShownReport,
  parseMonitorTerminalReport,
  type MonitorAgentRecordLike,
} from './monitor-host.js';

const DEVICE = { id: 'mac-1', name: 'Mac', os: 'mac' as const, self: true };

function info(sessionId: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    provider: { id: 'codex', label: 'Codex' },
    agent: 'codex',
    runtimeRunId: `run-${sessionId}`,
    runtimeEpoch: 1,
    terminalSessionId: sessionId,
    runtimeSessionId: sessionId,
    nativeSession: { id: `native-${sessionId}` },
    sessionId: `native-${sessionId}`,
    workspace: { mode: 'direct', root: '/repos/app', sourcePath: '/repos/app' },
    session: { id: sessionId, exited: false, createdAtMs: 1_000, cwd: '/repos/app/src' } as SessionSummary,
    ...overrides,
  } as AgentSessionInfo;
}

function record(sessionId: string, overrides: Partial<AgentSessionInfo> = {}, alive = true): MonitorAgentRecordLike {
  return { info: info(sessionId, overrides), agentProcessAlive: alive };
}

describe('monitorHostRun', () => {
  it('names the run as the seam named its row: the terminal identity, else the terminal session', () => {
    const plain = monitorHostRun(
      record('pty-1'),
      () => undefined,
      () => undefined,
    );
    expect(plain).toEqual({
      runtimeRunId: 'run-pty-1',
      createdAt: 1_000,
      provider: { id: 'codex', label: 'Codex' },
      terminalSessionId: 'pty-1',
      terminalIdentity: 'pty-1',
      projectKey: null,
      workspace: { root: '/repos/app', sourcePath: '/repos/app' },
      cwd: '/repos/app/src',
      nativeSessionId: 'native-pty-1',
    });
    expect(
      monitorHostRun(
        record('pty-2'),
        (id) => (id === 'pty-2' ? 'pty-0' : undefined),
        () => undefined,
      ),
    ).toMatchObject({ terminalSessionId: 'pty-2', terminalIdentity: 'pty-0' });
  });

  it('keys the colour by the registry root only once main has folded it, and names the account by its label', () => {
    const folded = monitorHostRun(
      record('pty-1', { project: { key: '/repos/app', name: 'app', seq: 3 }, profileId: 'p-1' }),
      () => undefined,
      (id) => (id === 'p-1' ? 'me@work' : undefined),
    );
    expect(folded).toMatchObject({ projectKey: '/repos/app', profileId: 'p-1', account: 'me@work' });
  });

  it("supplies the workspace's branch as the fallback for when the observation names none (M26)", () => {
    const branched = record('pty-1', { workspace: { mode: 'direct', root: '/repos/app', branch: 'wip' } as never });
    expect(
      monitorHostRun(
        branched,
        () => undefined,
        () => undefined,
      ),
    ).toMatchObject({
      workspace: { root: '/repos/app', branch: 'wip' },
      fallbackBranch: 'wip',
    });
    expect(
      'fallbackBranch' in
        monitorHostRun(
          record('pty-2'),
          () => undefined,
          () => undefined,
        ),
    ).toBe(false);
  });

  it('says a witnessed exit of the adopted process, and nothing while it lives', () => {
    expect(
      monitorHostRun(
        record('pty-1', {}, false),
        () => undefined,
        () => undefined,
      ).alive,
    ).toBe(false);
    expect(
      'alive' in
        monitorHostRun(
          record('pty-1'),
          () => undefined,
          () => undefined,
        ),
    ).toBe(false);
  });
});

describe('the Godview host port', () => {
  it("reads main's records once per change, and notifies the backend when they move", () => {
    const records = [record('pty-1')];
    let reads = 0;
    const host = createGodviewMonitorHost({
      device: DEVICE,
      records: () => {
        reads += 1;
        return records;
      },
      identityOf: () => undefined,
      accountLabel: () => undefined,
    });
    let heard = 0;
    host.port.subscribe(() => (heard += 1));
    const first = host.port.getFacts();
    expect(host.port.getFacts()).toBe(first);
    expect(first).toMatchObject({ device: DEVICE, terminals: [], profileSets: [] });
    expect(first.runs.map((run) => run.runtimeRunId)).toEqual(['run-pty-1']);
    records.push(record('pty-2'));
    host.runsChanged();
    expect(heard).toBe(1);
    expect(host.port.getFacts().runs.map((run) => run.runtimeRunId)).toEqual(['run-pty-1', 'run-pty-2']);
    expect(reads).toBe(2);
  });

  it("unions the windows' terminals by session, and forgets a window that closed", () => {
    const host = createGodviewMonitorHost({
      device: DEVICE,
      records: () => [],
      identityOf: () => undefined,
      accountLabel: () => undefined,
    });
    host.reportTerminals('tab-a', [
      { sessionId: 'sh-1', createdAt: 1 },
      { sessionId: 'sh-2', createdAt: 2 },
    ]);
    host.reportTerminals('tab-b', [
      { sessionId: 'sh-2', createdAt: 2 },
      { sessionId: 'sh-3', createdAt: 3 },
    ]);
    expect(host.port.getFacts().terminals.map((terminal) => terminal.sessionId)).toEqual(['sh-1', 'sh-2', 'sh-3']);
    host.forgetWindow('tab-a');
    expect(host.port.getFacts().terminals.map((terminal) => terminal.sessionId)).toEqual(['sh-2', 'sh-3']);
    host.reportTerminals('tab-b', []);
    expect(host.port.getFacts().terminals).toEqual([]);
  });

  it('drives the backend as the seam drew it: the shell stands in before the first state, then the agent takes its id', async () => {
    let onState: ((state: AgentMonitorState) => void) | undefined;
    const runs: MonitorRunSource = {
      listStates: () => Promise.resolve([]),
      onState: (listener) => {
        onState = listener;
        return () => undefined;
      },
      onNotification: () => () => undefined,
      onRemoved: () => () => undefined,
    };
    const records: MonitorAgentRecordLike[] = [];
    const host = createGodviewMonitorHost({
      device: DEVICE,
      records: () => records,
      identityOf: () => undefined,
      accountLabel: () => undefined,
    });
    const flushes: Array<() => void> = [];
    const backend = createMonitorBackend({
      runs,
      host: host.port,
      identity: createMemoryProjectIdentityStore(),
      sink: { select: () => undefined, create: () => undefined },
      unobservedAgents: 'terminal',
      scheduler: (task) => {
        flushes.push(task);
        return () => undefined;
      },
    });
    const flush = (): void => {
      for (const task of flushes.splice(0)) task();
    };
    await backend.ready;
    host.reportTerminals('tab-a', [{ sessionId: 'pty-1', createdAt: 1_000, cwd: '/repos/app' }]);
    records.push(record('pty-1'));
    host.runsChanged();
    flush();
    expect(backend.getSnapshot().rows.map((row) => [row.id, row.kind])).toEqual([['pty-1', 'terminal']]);
    onState?.({
      schemaVersion: 3,
      runtimeEpoch: 1,
      revision: 1,
      runtimeRunId: 'run-pty-1',
      status: 'working',
      statusSince: new Date(2_000).toISOString(),
      blockers: [],
      usage: { samples: [] },
      modes: { execution: 'native-tui' },
      subagentCount: 0,
      subagents: [],
      compaction: { active: false, count: 0 },
      environment: { worktrees: [] },
      session: {},
      freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: new Date(2_000).toISOString() },
      alive: true,
    });
    expect(backend.getSnapshot().rows.map((row) => [row.id, row.kind, row.project.name])).toEqual([
      ['pty-1', 'agent', 'app'],
    ]);
    backend.dispose();
  });
});

describe('the renderer reports', () => {
  it('keeps well-formed terminals, drops malformed ones, and never carries a title', () => {
    expect(
      parseMonitorTerminalReport([
        { sessionId: 'sh-1', createdAt: 5, cwd: '/home', activity: { kind: 'foreground-job' }, title: 'zsh' },
        { sessionId: 'sh-2', identity: 'pty-0', createdAt: 0 },
        { sessionId: '../escape', createdAt: 1 },
        { sessionId: 'sh-3', createdAt: Number.NaN },
        { sessionId: 'sh-4', createdAt: 1, activity: { kind: 7 } },
        'nonsense',
      ]),
    ).toEqual([
      { sessionId: 'sh-1', createdAt: 5, cwd: '/home', activity: { kind: 'foreground-job' } },
      { sessionId: 'sh-2', identity: 'pty-0', createdAt: 0 },
    ]);
    expect(parseMonitorTerminalReport({ sessionId: 'sh-1' })).toBeUndefined();
    expect(
      parseMonitorTerminalReport(Array.from({ length: 513 }, (_, index) => ({ sessionId: `s${index}`, createdAt: 0 }))),
    ).toBeUndefined();
  });

  it('keeps only opaque row ids in a shown report', () => {
    expect(parseMonitorShownReport(['pty-1', '', '/etc', 7, 'run-2'])).toEqual(['pty-1', 'run-2']);
    expect(parseMonitorShownReport('pty-1')).toBeUndefined();
  });
});
