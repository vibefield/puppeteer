import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AgentEvent, AgentEventEnvelope } from './events/index.js';
import { createEnvelopeStamper } from './events/index.js';
import { createInitialSessionState, reduceSessionState, type SessionRuntimeState } from './state.js';

function stampAll(events: AgentEvent[]): AgentEventEnvelope[] {
  const stamper = createEnvelopeStamper();
  return events.map((event, i) =>
    stamper.next({
      sessionId: 's-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      monotonicTime: i,
      source: 'native-hook',
      confidence: 'authoritative',
      event,
    }),
  );
}

function replay(envelopes: AgentEventEnvelope[], initial = createInitialSessionState()): SessionRuntimeState {
  return envelopes.reduce(reduceSessionState, initial);
}

const id = fc.constantFrom('a', 'b', 'c', 'd');

const arbitraryEvent: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.constant<AgentEvent>({ type: 'session:started' }),
  fc.constant<AgentEvent>({ type: 'session:ready' }),
  id.map((turnId): AgentEvent => ({ type: 'turn:started', turnId, prompt: `p-${turnId}` })),
  id.map((turnId): AgentEvent => ({ type: 'turn:completed', turnId, lastAssistantMessage: `m-${turnId}` })),
  id.map((turnId): AgentEvent => ({ type: 'turn:failed', turnId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool:requested', toolCallId, tool: 'Bash' })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool:started', toolCallId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool:completed', toolCallId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool:failed', toolCallId })),
  id.map((requestId): AgentEvent => ({
    type: 'interaction:permission-requested',
    requestId,
    presentation: 'native-tui',
  })),
  id.map((requestId): AgentEvent => ({ type: 'interaction:permission-resolved', requestId, outcome: 'allowed' })),
  id.map((subagentId): AgentEvent => ({ type: 'delegation:subagent-started', subagentId })),
  id.map((subagentId): AgentEvent => ({ type: 'delegation:subagent-stopped', subagentId })),
  fc.constant<AgentEvent>({ type: 'conversation:assistant-message', text: 'hello' }),
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 1_000_000 })).map(([usedTokens, capacityTokens]): AgentEvent => ({
    type: 'context-window:updated',
    usedTokens,
    capacityTokens,
  })),
  fc.constant<AgentEvent>({ type: 'context-window:invalidated', reason: 'compacted' }),
  fc.constant<AgentEvent>({ type: 'environment:updated', currentCwd: '/tmp/project' }),
  fc.constant<AgentEvent>({ type: 'model:updated', model: { id: 'model-a', displayName: 'Model A' } }),
  fc.constant<AgentEvent>({ type: 'session:exited', reason: 'other' }),
  fc.constant<AgentEvent>({ type: 'process:exited', reason: 'completed', exitCode: 0 }),
  fc.constant<AgentEvent>({ type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'Mystery' }),
);

const arbitraryEvents = fc.array(arbitraryEvent, { maxLength: 40 });

describe('reduceSessionState properties (DESIGN §26.5)', () => {
  it('replaying the same log produces the same state, without mutating the initial state', () => {
    fc.assert(
      fc.property(arbitraryEvents, (events) => {
        const envelopes = stampAll(events);
        const initial = createInitialSessionState();
        const snapshot = structuredClone(initial);
        const a = replay(envelopes, initial);
        const b = replay(envelopes);
        expect(a).toEqual(b);
        expect(initial).toEqual(snapshot);
      }),
    );
  });

  it('duplicate envelopes do not change the outcome', () => {
    fc.assert(
      fc.property(arbitraryEvents, fc.nat(), (events, pick) => {
        fc.pre(events.length > 0);
        const envelopes = stampAll(events);
        const i = pick % envelopes.length;
        const withDuplicate = [...envelopes.slice(0, i + 1), envelopes[i]!, ...envelopes.slice(i + 1)];
        expect(replay(withDuplicate)).toEqual(replay(envelopes));
      }),
    );
  });

  it('never throws on out-of-order application', () => {
    fc.assert(
      fc.property(arbitraryEvents, fc.array(fc.nat(), { maxLength: 40 }), (events, order) => {
        const envelopes = stampAll(events);
        fc.pre(envelopes.length > 0);
        let state = createInitialSessionState();
        for (const n of order) {
          state = reduceSessionState(state, envelopes[n % envelopes.length]!);
        }
      }),
    );
  });
});

