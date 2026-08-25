import { describe, expect, it } from 'vitest';
import { agentEventService, agentServiceEventType, type AgentEvent, type AgentEventEnvelope } from '../events.js';
import type { MonitorFamilyUpdate, RuntimeMonitorObservationBatch } from './internal-types.js';
import { projectAgentMonitorState } from './project.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';

const T0 = '2026-08-16T12:00:00.000Z';

function initial() {
  return createMonitorAccumulatorState({
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'native-hooks',
    allocatedAt: T0,
  });
}

function runtime(
  event: AgentEvent,
  sequence: number,
  replay = false,
  confidence: AgentEventEnvelope['confidence'] = 'authoritative',
) {
  const envelope: AgentEventEnvelope = {
    type: agentServiceEventType(event),
    service: agentEventService(event),
    eventId: `event-${sequence}`,
    sequence,
    sessionId: 'session-1',
    timestamp: new Date(Date.parse(T0) + sequence * 1_000).toISOString(),
    monotonicTime: sequence,
    source: 'native-hook',
    confidence,
    replay,
    event,
  };
  return translateAgentEventEnvelope({ runtimeRunId: 'run-1', runtimeEpoch: 1, envelope });
}

function semantic(
  batchId: string,
  phase: RuntimeMonitorObservationBatch['phase'],
  updates: MonitorFamilyUpdate[],
): RuntimeMonitorObservationBatch {
  return {
    kind: 'semantic',
    schemaVersion: 1,
    batchId,
    producer: { id: 'semantic', epoch: 'epoch-1' },
    phase,
    observedAt: '2026-08-16T12:00:10.000Z',
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    updates,
    sourceWatermarks: [],
    evidence: [],
  };
}

