import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MONITOR_SCHEMA_VERSION,
  createInitialSessionState,
  type AgentMonitorHandle,
  type AgentMonitorState,
  type MonitorNotification,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import {
  acknowledgeAgentFailureForIpc,
  connectMonitorIpcRelay,
  formatMonitorCanaryTrace,
  isAgentMonitorStateAfterRemoval,
  isNewerAgentMonitorStateMessage,
  MONITOR_CANARY_TRACE_PREFIX,
  MonitorIpcRelay,
  parseAcknowledgeAgentFailureRequest,
  resolveMonitorHostFeatureFlags,
  readAgentMonitorArtifactForIpc,
  sanitizeMonitorArtifactReadResult,
  validateReadAgentMonitorArtifactRequest,
  type AgentMonitorNotificationMessage,
  type AgentMonitorRemovedMessage,
  type AgentMonitorStateMessage,
  type MonitorShadowMismatchReport,
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

  it('ignores duplicate, stale revision, and stale epoch full states', () => {
    const delivered: AgentMonitorStateMessage[] = [];
    const relay = new MonitorIpcRelay({ enabled: true, onState: (message) => delivered.push(message) });

    expect(relay.acceptState(monitorState({ revision: 2 }))).toBe(true);
    expect(relay.acceptState(monitorState({ revision: 2, status: 'working' }))).toBe(false);
    expect(relay.acceptState(monitorState({ revision: 1 }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 0, revision: 100 }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 2, revision: 1, status: 'working' }))).toBe(true);

    expect(delivered.map(({ state }) => [state.runtimeEpoch, state.revision, state.status])).toEqual([
      [1, 2, 'idle'],
      [2, 1, 'working'],
    ]);
  });

  it('retains one current reconnect snapshot and never replays notifications', () => {
    const deliveredNotices: AgentMonitorNotificationMessage[] = [];
    const relay = new MonitorIpcRelay({
      enabled: true,
      onNotification: (message) => deliveredNotices.push(message),
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptState(monitorState({ revision: 1 }));
    relay.acceptState(monitorState({ revision: 2, status: 'working' }));
    expect(relay.acceptNotification(notice())).toBe(true);
    expect(relay.acceptNotification(notice())).toBe(false);

    expect(relay.snapshot()).toEqual([
      expect.objectContaining({
        runtimeRunId: 'run-1',
        terminalSessionId: 'terminal-1',
        state: expect.objectContaining({ revision: 2, status: 'working' }),
      }),
    ]);
    expect(deliveredNotices).toHaveLength(1);
    expect(relay.snapshot()[0]).not.toHaveProperty('notifications');
  });

  it('uses the last known terminal mapping for removal and rejects late state', () => {
    const removals: AgentMonitorRemovedMessage[] = [];
    const relay = new MonitorIpcRelay({ enabled: true, onRemoved: (message) => removals.push(message) });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptState(monitorState({ revision: 4 }));

    expect(relay.remove('run-1')).toBe(true);
    expect(relay.remove('run-1')).toBe(false);
    expect(relay.acceptState(monitorState({ revision: 3 }))).toBe(false);
    expect(relay.acceptState(monitorState({ revision: 5 }))).toBe(false);
    expect(relay.acceptState(monitorState({ runtimeEpoch: 2, revision: 1 }))).toBe(true);
    expect(removals).toEqual([
      { runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', runtimeEpoch: 1, revision: 4 },
    ]);
  });

  it('classifies and deduplicates shadow mismatches without recording values', async () => {
    const reports: MonitorShadowMismatchReport[] = [];
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: queueMicrotask,
    });
    const legacy: SessionRuntimeState = {
      ...createInitialSessionState(),
      lifecycle: 'ready',
      environment: {
        currentCwd: {
          value: '/private/secret-repository',
          updatedAt: '2026-08-17T00:00:00.000Z',
          source: 'native-hook',
          confidence: 'authoritative',
        },
      },
    };
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', legacy);
    relay.acceptState(monitorState({ environment: { cwd: '/different/private/path', worktrees: [] } }));
    await Promise.resolve();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.mismatches).toContainEqual({
      family: 'environment',
      fact: 'cwd',
      classification: 'value',
    });
    expect(JSON.stringify(reports[0])).not.toContain('/private/');

    relay.acceptState(monitorState({ revision: 2, environment: { cwd: '/different/private/path', worktrees: [] } }));
    await Promise.resolve();
    expect(reports).toHaveLength(1);
  });

  it('compares the settled v1/v2 pair instead of reporting a transient publication skew', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptState(
      monitorState({
        status: 'working',
        activity: { kind: 'starting', line: 'Starting', since: '2026-08-17T00:00:00.000Z' },
      }),
    );
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'ready' });
    // The matching v2 idle revision is already queued by runtime when the v1
    // ready state reaches the relay.
    relay.acceptState(monitorState({ revision: 2, status: 'idle' }));
    compare?.();

    expect(reports).toEqual([]);
    expect(relay.shadowMismatches()).toEqual([]);
  });

  it('does not treat v2-only compaction activity as a legacy headline disagreement', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'ready' });
    relay.acceptState(
      monitorState({
        status: 'working',
        activity: { kind: 'compacting', line: 'Compacting context', since: '2026-08-17T00:00:01.000Z' },
        compaction: { active: true, provisional: true, count: 1 },
      }),
    );
    compare?.();

    expect(reports).toEqual([]);
  });

  it('does not compare input-only v2 context that the legacy state cannot represent', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'ready' });
    relay.acceptState(
      monitorState({
        context: { usedTokens: 48, percentageSource: 'unavailable', asOf: '2026-08-17T00:00:01.000Z' },
      }),
    );
    compare?.();

    expect(reports).toEqual([]);
  });

  it('still reports a missing legacy context measurement when v2 has a comparable capacity', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'ready' });
    relay.acceptState(
      monitorState({
        context: {
          usedTokens: 48,
          capacityTokens: 1_000,
          usedPercent: 4.8,
          percentageSource: 'derived',
          asOf: '2026-08-17T00:00:01.000Z',
        },
      }),
    );
    compare?.();

    expect(reports.at(-1)?.mismatches).toContainEqual({
      family: 'context',
      fact: 'measurement',
      classification: 'presence',
    });
  });

  it('does not compare v2 configured model intent until v1 has an observed model', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    const legacy = { ...createInitialSessionState(), lifecycle: 'ready' } satisfies SessionRuntimeState;
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', legacy);
    relay.acceptState(monitorState({ model: { id: 'haiku', asOf: '2026-08-17T00:00:00.000Z' } }));
    compare?.();
    expect(reports).toEqual([]);

    relay.acceptLegacyState('terminal-1', {
      ...legacy,
      environment: {
        model: {
          value: { id: 'sonnet', provider: 'anthropic' },
          updatedAt: '2026-08-17T00:00:01.000Z',
          source: 'native-statusline',
          confidence: 'authoritative',
        },
      },
    });
    // The v2 value is still launch intent from before v1's native model-card
    // observation, so this is publication skew rather than disagreement.
    relay.acceptState(monitorState({ revision: 2, model: { id: 'haiku', asOf: '2026-08-17T00:00:00.000Z' } }));
    compare?.();
    expect(reports).toEqual([]);

    relay.acceptState(monitorState({ revision: 3, model: { id: 'haiku', asOf: '2026-08-17T00:00:02.000Z' } }));
    compare?.();
    expect(reports.at(-1)?.mismatches).toContainEqual({
      family: 'model',
      fact: 'id',
      classification: 'value',
    });
  });

  it('allows v2 structured-close lag but makes removal a strict liveness boundary', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    let compare: (() => void) | undefined;
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: (callback) => {
        compare = callback;
      },
    });
    relay.bindTerminal('run-1', 'terminal-1');
    // The adapter has closed v1 (and cleared its active tool) while the
    // host-authoritative v2 run is still alive with that tool open.
    relay.acceptState(monitorState({ status: 'working', alive: true }));
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'exited' });
    compare?.();
    expect(reports).toEqual([]);

    relay.remove('run-1');
    expect(reports.at(-1)?.mismatches).toContainEqual({
      family: 'status',
      fact: 'alive',
      classification: 'liveness',
    });
    expect(reports.at(-1)?.mismatches).toContainEqual({
      family: 'status',
      fact: 'headline',
      classification: 'headline-status',
    });
  });

  it('removes converged compatibility and monitor state without a shadow mismatch', () => {
    const reports: MonitorShadowMismatchReport[] = [];
    const relay = new MonitorIpcRelay({
      enabled: true,
      shadowComparison: true,
      onShadowMismatch: (report) => reports.push(report),
      scheduleComparison: () => undefined,
    });
    relay.bindTerminal('run-1', 'terminal-1');
    relay.acceptLegacyState('terminal-1', { ...createInitialSessionState(), lifecycle: 'exited' });
    relay.acceptState(monitorState({ alive: false }));
    relay.remove('run-1');
    expect(reports).toEqual([]);
  });

  it('is inert when the presentation relay is disabled', () => {
    const onState = vi.fn();
    const relay = new MonitorIpcRelay({ enabled: false, onState });
    expect(relay.acceptState(monitorState())).toBe(false);
    expect(relay.snapshot()).toEqual([]);
    expect(onState).not.toHaveBeenCalled();
  });

  it('creates and drains a monitor handle before installing the discovered snapshot', async () => {
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
    const relay = new MonitorIpcRelay({
      enabled: true,
      onState: () => order.push('snapshot'),
    });
    const connection = connectMonitorIpcRelay(runtime, relay);

    stateListener?.(initial);
    expect(order).toEqual(['handle']);
    await vi.waitFor(() => expect(order).toContain('snapshot'));
    expect(order.indexOf('handle')).toBeLessThan(order.indexOf('snapshot'));
    await connection.close();
  });
});

