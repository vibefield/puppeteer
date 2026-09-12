import { describe, expect, it } from 'vitest';
import { agentEventType, type AdapterEventCandidate, type AgentEvent } from '@vibecook/puppeteer-core';
import { GROK_MONITOR_CAPABILITIES, GrokMonitorEvidence } from './monitor.js';
import type { GrokObservedEvent } from './types.js';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/puppeteer-core/monitor-spi';

const SESSION = 'grok-session';
const AT = '2026-08-08T00:00:00.000Z';

function evidence(): GrokMonitorEvidence {
  return new GrokMonitorEvidence({ nativeSessionId: () => SESSION, epoch: 'test' });
}

function record(update: Record<string, unknown>, promptId?: string): unknown {
  return {
    timestamp: Date.parse(AT),
    method: '_x.ai/session/update',
    params: {
      sessionId: SESSION,
      update,
      ...(promptId ? { _meta: { promptId, agentTimestampMs: Date.parse(AT) } } : {}),
    },
  };
}

function observed(event: AgentEvent, nativeEvent: unknown, promptId?: string): GrokObservedEvent {
  return { event, nativeEvent, promptId, timestamp: AT, phase: 'bootstrap' };
}

function candidate(update: Record<string, unknown>, event?: AgentEvent): AdapterEventCandidate {
  const normalized = event ?? {
    type: 'adapter:native-event',
    adapter: 'grok',
    nativeType: String(update.sessionUpdate),
  };
  return {
    type: agentEventType(normalized),
    sessionId: SESSION,
    nativeSessionId: SESSION,
    timestamp: AT,
    monotonicTime: 0,
    source: 'native-protocol',
    confidence: 'authoritative',
    event: normalized,
    nativeEvent: { method: '_x.ai/session_notification', params: { sessionId: SESSION, update } },
  } as AdapterEventCandidate;
}

