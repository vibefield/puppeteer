import { describe, expect, it } from 'vitest';
import { agentEventCategory, agentEventType, type AgentEvent, type AgentEventEnvelope } from '../events/index.js';
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
    type: agentEventType(event),
    category: agentEventCategory(event),
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

function observedChild(id: string, state: 'active' | 'stopped') {
  return {
    kind: 'actor' as const,
    actor: { rootSessionKey: 'session-1', runKey: `session-1:actor:${id}`, role: 'child' as const, nativeAgentId: id },
    state,
  };
}

describe('monitor notifications', () => {
  it('uses stable IDs and does not repeat a duplicate transition', () => {
    const input = runtime({ type: 'delegation:subagent-started', subagentId: 'child-1', agentType: 'reviewer' }, 1);
    const first = reduceMonitorAccumulator(initial(), input);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]).toMatchObject({ type: 'delegation:subagent-started', summary: 'reviewer' });

    const duplicate = reduceMonitorAccumulator(first.state, input);
    expect(duplicate.notifications).toEqual([]);
    expect(duplicate.accepted).toBe(false);

    const replayed = reduceMonitorAccumulator(initial(), input);
    expect(replayed.notifications[0]?.notificationId).toBe(first.notifications[0]?.notificationId);
  });

  it('confirms team membership without promoting a provisional idle hook', () => {
    const provisional = reduceMonitorAccumulator(
      initial(),
      runtime(
        { type: 'delegation:teammate-idle', teamName: 'alpha', teammateName: 'researcher' },
        1,
        false,
        'inferred',
      ),
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
    const values = Array.from({ length: 257 }, (_, index) => {
      const id = `child-${index.toString().padStart(3, '0')}`;
      return {
        key: id,
        value: observedChild(id, 'active'),
      };
    });
    const installed = reduceMonitorAccumulator(
      initial(),
      semantic('child-snapshot', 'live', [
        { family: 'delegation', operation: 'replace', coverage: 'complete', values },
      ]),
    );
    const completed = reduceMonitorAccumulator(
      installed.state,
      semantic('child-completed', 'live', [
        {
          family: 'delegation',
          operation: 'upsert',
          key: 'child-000',
          value: observedChild('child-000', 'stopped'),
        },
      ]),
    );
    expect(completed.notifications.map(({ type }) => type)).toEqual(['delegation:subagent-stopped']);
  });

  it('suppresses bootstrap, correction, resync, and replacement installation', () => {
    expect(
      reduceMonitorAccumulator(
        initial(),
        runtime({ type: 'delegation:subagent-started', subagentId: 'history' }, 1, true),
      ).notifications,
    ).toEqual([]);

    const update: MonitorFamilyUpdate = {
      family: 'delegation',
      operation: 'upsert',
      key: 'actor:1',
      value: observedChild('1', 'active'),
    };
    expect(reduceMonitorAccumulator(initial(), semantic('correction', 'correction', [update])).notifications).toEqual(
      [],
    );
    expect(
      reduceMonitorAccumulator(
        initial(),
        semantic('replace', 'live', [
          {
            family: 'delegation',
            operation: 'replace',
            coverage: 'complete',
            values: [{ key: 'actor:1', value: update.value }],
          },
        ]),
      ).notifications,
    ).toEqual([]);
    expect(reduceMonitorAccumulator(initial(), semantic('resync', 'resync', [update])).notifications).toEqual([]);
  });

  it('emits blocker, compaction, and terminal transitions separately from state', () => {
    let state = reduceMonitorAccumulator(initial(), runtime({ type: 'session:ready' }, 1)).state;
    const blocked = reduceMonitorAccumulator(
      state,
      runtime({ type: 'interaction:question-requested', requestId: 'q1', questions: [{ prompt: 'Proceed?' }] }, 2),
    );
    expect(blocked.notifications.map((item) => item.type)).toEqual(['blocked.entered']);
    state = blocked.state;

    const compacting = reduceMonitorAccumulator(state, runtime({ type: 'compaction:started', compactionId: 'c1' }, 3));
    expect(compacting.notifications.map((item) => item.type)).toEqual(['compaction:started']);
    const compacted = reduceMonitorAccumulator(
      compacting.state,
      runtime({ type: 'compaction:completed', compactionId: 'c1' }, 4),
    );
    expect(compacted.notifications.map((item) => item.type)).toEqual(['compaction:completed']);

    const retrying = reduceMonitorAccumulator(
      compacted.state,
      runtime({ type: 'compaction:started', compactionId: 'c2' }, 5),
    );
    const cancelled = reduceMonitorAccumulator(
      retrying.state,
      runtime({ type: 'compaction:completed', compactionId: 'c2', outcome: 'cancelled' }, 6),
    );
    expect(cancelled.notifications).toEqual([]);
    expect(projectAgentMonitorState(cancelled.state).compaction).toMatchObject({
      active: false,
      lastOutcome: 'cancelled',
    });

    const ended = reduceMonitorAccumulator(
      cancelled.state,
      runtime({ type: 'process:exited', reason: 'crash', exitCode: 1 }, 7),
    );
    expect(ended.notifications.map((item) => item.type)).toContain('session.ended');
  });
});
