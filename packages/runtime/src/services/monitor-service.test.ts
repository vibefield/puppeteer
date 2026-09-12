import type {
  AgentMonitorState,
  AgentAdapterBinding,
  MonitorArtifactReadResult,
  MonitorNotification,
  ObservationLevel,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, MonitorFamilyUpdate } from '@vibecook/puppeteer-core/monitor-spi';
import { agentEventCategory, type AgentEvent } from '@vibecook/puppeteer-core';
import * as monitorProjection from '@vibecook/puppeteer-core/monitor-spi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentEventEnvelope } from '../types.js';
import type { MonitorClock, MonitorScheduledTask } from '../monitor/clock.js';
import { AgentMonitorService, MONITOR_ARTIFACT_HARD_MAX_BYTES, type MonitorArtifactAudit } from './monitor-service.js';

afterEach(() => vi.restoreAllMocks());

function envelope(event: AgentEvent, sequence: number, replay = false): RuntimeAgentEventEnvelope {
  return {
    eventId: `event-${sequence}`,
    type: event.type,
    category: agentEventCategory(event),
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    sequence,
    sessionId: 'native-1',
    timestamp: '2026-08-16T12:00:00.000Z',
    monotonicTime: sequence,
    source: 'native-transcript',
    confidence: 'authoritative',
    replay,
    event,
  };
}

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
    errors?: Error[];
  } = {},
) {
  const clock = options.clock ?? new FakeClock();
  const result = new AgentMonitorService({
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
    onError: (error) => options.errors?.push(error),
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
    events: { onCandidate: () => () => undefined },
    services: {
      prompt: { submit: async () => ({ status: 'confirmed' as const }) },
      artifacts: {
        async read(artifactId: string, readOptions: { maxBytes: number }) {
          reads += 1;
          return (
            options.onRead?.(artifactId, readOptions.maxBytes) ?? Promise.resolve({ status: 'unavailable' as const })
          );
        },
      },
    },
    dispose: async () => undefined,
  } satisfies AgentAdapterBinding;
  return {
    session,
    reads: () => reads,
  };
}

describe('AgentMonitorService', () => {
  it('calculates a replay baseline once per publication instead of once per historical event', () => {
    const project = vi.spyOn(monitorProjection, 'projectAgentMonitorState');
    const states: AgentMonitorState[] = [];
    const notifications: MonitorNotification[] = [];
    const { clock, hub: monitor } = hub({ states, notifications });
    monitor.updateRun('running', { alive: true });
    const before = monitor.current();
    project.mockClear();
    notifications.length = 0;
    for (let index = 0; index < 1_000; index++) {
      monitor.acceptAgentEvent(
        envelope(
          {
            type: 'usage:tokens-used',
            usageId: `request-${index}`,
            totalTokens: 10,
            canonical: true,
            boundary: 'response',
          },
          index * 2,
          true,
        ),
      );
      monitor.acceptAgentEvent(
        envelope(
          {
            type: 'adapter:native-event',
            adapter: 'claude-code',
            nativeType: 'transcript:attachment',
          },
          index * 2 + 1,
          true,
        ),
      );
    }
    expect(monitor.current()).toBe(before);
    expect(project).not.toHaveBeenCalled();
    clock.advance(100);
    expect(project).toHaveBeenCalledTimes(1);
    expect(monitor.current().usage.cumulativeTokens).toBe(10_000);
    expect(monitor.current().usage.burnRatePerMin).toBeUndefined();
    expect(notifications).toEqual([]);
    monitor.remove();
  });

  it('ignores metadata for monitor calculation and keeps live permissions urgent during replay', () => {
    const project = vi.spyOn(monitorProjection, 'projectAgentMonitorState');
    const { clock, hub: monitor } = hub();
    monitor.updateRun('running', { alive: true });
    const before = monitor.current();
    project.mockClear();
    for (let index = 0; index < 1_000; index++) {
      monitor.acceptAgentEvent(
        envelope(
          {
            type: 'adapter:native-event',
            adapter: 'claude-code',
            nativeType: 'transcript:attachment',
          },
          index,
        ),
      );
    }
    clock.advance(100);
    expect(project).not.toHaveBeenCalled();
    expect(monitor.current()).toBe(before);
    monitor.acceptAgentEvent(
      envelope(
        {
          type: 'usage:tokens-used',
          usageId: 'historical',
          totalTokens: 10,
          canonical: true,
          boundary: 'response',
        },
        1_001,
        true,
      ),
    );
    monitor.acceptAgentEvent(
      envelope(
        {
          type: 'interaction:permission-requested',
          requestId: 'permission-1',
          tool: 'Bash',
          presentation: 'native-tui',
        },
        1_002,
      ),
    );
    expect(monitor.current()).toMatchObject({ status: 'blocked', usage: { cumulativeTokens: 10 } });
    monitor.acceptAgentEvent(
      envelope(
        {
          type: 'interaction:permission-resolved',
          requestId: 'permission-1',
          outcome: 'allowed',
        },
        1_003,
      ),
    );
    expect(monitor.current().status).toBe('idle');
    monitor.remove();
  });

  it('publishes deeply immutable monitor snapshots', () => {
    const { hub: monitor } = hub();
    const snapshot = monitor.current();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.blockers)).toBe(true);
    expect(() =>
      snapshot.blockers.push({ id: 'forged', kind: 'failure', since: '2026-08-16T12:00:00.000Z' }),
    ).toThrow();
    expect(monitor.current().blockers).toHaveLength(0);
  });

  it('validates semantic batches before they reach the accumulator', () => {
    const errors: Error[] = [];
    const { hub: monitor } = hub({ errors });
    const before = monitor.current();
    const invalid = {
      ...batch('batch-1', []),
      observedAt: 'August 16, 2026',
    } as AdapterMonitorObservationBatch;

    expect(monitor.acceptSemantic(invalid)).toBe(false);
    expect(monitor.current()).toBe(before);
    expect(errors[0]?.message).toMatch(/invalid monitor batch/);
  });

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
      category: 'process' as const,
      eventId: 'exit-1',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      sequence: 1,
      sessionId: 'native-1',
      timestamp: '2026-08-16T12:00:01.000Z',
      monotonicTime: 1,
      source: 'native-protocol' as const,
      confidence: 'authoritative' as const,
      event: { type: 'process:exited' as const, exitCode: 1, reason: 'crash' as const },
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