describe('GrokMonitorEvidence', () => {
  it('publishes live response burn and reconciles the final turn without double counting', () => {
    const projector = evidence();
    let state = createMonitorAccumulatorState({
      runtimeRunId: 'run',
      runtimeEpoch: 1,
      providerId: 'grok',
      executionMode: 'native-tui',
      observationLevel: 'native-log',
      allocatedAt: AT,
    });
    const apply = (batch: ReturnType<GrokMonitorEvidence['controlCandidateBatch']>) => {
      if (batch)
        state = reduceMonitorAccumulator(state, {
          ...batch,
          kind: 'semantic',
          runtimeRunId: 'run',
          runtimeEpoch: 1,
        }).state;
    };
    apply(
      projector.observedBatch(
        {
          ...observed(
            { type: 'turn:started', turnId: 'prompt-1' },
            record({ sessionUpdate: 'user_message_chunk' }),
            'prompt-1',
          ),
          phase: 'live',
        },
        AT,
      ),
    );
    const response = candidate({
      sessionUpdate: 'response_completed',
      signature: 'response-1',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    response.timestamp = '2026-08-08T00:00:01.000Z';
    apply(projector.controlCandidateBatch(response));
    apply(projector.controlCandidateBatch(response));
    expect(projectAgentMonitorState(state, { asOf: response.timestamp }).usage).toMatchObject({
      cumulativeTokens: 150,
      inputTokens: 120,
      outputTokens: 30,
      burnRatePerMin: 150,
    });
    apply(
      projector.controlCandidateBatch({
        ...candidate({
          sessionUpdate: 'response_completed',
          signature: 'response-2',
          usage: { inputTokens: 200, outputTokens: 50 },
        }),
        timestamp: '2026-08-08T00:00:02.000Z',
      }),
    );
    const completed = candidate({
      sessionUpdate: 'turn_completed',
      prompt_id: 'prompt-1',
      usage: { totalTokens: 500, inputTokens: 400, outputTokens: 100 },
    });
    completed.timestamp = '2026-08-08T00:00:03.000Z';
    apply(projector.controlCandidateBatch(completed));
    apply(projector.controlCandidateBatch(completed));
    apply(projector.controlCandidateBatch(response));
    expect(projectAgentMonitorState(state, { asOf: completed.timestamp }).usage).toMatchObject({
      cumulativeTokens: 500,
      inputTokens: 400,
      outputTokens: 100,
      burnRatePerMin: 500,
      samples: expect.arrayContaining([expect.objectContaining({ cumulativeTokens: 150 })]),
    });
  });

  it('declares every checklist family without claiming unverified workflow parity', () => {
    expect(GROK_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
      [
        'status',
        'usage',
        'context',
        'model',
        'effort',
        'mode',
        'delegation',
        'workflow',
        'compaction',
        'environment',
      ].sort(),
    );
    expect(GROK_MONITOR_CAPABILITIES.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'supported',
      actorScope: 'root',
    });
    expect(GROK_MONITOR_CAPABILITIES.find(({ family }) => family === 'workflow')).toMatchObject({
      support: 'unsupported',
    });
    expect(GROK_MONITOR_CAPABILITIES.find(({ family }) => family === 'delegation')).toMatchObject({
      support: 'degraded',
    });
  });

  it('includes cached input once and keeps reasoning within native response output', () => {
    const batch = evidence().controlCandidateBatch(
      candidate({
        sessionUpdate: 'response_completed',
        prompt_id: 'prompt-1',
        signature: 'private-signature',
        usage: {
          input_tokens: 3_123,
          output_tokens: 4_591,
          cache_read_input_tokens: 167_168,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 4_588,
        },
      }),
    );
    expect(batch?.updates).toEqual([
      expect.objectContaining({
        family: 'usage',
        value: expect.objectContaining({ inputTokens: 170_291, outputTokens: 4_591, deltaTokens: 174_882 }),
      }),
    ]);
    expect(JSON.stringify(batch)).not.toContain('private-signature');
  });

  it('keeps replayed response usage out of live burn', () => {
    const projector = evidence();
    const batch = projector.observedBatch(
      observed(
        { type: 'adapter:native-event', adapter: 'grok', nativeType: 'response_completed' },
        record({
          sessionUpdate: 'response_completed',
          signature: 'response-1',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        'prompt-1',
      ),
      AT,
    )!;
    const initial = createMonitorAccumulatorState({
      runtimeRunId: 'run',
      runtimeEpoch: 1,
      providerId: 'grok',
      executionMode: 'native-tui',
      observationLevel: 'native-log',
      allocatedAt: AT,
    });
    const { state } = reduceMonitorAccumulator(initial, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run',
      runtimeEpoch: 1,
    });
    const usage = projectAgentMonitorState(state, { asOf: AT }).usage;
    expect(usage.cumulativeTokens).toBe(15);
    expect(usage.burnRatePerMin).toBeUndefined();
  });

  it('does not publish incomplete or uncorrelated response usage', () => {
    const projector = evidence();
    for (const update of [
      { signature: 'no-prompt', usage: { inputTokens: 100 } },
      { prompt_id: 'p', usage: { inputTokens: 100 } },
      { prompt_id: 'p', signature: 'incomplete', usage: { inputTokens: 100, usage_is_incomplete: true } },
    ]) {
      expect(projector.controlCandidateBatch(candidate({ sessionUpdate: 'response_completed', ...update }))).toBeNull();
    }
  });

  it('replaces streamed usage when a corrected durable total is smaller', () => {
    const projector = evidence();
    const response = projector.controlCandidateBatch(
      candidate({
        sessionUpdate: 'response_completed',
        prompt_id: 'p',
        signature: 'r',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    )!;
    const completed = candidate({
      sessionUpdate: 'turn_completed',
      prompt_id: 'p',
      usage: { inputTokens: 80, outputTokens: 20 },
    });
    const responseUpdate = response.updates[0];
    if (responseUpdate?.operation !== 'upsert') throw new Error('expected a response usage contribution');
    expect(projector.controlCandidateBatch(completed)?.updates).toEqual([
      { family: 'usage', operation: 'retract', key: responseUpdate.key },
      expect.objectContaining({
        family: 'usage',
        value: expect.objectContaining({ deltaTokens: 100, inputTokens: 80, outputTokens: 20 }),
      }),
    ]);
    expect(projector.controlCandidateBatch(completed)?.updates).toHaveLength(1);
  });

  it('maps captured turn usage as canonical burn while keeping signals as context only', () => {
    const projector = evidence();
    const usage = projector.observedBatch(
      observed(
        { type: 'turn:completed', turnId: 'prompt-1', stopReason: 'end_turn' },
        record(
          {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-1',
            usage: { inputTokens: 12, outputTokens: 1 },
          },
          'prompt-1',
        ),
        'prompt-1',
      ),
      AT,
    );
    expect(usage).toMatchObject({
      phase: 'bootstrap',
      updates: [
        {
          family: 'usage',
          operation: 'upsert',
          key: `grok-turn:${SESSION}:prompt-1`,
          value: {
            boundary: 'response',
            canonical: true,
            deltaTokens: 13,
            inputTokens: 12,
            outputTokens: 1,
          },
        },
      ],
    });

    const context = projector.observedBatch(
      observed(
        { type: 'context-window:updated', usedTokens: 13, capacityTokens: 131_072, modelId: 'grok-4.5' },
        {
          contextTokensUsed: 13,
          contextWindowTokens: 131_072,
          primaryModelId: 'grok-4.5',
          compactionCount: 0,
        },
      ),
      AT,
    );
    expect(context?.updates.some(({ family }) => family === 'context')).toBe(true);
    expect(context?.updates.some(({ family }) => family === 'model')).toBe(true);
    expect(context?.updates.some(({ family }) => family === 'usage')).toBe(false);
  });

  it('maps configured intent and ACP mode, model, and effort while leaving plans native', () => {
    const projector = evidence();
    expect(
      projector.configuredBatch(
        { cwd: '/workspace', model: 'grok-code', permissionMode: 'plan', sandbox: 'workspace-write' },
        AT,
      ),
    ).toMatchObject({
      phase: 'bootstrap',
      updates: expect.arrayContaining([
        expect.objectContaining({ family: 'environment', value: expect.objectContaining({ cwd: '/workspace' }) }),
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'grok-code', intent: 'configured' }),
        }),
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({
            raw: 'permission:plan; sandbox:workspace-write',
            intent: 'configured',
          }),
        }),
      ]),
    });

    const plan = projector.controlCandidateBatch(
      candidate({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect evidence', priority: 'high', status: 'in_progress' },
          { content: 'Implement', priority: 'medium', status: 'pending' },
        ],
      }),
    );
    expect(plan).toBeNull();
    expect(projector.controlCandidateBatch(candidate({ sessionUpdate: 'plan', entries: [] }))).toBeNull();

    expect(
      projector.controlCandidateBatch(candidate({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' })),
    ).toMatchObject({
      updates: [{ family: 'mode', value: { raw: 'ask', intent: 'observed' } }],
    });
    expect(
      projector.controlCandidateBatch(
        candidate({ sessionUpdate: 'model_changed', model_id: 'grok-4.5', reasoning_effort: 'high' }),
      ),
    ).toMatchObject({
      quality: 'unknown',
      provisional: true,
      updates: expect.arrayContaining([
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'grok-4.5', intent: 'observed' }),
        }),
        expect.objectContaining({
          family: 'effort',
          value: expect.objectContaining({ value: 'high', intent: 'observed' }),
        }),
      ]),
    });
  });

  it('tracks source-backed subagent activity and context without inventing child burn', () => {
    const projector = evidence();
    const spawned = projector.observedBatch(
      observed(
        { type: 'delegation:subagent-started', subagentId: 'child-1', agentType: 'explore' },
        record({
          sessionUpdate: 'subagent_spawned',
          subagent_id: 'child-1',
          child_session_id: 'child-1',
          subagent_type: 'explore',
          model: 'grok-mini',
          description: 'private task description',
        }),
      ),
      AT,
    );
    const progress = projector.observedBatch(
      observed(
        { type: 'adapter:native-event', adapter: 'grok', nativeType: 'subagent_progress' },
        record({
          sessionUpdate: 'subagent_progress',
          subagent_id: 'child-1',
          child_session_id: 'child-1',
          tokens_used: 1_234,
          context_window_tokens: 131_072,
          tools_used: ['private-tool-name'],
        }),
      ),
      AT,
    );
    const finished = projector.observedBatch(
      observed(
        { type: 'delegation:subagent-stopped', subagentId: 'child-1' },
        record({
          sessionUpdate: 'subagent_finished',
          subagent_id: 'child-1',
          child_session_id: 'child-1',
          status: 'completed',
          output: 'private child output',
        }),
      ),
      AT,
    );

    const actorRunKeys = [spawned, progress, finished].flatMap(
      (batch) =>
        batch?.updates.flatMap((update) =>
          update.operation === 'upsert' && 'actor' in update.value && update.value.actor
            ? [update.value.actor.runKey]
            : [],
        ) ?? [],
    );
    expect(new Set(actorRunKeys)).toEqual(new Set([`${SESSION}:actor:child-1`]));
    expect(progress?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'delegation', value: expect.objectContaining({ state: 'active' }) }),
        expect.objectContaining({
          family: 'context',
          value: expect.objectContaining({ usedTokens: 1_234, capacityTokens: 131_072 }),
        }),
      ]),
    );
    expect(
      [spawned, progress, finished].flatMap((batch) => batch?.updates ?? []).some(({ family }) => family === 'usage'),
    ).toBe(false);
    const serialized = JSON.stringify([spawned, progress, finished]);
    expect(serialized).not.toContain('private task description');
    expect(serialized).not.toContain('private-tool-name');
    expect(serialized).not.toContain('private child output');
  });

  it('maps compaction phases without copying summaries or errors', () => {
    const projector = evidence();
    const started = projector.controlCandidateBatch(
      candidate({
        sessionUpdate: 'auto_compact_started',
        tokens_used: 110_000,
        context_window: 131_072,
        reason: 'context_threshold',
      }),
    );
    const completed = projector.controlCandidateBatch(
      candidate({
        sessionUpdate: 'auto_compact_completed',
        tokens_before: 110_000,
        tokens_after: 22_000,
        summary_preview: 'private compacted summary',
      }),
    );
    const failed = projector.controlCandidateBatch(
      candidate({ sessionUpdate: 'auto_compact_failed', error: 'private provider error' }),
    );

    expect(started).toMatchObject({
      quality: 'unknown',
      provisional: true,
      updates: expect.arrayContaining([
        expect.objectContaining({
          family: 'compaction',
          value: expect.objectContaining({ active: true, trigger: 'auto' }),
        }),
        expect.objectContaining({
          family: 'context',
          value: expect.objectContaining({ usedTokens: 110_000, capacityTokens: 131_072 }),
        }),
      ]),
    });
    expect(completed?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'compaction', value: expect.objectContaining({ active: false }) }),
        expect.objectContaining({ family: 'context', value: expect.objectContaining({ usedTokens: 22_000 }) }),
      ]),
    );
    expect(JSON.stringify([started, completed, failed])).not.toContain('private');
  });

  it('detects generic pending questions but keeps workflow and goal updates raw-only', () => {
    const projector = evidence();
    expect(
      projector.controlCandidateBatch(
        candidate({ sessionUpdate: 'pending_interaction', tool_call_id: 'question-1', kind: 'question' }),
      ),
    ).toMatchObject({
      quality: 'unknown',
      provisional: true,
      updates: [
        {
          family: 'status',
          value: { kind: 'interaction', interactionId: 'question-1', interactionKind: 'mixed', state: 'pending' },
        },
      ],
    });
    expect(
      projector.controlCandidateBatch(
        candidate({
          sessionUpdate: 'workflow_updated',
          run_id: 'workflow-1',
          revision: 1,
          objective: 'private objective',
        }),
      ),
    ).toBeNull();
    expect(
      projector.controlCandidateBatch(
        candidate({ sessionUpdate: 'goal_updated', goal_id: 'goal-1', objective: 'private goal' }),
      ),
    ).toBeNull();
  });

  it('degrades control readiness without a lifecycle claim or sensitive reason', () => {
    const batch = evidence().controlUnavailableBatch(AT, true);
    expect(batch).toMatchObject({ readiness: 'degraded', completeness: 'partial', updates: [] });
    expect(batch.coverage).toEqual([expect.objectContaining({ family: 'status', completeness: 'partial' })]);
    expect(batch.capabilities?.find(({ family }) => family === 'status')).toMatchObject({ support: 'degraded' });
    expect(batch.capabilities?.find(({ family }) => family === 'context')).toMatchObject({ support: 'supported' });
  });
});
