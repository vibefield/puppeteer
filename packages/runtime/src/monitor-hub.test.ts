import type {
  AgentMonitorState,
  AgentAdapterSession,
  MonitorArtifactReadResult,
  MonitorNotification,
  ObservationLevel,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, MonitorFamilyUpdate } from '@vibecook/puppeteer-core/monitor-spi';
import { describe, expect, it, vi } from 'vitest';
import type { MonitorClock, MonitorScheduledTask } from './monitor-clock.js';
import { MONITOR_ARTIFACT_HARD_MAX_BYTES, RuntimeMonitorHub, type MonitorArtifactAudit } from './monitor-hub.js';

class FakeClock implements MonitorClock {
  private currentMs = Date.parse('2026-08-16T12:00:00.000Z');
  private sequence = 0;
  private readonly tasks: Array<{ id: number; at: number; callback: () => void; cancelled: boolean }> = [];

  now(): Date {
    return new Date(this.currentMs);
  }

  schedule(delayMs: number, callback: () => void): MonitorScheduledTask {
    const task = { id: ++this.sequence, at: this.currentMs + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  advance(ms: number): void {
    const target = this.currentMs + ms;
    for (;;) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      next.cancelled = true;
      this.currentMs = next.at;
      next.callback();
    }
    this.currentMs = target;
  }
}

function batch(
  id: string,
  updates: MonitorFamilyUpdate[],
  overrides: Partial<AdapterMonitorObservationBatch> = {},
): AdapterMonitorObservationBatch {
  return {
    schemaVersion: 1,
    batchId: id,
    producer: { id: 'test-observer', epoch: 'epoch-1', sequence: Number(id.replace(/\D/g, '')) || 1 },
    phase: 'live',
    observedAt: '2026-08-16T12:00:00.000Z',
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    updates,
    sourceWatermarks: [],
    evidence: [],
    ...overrides,
  };
}

function hub(
  options: {
    clock?: FakeClock;
    states?: AgentMonitorState[];
    notifications?: MonitorNotification[];
    audits?: MonitorArtifactAudit[];
  } = {},
) {
  const clock = options.clock ?? new FakeClock();
  const result = new RuntimeMonitorHub({
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    providerId: 'claude',
    executionMode: 'native-tui',
    observationLevel: 'terminal-only',
    allocatedAt: clock.now().toISOString(),
    clock,
    onState: (state) => options.states?.push(state),
    onNotification: (notice) => options.notifications?.push(notice),
    onArtifactAudit: (audit) => {
      options.audits?.push(audit);
    },
  });
  result.start();
  return { clock, hub: result };
}

function semanticSession(
  options: {
    onRead?: (artifactId: string, maxBytes: number) => Promise<MonitorArtifactReadResult>;
    observationLevel?: () => ObservationLevel;
  } = {},
) {
  let reads = 0;
  const session = {
    sessionId: 'native-1',
    runtimeSessionId: 'terminal-1',
    observationLevel: options.observationLevel ?? (() => 'native-log' as const),
    async readMonitorArtifact(artifactId: string, readOptions: { maxBytes: number }) {
      reads += 1;
      return options.onRead?.(artifactId, readOptions.maxBytes) ?? Promise.resolve({ status: 'unavailable' as const });
    },
    onEvent: () => () => undefined,
    submitPrompt: async () => ({ status: 'confirmed' as const }),
    dispose: async () => undefined,
  } satisfies AgentAdapterSession;
  return {
    session,
    reads: () => reads,
  };
}

describe('RuntimeMonitorHub', () => {
  it('publishes a synchronous readiness state and coalesces ordinary full-state revisions', () => {
    const states: AgentMonitorState[] = [];
    const { clock, hub: monitor } = hub({ states });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ revision: 1, status: 'working', activity: { kind: 'starting' } });

    monitor.updateRun('running', { alive: true });
    monitor.acceptSemantic(
      batch('batch-2', [
        {
          family: 'planning',
          operation: 'upsert',
          key: 'task:1',
          value: { kind: 'task', taskId: '1', status: 'pending', provisional: false },
        },
      ]),
    );
    expect(states).toHaveLength(2);
    clock.advance(100);
    expect(states).toHaveLength(3);
    expect(states[2]).toMatchObject({ revision: 3, status: 'idle', tasks: [{ id: '1' }] });
  });

