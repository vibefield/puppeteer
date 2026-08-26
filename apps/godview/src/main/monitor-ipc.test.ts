import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MONITOR_SCHEMA_VERSION,
  type AgentMonitorHandle,
  type AgentMonitorState,
  type MonitorNotification,
} from '@vibecook/puppeteer-core';
import {
  acknowledgeAgentFailureForIpc,
  connectMonitorIpcRelay,
  isAgentMonitorStateAfterRemoval,
  isNewerAgentMonitorStateMessage,
  MonitorIpcRelay,
  parseAcknowledgeAgentFailureRequest,
  readAgentMonitorArtifactForIpc,
  sanitizeMonitorArtifactReadResult,
  validateReadAgentMonitorArtifactRequest,
  type AgentMonitorNotificationMessage,
  type AgentMonitorRemovedMessage,
  type AgentMonitorStateMessage,
} from './monitor-ipc.js';

function monitorState(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    revision: 1,
    status: 'idle',
    statusSince: '2026-08-17T00:00:00.000Z',
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    tasks: [],
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'terminal-only', families: {} },
    alive: true,
    ...overrides,
  };
}

function notice(overrides: Partial<MonitorNotification> = {}): MonitorNotification {
  return {
    notificationId: 'notice-1',
    runtimeRunId: 'run-1',
    at: '2026-08-17T00:00:00.000Z',
    type: 'delegation:task-created',
    ...overrides,
  };
}

describe('MonitorIpcRelay', () => {
  it('shares epoch/revision and removal ordering with renderers', () => {
    const current: AgentMonitorStateMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      state: monitorState({ runtimeEpoch: 2, revision: 7 }),
    };
    expect(
      isNewerAgentMonitorStateMessage(current, { ...current, state: monitorState({ runtimeEpoch: 2, revision: 8 }) }),
    ).toBe(true);
    expect(
      isNewerAgentMonitorStateMessage(current, { ...current, state: monitorState({ runtimeEpoch: 2, revision: 6 }) }),
    ).toBe(false);
    const removal: AgentMonitorRemovedMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      runtimeEpoch: 2,
      revision: 7,
    };
    expect(isAgentMonitorStateAfterRemoval(current, removal)).toBe(false);
    expect(
      isAgentMonitorStateAfterRemoval({ ...current, state: monitorState({ runtimeEpoch: 3, revision: 1 }) }, removal),
    ).toBe(true);
    expect(isAgentMonitorStateAfterRemoval(current, { ...removal, runtimeEpoch: null, revision: null })).toBe(false);
  });

  it('orders full replacements and retains only the latest reconnect state', () => {
    const delivered: AgentMonitorStateMessage[] = [];
    const relay = new MonitorIpcRelay({ onState: (message) => delivered.push(message) });
    relay.bindTerminal('run-1', 'terminal-1');

    expect(relay.acceptState(monitorState({ revision: 2 }))).toBe(true);
    expect(relay.acceptState(monitorState({ revision: 2, status: 'working' }))).toBe(false);
    expect(relay.acceptState(monitorState({ revision: 1 }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 0, revision: 100 }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 2, revision: 1, status: 'working' }))).toBe(true);

    expect(delivered.map(({ state }) => [state.runtimeEpoch, state.revision, state.status])).toEqual([
      [1, 2, 'idle'],
      [2, 1, 'working'],
    ]);
    expect(relay.snapshot()).toEqual([
      expect.objectContaining({
        runtimeRunId: 'run-1',
        terminalSessionId: 'terminal-1',
        state: expect.objectContaining({ runtimeEpoch: 2, revision: 1, status: 'working' }),
      }),
    ]);
  });

  it('deduplicates notifications without retaining them in reconnect snapshots', () => {
    const delivered: AgentMonitorNotificationMessage[] = [];
    const relay = new MonitorIpcRelay({ onNotification: (message) => delivered.push(message) });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptState(monitorState());

    expect(relay.acceptNotification(notice())).toBe(true);
    expect(relay.acceptNotification(notice())).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.terminalSessionId).toBe('terminal-1');
    expect(relay.snapshot()[0]).not.toHaveProperty('notifications');
  });

  it('seals a removed epoch and permits only explicit reconstruction', () => {
    const removals: AgentMonitorRemovedMessage[] = [];
    const relay = new MonitorIpcRelay({ onRemoved: (message) => removals.push(message) });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptState(monitorState({ revision: 4 }));

    expect(relay.remove('run-1')).toBe(true);
    expect(relay.remove('run-1')).toBe(false);
    expect(relay.acceptState(monitorState({ revision: 5 }))).toBe(false);
    expect(relay.acceptNotification(notice({ notificationId: 'late' }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 2, revision: 1 }))).toBe(true);
    expect(removals).toEqual([
      { runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', runtimeEpoch: 1, revision: 4 },
    ]);
  });

  it('creates a race-free monitor handle before installing a discovered snapshot', async () => {
    const order: string[] = [];
    const initial = monitorState();
    const handle: AgentMonitorHandle = {
      states: (async function* () {
        yield initial;
      })(),
      notifications: (async function* () {})(),
      ready: Promise.resolve(initial),
      current: () => initial,
      readArtifact: async () => ({ status: 'unavailable' }),
      close: async () => undefined,
    };
    let stateListener: ((state: AgentMonitorState) => void) | undefined;
    const runtime = {
      runtimeRunInfo: () => ({ status: 'active' as const, terminalSessionId: 'terminal-1' }),
      observeMonitor: vi.fn(() => {
        order.push('handle');
        return handle;
      }),
      onMonitorState: (listener: (state: AgentMonitorState) => void) => {
        stateListener = listener;
        return () => undefined;
      },
      onMonitorNotification: () => () => undefined,
      onMonitorRemoved: () => () => undefined,
      acknowledgeFailureBlocker: async () => false,
      readMonitorArtifact: async () => ({ status: 'unavailable' as const }),
    };
    const relay = new MonitorIpcRelay({ onState: () => order.push('snapshot') });
    const connection = connectMonitorIpcRelay(runtime, relay);

    stateListener?.(initial);
    expect(order).toEqual(['handle']);
    await vi.waitFor(() => expect(order).toContain('snapshot'));
    expect(order.indexOf('handle')).toBeLessThan(order.indexOf('snapshot'));
    await connection.close();
  });
});

