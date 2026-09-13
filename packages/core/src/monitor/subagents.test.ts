import { describe, expect, it } from 'vitest';
import { agentEventCategory, agentEventType, type AgentEvent } from '../events/index.js';
import type { MonitorFamilyUpdate } from './internal-types.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';
import { projectAgentMonitorState } from './project.js';

const T0 = Date.parse('2026-09-12T12:00:00Z');
const child = {
  rootSessionKey: 'session',
  runKey: 'session:actor:child',
  role: 'child' as const,
  nativeAgentId: 'child',
};

function monitor() {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'native-hooks',
    allocatedAt: new Date(T0).toISOString(),
  });
  let sequence = 0;
  return {
    event(event: AgentEvent) {
      sequence += 1;
      state = reduceMonitorAccumulator(
        state,
        translateAgentEventEnvelope({
          runtimeRunId: 'run',
          runtimeEpoch: 1,
          envelope: {
            type: agentEventType(event),
            category: agentEventCategory(event),
            event,
            eventId: `event-${sequence}`,
            sequence,
            sessionId: 'session',
            nativeSessionId: 'session',
            timestamp: new Date(T0 + sequence * 1000).toISOString(),
            monotonicTime: sequence,
            source: 'native-hook',
            confidence: 'authoritative',
          },
        }),
      ).state;
    },
    update(updates: MonitorFamilyUpdate[]) {
      sequence += 1;
      state = reduceMonitorAccumulator(state, {
        kind: 'semantic',
        schemaVersion: 1,
        runtimeRunId: 'run',
        runtimeEpoch: 1,
        batchId: `batch-${sequence}`,
        producer: { id: 'test', epoch: '1', sequence },
        phase: 'live',
        observedAt: new Date(T0 + sequence * 1000).toISOString(),
        quality: 'exact',
        completeness: 'complete',
        provisional: false,
        updates,
        sourceWatermarks: [],
        evidence: [],
      }).state;
    },
    get value() {
      return projectAgentMonitorState(state);
    },
  };
}

describe('minimal subagent monitor', () => {
  it('keeps the parent working after its turn ends until the last child stops', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    m.event({ type: 'turn:started', turnId: 'turn' });
    m.event({ type: 'delegation:subagent-started', subagentId: 'a' });
    m.event({ type: 'delegation:subagent-started', subagentId: 'b' });
    m.event({ type: 'turn:completed', turnId: 'turn' });
    expect(m.value).toMatchObject({ status: 'working', subagentCount: 2 });
    m.event({ type: 'delegation:subagent-stopped', subagentId: 'a' });
    expect(m.value.status).toBe('working');
    m.event({ type: 'delegation:subagent-stopped', subagentId: 'b' });
    expect(m.value).toMatchObject({
      status: 'idle',
      subagentCount: 2,
      subagents: [
        { id: 'a', working: false },
        { id: 'b', working: false },
      ],
    });
  });

  it('counts identifiable children without inferring work or membership from model attribution', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    m.update([
      {
        family: 'model',
        operation: 'upsert',
        key: 'child-model',
        value: { kind: 'model', actor: child, intent: 'observed', providerModelId: 'child-model' },
      },
      {
        family: 'effort',
        operation: 'upsert',
        key: 'child-effort',
        value: { kind: 'effort', actor: child, intent: 'observed', value: 'high' },
      },
      {
        family: 'model',
        operation: 'upsert',
        key: 'unjoined-task',
        value: {
          kind: 'model',
          actor: { rootSessionKey: 'session', runKey: 'status-task', role: 'child' },
          intent: 'observed',
          providerModelId: 'unjoined-model',
        },
      },
    ]);
    expect(m.value.subagentCount).toBe(1);
    expect(m.value.subagents).toEqual([{ id: 'child', working: false, modelId: 'child-model', effort: 'high' }]);
    expect(m.value.status).toBe('idle');
    expect(m.value).not.toHaveProperty('team');
    expect(m.value).not.toHaveProperty('workflows');
  });

  it('lets a newer native stop close a child previously observed working by a semantic source', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'active' },
      },
    ]);
    expect(m.value.status).toBe('working');
    m.event({ type: 'delegation:subagent-stopped', subagentId: 'child' });
    expect(m.value).toMatchObject({ status: 'idle', subagentCount: 1, subagents: [{ working: false }] });
    m.event({ type: 'delegation:subagent-started', subagentId: 'child' });
    expect(m.value.status).toBe('working');
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'idle' },
      },
    ]);
    expect(m.value.status).toBe('idle');
  });

  it('prioritizes runnable children over a root gate and closes stale child work on idle or process exit', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    m.event({ type: 'interaction:question-requested', requestId: 'root-gate', questions: [{ prompt: 'Continue?' }] });
    const activity: MonitorFamilyUpdate = {
      family: 'status',
      operation: 'upsert',
      key: 'child-tool',
      value: { kind: 'activity', actor: child, activityKind: 'tool', active: true, line: 'Reading files' },
    };
    m.update([activity]);
    expect(m.value).toMatchObject({ status: 'working', subagents: [{ working: true, activity: 'Reading files' }] });
    expect(m.value.blockers).toHaveLength(1);
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'idle' },
      },
    ]);
    expect(m.value).toMatchObject({ status: 'blocked', subagents: [{ working: false }] });
    m.update([activity]);
    expect(m.value.status).toBe('working');
    m.event({ type: 'process:exited', reason: 'completed', exitCode: 0 });
    expect(m.value.alive).toBe(false);
    expect(m.value.subagents[0]?.working).toBe(false);
    expect(m.value.activity).toBeUndefined();
  });

  it('does not leave a stopped child permission gate blocking the parent', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'active' },
      },
      {
        family: 'status',
        operation: 'upsert',
        key: 'gate',
        value: {
          kind: 'interaction',
          actor: child,
          interactionId: 'gate',
          interactionKind: 'permission',
          state: 'pending',
        },
      },
    ]);
    expect(m.value).toMatchObject({ status: 'blocked', subagents: [{ working: false }] });
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'stopped' },
      },
    ]);
    expect(m.value).toMatchObject({ status: 'idle', blockers: [] });
  });

  it('folds corrected child usage exactly once and retains it after completion', () => {
    const m = monitor();
    m.event({ type: 'session:ready' });
    const root = { rootSessionKey: 'session', runKey: 'root', role: 'root' as const };
    const usage = (
      key: string,
      actor: typeof root | typeof child,
      total: number,
      meter: number,
    ): MonitorFamilyUpdate => ({
      family: 'usage',
      operation: 'upsert',
      key,
      value: {
        kind: 'usage',
        usageId: key,
        actor,
        boundary: 'response',
        canonical: true,
        totalTokens: total,
        meterTokens: meter,
      },
    });
    m.update([usage('root-request', root, 100, 20), usage('child-request', child, 50, 10)]);
    expect(m.value.usage).toMatchObject({
      cumulativeTokens: 150,
      burnRatePerMin: 30,
      rootActor: { cumulativeTokens: 100, burnRatePerMin: 20 },
    });
    m.update([usage('child-request', child, 40, 8)]);
    m.update([
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'child',
        value: { kind: 'actor', actor: child, state: 'stopped' },
      },
    ]);
    expect(m.value.usage).toMatchObject({ cumulativeTokens: 140, burnRatePerMin: 28 });
    expect(m.value.subagents).toEqual([{ id: 'child', working: false, cumulativeTokens: 40, burnRatePerMin: 8 }]);
  });
});
