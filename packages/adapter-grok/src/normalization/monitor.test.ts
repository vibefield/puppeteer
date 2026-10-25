import { describe, expect, it } from 'vitest';
import {
  agentEventType,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventSource,
} from '@vibefield/puppeteer-core';
import { GROK_MONITOR_CAPABILITIES, GrokMonitorEvidence } from './monitor.js';
import type { GrokObservedEvent } from './types.js';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  type AdapterMonitorObservationBatch,
} from '@vibefield/puppeteer-core/monitor-spi';

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

/** A live control candidate as adapter-acp publishes it, carrying the exact ACP frame. */
function frame(
  nativeEvent: { method?: string; params: Record<string, unknown> },
  event: AgentEvent = {
    type: 'adapter:native-event',
    adapter: 'grok',
    nativeType: String(
      (nativeEvent.params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ?? nativeEvent.method,
    ),
  },
  source: AgentEventSource = 'native-protocol',
): AdapterEventCandidate {
  return {
    type: agentEventType(event),
    sessionId: SESSION,
    nativeSessionId: SESSION,
    timestamp: AT,
    monotonicTime: 0,
    source,
    confidence: 'authoritative',
    event,
    // adapter-acp attaches a session/update's bare params, and an extension's { method, params }.
    nativeEvent: nativeEvent.method ? nativeEvent : nativeEvent.params,
  } as AdapterEventCandidate;
}

// Shapes from the 1.0.70 census (packages/surface/vendors/grok/captures/grok@1.0.70/subagent/acp-controller.jsonl).
const RESPONSE_USAGE = {
  input_tokens: 28,
  output_tokens: 7,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 2,
};
const queueChanged = (sessionId: string, runningPromptId?: string) =>
  frame({
    method: '_x.ai/queue/changed',
    params: {
      sessionId,
      entries: [],
      ...(runningPromptId ? { runningPromptId, runningText: '<redacted>', runningKind: 'prompt' } : {}),
    },
  });
const responseCompleted = (sessionId: string) =>
  frame({
    method: '_x.ai/session_notification',
    params: { sessionId, update: { sessionUpdate: 'response_completed', usage: RESPONSE_USAGE } },
  });
const turnCompleted = (sessionId: string, promptId: string, usage?: Record<string, unknown>) =>
  frame({
    method: '_x.ai/session_notification',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: promptId,
        stop_reason: 'end_turn',
        ...(usage ? { usage } : {}),
        elapsed_ms: 393,
      },
      _meta: { eventId: `${sessionId}-26`, agentTimestampMs: 1_767_225_600_000 },
    },
  });
const turnUsage = (calls: number, extra: Record<string, unknown> = {}) => ({
  inputTokens: 31 * calls,
  outputTokens: 7 * calls,
  totalTokens: 38 * calls,
  cachedReadTokens: 3 * calls,
  cacheCreationTokens: 0,
  reasoningTokens: 2 * calls,
  modelCalls: calls,
  numTurns: calls,
  ...extra,
});

function monitorOf(batches: readonly (AdapterMonitorObservationBatch | null)[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run',
    runtimeEpoch: 1,
    providerId: 'grok',
    executionMode: 'native-tui',
    observationLevel: 'native-log',
    allocatedAt: AT,
  });
  for (const batch of batches) {
    if (batch)
      state = reduceMonitorAccumulator(state, {
        ...batch,
        kind: 'semantic',
        runtimeRunId: 'run',
        runtimeEpoch: 1,
      }).state;
  }
  return projectAgentMonitorState(state, { asOf: AT });
}