  it('shares one semantic source across independent race-free handles', async () => {
    const { clock, hub: monitor } = hub();
    const source = semanticSession();
    monitor.attachSession(source.session);
    const first = monitor.observe();
    const second = monitor.observe();
    monitor.acceptSemantic(
      batch('batch-1', [
        {
          family: 'model',
          operation: 'upsert',
          key: 'observed',
          value: { kind: 'model', providerModelId: 'claude-opus-4-1', intent: 'observed' },
        },
      ]),
    );
    clock.advance(100);

    await expect(first.states[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { model: { id: 'claude-opus-4-1' } },
    });
    await expect(second.states[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { model: { id: 'claude-opus-4-1' } },
    });
  });

  it('expires pulse activity and ages burn rate through its injected scheduler', () => {
    const { clock, hub: monitor } = hub();
    monitor.updateRun('running', { alive: true });
    monitor.acceptSemantic(
      batch('batch-1', [
        {
          family: 'status',
          operation: 'upsert',
          key: 'pulse',
          value: {
            kind: 'activity',
            activityKind: 'responding',
            active: true,
            line: 'Streaming',
            leaseId: 'lease-1',
          },
        },
        {
          family: 'usage',
          operation: 'upsert',
          key: 'usage-1',
          value: { kind: 'usage', usageId: 'usage-1', boundary: 'response', canonical: true, deltaTokens: 60 },
        },
      ]),
    );
    clock.advance(100);
    expect(monitor.current()).toMatchObject({ status: 'working', usage: { burnRatePerMin: 60 } });

    clock.advance(4_900);
    expect(monitor.current().status).toBe('idle');
    clock.advance(55_001);
    expect(monitor.current().usage.burnRatePerMin).toBeUndefined();
  });

  it('allows a refreshed stable lease to expire again', () => {
    const { clock, hub: monitor } = hub();
    monitor.updateRun('running', { alive: true });
    const activity = {
      family: 'status' as const,
      operation: 'upsert' as const,
      key: 'pulse',
      value: {
        kind: 'activity' as const,
        activityKind: 'responding' as const,
        active: true,
        line: 'Streaming',
        leaseId: 'stable-lease',
      },
    };

    monitor.acceptSemantic(batch('batch-1', [activity]));
    clock.advance(5_000);
    expect(monitor.current().status).toBe('idle');

    monitor.acceptSemantic(batch('batch-2', [activity], { observedAt: clock.now().toISOString() }));
    clock.advance(100);
    expect(monitor.current().status).toBe('working');
    clock.advance(4_900);
    expect(monitor.current().status).toBe('idle');
  });

  it('refreshes the public observation level when an attached rail changes state', () => {
    let level: ObservationLevel = 'terminal-only';
    const { clock, hub: monitor } = hub();
    const source = semanticSession({ observationLevel: () => level });
    monitor.attachSession(source.session);

    level = 'native-log';
    monitor.updateSessionMetadata({
      executionMode: 'native-tui',
      observationLevel: level,
      terminalSessionId: 'terminal-1',
    });
    monitor.acceptSemantic(batch('batch-1', []));
    clock.advance(100);
    expect(monitor.current().freshness.level).toBe('native-log');

    level = 'terminal-only';
    monitor.updateSessionMetadata({
      executionMode: 'native-tui',
      observationLevel: level,
      terminalSessionId: 'terminal-1',
    });
    monitor.acceptSemantic(batch('batch-2', []));
    clock.advance(100);
    expect(monitor.current().freshness.level).toBe('terminal-only');
  });

  it('publishes a revision pulse when fresh evidence crosses the shared stale boundary', () => {
    const states: AgentMonitorState[] = [];
    const { clock, hub: monitor } = hub({ states });
    monitor.updateRun('running', { alive: true });
    const before = monitor.current();

    clock.advance(30_001);

    expect(monitor.current()).toMatchObject({
      revision: before.revision + 1,
      freshness: { families: { status: { support: 'supported' } } },
    });
    expect(states.at(-1)?.revision).toBe(before.revision + 1);
  });