describe('reduceSessionState transitions', () => {
  it('tracks exact context pressure, provenance, and invalidation', () => {
    const [baseUpdated, invalidated] = stampAll([
      {
        type: 'context-window:updated',
        usedTokens: 18_415,
        capacityTokens: 500_000,
        modelId: 'grok-4.5',
      },
      { type: 'context-window:invalidated', reason: 'compacted' },
    ]);
    const updated = { ...baseUpdated!, source: 'native-log' as const };

    const measured = reduceSessionState(createInitialSessionState(), updated);
    expect(measured.contextWindow).toMatchObject({
      usedTokens: 18_415,
      capacityTokens: 500_000,
      modelId: 'grok-4.5',
      updatedAt: '2026-07-12T00:00:00.000Z',
      source: 'native-log',
      confidence: 'authoritative',
    });
    expect(measured.contextWindow?.usedPercent).toBeCloseTo(3.683);
    expect(reduceSessionState(measured, invalidated!).contextWindow).toBeUndefined();
  });

  it('preserves a valid provider-calculated context percentage', () => {
    const [updated] = stampAll([
      {
        type: 'context-window:updated',
        usedTokens: 15_000,
        capacityTokens: 200_000,
        usedPercentage: 19.5,
        percentageSource: 'provider',
      },
    ]);
    expect(reduceSessionState(createInitialSessionState(), updated!).contextWindow).toMatchObject({
      usedTokens: 15_000,
      capacityTokens: 200_000,
      usedPercent: 19.5,
      percentageSource: 'provider',
    });
  });

  it('clamps over-capacity display values and rejects invalid measurements', () => {
    const [over, invalid] = stampAll([
      {
        type: 'context-window:updated',
        usedTokens: 250,
        capacityTokens: 200,
        usedPercentage: 140,
        percentageSource: 'provider',
      },
      { type: 'context-window:updated', usedTokens: 10, capacityTokens: 0 },
    ]);
    const measured = reduceSessionState(createInitialSessionState(), over!);
    expect(measured.contextWindow?.usedPercent).toBe(100);
    expect(measured.contextWindow?.percentageSource).toBe('derived');

    const rejected = reduceSessionState(measured, invalid!);
    expect(rejected.contextWindow).toBe(measured.contextWindow);
    expect(rejected.diagnostics.at(-1)?.code).toBe('context-window-invalid');
  });

  it('merges sparse environment facts, tracks provenance, and clears stale Git on cwd changes', () => {
    const [baseInitial, baseModel, baseMoved, baseResolved] = stampAll([
      {
        type: 'environment:updated',
        currentCwd: '/repo/one',
        git: { root: '/repo/one', branch: 'main', headSha: 'abc', detached: false },
      },
      { type: 'model:updated', model: { id: 'codex-1', displayName: 'Codex 1', provider: 'openai' } },
      { type: 'environment:updated', currentCwd: '/repo/two' },
      { type: 'environment:updated', git: null },
    ]);
    const initial = { ...baseInitial!, source: 'native-protocol' as const };
    const model = { ...baseModel!, source: 'native-protocol' as const };
    const moved = { ...baseMoved!, source: 'native-hook' as const };
    const resolved = { ...baseResolved!, source: 'runtime' as const, confidence: 'derived' as const };

    const first = replay([initial, model]);
    expect(first.environment.currentCwd).toMatchObject({ value: '/repo/one', source: 'native-protocol' });
    expect(first.environment.model?.value).toMatchObject({ id: 'codex-1', displayName: 'Codex 1' });
    expect(first.environment.git?.value).toMatchObject({ branch: 'main' });

    const second = reduceSessionState(first, moved);
    expect(second.environment.currentCwd).toMatchObject({ value: '/repo/two', source: 'native-hook' });
    expect(second.environment.model).toBe(first.environment.model);
    expect(second.environment.git).toBeUndefined();

    const third = reduceSessionState(second, resolved);
    expect(third.environment.git).toMatchObject({ value: null, source: 'runtime', confidence: 'derived' });
  });

  it('preserves complementary model-card fields when sources report the same model id', () => {
    const [catalog, provider] = stampAll([
      { type: 'model:updated', model: { id: 'grok-4.5', displayName: 'Grok 4.5' } },
      { type: 'model:updated', model: { id: 'grok-4.5', provider: 'xai' } },
    ]);
    const state = replay([catalog!, provider!]);
    expect(state.environment.model?.value).toEqual({ id: 'grok-4.5', displayName: 'Grok 4.5', provider: 'xai' });
  });

  it('does not project actor-scoped context or environment into root session state', () => {
    const [root, baseChildModel, baseChildContext] = stampAll([
      { type: 'model:updated', model: { id: 'root-model' } },
      { type: 'model:updated', model: { id: 'child-model' } },
      { type: 'context-window:updated', usedTokens: 50, capacityTokens: 100 },
    ]);
    const childModel = { ...baseChildModel!, actorKey: 'workflow:worker', actorRole: 'child' as const };
    const childContext = { ...baseChildContext!, agentId: 'worker-1' };

    const state = replay([root!, childModel, childContext]);

    expect(state.environment.model?.value.id).toBe('root-model');
    expect(state.contextWindow).toBeUndefined();
  });

  it('keeps actor-local lifecycle and resources out of the root state machine', () => {
    const [
      ready,
      rootTurn,
      rootTool,
      childSessionExit,
      childProcessExit,
      childTurnEnd,
      childMessage,
      childToolEnd,
      child,
    ] = stampAll([
      { type: 'session:ready' },
      { type: 'turn:started', turnId: 'root-turn' },
      { type: 'tool:started', toolCallId: 'root-tool', tool: 'Read' },
      { type: 'session:exited', reason: 'child-finished' },
      { type: 'process:exited', reason: 'crash', exitCode: 1 },
      { type: 'turn:completed', turnId: 'root-turn' },
      { type: 'conversation:assistant-message', text: 'child response', final: true },
      { type: 'tool:completed', toolCallId: 'root-tool' },
      { type: 'delegation:subagent-started', subagentId: 'worker-1', agentType: 'reviewer' },
    ]);
    const actor = { agentId: 'worker-1', agentType: 'reviewer' };
    const state = replay([
      ready!,
      rootTurn!,
      rootTool!,
      { ...childSessionExit!, ...actor },
      { ...childProcessExit!, ...actor },
      { ...childTurnEnd!, ...actor },
      { ...childMessage!, ...actor },
      { ...childToolEnd!, ...actor },
      { ...child!, ...actor },
    ]);

    expect(state).toMatchObject({
      lifecycle: 'running',
      activeTurn: { id: 'root-turn' },
      lastSequence: 9,
    });
    expect(state.lastAssistantMessage).toBeUndefined();
    expect([...state.tools.keys()]).toEqual(['root-tool']);
    expect([...state.subagents.keys()]).toEqual(['worker-1']);
  });

  it('does not mistake configured launch intent for an observed effective model', () => {
    const state = replay(
      stampAll([
        {
          type: 'model:updated',
          intent: 'configured',
          model: { id: 'configured-model' },
        },
        { type: 'mode:updated', intent: 'configured', modeKind: 'provider-permission', mode: { raw: 'plan' } },
      ]),
    );
    expect(state.environment.model).toBeUndefined();
  });

  it('rejects blank environment identities without losing previous facts', () => {
    const [validEnvironment, validModel, invalidEnvironment, invalidModel] = stampAll([
      { type: 'environment:updated', currentCwd: '/repo' },
      { type: 'model:updated', model: { id: 'model-a' } },
      { type: 'environment:updated', currentCwd: ' ' },
      { type: 'model:updated', model: { id: '' } },
    ]);
    const first = replay([validEnvironment!, validModel!]);
    const second = replay([invalidEnvironment!, invalidModel!], first);
    expect(second.environment.currentCwd).toBe(first.environment.currentCwd);
    expect(second.environment.model).toBe(first.environment.model);
    expect(second.diagnostics.slice(-2).map((diagnostic) => diagnostic.code)).toEqual([
      'environment-cwd-invalid',
      'model-id-invalid',
    ]);
  });

  it('completed tools leave the active-tool map', () => {
    const state = replay(
      stampAll([
        { type: 'tool:requested', toolCallId: 't1', tool: 'Read' },
        { type: 'tool:requested', toolCallId: 't2', tool: 'Bash' },
        { type: 'tool:completed', toolCallId: 't1' },
        { type: 'tool:failed', toolCallId: 't2' },
      ]),
    );
    expect(state.tools.size).toBe(0);
    expect(state.counters.toolsCompleted).toBe(1);
    expect(state.counters.toolsFailed).toBe(1);
  });

  it('keeps terminal tool events idempotent across native duplicate and out-of-order delivery', () => {
    const state = replay(
      stampAll([
        { type: 'tool:completed', toolCallId: 'reordered' },
        { type: 'tool:started', toolCallId: 'reordered', tool: 'command' },
        { type: 'tool:completed', toolCallId: 'reordered' },
      ]),
    );

    expect(state.tools.size).toBe(0);
    expect(state.settledTools.get('reordered')).toBe('completed');
    expect(state.counters.toolsCompleted).toBe(1);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['tool-after-terminal']);
  });

  it('tracks explicit reasoning independently and clears it at turn completion', () => {
    const mid = replay(
      stampAll([
        { type: 'turn:started', turnId: 'p1' },
        { type: 'reasoning:started', reasoningId: 'r1' },
        { type: 'tool:started', toolCallId: 't1', tool: 'command' },
      ]),
    );
    expect(mid.activeReasoning).toMatchObject({ reasoningId: 'r1' });
    expect(mid.tools.has('t1')).toBe(true);

    const done = replay(
      stampAll([
        { type: 'turn:started', turnId: 'p1' },
        { type: 'reasoning:started', reasoningId: 'r1' },
        { type: 'turn:completed', turnId: 'p1' },
      ]),
    );
    expect(done.activeReasoning).toBeUndefined();
  });

  it('session exit ends the active turn and clears in-flight tools with diagnostics', () => {
    const state = replay(
      stampAll([
        { type: 'session:started' },
        { type: 'turn:started', turnId: 'p1' },
        { type: 'tool:requested', toolCallId: 't1', tool: 'Bash' },
        { type: 'session:exited', reason: 'other' },
      ]),
    );
    expect(state.lifecycle).toBe('exited');
    expect(state.activeTurn).toBeUndefined();
    expect(state.tools.size).toBe(0);
    expect(state.diagnostics.map((d) => d.code)).toEqual(['turn-orphaned-on-exit', 'tools-orphaned-on-exit']);
  });

  it('allows an explicit native-session rebind to reopen the same live runtime after /clear', () => {
    const state = replay(
      stampAll([
        { type: 'session:started', nativeSessionId: 'native-before' },
        { type: 'session:exited', reason: 'clear' },
        {
          type: 'session:started',
          nativeSessionId: 'native-after',
          startSource: 'clear',
          rebind: true,
        },
      ]),
    );
    expect(state.lifecycle).toBe('ready');
    expect(state.exit).toBeUndefined();
    expect(state.diagnostics.some((diagnostic) => diagnostic.code === 'session-start-after-exit')).toBe(false);
  });

  it('permission events cannot overwrite unrelated tool state', () => {
    const state = replay(
      stampAll([
        { type: 'tool:requested', toolCallId: 'x', tool: 'Bash' },
        { type: 'interaction:permission-requested', requestId: 'x', toolCallId: 'x', presentation: 'native-tui' },
        { type: 'interaction:permission-resolved', requestId: 'x', outcome: 'denied' },
      ]),
    );
    expect(state.tools.get('x')).toMatchObject({ tool: 'Bash', state: 'requested' });
    expect(state.permissions.size).toBe(0);
  });

  it('unknown event types are counted, never thrown', () => {
    const [base] = stampAll([{ type: 'adapter:native-event', adapter: 'test', nativeType: 'bogus' }]);
    const bogus = { ...base, event: { type: 'wat.is-this' } as unknown as AgentEvent } as AgentEventEnvelope;
    const state = replay([bogus]);
    expect(state.counters.unknownEvents).toBe(1);
  });

  it('keeps monitor-only event additions compatible without misclassifying them as unknown native events', () => {
    const state = replay(
      stampAll([
        { type: 'usage:tokens-used', usageId: 'response-1', boundary: 'response', canonical: true, deltaTokens: 20 },
        { type: 'compaction:started', compactionId: 'c1' },
        { type: 'compaction:completed', compactionId: 'c1' },
        { type: 'delegation:teammate-idle', teammateName: 'researcher' },
        { type: 'interaction:question-requested', requestId: 'q1', questions: [{ prompt: 'Proceed?' }] },
        { type: 'interaction:question-resolved', requestId: 'q1', outcome: 'answered' },
      ]),
    );
    expect(state.counters.unknownEvents).toBe(0);
  });

  it('turn lifecycle: started → running, completed → ready with last assistant message', () => {
    const mid = replay(stampAll([{ type: 'session:started' }, { type: 'turn:started', turnId: 'p1' }]));
    expect(mid.lifecycle).toBe('running');
    expect(mid.activeTurn?.id).toBe('p1');
    const done = replay(
      stampAll([
        { type: 'session:started' },
        { type: 'turn:started', turnId: 'p1' },
        { type: 'turn:completed', turnId: 'p1', lastAssistantMessage: 'ok' },
      ]),
    );
    expect(done.lifecycle).toBe('ready');
    expect(done.activeTurn).toBeUndefined();
    expect(done.lastAssistantMessage).toBe('ok');
  });

  it('crash-like process exits mark the session failed', () => {
    const state = replay(
      stampAll([{ type: 'session:started' }, { type: 'process:exited', reason: 'crash', exitCode: 1 }]),
    );
    expect(state.lifecycle).toBe('failed');
    expect(state.exit).toEqual({ exitCode: 1, signal: undefined, reason: 'crash' });
  });

  it('process exit diagnoses and clears every in-flight resource', () => {
    const state = replay(
      stampAll([
        { type: 'session:started' },
        { type: 'turn:started', turnId: 'p1' },
        { type: 'reasoning:started', reasoningId: 'r1' },
        { type: 'tool:started', toolCallId: 'tool-1' },
        { type: 'interaction:permission-requested', requestId: 'permission-1', presentation: 'host-ui' },
        { type: 'delegation:subagent-started', subagentId: 'subagent-1' },
        { type: 'process:exited', reason: 'crash', exitCode: 137 },
      ]),
    );

    expect(state.lifecycle).toBe('failed');
    expect(state.activeTurn).toBeUndefined();
    expect(state.activeReasoning).toBeUndefined();
    expect(state.tools.size).toBe(0);
    expect(state.permissions.size).toBe(0);
    expect(state.subagents.size).toBe(0);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'turn-orphaned-on-exit',
      'reasoning-orphaned-on-exit',
      'tools-orphaned-on-exit',
      'permissions-orphaned-on-exit',
      'subagents-orphaned-on-exit',
    ]);
  });

  it('does not let late events reopen resources after a terminal exit', () => {
    const state = replay(
      stampAll([
        { type: 'session:exited', reason: 'other' },
        { type: 'reasoning:started', reasoningId: 'late-reasoning' },
        { type: 'tool:started', toolCallId: 'late-tool' },
        { type: 'interaction:permission-requested', requestId: 'late-permission', presentation: 'host-ui' },
        { type: 'delegation:subagent-started', subagentId: 'late-subagent' },
      ]),
    );

    expect(state.lifecycle).toBe('exited');
    expect(state.activeReasoning).toBeUndefined();
    expect(state.tools.size).toBe(0);
    expect(state.permissions.size).toBe(0);
    expect(state.subagents.size).toBe(0);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'resource-after-exit',
      'resource-after-exit',
      'resource-after-exit',
      'resource-after-exit',
    ]);
  });

  it('diagnostics are bounded', () => {
    const events: AgentEvent[] = [{ type: 'session:exited', reason: 'other' }];
    for (let i = 0; i < 200; i++) events.push({ type: 'turn:started', turnId: `p${i}` });
    const state = replay(stampAll(events));
    expect(state.diagnostics.length).toBeLessThanOrEqual(50);
  });
});