describe('monitor notifications', () => {
  it('uses stable IDs and does not repeat a duplicate transition', () => {
    const input = runtime({ type: 'task.created', taskId: 'task-1', description: 'Build it' }, 1);
    const first = reduceMonitorAccumulator(initial(), input);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]).toMatchObject({ type: 'task.created', summary: 'Build it' });

    const duplicate = reduceMonitorAccumulator(first.state, input);
    expect(duplicate.notifications).toEqual([]);
    expect(duplicate.accepted).toBe(false);

    const replayed = reduceMonitorAccumulator(initial(), input);
    expect(replayed.notifications[0]?.notificationId).toBe(first.notifications[0]?.notificationId);
  });

  it('does not announce a blockable task transition until confirmation', () => {
    const provisional = reduceMonitorAccumulator(
      initial(),
      runtime({ type: 'task.updated', taskId: 'task-p', status: 'proposed', provisional: true }, 1, false, 'inferred'),
    );
    expect(provisional.notifications).toEqual([]);

    const confirmed = reduceMonitorAccumulator(
      provisional.state,
      runtime({ type: 'task.updated', taskId: 'task-p', status: 'pending', provisional: false }, 2),
    );
    expect(confirmed.notifications).toEqual([expect.objectContaining({ type: 'task.created' })]);
  });

  it('confirms team membership without promoting a provisional idle hook', () => {
    const provisional = reduceMonitorAccumulator(
      initial(),
      runtime({ type: 'teammate.idle', teamName: 'alpha', teammateName: 'researcher' }, 1, false, 'inferred'),
    );
    expect(provisional.notifications).toEqual([]);
    expect(projectAgentMonitorState(provisional.state).team?.teammates[0]).toMatchObject({
      idle: true,
      provisional: true,
      activityProvisional: true,
    });

    const confirmed = reduceMonitorAccumulator(
      provisional.state,
      semantic('team-confirmed', 'live', [
        {
          family: 'delegation',
          operation: 'upsert',
          key: 'team:canonical-alpha',
          value: { kind: 'team', teamId: 'canonical-alpha', nativeTeamId: 'alpha', name: 'alpha' },
        },
        {
          family: 'delegation',
          operation: 'upsert',
          key: 'member:researcher',
          value: {
            kind: 'team-member',
            membershipId: 'researcher',
            teamId: 'canonical-alpha',
            nativeTeamId: 'alpha',
            nativeMemberId: 'researcher',
            membershipState: 'present',
            state: 'unknown',
          },
        },
      ]),
    );
    expect(confirmed.notifications.map(({ type }) => type)).toEqual(['team.observed', 'team.member-added']);
    expect(projectAgentMonitorState(confirmed.state).team?.teammates[0]).toMatchObject({
      idle: true,
      activityProvisional: true,
    });
    expect(projectAgentMonitorState(confirmed.state).team?.teammates[0]).not.toHaveProperty('provisional');

    const confirmedIdle = reduceMonitorAccumulator(
      confirmed.state,
      semantic('team-idle-confirmed', 'live', [
        {
          family: 'delegation',
          operation: 'upsert',
          key: 'member:researcher',
          value: {
            kind: 'team-member',
            membershipId: 'researcher',
            teamId: 'canonical-alpha',
            nativeTeamId: 'alpha',
            nativeMemberId: 'researcher',
            membershipState: 'present',
            state: 'idle',
          },
        },
      ]),
    );
    expect(confirmedIdle.notifications.map(({ type }) => type)).toEqual(['team.member-idle']);
    expect(projectAgentMonitorState(confirmedIdle.state).team?.teammates[0]).not.toHaveProperty('activityProvisional');

    const removed = reduceMonitorAccumulator(
      confirmedIdle.state,
      semantic('team-member-removed', 'live', [
        {
          family: 'delegation',
          operation: 'upsert',
          key: 'member:researcher',
          value: {
            kind: 'team-member',
            membershipId: 'researcher',
            teamId: 'canonical-alpha',
            nativeTeamId: 'alpha',
            nativeMemberId: 'researcher',
            membershipState: 'removed',
            state: 'unknown',
          },
        },
      ]),
    );
    expect(removed.notifications.map(({ type }) => type)).toEqual(['team.member-removed']);
  });

  it('derives entity transitions from unbounded logical state at the public collection cap', () => {
    const values = Array.from({ length: 513 }, (_, index) => {
      const id = `task-${index.toString().padStart(3, '0')}`;
      return {
        key: id,
        value: { kind: 'task' as const, taskId: id, status: 'pending' as const, provisional: false },
      };
    });
    const installed = reduceMonitorAccumulator(
      initial(),
      semantic('task-snapshot', 'live', [{ family: 'planning', operation: 'replace', coverage: 'complete', values }]),
    );
    const completed = reduceMonitorAccumulator(
      installed.state,
      semantic('task-completed', 'live', [
        {
          family: 'planning',
          operation: 'upsert',
          key: 'task-000',
          value: { kind: 'task', taskId: 'task-000', status: 'completed', provisional: false },
        },
      ]),
    );
    expect(completed.notifications.map(({ type }) => type)).toEqual(['task.completed']);
  });

  it('suppresses bootstrap, correction, resync, and replacement installation', () => {
    expect(
      reduceMonitorAccumulator(initial(), runtime({ type: 'task.created', taskId: 'history' }, 1, true)).notifications,
    ).toEqual([]);

    const update: MonitorFamilyUpdate = {
      family: 'planning',
      operation: 'upsert',
      key: 'task:1',
      value: { kind: 'task', taskId: '1', status: 'pending', provisional: false },
    };
    expect(reduceMonitorAccumulator(initial(), semantic('correction', 'correction', [update])).notifications).toEqual(
      [],
    );
    expect(
      reduceMonitorAccumulator(
        initial(),
        semantic('replace', 'live', [
          {
            family: 'planning',
            operation: 'replace',
            coverage: 'complete',
            values: [{ key: 'task:1', value: update.value }],
          },
        ]),
      ).notifications,
    ).toEqual([]);
    expect(reduceMonitorAccumulator(initial(), semantic('resync', 'resync', [update])).notifications).toEqual([]);
  });

  it('emits blocker, compaction, and terminal transitions separately from state', () => {
    let state = reduceMonitorAccumulator(initial(), runtime({ type: 'session.ready' }, 1)).state;
    const blocked = reduceMonitorAccumulator(
      state,
      runtime({ type: 'question.requested', requestId: 'q1', questions: [{ prompt: 'Proceed?' }] }, 2),
    );
    expect(blocked.notifications.map((item) => item.type)).toEqual(['blocked.entered']);
    state = blocked.state;

    const compacting = reduceMonitorAccumulator(state, runtime({ type: 'compaction.started', compactionId: 'c1' }, 3));
    expect(compacting.notifications.map((item) => item.type)).toEqual(['compaction.started']);
    const compacted = reduceMonitorAccumulator(
      compacting.state,
      runtime({ type: 'compaction.completed', compactionId: 'c1' }, 4),
    );
    expect(compacted.notifications.map((item) => item.type)).toEqual(['compaction.completed']);

    const retrying = reduceMonitorAccumulator(
      compacted.state,
      runtime({ type: 'compaction.started', compactionId: 'c2' }, 5),
    );
    const cancelled = reduceMonitorAccumulator(
      retrying.state,
      runtime({ type: 'compaction.completed', compactionId: 'c2', outcome: 'cancelled' }, 6),
    );
    expect(cancelled.notifications).toEqual([]);
    expect(projectAgentMonitorState(cancelled.state).compaction).toMatchObject({
      active: false,
      lastOutcome: 'cancelled',
    });

    const ended = reduceMonitorAccumulator(
      cancelled.state,
      runtime({ type: 'process.exited', reason: 'crash', exitCode: 1 }, 7),
    );
    expect(ended.notifications.map((item) => item.type)).toContain('session.ended');
  });
});
