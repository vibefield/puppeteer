import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { agentEventService, agentServiceEventType, type AgentEvent, type AgentEventEnvelope } from '../events.js';
import type {
  MonitorFamilyUpdate,
  MonitorAccumulatorState,
  RuntimeMonitorObservationBatch,
  WorkspaceMonitorObservation,
} from './internal-types.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';
import { projectAgentMonitorState } from './project.js';

const T0 = '2026-08-16T12:00:00.000Z';

function initial(): MonitorAccumulatorState {
  return createMonitorAccumulatorState({
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'native-hooks',
    allocatedAt: T0,
    providerId: 'claude',
  });
}

function envelope(event: AgentEvent, sequence: number, options: Partial<AgentEventEnvelope> = {}): AgentEventEnvelope {
  return {
    sequence,
    sessionId: 'terminal-1',
    nativeSessionId: 'native-1',
    timestamp: new Date(Date.parse(T0) + sequence * 1_000).toISOString(),
    monotonicTime: sequence,
    source: 'native-hook',
    confidence: 'authoritative',
    ...options,
    type: agentServiceEventType(event),
    service: agentEventService(event),
    event,
  };
}

function runtime(event: AgentEvent, sequence: number, options: Partial<AgentEventEnvelope> = {}) {
  return translateAgentEventEnvelope({
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    envelope: envelope(event, sequence, options),
  });
}

function semantic(
  batchId: string,
  phase: RuntimeMonitorObservationBatch['phase'],
  updates: MonitorFamilyUpdate[],
  options: {
    epoch?: string;
    sequence?: number;
    observedAt?: string;
    completeness?: RuntimeMonitorObservationBatch['completeness'];
    readiness?: RuntimeMonitorObservationBatch['readiness'];
  } = {},
): RuntimeMonitorObservationBatch {
  return {
    kind: 'semantic',
    schemaVersion: 1,
    batchId,
    producer: { id: 'semantic-1', epoch: options.epoch ?? 'epoch-1', sequence: options.sequence },
    phase,
    observedAt: options.observedAt ?? new Date(Date.parse(T0) + (options.sequence ?? 1) * 1_000).toISOString(),
    quality: 'exact',
    completeness: options.completeness ?? 'complete',
    ...(options.readiness ? { readiness: options.readiness } : {}),
    provisional: false,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    updates,
    sourceWatermarks: [],
    evidence: [{ namespace: 'test', id: batchId }],
  };
}

function workspace(recordId: string, value: Extract<WorkspaceMonitorObservation, { operation: 'upsert' }>['value']) {
  return {
    kind: 'workspace',
    schemaVersion: 1,
    recordId,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    observedAt: '2026-08-16T12:00:02.000Z',
    source: { id: 'workspace-test', kind: 'workspace-observation' },
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    evidence: [],
    operation: 'upsert',
    value,
  } satisfies WorkspaceMonitorObservation;
}

function apply(state: MonitorAccumulatorState, inputs: Parameters<typeof reduceMonitorAccumulator>[1][]) {
  return inputs.reduce((current, input) => reduceMonitorAccumulator(current, input).state, state);
}