  it('keeps rail degradation separate from process liveness', () => {
    const { hub: monitor } = hub();
    monitor.updateRun('running', { alive: true });
    monitor.acceptSemantic(
      batch('batch-1', [], {
        readiness: 'degraded',
        capabilities: [
          {
            family: 'usage',
            support: 'degraded',
            actorScope: 'session',
            latency: 'historical',
            source: 'test-observer',
            limitations: ['observer unavailable'],
          },
        ],
      }),
    );
    expect(monitor.current()).toMatchObject({
      alive: true,
      freshness: { families: { usage: { support: 'degraded' } } },
    });
  });

  it('accepts process death only from the runtime host rail', () => {
    const { hub: monitor } = hub();
    monitor.updateRun('running', { alive: true });
    const envelope = {
      type: 'process:exited' as const,
      service: 'process' as const,
      eventId: 'exit-1',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      sequence: 1,
      sessionId: 'native-1',
      timestamp: '2026-08-16T12:00:01.000Z',
      monotonicTime: 1,
      source: 'native-protocol' as const,
      confidence: 'authoritative' as const,
      event: { type: 'process.exited' as const, exitCode: 1, reason: 'crash' as const },
    };
    monitor.acceptAgentEvent(envelope);
    expect(monitor.current()).toMatchObject({ alive: true, status: 'idle' });

    monitor.acceptAgentEvent({ ...envelope, eventId: 'exit-2', sequence: 2, source: 'runtime' });
    expect(monitor.current()).toMatchObject({ alive: true, status: 'idle' });

    monitor.acceptAgentEvent(
      { ...envelope, eventId: 'exit-3', sequence: 3, source: 'runtime' },
      { hostProcessEvidence: true },
    );
    expect(monitor.current()).toMatchObject({ alive: false, status: 'blocked' });
  });

  it('allows only failure acknowledgment', () => {
    const { hub: monitor } = hub();
    monitor.updateRun('failed', { alive: false, code: 'crash', detail: 'Process crashed' });
    expect(monitor.current()).toMatchObject({ status: 'blocked', alive: false });
    expect(monitor.acknowledgeFailure('missing')).toBe(false);
    expect(monitor.acknowledgeFailure('run:runtime')).toBe(true);
    expect(monitor.current()).toMatchObject({ status: 'idle', alive: false, blockers: [] });
  });

  it('guards opaque artifact reads before delegation and audits metadata only', async () => {
    const audits: MonitorArtifactAudit[] = [];
    const read = vi.fn(async (artifactId: string): Promise<MonitorArtifactReadResult> => ({
      status: 'ok',
      artifact: { artifactId, family: 'workflow-definition', availability: 'readable' },
      encoding: 'utf8',
      content: 'workflow: test',
    }));
    const { hub: monitor } = hub({ audits });
    const source = semanticSession({ onRead: (artifactId) => read(artifactId) });
    monitor.attachSession(source.session);
    monitor.acceptSemantic(
      batch('batch-1', [
        {
          family: 'workflow',
          operation: 'upsert',
          key: 'workflow-1',
          value: {
            kind: 'workflow',
            workflowId: 'workflow-1',
            active: true,
            actorRunKeys: [],
            artifactRefs: [
              {
                artifactId: 'opaque:workflow-1',
                family: 'workflow-definition',
                mediaType: 'text/yaml',
                availability: 'readable',
              },
            ],
          },
        },
      ]),
    );

    await expect(monitor.readArtifact('/tmp/workflow.yaml')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      monitor.readArtifact('opaque:workflow-1', { maxBytes: MONITOR_ARTIFACT_HARD_MAX_BYTES + 1 }),
    ).resolves.toMatchObject({ status: 'too-large' });
    expect(source.reads()).toBe(0);

    await expect(monitor.readArtifact('opaque:workflow-1')).resolves.toMatchObject({
      status: 'ok',
      artifact: { artifactId: 'opaque:workflow-1' },
      content: 'workflow: test',
    });
    expect(source.reads()).toBe(1);
    expect(audits.at(-1)).toEqual({
      artifactId: 'opaque:workflow-1',
      maxBytes: 256 * 1024,
      outcome: 'ok',
      returnedBytes: 14,
      mediaType: 'text/yaml',
    });
    expect(JSON.stringify(audits)).not.toContain('workflow: test');
  });
});