describe('monitor IPC request boundary', () => {
  it('accepts only opaque failure blocker identities', () => {
    expect(parseAcknowledgeAgentFailureRequest({ runtimeRunId: 'run-1', blockerId: 'run:runtime' })).toEqual({
      runtimeRunId: 'run-1',
      blockerId: 'run:runtime',
    });
    expect(parseAcknowledgeAgentFailureRequest({ runtimeRunId: 'run-1', blockerId: '/tmp/blocker' })).toBeUndefined();
    expect(parseAcknowledgeAgentFailureRequest({ runtimeRunId: '../run', blockerId: 'failure' })).toBeUndefined();
  });

  it('rejects paths and oversized artifact requests before runtime access', () => {
    expect(
      validateReadAgentMonitorArtifactRequest({
        runtimeRunId: 'run-1',
        artifactId: '/tmp/workflow.md',
        maxBytes: 1024,
      }),
    ).toEqual({ ok: false, result: { status: 'denied' } });
    expect(
      validateReadAgentMonitorArtifactRequest({
        runtimeRunId: 'run-1',
        artifactId: 'workflow-1',
        maxBytes: 1024 * 1024 + 1,
      }),
    ).toEqual({ ok: false, result: { status: 'too-large' } });
    expect(
      validateReadAgentMonitorArtifactRequest({
        runtimeRunId: 'run-1',
        artifactId: 'opaque:workflow-1',
        maxBytes: 1024,
      }),
    ).toEqual({
      ok: true,
      request: { runtimeRunId: 'run-1', artifactId: 'opaque:workflow-1', maxBytes: 1024 },
    });
  });

  it('strips provider-authored failure text that could reveal a locator', () => {
    const result = sanitizeMonitorArtifactReadResult({
      status: 'unavailable',
      message: 'failed to read /Users/private/.claude/workflow.md',
      artifact: {
        artifactId: 'workflow-1',
        family: 'workflow-definition',
        availability: 'metadata-only',
      },
    });
    expect(result).toEqual({
      status: 'unavailable',
      artifact: {
        artifactId: 'workflow-1',
        family: 'workflow-definition',
        availability: 'metadata-only',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });

  it('rejects unknown runs and sanitizes provider failures', async () => {
    const readMonitorArtifact = vi.fn().mockResolvedValue({
      status: 'unavailable',
      message: 'unsupported at /Users/private/.claude/team.json',
      artifact: { artifactId: 'team-1', family: 'team-config', availability: 'metadata-only' },
    });
    const runtime = { acknowledgeFailureBlocker: vi.fn().mockResolvedValue(false), readMonitorArtifact };
    const relay = new MonitorIpcRelay();
    const request = { runtimeRunId: 'run-1', artifactId: 'team-1', maxBytes: 4096 };

    await expect(readAgentMonitorArtifactForIpc(runtime, relay, request)).resolves.toEqual({ status: 'unavailable' });
    expect(readMonitorArtifact).not.toHaveBeenCalled();

    relay.acceptState(monitorState());
    const result = await readAgentMonitorArtifactForIpc(runtime, relay, request);
    expect(result).toEqual({
      status: 'unavailable',
      artifact: { artifactId: 'team-1', family: 'team-config', availability: 'metadata-only' },
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });

  it('does not dispatch invalid or non-live failure acknowledgments', async () => {
    const acknowledgeFailureBlocker = vi.fn().mockResolvedValue(true);
    const runtime = { acknowledgeFailureBlocker, readMonitorArtifact: vi.fn() };
    const relay = new MonitorIpcRelay();

    await expect(
      acknowledgeAgentFailureForIpc(runtime, relay, { runtimeRunId: 'run-1', blockerId: 'permission-1' }),
    ).resolves.toBe(false);
    await expect(
      acknowledgeAgentFailureForIpc(runtime, relay, { runtimeRunId: 'run-1', blockerId: '/tmp/failure' }),
    ).resolves.toBe(false);
    expect(acknowledgeFailureBlocker).not.toHaveBeenCalled();
  });
});