describe('monitor accumulator', () => {
  it('keeps provider context percentage instead of recalculating it from counts', () => {
    const state = reduceMonitorAccumulator(
      initial(),
      runtime(
        {
          type: 'context-window.updated',
          usedTokens: 15_000,
          capacityTokens: 200_000,
          usedPercentage: 19.5,
          percentageSource: 'provider',
        },
        1,
      ),
    ).state;
    expect(projectAgentMonitorState(state).context).toMatchObject({
      usedTokens: 15_000,
      capacityTokens: 200_000,
      usedPercent: 19.5,
      percentageSource: 'provider',
    });
  });

  it('preserves journal workflow members across later identity-only telemetry', () => {
    const state = apply(initial(), [
      runtime(
        {
          type: 'workflow.updated',
          workflowId: 'workflow-1',
          active: false,
          members: [{ agentId: 'worker-a', agentType: 'researcher', state: 'completed' }],
        },
        1,
        { source: 'native-transcript' },
      ),
      runtime({ type: 'workflow.updated', workflowId: 'workflow-1', name: 'research', active: true }, 2, {
        source: 'native-telemetry',
      }),
    ]);

    expect(projectAgentMonitorState(state).workflows).toEqual([
      {
        id: 'workflow-1',
        name: 'research',
        active: false,
        actorRunKeys: ['native-1:actor:worker-a'],
        artifactRefs: [],
      },
    ]);
  });

  it('keeps plans and tasks informational while projecting exact activity priority', () => {
    let state = apply(initial(), [
      runtime({ type: 'session.ready' }, 1),
      runtime({ type: 'plan.updated', steps: [{ text: 'Do it', status: 'pending' }] }, 2),
      runtime({ type: 'task.created', taskId: 'task-1' }, 3),
    ]);
    const informational = projectAgentMonitorState(state);
    expect(informational.status).toBe('idle');
    expect(informational.activity).toBeUndefined();

    state = apply(state, [
      runtime({ type: 'turn.started', turnId: 'turn-1' }, 4),
      runtime({ type: 'assistant.message', text: 'partial', final: false }, 5),
      runtime({ type: 'reasoning.started', reasoningId: 'reason-1' }, 6),
      runtime(
        { type: 'tool.started', toolCallId: 'tool-1', presentation: { kind: 'file-edit', title: 'Editing reducer' } },
        7,
      ),
      runtime({ type: 'compaction.started', compactionId: 'compact-1' }, 8),
    ]);
    expect(projectAgentMonitorState(state)).toMatchObject({
      status: 'working',
      activity: { kind: 'compacting', line: 'Compacting context' },
    });
  });

  it('retains concurrent blockers and closes permission and question independently', () => {
    let state = apply(initial(), [
      runtime({ type: 'session.ready' }, 1),
      runtime({ type: 'permission.requested', requestId: 'permission-1', presentation: 'native-tui' }, 2),
      runtime(
        {
          type: 'question.requested',
          requestId: 'question-1',
          questions: [{ prompt: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }],
        },
        3,
      ),
    ]);
    expect(projectAgentMonitorState(state).blockers.map((blocker) => blocker.kind)).toEqual(['question', 'permission']);

    state = apply(state, [runtime({ type: 'permission.resolved', requestId: 'permission-1', outcome: 'allowed' }, 4)]);
    expect(projectAgentMonitorState(state).blockers.map((blocker) => blocker.id)).toEqual(['question-1']);

    state = apply(state, [runtime({ type: 'question.resolved', requestId: 'question-1', outcome: 'answered' }, 5)]);
    expect(projectAgentMonitorState(state)).toMatchObject({ status: 'idle', blockers: [] });
  });

  it('orders failures before questions before permissions, then oldest and lexical id', () => {
    const state = apply(initial(), [
      runtime({ type: 'session.ready' }, 1),
      runtime({ type: 'permission.requested', requestId: 'p', presentation: 'native-tui' }, 2),
      runtime({ type: 'question.requested', requestId: 'q-b', questions: [{ prompt: 'B?' }] }, 4),
      runtime({ type: 'question.requested', requestId: 'q-a', questions: [{ prompt: 'A?' }] }, 3),
      runtime({ type: 'turn.failed', turnId: 'turn', error: 'boom' }, 5),
    ]);
    expect(projectAgentMonitorState(state).blockers.map((blocker) => blocker.id)).toEqual(['turn', 'q-a', 'q-b', 'p']);
  });

  it('applies complete/partial replacement and swaps a new scope epoch without erasing other planes', () => {
    let state = apply(initial(), [
      runtime({ type: 'session.ready' }, 1),
      runtime({ type: 'context-window.updated', usedTokens: 20, capacityTokens: 100 }, 2),
      workspace('workspace-1', { kind: 'environment', cwd: '/repo', worktrees: ['/repo/wt'] }),
      semantic(
        'replace-1',
        'live',
        [
          {
            family: 'planning',
            operation: 'replace',
            coverage: 'complete',
            values: [
              { key: 'task:a', value: { kind: 'task', taskId: 'a', status: 'pending', provisional: false } },
              { key: 'task:b', value: { kind: 'task', taskId: 'b', status: 'pending', provisional: false } },
            ],
          },
        ],
        { sequence: 1 },
      ),
    ]);
    expect(projectAgentMonitorState(state).tasks.map((task) => task.id)).toEqual(['a', 'b']);

    state = apply(state, [
      semantic(
        'replace-2',
        'live',
        [
          {
            family: 'planning',
            operation: 'replace',
            coverage: 'complete',
            values: [
              { key: 'task:b', value: { kind: 'task', taskId: 'b', status: 'in-progress', provisional: false } },
            ],
          },
        ],
        { sequence: 2 },
      ),
      semantic(
        'replace-3',
        'live',
        [
          {
            family: 'planning',
            operation: 'replace',
            coverage: 'partial',
            values: [{ key: 'task:c', value: { kind: 'task', taskId: 'c', status: 'pending', provisional: false } }],
          },
        ],
        { sequence: 3, completeness: 'partial' },
      ),
    ]);
    expect(projectAgentMonitorState(state).tasks.map((task) => task.id)).toEqual(['b', 'c']);

    state = apply(state, [
      semantic(
        'resync-1',
        'resync',
        [
          {
            family: 'planning',
            operation: 'replace',
            coverage: 'complete',
            values: [{ key: 'task:d', value: { kind: 'task', taskId: 'd', status: 'pending', provisional: false } }],
          },
        ],
        { epoch: 'epoch-2', sequence: 1 },
      ),
    ]);
    const projected = projectAgentMonitorState(state);
    expect(projected.tasks.map((task) => task.id)).toEqual(['d']);
    expect(projected.context?.usedPercent).toBe(20);
    expect(projected.environment).toEqual({ cwd: '/repo', worktrees: ['/repo/wt'] });

    const late = reduceMonitorAccumulator(
      state,
      semantic(
        'late-old-epoch',
        'live',
        [
          {
            family: 'planning',
            operation: 'upsert',
            key: 'task:e',
            value: { kind: 'task', taskId: 'e', status: 'pending', provisional: false },
          },
        ],
        { epoch: 'epoch-1', sequence: 4 },
      ),
    );
    expect(late.accepted).toBe(false);
    expect(late.state).toBe(state);
  });

  it('deduplicates stable runtime and semantic identities', () => {
    const runtimeEvent = runtime({ type: 'task.created', taskId: 'task-1' }, 1, { eventId: 'event-1' });
    const first = reduceMonitorAccumulator(initial(), runtimeEvent);
    const duplicate = reduceMonitorAccumulator(first.state, runtimeEvent);
    expect(duplicate).toMatchObject({ accepted: false, notifications: [] });
    expect(duplicate.state).toBe(first.state);

    const batch = semantic('batch-1', 'live', [
      {
        family: 'planning',
        operation: 'upsert',
        key: 'task:2',
        value: { kind: 'task', taskId: '2', status: 'pending', provisional: false },
      },
    ]);
    const semanticFirst = reduceMonitorAccumulator(first.state, batch);
    const semanticDuplicate = reduceMonitorAccumulator(semanticFirst.state, batch);
    expect(semanticDuplicate.accepted).toBe(false);
    expect(semanticDuplicate.state).toBe(semanticFirst.state);
  });

  it('does not restamp historical usage samples repeated by a live replacement', () => {
    const sample = (id: string, cumulativeTokens: number) => ({
      key: id,
      value: { kind: 'usage' as const, usageId: id, boundary: 'sample' as const, canonical: false, cumulativeTokens },
    });
    let state = reduceMonitorAccumulator(
      initial(),
      semantic(
        'usage-1',
        'live',
        [{ family: 'usage', operation: 'replace', coverage: 'complete', values: [sample('sample-1', 0)] }],
        { sequence: 1, observedAt: '2026-08-16T12:00:01.000Z' },
      ),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      semantic(
        'usage-2',
        'live',
        [
          {
            family: 'usage',
            operation: 'replace',
            coverage: 'complete',
            values: [sample('sample-1', 0), sample('sample-2', 100)],
          },
        ],
        { sequence: 2, observedAt: '2026-08-16T12:00:11.000Z' },
      ),
    ).state;

    const projection = projectAgentMonitorState(state, {
      asOf: '2026-08-16T12:00:11.000Z',
      burnRateWindowMs: 60_000,
    });
    expect(projection.usage.samples).toEqual([
      { at: '2026-08-16T12:00:01.000Z', cumulativeTokens: 0 },
      { at: '2026-08-16T12:00:11.000Z', cumulativeTokens: 100 },
    ]);
    expect(projection.usage.burnRatePerMin).toBe(600);
  });

  it('retains producer readiness, capability, coverage, and source watermarks', () => {
    const input = {
      ...semantic('capabilities', 'bootstrap', [], { sequence: 1 }),
      readiness: 'loading' as const,
      capabilities: [
        {
          family: 'usage' as const,
          support: 'degraded' as const,
          actorScope: 'current-actors' as const,
          latency: 'file-flush' as const,
          source: 'semantic-observer',
          limitations: ['bootstrap pending'],
        },
      ],
      coverage: [
        {
          family: 'usage' as const,
          completeness: 'partial' as const,
          asOf: T0,
          reason: 'tailing history',
        },
      ],
      sourceWatermarks: [{ sourceId: 'transcript', sourceEpoch: 'generation-1', cursor: '4096' }],
    };
    const reduced = reduceMonitorAccumulator(initial(), input);
    const producer = reduced.state.semantic.producers.get('semantic-1');
    expect(producer).toMatchObject({ readiness: 'loading' });
    expect(producer?.capabilities.get('usage')?.support).toBe('degraded');
    expect(producer?.coverage.size).toBe(1);
    expect(producer?.watermarks.size).toBe(1);
    expect(projectAgentMonitorState(reduced.state).freshness.families.usage).toEqual({
      support: 'degraded',
      availability: 'loading',
      asOf: T0,
      reason: 'tailing history',
    });
  });

  it('stages a multi-batch resync and swaps the complete producer slice only at the ready barrier', () => {
    const live = semantic(
      'live-before-resync',
      'live',
      [
        {
          family: 'planning',
          operation: 'upsert',
          key: 'old-task',
          value: { kind: 'task', taskId: 'old-task', status: 'pending', provisional: false },
        },
        {
          family: 'model',
          operation: 'upsert',
          key: 'root',
          value: { kind: 'model', providerModelId: 'old-model', intent: 'observed' },
        },
      ],
      { sequence: 1 },
    );
    live.capabilities = [
      {
        family: 'planning',
        support: 'supported',
        actorScope: 'session',
        latency: 'hook',
        source: 'test',
        limitations: [],
      },
    ];
    live.coverage = [{ family: 'planning', completeness: 'complete', asOf: live.observedAt }];
    live.sourceWatermarks = [{ sourceId: 'transcript', sourceEpoch: 'generation-1', cursor: '10' }];
    let state = apply(initial(), [live]);

    state = apply(state, [semantic('recovering', 'resync', [], { sequence: 2, readiness: 'loading' })]);
    expect(projectAgentMonitorState(state)).toMatchObject({
      tasks: [{ id: 'old-task' }],
      model: { id: 'old-model' },
    });

    state = apply(state, [
      semantic(
        'resync-task',
        'resync',
        [
          {
            family: 'planning',
            operation: 'upsert',
            key: 'new-task',
            value: { kind: 'task', taskId: 'new-task', status: 'in-progress', provisional: false },
          },
        ],
        { sequence: 3, readiness: 'loading' },
      ),
      semantic(
        'resync-model',
        'resync',
        [
          {
            family: 'model',
            operation: 'upsert',
            key: 'root',
            value: { kind: 'model', providerModelId: 'new-model', intent: 'observed' },
          },
        ],
        { sequence: 4, readiness: 'loading' },
      ),
    ]);
    expect(projectAgentMonitorState(state)).toMatchObject({
      tasks: [{ id: 'old-task' }],
      model: { id: 'old-model' },
    });

    state = apply(state, [semantic('ready', 'resync', [], { sequence: 5, readiness: 'ready' })]);
    expect(projectAgentMonitorState(state)).toMatchObject({
      tasks: [{ id: 'new-task' }],
      model: { id: 'new-model' },
    });
    expect(state.semantic.resyncs.size).toBe(0);
    const producer = state.semantic.producers.get('semantic-1');
    expect(producer?.capabilities.get('planning')?.support).toBe('supported');
    expect(producer?.coverage.size).toBe(1);
    expect(producer?.watermarks.size).toBe(1);
  });

  it('deduplicates workspace records by stable record ID', () => {
    const input = workspace('workspace-stable', { kind: 'environment', cwd: '/repo/one', worktrees: [] });
    const first = reduceMonitorAccumulator(initial(), input);
    const duplicate = reduceMonitorAccumulator(first.state, input);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.state).toBe(first.state);
  });

  it('retains privacy-safe workspace baseline and finalization provenance in its private plane', () => {
    const input: WorkspaceMonitorObservation = {
      kind: 'workspace',
      schemaVersion: 1,
      recordId: 'workspace-provenance-1',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      observedAt: T0,
      source: { id: 'runtime-workspace', kind: 'workspace-provenance' },
      quality: 'strong',
      completeness: 'partial',
      provisional: false,
      evidence: [],
      operation: 'provenance',
      value: {
        workspaceInstanceId: 'workspace-1',
        allocation: { mode: 'worktree', repositoryKind: 'git' },
        baseline: {
          capturedAt: T0,
          isolation: 'managed-isolated',
          knownConcurrentClaims: 0,
          quality: 'exact',
          completeness: 'complete',
          limitations: [],
          git: {
            state: 'attached',
            headCommit: 'abc123',
            headRef: 'refs/heads/feature',
            index: {
              total: 0,
              added: 0,
              modified: 0,
              deleted: 0,
              renamed: 0,
              copied: 0,
              unmerged: 0,
              untracked: 0,
              other: 0,
            },
            worktree: {
              total: 0,
              added: 0,
              modified: 0,
              deleted: 0,
              renamed: 0,
              copied: 0,
              unmerged: 0,
              untracked: 0,
              other: 0,
            },
            conflicts: 0,
          },
          initialDirtyFileCount: 0,
        },
        finalization: {
          finalizedAt: '2026-08-16T12:01:00.000Z',
          outcome: 'partial',
          repositoryKind: 'git',
          reachableCommits: {
            relation: 'fast-forward',
            initialCommit: 'abc123',
            finalCommit: 'def456',
            commits: ['def456'],
            totalCount: 1,
            truncated: false,
          },
          changes: { filesTouchedCount: 1, insertions: 4, deletions: 1 },
          cleanupOutcome: 'retained-dirty',
          retained: true,
          quality: 'strong',
          completeness: 'partial',
          limitations: ['cleanup incomplete'],
        },
        interference: [{ kind: 'observation-gap', observedAt: '2026-08-16T12:01:00.000Z' }],
        completeness: 'partial',
      },
    };
    const reduced = reduceMonitorAccumulator(initial(), input);
    expect(reduced.state.workspace.provenance.get('workspace-1')).toMatchObject({
      baseline: { isolation: 'managed-isolated', git: { headCommit: 'abc123' } },
      finalization: {
        outcome: 'partial',
        reachableCommits: { commits: ['def456'] },
        cleanupOutcome: 'retained-dirty',
      },
      interference: [{ kind: 'observation-gap' }],
    });
    expect(JSON.stringify(reduced.state.workspace.provenance.get('workspace-1'))).not.toContain('/Users/');
  });

  it('is deterministic under replay and commutes for disjoint unordered semantic facts', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 12 }), (ids) => {
        const inputs = ids.map((id, index) =>
          semantic(
            `batch-${id}`,
            'live',
            [
              {
                family: 'planning',
                operation: 'upsert',
                key: `task:${id}`,
                value: { kind: 'task', taskId: id, status: 'pending', provisional: false },
              },
            ],
            { observedAt: new Date(Date.parse(T0) + index * 1_000).toISOString() },
          ),
        );
        const forward = projectAgentMonitorState(apply(initial(), inputs));
        const reverse = projectAgentMonitorState(apply(initial(), [...inputs].reverse()));
        expect(forward).toEqual(reverse);
        expect(projectAgentMonitorState(apply(initial(), inputs))).toEqual(forward);
      }),
    );
  });

  it('expires pulse activity only through an explicit reducer input', () => {
    let state = apply(initial(), [runtime({ type: 'session.ready' }, 1)]);
    state = apply(state, [
      semantic('pulse', 'live', [
        {
          family: 'status',
          operation: 'upsert',
          key: 'pulse',
          value: { kind: 'activity', activityKind: 'responding', active: true, line: 'Streaming', leaseId: 'lease-1' },
        },
      ]),
    ]);
    expect(projectAgentMonitorState(state).status).toBe('working');
    const expired = reduceMonitorAccumulator(state, {
      kind: 'lease-expired',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      leaseId: 'lease-1',
      expiredAt: '2026-08-16T12:00:10.000Z',
    });
    expect(expired.accepted).toBe(true);
    expect(projectAgentMonitorState(expired.state).status).toBe('idle');
  });

  it('allows a stable activity lease to refresh and expire more than once', () => {
    const pulse = (batchId: string) =>
      semantic(batchId, 'live', [
        {
          family: 'status',
          operation: 'upsert',
          key: 'pulse',
          value: {
            kind: 'activity',
            activityKind: 'delegating',
            active: true,
            leaseId: 'stable-child-lease',
          },
        },
      ]);
    let state = apply(initial(), [runtime({ type: 'session.ready' }, 1), pulse('pulse-1')]);
    state = reduceMonitorAccumulator(state, {
      kind: 'lease-expired',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      leaseId: 'stable-child-lease',
      expiredAt: '2026-08-16T12:00:10.000Z',
    }).state;
    expect(projectAgentMonitorState(state).status).toBe('idle');

    state = apply(state, [pulse('pulse-2')]);
    expect(projectAgentMonitorState(state).status).toBe('working');
    const second = reduceMonitorAccumulator(state, {
      kind: 'lease-expired',
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      leaseId: 'stable-child-lease',
      expiredAt: '2026-08-16T12:00:20.000Z',
    });
    expect(second.accepted).toBe(true);
    expect(projectAgentMonitorState(second.state).status).toBe('idle');
  });
});