describe('monitor IPC request boundary', () => {
  it('keeps monitor rollout flags independent of Claude semantic observation', () => {
    expect(resolveMonitorHostFeatureFlags([])).toEqual({
      monitorV2: false,
      shadowComparison: false,
      godviewMonitorV2: false,
      canaryTrace: false,
    });
    expect(resolveMonitorHostFeatureFlags(['--puppeteer-monitor-v2'])).toEqual({
      monitorV2: true,
      shadowComparison: false,
      godviewMonitorV2: false,
      canaryTrace: false,
    });
    expect(resolveMonitorHostFeatureFlags(['--puppeteer-monitor-shadow'])).toEqual({
      monitorV2: true,
      shadowComparison: true,
      godviewMonitorV2: false,
      canaryTrace: false,
    });
    expect(resolveMonitorHostFeatureFlags(['--puppeteer-godview-monitor-v2'])).toEqual({
      monitorV2: true,
      shadowComparison: false,
      godviewMonitorV2: true,
      canaryTrace: false,
    });
    expect(resolveMonitorHostFeatureFlags(['--puppeteer-monitor-canary-trace'])).toEqual({
      monitorV2: true,
      shadowComparison: false,
      godviewMonitorV2: false,
      canaryTrace: true,
    });
    expect(
      resolveMonitorHostFeatureFlags(['--puppeteer-spaghetti-scoped-shadow', '--puppeteer-spaghetti-scoped-primary']),
    ).toEqual({
      monitorV2: false,
      shadowComparison: false,
      godviewMonitorV2: false,
      canaryTrace: false,
    });
  });

  it('formats one-line canary records with routing identity and the public payload', () => {
    const message: AgentMonitorStateMessage = {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      state: monitorState({
        model: { id: 'claude-opus-5' },
        environment: { cwd: '/private/canary-workspace', worktrees: [] },
      }),
    };
    const line = formatMonitorCanaryTrace('state', message, '2026-08-17T01:02:03.000Z');

    expect(line.startsWith(MONITOR_CANARY_TRACE_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    const record = JSON.parse(line.slice(MONITOR_CANARY_TRACE_PREFIX.length));
    expect(record).toMatchObject({
      schemaVersion: 1,
      kind: 'state',
      observedAt: '2026-08-17T01:02:03.000Z',
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      payload: {
        runtimeRunId: 'run-1',
        terminalSessionId: 'terminal-1',
        state: { revision: 1, model: { id: 'claude-opus-5' } },
      },
    });
    expect(line.split('\n')).toHaveLength(2);
  });

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

  it('rejects unknown runs and sanitizes unsupported artifacts without locator leakage', async () => {
    const readMonitorArtifact = vi.fn().mockResolvedValue({
      status: 'unavailable',
      message: 'unsupported at /Users/private/.claude/team.json',
      artifact: {
        artifactId: 'team-1',
        family: 'team-config',
        availability: 'metadata-only',
      },
    });
    const runtime = {
      acknowledgeFailureBlocker: vi.fn().mockResolvedValue(false),
      readMonitorArtifact,
    };
    const relay = new MonitorIpcRelay({ enabled: true });
    const request = { runtimeRunId: 'run-1', artifactId: 'team-1', maxBytes: 4096 };

    await expect(readAgentMonitorArtifactForIpc(runtime, relay, request)).resolves.toEqual({
      status: 'unavailable',
    });
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
    const relay = new MonitorIpcRelay({ enabled: true });

    await expect(
      acknowledgeAgentFailureForIpc(runtime, relay, { runtimeRunId: 'run-1', blockerId: 'permission-1' }),
    ).resolves.toBe(false);
    await expect(
      acknowledgeAgentFailureForIpc(runtime, relay, { runtimeRunId: 'run-1', blockerId: '/tmp/failure' }),
    ).resolves.toBe(false);
    expect(acknowledgeFailureBlocker).not.toHaveBeenCalled();
  });
});