describe('GrokMonitorEvidence', () => {
  it('identifies unsigned live responses by session, running native prompt, and ordinal', () => {
    const projector = evidence();
    const prompt = 'a11a5ed0-7f16-4f54-a38b-b4622654d3f8';
    const batches = [
      projector.controlCandidateBatch(queueChanged(SESSION)),
      projector.controlCandidateBatch(queueChanged(SESSION, prompt)),
      projector.controlCandidateBatch(responseCompleted(SESSION)),
      projector.controlCandidateBatch(responseCompleted(SESSION)),
      projector.controlCandidateBatch(queueChanged(SESSION)),
      projector.controlCandidateBatch(turnCompleted(SESSION, prompt, turnUsage(2))),
    ];
    expect(batches.flatMap((batch) => batch?.updates ?? [])).toEqual([
      expect.objectContaining({
        key: `grok-turn:${SESSION}:${prompt}:response:1`,
        value: expect.objectContaining({ inputTokens: 31, outputTokens: 7, deltaTokens: 38 }),
      }),
      expect.objectContaining({
        key: `grok-turn:${SESSION}:${prompt}:response:2`,
        value: expect.objectContaining({ deltaTokens: 38 }),
      }),
      // The turn total equals its two responses, so reconciliation adds nothing.
      expect.objectContaining({
        key: `grok-turn:${SESSION}:${prompt}`,
        value: expect.objectContaining({ deltaTokens: 0, inputTokens: 0, outputTokens: 0 }),
      }),
    ]);
    // A response after its turn ended belongs to no running prompt and is not counted twice.
    expect(projector.controlCandidateBatch(responseCompleted(SESSION))).toBeNull();
    expect(monitorOf(batches).usage).toMatchObject({ cumulativeTokens: 76, burnRateBoundary: 'response' });
  });

  it('correlates a response through the turn’s session/update _meta.promptId', () => {
    const projector = evidence();
    projector.controlCandidateBatch(
      frame(
        {
          params: {
            sessionId: SESSION,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
            _meta: { promptId: 'anon-a30e14c93db4bc70', eventId: `${SESSION}-32`, chunkId: 2 },
          },
        },
        { type: 'conversation:assistant-message', text: 'x', final: false, displayOnly: false },
        'native-hook',
      ),
    );
    expect(projector.controlCandidateBatch(responseCompleted(SESSION))?.updates).toEqual([
      expect.objectContaining({ key: `grok-turn:${SESSION}:anon-a30e14c93db4bc70:response:1` }),
    ]);
  });

  it('never keys a signed response by the adapter turn id, which its native turn_completed never names', () => {
    const projector = evidence();
    // The 1.0.0 live shape (captures/grok@1.0.0/turn.jsonl): a signed
    // response_completed, no _meta.promptId on the turn's frames, no queue/changed.
    const batches = [
      projector.controlCandidateBatch(
        frame(
          { params: { sessionId: SESSION, update: { sessionUpdate: 'user_message_chunk' } } },
          { type: 'turn:started', turnId: 'acp-turn-1' },
        ),
      ),
      projector.controlCandidateBatch(
        frame({
          method: '_x.ai/session_notification',
          params: {
            sessionId: SESSION,
            update: { sessionUpdate: 'response_completed', signature: 'sig-1', usage: RESPONSE_USAGE },
          },
        }),
      ),
      projector.controlCandidateBatch(turnCompleted(SESSION, 'native-prompt', turnUsage(1))),
    ];
    expect(batches[1]).toBeNull();
    expect(monitorOf(batches).usage.cumulativeTokens).toBe(38);
  });

  it('never takes a running prompt from replayed history or another session', () => {
    const projector = evidence();
    const replayed = queueChanged(SESSION, 'replayed-prompt');
    (replayed.nativeEvent as { params: Record<string, unknown> }).params._meta = { isReplay: true };
    projector.controlCandidateBatch(replayed);
    projector.controlCandidateBatch(queueChanged('unspawned-child', 'child-prompt'));
    expect(projector.controlCandidateBatch(responseCompleted(SESSION))).toBeNull();
  });

  it('keeps the response contributions of a turn whose total is incomplete or absent', () => {
    const projector = evidence();
    const batches = [
      projector.controlCandidateBatch(queueChanged(SESSION, 'p1')),
      projector.controlCandidateBatch(responseCompleted(SESSION)),
      projector.controlCandidateBatch(responseCompleted(SESSION)),
      // The subagent census's root turn: Grok flags the total incomplete.
      projector.controlCandidateBatch(turnCompleted(SESSION, 'p1', turnUsage(2, { usageIsIncomplete: true }))),
      projector.controlCandidateBatch(queueChanged(SESSION, 'p2')),
      projector.controlCandidateBatch(responseCompleted(SESSION)),
      // A mid-turn abort reports no usage at all.
      projector.controlCandidateBatch(turnCompleted(SESSION, 'p2')),
    ];
    expect(batches[3]).toBeNull();
    expect(batches[6]).toBeNull();
    expect(monitorOf(batches).usage.cumulativeTokens).toBe(38 * 3);
  });

  it('attributes a spawned child’s usage and running turn to its subagent actor', () => {
    const projector = evidence();
    const child = 'a11a5ed0-0199-422d-ab3b-5ce364f0476a';
    const runKey = `${SESSION}:actor:${child}`;
    const batches = [
      projector.controlCandidateBatch(
        frame({
          method: '_x.ai/session_notification',
          params: {
            sessionId: SESSION,
            update: {
              sessionUpdate: 'subagent_spawned',
              subagent_id: child,
              attempt_id: 'anon-ea7651f99560907e',
              parent_session_id: SESSION,
              parent_prompt_id: 'root-prompt',
              child_session_id: child,
              subagent_type: 'general-purpose',
              description: '<redacted:description>',
              effective_context_source: 'new',
              model: 'puppeteer-grok-live',
              agentAddress: 'anon-a3bb37eafac9effc',
            },
            _meta: { eventId: `${SESSION}-11`, agentTimestampMs: 1_767_225_600_000 },
          },
        }),
      ),
      projector.controlCandidateBatch(queueChanged(child)),
      projector.controlCandidateBatch(queueChanged(child, 'child-prompt')),
      projector.controlCandidateBatch(queueChanged(child, 'child-prompt')),
      projector.controlCandidateBatch(responseCompleted(child)),
      projector.controlCandidateBatch(queueChanged(child)),
      projector.controlCandidateBatch(turnCompleted(child, 'child-prompt', turnUsage(1))),
    ];
    expect(batches[1]).toBeNull();
    expect(batches[2]?.updates).toEqual([
      {
        family: 'status',
        operation: 'upsert',
        key: `turn:actor:${runKey}`,
        value: expect.objectContaining({
          kind: 'activity',
          active: true,
          actor: expect.objectContaining({ runKey, role: 'child', nativeSessionId: child }),
        }),
      },
    ]);
    expect(batches[3]).toBeNull();
    expect(batches[4]?.updates).toEqual([
      expect.objectContaining({
        key: `grok-turn:${child}:child-prompt:response:1`,
        value: expect.objectContaining({ deltaTokens: 38, actor: expect.objectContaining({ runKey }) }),
      }),
    ]);
    expect(batches[6]?.updates).toEqual([
      expect.objectContaining({
        key: `grok-turn:${child}:child-prompt`,
        value: expect.objectContaining({ deltaTokens: 0, actor: expect.objectContaining({ runKey }) }),
      }),
      { family: 'status', operation: 'retract', key: `turn:actor:${runKey}` },
    ]);
    expect(batches.every((batch) => batch === null || batch.scope?.nativeSessionId === SESSION)).toBe(true);

    const state = monitorOf(batches);
    expect(state.usage.cumulativeTokens).toBe(38);
    expect(state.subagents).toEqual([expect.objectContaining({ id: child, cumulativeTokens: 38 })]);
    // While the child's turn runs it is the subagent's own activity, never the root's.
    const running = monitorOf(batches.slice(0, 3));
    expect(running.subagents).toEqual([expect.objectContaining({ id: child, working: true, activity: 'Working' })]);
  });

  it('projects nothing for a child no spawn announced, nor other child-session evidence', () => {
    const projector = evidence();
    for (const batch of [
      queueChanged('unknown-child', 'p'),
      responseCompleted('unknown-child'),
      turnCompleted('unknown-child', 'p', turnUsage(1)),
    ]) {
      expect(projector.controlCandidateBatch(batch)).toBeNull();
    }
    projector.controlCandidateBatch(
      frame({
        method: '_x.ai/session_notification',
        params: {
          sessionId: SESSION,
          update: { sessionUpdate: 'subagent_spawned', subagent_id: 'child', child_session_id: 'child' },
        },
      }),
    );
    for (const update of [
      { sessionUpdate: 'pending_interaction', tool_call_id: 'call-1', kind: 'permission' },
      { sessionUpdate: 'auto_compact_completed', tokens_before: 10, tokens_after: 2 },
      { sessionUpdate: 'model_changed', model_id: 'other' },
    ]) {
      expect(
        projector.controlCandidateBatch(
          frame({ method: '_x.ai/session_notification', params: { sessionId: 'child', update } }),
        ),
      ).toBeNull();
    }
    expect(
      projector.controlCandidateBatch(
        frame(
          { params: { sessionId: 'child', update: { sessionUpdate: 'usage_update', used: 5, size: 10 } } },
          { type: 'context-window:updated', usedTokens: 5, capacityTokens: 10 },
        ),
      ),
    ).toBeNull();
  });

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
      projector.controlCandidateBatch(
        candidate({ sessionUpdate: 'user_message_chunk' }, { type: 'turn:started', turnId: 'acp-turn-1' }),
      ),
    );
    // The native prompt, not adapter-acp's turn id, is what turn_completed names.
    apply(projector.controlCandidateBatch(queueChanged(SESSION, 'prompt-1')));
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

  it('declares every unified monitor family', () => {
    expect(GROK_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
      ['status', 'usage', 'context', 'model', 'effort', 'mode', 'delegation', 'compaction', 'environment'].sort(),
    );
    expect(GROK_MONITOR_CAPABILITIES.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'degraded',
      actorScope: 'current-actors',
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
    const state = batch
      ? reduceMonitorAccumulator(initial, {
          ...batch,
          kind: 'semantic',
          runtimeRunId: 'run',
          runtimeEpoch: 1,
        }).state
      : initial;
    const usage = projectAgentMonitorState(state, { asOf: AT }).usage;
    expect(usage.cumulativeTokens).toBeUndefined();
    expect(usage.burnRatePerMin).toBeUndefined();
  });

  it('does not publish incomplete or uncorrelated response usage', () => {
    const projector = evidence();
    for (const update of [
      { signature: 'no-prompt', usage: { inputTokens: 100 } },
      // Neither a native id nor a native prompt: nothing to identify it by.
      { usage: { inputTokens: 100 } },
      { prompt_id: 'p', signature: 'incomplete', usage: { inputTokens: 100, usage_is_incomplete: true } },
      { prompt_id: 'p', usage: { inputTokens: 100, usage_is_incomplete: true } },
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

  it('excludes captured journal usage while keeping signals as context only', () => {
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
    expect(usage).toBeNull();

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

  it('tracks source-backed subagent activity without treating context as burn', () => {
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
      ]),
    );
    expect(
      [spawned, progress, finished].flatMap((batch) => batch?.updates ?? []).some(({ family }) => family === 'usage'),
    ).toBe(false);
    expect(progress?.updates.some(({ family }) => family === 'context')).toBe(false);
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
