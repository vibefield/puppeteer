import { describe, expect, it } from 'vitest';
import { agentEventCategory, agentEventType, type AgentEventEnvelope } from '../events/index.js';
import type { MonitorFamilyUpdate, RuntimeMonitorObservationBatch } from './internal-types.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';
import { projectAgentMonitorState } from './project.js';

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

function semantic(
  batchId: string,
  phase: RuntimeMonitorObservationBatch['phase'],
  updates: MonitorFamilyUpdate[],
  sequence: number,
): RuntimeMonitorObservationBatch {
  return {
    kind: 'semantic',
    schemaVersion: 1,
    batchId,
    producer: { id: 'semantic', epoch: 'epoch-1', sequence },
    phase,
    observedAt: new Date(Date.parse(T0) + sequence * 10_000).toISOString(),
    effectiveAt: new Date(Date.parse(T0) + 10_000).toISOString(),
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

function runtimeEnvelope(
  event: AgentEventEnvelope['event'],
  sequence: number,
  confidence: AgentEventEnvelope['confidence'] = 'authoritative',
) {
  return translateAgentEventEnvelope({
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    envelope: {
      type: agentEventType(event),
      category: agentEventCategory(event),
      eventId: `event-${sequence}`,
      sequence,
      sessionId: 'session-1',
      timestamp: new Date(Date.parse(T0) + sequence * 1_000).toISOString(),
      monotonicTime: sequence,
      source: 'native-hook',
      confidence,
      event,
    },
  });
}

describe('projectAgentMonitorState', () => {
  it('increments revisions only when the public full state changes', () => {
    const accumulator = initial();
    const first = projectAgentMonitorState(accumulator);
    const unchanged = projectAgentMonitorState(accumulator, { previous: first });
    expect(unchanged).toBe(first);

    const readyAccumulator = reduceMonitorAccumulator(accumulator, runtimeEnvelope({ type: 'session:ready' }, 1)).state;
    const ready = projectAgentMonitorState(readyAccumulator, { previous: first });
    expect(ready.revision).toBe(first.revision + 1);
    expect(ready.status).toBe('idle');
    expect(projectAgentMonitorState(readyAccumulator, { previous: ready })).toBe(ready);
  });

  it('does not leave a dead clean run working when a tool lacks a terminal event', () => {
    let state = reduceMonitorAccumulator(initial(), runtimeEnvelope({ type: 'session:ready' }, 1)).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'tool:requested', toolCallId: 'open-tool', tool: 'ExitPlanMode' }, 2),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({ status: 'working', alive: true });

    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'process:exited', reason: 'completed', exitCode: 0 }, 3),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({ status: 'idle', alive: false });
  });

  it('does not present retained evidence as fully available when its only producer is degraded', () => {
    const input = semantic(
      'degraded-usage',
      'live',
      [
        {
          family: 'usage',
          operation: 'upsert',
          key: 'sample',
          value: { kind: 'usage', usageId: 'sample', boundary: 'sample', canonical: false, cumulativeTokens: 10 },
        },
      ],
      1,
    );
    input.readiness = 'degraded';
    input.capabilities = [
      {
        family: 'usage',
        support: 'supported',
        actorScope: 'session',
        latency: 'sample',
        source: 'test',
        limitations: [],
      },
    ];

    const state = reduceMonitorAccumulator(initial(), input).state;
    expect(projectAgentMonitorState(state).freshness.families.usage).toMatchObject({
      support: 'supported',
      availability: 'partial',
    });
  });

  it('keeps alternate producer evidence visible when another observation rail is unavailable', () => {
    const unavailable = semantic('hook-unavailable', 'live', [], 1);
    unavailable.producer.id = 'hook-rail';
    unavailable.readiness = 'degraded';
    unavailable.completeness = 'unavailable';
    unavailable.capabilities = [
      {
        family: 'usage',
        support: 'degraded',
        actorScope: 'session',
        latency: 'hook',
        source: 'hook',
        limitations: ['hook unavailable'],
      },
    ];
    unavailable.coverage = [
      {
        family: 'usage',
        completeness: 'unavailable',
        asOf: unavailable.observedAt,
        reason: 'hook unavailable',
      },
    ];

    const transcript = semantic(
      'transcript-usage',
      'live',
      [
        {
          family: 'usage',
          operation: 'upsert',
          key: 'response',
          value: { kind: 'usage', usageId: 'response', boundary: 'response', canonical: true, deltaTokens: 25 },
        },
      ],
      1,
    );
    transcript.producer.id = 'transcript-rail';
    transcript.capabilities = [
      {
        family: 'usage',
        support: 'supported',
        actorScope: 'session',
        latency: 'file-flush',
        source: 'transcript',
        limitations: [],
      },
    ];

    const state = reduceMonitorAccumulator(reduceMonitorAccumulator(initial(), unavailable).state, transcript).state;
    expect(projectAgentMonitorState(state).freshness.families.usage).toMatchObject({
      support: 'supported',
      availability: 'partial',
      reason: 'hook unavailable',
    });
  });

  it('reports a capability-less producer as loading while its retained slice is being replaced', () => {
    const current = semantic(
      'current-usage',
      'live',
      [
        {
          family: 'usage',
          operation: 'upsert',
          key: 'sample',
          value: { kind: 'usage', usageId: 'sample', boundary: 'sample', canonical: false, cumulativeTokens: 10 },
        },
      ],
      1,
    );
    const recovering = semantic('recovering-usage', 'resync', [], 2);
    recovering.readiness = 'loading';
    recovering.completeness = 'unavailable';

    const state = reduceMonitorAccumulator(reduceMonitorAccumulator(initial(), current).state, recovering).state;
    expect(projectAgentMonitorState(state).freshness.families.usage).toMatchObject({
      support: 'supported',
      availability: 'loading',
    });
  });

  it('keeps configured and observed model/effort/modes distinct and open-ended', () => {
    let state = reduceMonitorAccumulator(initial(), runtimeEnvelope({ type: 'session:ready' }, 1)).state;
    state = reduceMonitorAccumulator(
      state,
      semantic(
        'configuration',
        'live',
        [
          {
            family: 'model',
            operation: 'upsert',
            key: 'configured',
            value: { kind: 'model', providerModelId: 'configured-model', intent: 'configured' },
          },
          {
            family: 'model',
            operation: 'upsert',
            key: 'observed',
            value: {
              kind: 'model',
              providerModelId: 'effective-model',
              displayName: 'Effective Model',
              intent: 'observed',
            },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'configured',
            value: { kind: 'effort', value: 'high', intent: 'configured' },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'observed',
            value: { kind: 'effort', value: 'future-ultra', intent: 'observed' },
          },
          {
            family: 'mode',
            operation: 'upsert',
            key: 'provider-session',
            value: { kind: 'mode', modeKind: 'provider-session', raw: 'future-auto', normalized: 'auto' },
          },
          {
            family: 'mode',
            operation: 'upsert',
            key: 'provider-permission',
            value: { kind: 'mode', modeKind: 'provider-permission', raw: 'accept-edits' },
          },
        ],
        1,
      ),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      model: { id: 'effective-model', displayName: 'Effective Model' },
      effort: { value: 'future-ultra', configured: 'high', intent: 'observed' },
      modes: {
        execution: 'native-tui',
        providerSession: { raw: 'future-auto', normalized: 'auto' },
        providerPermission: { raw: 'accept-edits' },
      },
    });
  });

  it('promotes explicit root-actor context, model, and effort to the run header', () => {
    const root = {
      rootSessionKey: 'native-1',
      runKey: 'native-1:root',
      role: 'root' as const,
    };
    const child = {
      rootSessionKey: 'native-1',
      runKey: 'native-1:child',
      role: 'child' as const,
      parentRunKey: root.runKey,
    };
    const state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'root-scoped-environment',
        'live',
        [
          {
            family: 'context',
            operation: 'upsert',
            key: 'root-context',
            value: { kind: 'context', usedPercentage: 42, percentageSource: 'provider', actor: root },
          },
          {
            family: 'model',
            operation: 'upsert',
            key: 'root-model',
            value: { kind: 'model', providerModelId: 'root-model', intent: 'observed', actor: root },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'root-effort',
            value: { kind: 'effort', value: 'xhigh', intent: 'observed', actor: root },
          },
          {
            family: 'model',
            operation: 'upsert',
            key: 'child-model',
            value: { kind: 'model', providerModelId: 'child-model', intent: 'observed', actor: child },
          },
        ],
        1,
      ),
    ).state;

    expect(projectAgentMonitorState(state)).toMatchObject({
      context: { usedPercent: 42 },
      model: { id: 'root-model', intent: 'observed' },
      effort: { value: 'xhigh', intent: 'observed' },
      subagents: [{ actorRunKey: 'native-1:child', modelId: 'child-model' }],
    });
  });

  it('prefers observed effective environment facts over separately retained launch intent', () => {
    let state = reduceMonitorAccumulator(
      initial(),
      runtimeEnvelope({ type: 'model:updated', intent: 'configured', model: { id: 'configured-model' } }, 1),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'effort:updated', intent: 'configured', effort: 'high' }, 2),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        {
          type: 'mode:updated',
          intent: 'configured',
          modeKind: 'provider-permission',
          mode: { raw: 'plan' },
        },
        3,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'model:updated', intent: 'observed', model: { id: 'effective-model' } }, 4),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'effort:updated', intent: 'observed', effort: 'future-ultra' }, 5),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        {
          type: 'mode:updated',
          intent: 'observed',
          modeKind: 'provider-permission',
          mode: { raw: 'accept-edits' },
        },
        6,
      ),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      model: { id: 'effective-model' },
      effort: { value: 'future-ultra', configured: 'high', intent: 'observed' },
      modes: { providerPermission: { raw: 'accept-edits' } },
    });

    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'effort:updated', intent: 'observed', effort: null }, 7),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      effort: { value: 'high', configured: 'high', intent: 'configured' },
    });
  });

  it('prefers authoritative runtime mode transitions while retaining configured mode intent', () => {
    let state = reduceMonitorAccumulator(
      initial(),
      runtimeEnvelope(
        {
          type: 'mode:updated',
          intent: 'configured',
          modeKind: 'provider-permission',
          mode: { raw: 'manual' },
        },
        1,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      semantic(
        'stale-transcript-mode',
        'live',
        [
          {
            family: 'mode',
            operation: 'upsert',
            key: 'provider-permission',
            value: { kind: 'mode', modeKind: 'provider-permission', raw: 'plan', intent: 'observed' },
          },
        ],
        1,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        {
          type: 'mode:updated',
          intent: 'observed',
          modeKind: 'provider-permission',
          mode: { raw: 'acceptEdits', normalized: 'Accept Edits' },
        },
        20,
      ),
    ).state;

    expect(projectAgentMonitorState(state).modes.providerPermission).toEqual({
      raw: 'acceptEdits',
      normalized: 'Accept Edits',
      configured: { raw: 'manual' },
      intent: 'observed',
    });
  });

  it('advances model, effort, and context at the newest equal-quality provider boundary', () => {
    let state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'previous-response-environment',
        'live',
        [
          {
            family: 'model',
            operation: 'upsert',
            key: 'observed',
            value: { kind: 'model', providerModelId: 'previous-model', intent: 'observed' },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'observed',
            value: { kind: 'effort', value: 'low', intent: 'observed' },
          },
          {
            family: 'context',
            operation: 'upsert',
            key: 'root',
            value: { kind: 'context', usedPercentage: 10, percentageSource: 'provider' },
          },
        ],
        1,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'model:updated', intent: 'observed', model: { id: 'current-model' } }, 20),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'effort:updated', intent: 'observed', effort: 'max' }, 21),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        {
          type: 'context-window:updated',
          usedTokens: 70_000,
          capacityTokens: 200_000,
          usedPercentage: 35,
          percentageSource: 'provider',
        },
        22,
      ),
    ).state;

    expect(projectAgentMonitorState(state)).toMatchObject({
      model: { id: 'current-model', intent: 'observed' },
      effort: { value: 'max', intent: 'observed' },
      context: { usedPercent: 35, percentageSource: 'provider' },
    });
  });

  it('keeps blockable hook transitions visibly provisional', () => {
    let state = reduceMonitorAccumulator(
      initial(),
      runtimeEnvelope(
        { type: 'delegation:task-updated', taskId: 'task-p', status: 'proposed', provisional: true },
        1,
        'inferred',
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        { type: 'delegation:teammate-idle', teamName: 'alpha', teammateName: 'researcher' },
        2,
        'inferred',
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope({ type: 'compaction:started', compactionId: 'compact-p' }, 3, 'inferred'),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      tasks: [{ id: 'task-p', status: 'proposed', provisional: true }],
      team: { teammates: [{ id: 'researcher', idle: true, provisional: true }] },
      compaction: { active: true, provisional: true },
    });
  });

  it('projects leased child activity without requiring it to own child lifecycle', () => {
    const actor = {
      rootSessionKey: 'native-1',
      runKey: 'native-1:status-task:task-7',
      role: 'child' as const,
      parentRunKey: 'native-1:root',
    };
    const state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'child-pulse',
        'live',
        [
          {
            family: 'status',
            operation: 'upsert',
            key: 'child-activity:task-7',
            value: {
              kind: 'activity',
              activityKind: 'delegating',
              active: true,
              line: 'Reviewing patch',
              actor,
              leaseId: 'lease-task-7',
            },
          },
          {
            family: 'status',
            operation: 'upsert',
            key: 'tool:edit-1',
            value: {
              kind: 'activity',
              activityKind: 'tool',
              active: true,
              line: 'Editing file',
              actor,
            },
          },
        ],
        1,
      ),
    ).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      status: 'working',
      subagents: [
        {
          actorRunKey: 'native-1:status-task:task-7',
          active: true,
          activity: 'Editing file',
        },
      ],
    });
  });

  it('lets an authoritative child stop seal stale sampled activity', () => {
    const actor = {
      rootSessionKey: 'native-1',
      runKey: 'native-1:actor:agent-7',
      role: 'child' as const,
      parentRunKey: 'native-1:root',
      nativeAgentId: 'agent-7',
      nativeAgentType: 'Explore',
    };
    let state = reduceMonitorAccumulator(initial(), runtimeEnvelope({ type: 'session:ready' }, 1)).state;
    state = reduceMonitorAccumulator(
      state,
      semantic(
        'stopped-child-with-stale-sample',
        'live',
        [
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'actor:agent-7',
            value: { kind: 'actor', actor, state: 'stopped' },
          },
          {
            family: 'status',
            operation: 'upsert',
            key: 'child-activity:agent-7',
            value: {
              kind: 'activity',
              activityKind: 'delegating',
              active: true,
              line: 'Stale running snapshot',
              actor,
            },
          },
        ],
        1,
      ),
    ).state;

    const projected = projectAgentMonitorState(state);
    expect(projected).toMatchObject({
      status: 'idle',
      subagents: [{ id: 'agent-7', type: 'Explore', active: false }],
    });
    expect(projected.activity).toBeUndefined();
    expect(projected.subagents[0]?.activity).toBeUndefined();
  });

  it('replaces corrected response usage and never turns the reduction into a negative rate', () => {
    const usage = (deltaTokens: number): MonitorFamilyUpdate => ({
      family: 'usage',
      operation: 'upsert',
      key: 'response-1',
      value: { kind: 'usage', usageId: 'response-1', boundary: 'response', canonical: true, deltaTokens },
    });
    let state = reduceMonitorAccumulator(initial(), semantic('response', 'live', [usage(100)], 1)).state;
    expect(projectAgentMonitorState(state, { asOf: '2026-08-16T12:00:20.000Z' }).usage).toMatchObject({
      cumulativeTokens: 100,
      burnRatePerMin: 100,
    });
    state = reduceMonitorAccumulator(state, semantic('response-correction', 'correction', [usage(40)], 2)).state;
    const corrected = projectAgentMonitorState(state, { asOf: '2026-08-16T12:00:30.000Z' });
    expect(corrected.usage).toMatchObject({ cumulativeTokens: 40, burnRatePerMin: 40 });
    expect(corrected.usage.burnRatePerMin).toBeGreaterThanOrEqual(0);
  });

  it('deduplicates one normalized usage identity across fast and semantic rails', () => {
    let state = reduceMonitorAccumulator(
      initial(),
      runtimeEnvelope(
        {
          type: 'usage:tokens-used',
          usageId: 'response-shared',
          boundary: 'response',
          canonical: true,
          deltaTokens: 60,
        },
        1,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      semantic(
        'canonical-shared',
        'live',
        [
          {
            family: 'usage',
            operation: 'upsert',
            key: 'provider-specific-key',
            value: {
              kind: 'usage',
              usageId: 'response-shared',
              actor: {
                rootSessionKey: 'session-1',
                runKey: 'session-1:actor:worker-1',
                role: 'child',
                parentRunKey: 'session-1:root',
                nativeAgentId: 'worker-1',
              },
              boundary: 'response',
              canonical: true,
              deltaTokens: 60,
            },
          },
        ],
        1,
      ),
    ).state;
    expect(projectAgentMonitorState(state).usage.cumulativeTokens).toBe(60);
  });

  it('aggregates an actor once regardless of affiliation arrival order', () => {
    const actor = {
      rootSessionKey: 'session-1',
      runKey: 'child-1',
      role: 'child' as const,
      parentRunKey: 'session-1:root',
      nativeAgentId: 'child-1',
    };
    const facts: MonitorFamilyUpdate[] = [
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'actor:child-1',
        value: { kind: 'actor', actor, state: 'active' },
      },
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'team:team-1',
        value: { kind: 'team', teamId: 'team-1', name: 'Research team' },
      },
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'team-member:child-1',
        value: {
          kind: 'team-member',
          membershipId: 'researcher',
          teamId: 'team-1',
          actor,
          state: 'unknown',
        },
      },
      {
        family: 'usage',
        operation: 'upsert',
        key: 'response-child-1',
        value: {
          kind: 'usage',
          usageId: 'response-child-1',
          actor,
          boundary: 'response',
          canonical: true,
          deltaTokens: 25,
        },
      },
      {
        family: 'delegation',
        operation: 'upsert',
        key: 'affiliation:child-1',
        value: { kind: 'affiliation', actor, affiliation: { kind: 'team', id: 'team-1' } },
      },
    ];
    const forward = facts.reduce(
      (state, update, index) =>
        reduceMonitorAccumulator(state, semantic(`forward-${index}`, 'live', [update], index + 1)).state,
      initial(),
    );
    const reverse = [...facts]
      .reverse()
      .reduce(
        (state, update, index) =>
          reduceMonitorAccumulator(state, semantic(`reverse-${index}`, 'live', [update], index + 1)).state,
        initial(),
      );
    const forwardProjection = projectAgentMonitorState(forward);
    const reverseProjection = projectAgentMonitorState(reverse);
    expect(forwardProjection.usage.cumulativeTokens).toBe(25);
    expect(forwardProjection.subagents[0]?.cumulativeTokens).toBe(25);
    expect(forwardProjection.subagents[0]?.burnRatePerMin).toBe(25);
    expect(forwardProjection.team?.teammates[0]).toMatchObject({
      id: 'researcher',
      actorRunKey: 'child-1',
      idle: false,
      cumulativeTokens: 25,
      burnRatePerMin: 25,
    });
    expect(reverseProjection.usage.cumulativeTokens).toBe(25);
    expect(reverseProjection.subagents[0]?.cumulativeTokens).toBe(25);
    expect(reverseProjection.team?.teammates[0]).toMatchObject({
      id: 'researcher',
      actorRunKey: 'child-1',
      idle: false,
      cumulativeTokens: 25,
      burnRatePerMin: 25,
    });
  });

  it('reconciles canonical team membership with native hook activity without losing actor telemetry', () => {
    const actor = {
      rootSessionKey: 'session-1',
      runKey: 'child-team-1',
      role: 'child' as const,
      parentRunKey: 'session-1:root',
      nativeAgentId: 'agent-1',
      nativeAgentType: 'researcher',
    };
    let state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'team-semantic',
        'live',
        [
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'team:canonical-team',
            value: {
              kind: 'team',
              teamId: 'canonical-team',
              nativeTeamId: 'alpha',
              name: 'alpha',
            },
          },
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'member:canonical-member',
            value: {
              kind: 'team-member',
              membershipId: 'researcher',
              teamId: 'canonical-team',
              nativeTeamId: 'alpha',
              nativeMemberId: 'researcher',
              actor,
              name: 'researcher',
              membershipState: 'present',
              state: 'unknown',
            },
          },
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'actor:child-team-1',
            value: { kind: 'actor', actor, state: 'unknown' },
          },
          {
            family: 'usage',
            operation: 'upsert',
            key: 'usage:child-team-1',
            value: {
              kind: 'usage',
              usageId: 'usage:child-team-1',
              actor,
              boundary: 'response',
              canonical: true,
              deltaTokens: 40,
            },
          },
          {
            family: 'context',
            operation: 'upsert',
            key: 'context:child-team-1',
            value: {
              kind: 'context',
              actor,
              usedTokens: 50_000,
              capacityTokens: 200_000,
              percentageSource: 'derived',
            },
          },
          {
            family: 'model',
            operation: 'upsert',
            key: 'model-configured:child-team-1',
            value: {
              kind: 'model',
              actor,
              providerModelId: 'haiku',
              intent: 'configured',
            },
          },
          {
            family: 'model',
            operation: 'upsert',
            key: 'model:child-team-1',
            value: {
              kind: 'model',
              actor,
              providerModelId: 'claude-haiku-4-5',
              intent: 'observed',
            },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'effort-configured:child-team-1',
            value: { kind: 'effort', actor, value: 'low', intent: 'configured' },
          },
          {
            family: 'effort',
            operation: 'upsert',
            key: 'effort:child-team-1',
            value: { kind: 'effort', actor, value: 'medium', intent: 'observed' },
          },
        ],
        1,
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      runtimeEnvelope(
        { type: 'delegation:teammate-idle', teamName: 'alpha', teammateName: 'researcher' },
        20,
        'inferred',
      ),
    ).state;

    expect(projectAgentMonitorState(state).team).toMatchObject({
      id: 'canonical-team',
      name: 'alpha',
      teammates: [
        {
          id: 'researcher',
          actorRunKey: 'child-team-1',
          idle: true,
          cumulativeTokens: 40,
          burnRatePerMin: 40,
          contextPercent: 25,
          modelId: 'claude-haiku-4-5',
          modelIntent: 'observed',
          effort: 'medium',
          effortIntent: 'observed',
          activityProvisional: true,
        },
      ],
    });
    expect(projectAgentMonitorState(state).team?.teammates[0]).not.toHaveProperty('provisional');

    const active = semantic(
      'team-active',
      'live',
      [
        {
          family: 'status',
          operation: 'upsert',
          key: 'activity:child-team-1',
          value: {
            kind: 'activity',
            actor,
            activityKind: 'tool',
            active: true,
            line: 'Running team tests',
          },
        },
      ],
      30,
    );
    active.effectiveAt = '2026-08-16T12:00:30.000Z';
    state = reduceMonitorAccumulator(state, active).state;
    expect(projectAgentMonitorState(state).team?.teammates).toEqual([
      expect.objectContaining({
        id: 'researcher',
        idle: false,
        activity: 'Running team tests',
        modelId: 'claude-haiku-4-5',
      }),
    ]);
    expect(projectAgentMonitorState(state).team?.teammates[0]).not.toHaveProperty('activityProvisional');

    state = reduceMonitorAccumulator(
      state,
      semantic(
        'team-removed',
        'live',
        [
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'member:canonical-member',
            value: {
              kind: 'team-member',
              membershipId: 'researcher',
              teamId: 'canonical-team',
              nativeTeamId: 'alpha',
              nativeMemberId: 'researcher',
              actor,
              name: 'researcher',
              membershipState: 'removed',
              state: 'unknown',
            },
          },
        ],
        31,
      ),
    ).state;
    expect(projectAgentMonitorState(state).team?.teammates).toEqual([]);
  });

  it('selects the root-affiliated team and separates the current member from teammates', () => {
    const root = {
      rootSessionKey: 'session-1',
      runKey: 'session-1:root',
      role: 'root' as const,
      nativeAgentId: 'lead-agent',
    };
    const child = {
      rootSessionKey: 'session-1',
      runKey: 'session-1:child',
      role: 'child' as const,
      parentRunKey: root.runKey,
      nativeAgentId: 'child-agent',
    };
    const state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'root-team',
        'live',
        [
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'team:000-unrelated',
            value: { kind: 'team', teamId: 'unrelated', nativeTeamId: 'other', name: 'other' },
          },
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'team:zzz-alpha',
            value: { kind: 'team', teamId: 'canonical-alpha', nativeTeamId: 'alpha', name: 'alpha' },
          },
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'member:lead',
            value: {
              kind: 'team-member',
              membershipId: 'team-lead',
              teamId: 'canonical-alpha',
              nativeTeamId: 'alpha',
              nativeMemberId: 'team-lead',
              actor: root,
              name: 'team-lead',
              membershipState: 'present',
              state: 'active',
            },
          },
          {
            family: 'delegation',
            operation: 'upsert',
            key: 'member:child',
            value: {
              kind: 'team-member',
              membershipId: 'researcher',
              teamId: 'canonical-alpha',
              nativeTeamId: 'alpha',
              nativeMemberId: 'researcher',
              actor: child,
              name: 'researcher',
              membershipState: 'present',
              state: 'idle',
            },
          },
        ],
        1,
      ),
    ).state;

    expect(projectAgentMonitorState(state).team).toMatchObject({
      id: 'canonical-alpha',
      name: 'alpha',
      memberId: 'team-lead',
      memberName: 'team-lead',
      teammates: [{ id: 'researcher', actorRunKey: 'session-1:child', idle: true }],
    });
  });

  it('accepts a semantic correction to the native-session claim without changing run identity', () => {
    const runClaim = (nativeId: string): MonitorFamilyUpdate => ({
      family: 'status',
      operation: 'upsert',
      key: 'run',
      value: {
        kind: 'run',
        lifecycle: 'running',
        alive: true,
        nativeSession: { namespace: 'claude', id: nativeId, basis: 'observed', quality: 'exact' },
      },
    });
    let state = reduceMonitorAccumulator(initial(), semantic('native-1', 'live', [runClaim('native-1')], 1)).state;
    state = reduceMonitorAccumulator(state, semantic('native-2', 'correction', [runClaim('native-2')], 2)).state;
    expect(projectAgentMonitorState(state)).toMatchObject({
      runtimeRunId: 'run-1',
      session: { nativeSessionId: 'native-2' },
    });
  });

  it('reports worktrees omitted after environment projection instead of silently slicing them', () => {
    const worktrees = Array.from({ length: 300 }, (_, index) => `/repo/worktree-${index.toString().padStart(3, '0')}`);
    const state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'worktrees',
        'live',
        [
          {
            family: 'environment',
            operation: 'upsert',
            key: 'workspace',
            value: { kind: 'environment', worktrees },
          },
        ],
        1,
      ),
    ).state;
    const projected = projectAgentMonitorState(state);
    expect(projected.environment.worktrees).toHaveLength(256);
    expect(projected.omitted).toMatchObject({ worktrees: 44 });
  });
});
