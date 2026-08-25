import { describe, expect, it, vi } from 'vitest';
import type {
  ObserverEvent,
  ObserverFamily,
  RuntimeSemanticValue,
  SemanticObserverEvent,
  SessionObserver,
  SessionObserverStatus,
} from '@vibecook/spaghetti-sdk';
import type { AdapterMonitorObservationBatch, MonitorFamilyUpdate } from '@vibecook/chopsticks-core/monitor-spi';
import type { SemanticObservationAttachRequest, SemanticObservationEvent } from './semantic-provider.js';
import {
  SpaghettiScopedObservationError,
  SpaghettiScopedObservationProvider,
  type SpaghettiScopedObservationDiagnostic,
} from './spaghetti-scoped.js';

const SESSION = '01234567-89ab-cdef-0123-456789abcdef';
const SESSION_KEY = 'v1:session';
const ROOT_RUN = 'v1:root-run';
const CHILD_RUN = 'v1:child-run';
const START = Date.parse('2026-08-23T20:00:00.000Z');

class FakeSessionObserver implements SessionObserver {
  private readonly events: ObserverEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ObserverEvent>) => void> = [];
  private closed = false;
  private readonly iterator: AsyncIterator<ObserverEvent> = {
    next: () => this.next(),
    return: async () => {
      await this.close();
      return { value: undefined, done: true };
    },
  };

  push(...events: ObserverEvent[]): void {
    for (const event of events) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else this.events.push(event);
    }
  }

  private next(): Promise<IteratorResult<ObserverEvent>> {
    const event = this.events.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<ObserverEvent> {
    return this.iterator;
  }

  status(): SessionObserverStatus {
    return {
      scopeEpoch: 1,
      offeredThroughSequence: 0,
      objectReads: 0,
      queuedSemantic: this.events.length,
      queuedControl: 0,
      retainedBytes: 0,
      epochValid: true,
      closed: this.closed,
    };
  }

  close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    return Promise.resolve();
  }
}

const childActor = {
  session_key: SESSION_KEY,
  native_session_id: SESSION,
  actor_run_key: CHILD_RUN,
  attribution: 'native' as const,
};

const rootActor = {
  session_key: SESSION_KEY,
  native_session_id: SESSION,
  actor_run_key: ROOT_RUN,
  attribution: 'native' as const,
};

function semantic(
  family: ObserverFamily,
  sequence: number,
  factId: string,
  value: RuntimeSemanticValue,
  options: { epoch?: number; phase?: 'bootstrap' | 'live' | 'correction'; actor?: typeof childActor } = {},
): SemanticObserverEvent {
  return {
    type: family,
    event_id: `event-${options.epoch ?? 1}-${sequence}`,
    sequence,
    scope_epoch: options.epoch ?? 1,
    family,
    phase: options.phase ?? 'bootstrap',
    operation: 'upsert',
    semantic_revision_ref: {
      semantic_reference_contract_version: 1,
      fact_revision_id: `v1:revision-${options.epoch ?? 1}-${sequence}`,
    },
    fact_id: factId,
    actor: options.actor ?? childActor,
    source: {
      stream_id: 'session-transcripts',
      object_path: `${SESSION}.jsonl`,
      root_name: 'projects',
      generation: 1,
      byte_start: sequence * 10,
      byte_end: sequence * 10 + 9,
      record_digest: `digest-${sequence}`,
    },
    native_time: START + sequence,
    observed_at: START + sequence,
    value,
  } as SemanticObserverEvent;
}

const allFamilies: ObserverFamily[] = [
  'message',
  'content_block',
  'tool',
  'user_input_request',
  'plan',
  'task',
  'native_marker',
  'effective_state',
  'actor_run',
  'actor_affiliation',
  'usage_v2',
];

function barrier(type: 'bootstrap_complete' | 'resync_complete', epoch: number, sequence: number): ObserverEvent {
  return {
    type,
    event_id: `barrier-${epoch}-${sequence}`,
    sequence,
    scope_epoch: epoch,
    root_present: true,
    family_manifest: allFamilies.map((family) => ({
      family,
      contract_version: 1,
      entity_count: 1,
      digest: `${family}-digest-${epoch}`,
    })),
    coverage: [
      {
        relation_id: 'root',
        stream_id: 'session-transcripts',
        object_path: `${SESSION}.jsonl`,
        root_name: 'projects',
        generation: epoch,
        present: true,
        error: null,
      },
    ],
    observed_at: START + sequence,
  };
}

function qualified(value: string) {
  return {
    value,
    quality: 'exact' as const,
    authority: 'native_response' as const,
    completeness: 'complete' as const,
    unknown_reason: null,
    effective_at: START,
    provenance: { native_field: 'fixture', normalization_contract_version: 1 },
  };
}

function bootstrapEvents(): ObserverEvent[] {
  return [
    semantic('actor_run', 1, 'actor-root', {
      ActorRunRevision: {
        actor_run: ROOT_RUN,
        session: SESSION_KEY,
        role: 'root',
        parent_actor_run: null,
        native_session_id: SESSION,
        native_actor_id: null,
        native_actor_type: null,
      },
    }),
    semantic('actor_run', 2, 'actor-child', {
      ActorRunRevision: {
        actor_run: CHILD_RUN,
        session: SESSION_KEY,
        role: 'child',
        parent_actor_run: ROOT_RUN,
        native_session_id: SESSION,
        native_actor_id: 'agent-1',
        native_actor_type: 'researcher',
      },
    }),
    semantic('user_input_request', 3, 'question-1', {
      UserInputRequestRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        native_tool_use_id: 'toolu-question',
        kind: 'multi_choice',
        questions: [
          {
            header: 'Scope',
            prompt: 'Which areas?',
            options: [
              { label: 'Runtime', description: 'Inspect runtime', preview: null },
              { label: 'UI', description: null, preview: null },
            ],
            multi_select: true,
          },
        ],
        state: 'pending',
        operation: 'upsert',
        completeness: 'complete',
        result_reference: null,
      },
    }),
    semantic('plan', 4, 'plan-1', {
      PlanRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        native_plan_id: 'toolu-plan',
        subject: 'Ship observer',
        ordered_step_keys: ['0:Map families', '1:Verify epochs'],
        completeness: 'complete',
        operation: 'upsert',
        owned_set: null,
      },
    }),
    semantic('task', 5, 'task-1', {
      TaskRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        native_task_id: 'task-1',
        subject: 'Map usage',
        state: 'updated',
        completeness: 'complete',
        operation: 'upsert',
        owned_set: ['task-1'],
      },
    }),
    semantic('native_marker', 6, 'compact-1', {
      NativeRuntimeMarkerRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        native_marker_id: 'compact-1',
        correlated_native_id: null,
        value: { kind: 'compaction', phase: 'started', trigger: 'auto', pre_tokens: 100 },
        quality: 'exact',
        effective_at: START,
        provenance: { native_field: 'compact', normalization_contract_version: 1 },
        completeness: 'complete',
        operation: 'upsert',
      },
    }),
    semantic('effective_state', 7, 'state-model', {
      EffectiveStateRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        dimension: 'model',
        value: qualified('claude-sonnet-4-6'),
        evidence_kind: 'response_observed',
        completeness: 'complete',
        operation: 'upsert',
      },
    }),
    semantic('effective_state', 8, 'state-effort', {
      EffectiveStateRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        dimension: 'effort',
        value: qualified('high'),
        evidence_kind: 'response_observed',
        completeness: 'complete',
        operation: 'upsert',
      },
    }),
    semantic('effective_state', 9, 'state-permission', {
      EffectiveStateRevision: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        dimension: 'permission_mode',
        value: qualified('acceptEdits'),
        evidence_kind: 'native_transition',
        completeness: 'complete',
        operation: 'upsert',
      },
    }),
    semantic('usage_v2', 10, 'usage-1', {
      UsageRevisionV2: {
        session: SESSION_KEY,
        actor_run: CHILD_RUN,
        response_key: 'response-1',
        response_identity: 'native_message_id',
        native_message_id: 'message-1',
        request_id: 'request-1',
        buckets: {
          input_tokens: { ...qualified('ignored'), value: 100 },
          output_tokens: { ...qualified('ignored'), value: 25 },
          cache_creation_input_tokens: { ...qualified('ignored'), value: 10 },
          cache_read_input_tokens: { ...qualified('ignored'), value: 50 },
        },
        model: null,
        effort: null,
        source_time: { value: '2026-08-23T20:00:00.000Z', quality: 'NativeExact' },
      },
    }),
    semantic('actor_affiliation', 11, 'team-membership', {
      ActorAffiliationRevision: {
        affiliation: 'v1:team-affiliation',
        actor_run: CHILD_RUN,
        session: SESSION_KEY,
        dimension: 'team',
        target: 'v1:team',
        member: 'v1:member',
        native_target_id: 'adapter-team',
        native_member_id: 'researcher-1',
        state: 'present',
        effective_at: null,
      },
    }),
    semantic('actor_affiliation', 12, 'workflow-membership', {
      ActorAffiliationRevision: {
        affiliation: 'v1:workflow-affiliation',
        actor_run: CHILD_RUN,
        session: SESSION_KEY,
        dimension: 'workflow',
        target: 'v1:workflow',
        member: null,
        native_target_id: 'review-workflow',
        native_member_id: null,
        state: 'present',
        effective_at: null,
      },
    }),
    barrier('bootstrap_complete', 1, 13),
  ];
}

function conversationEvents(phase: 'bootstrap' | 'live' = 'bootstrap'): ObserverEvent[] {
  return [
    semantic(
      'actor_run',
      1,
      'actor-root',
      {
        ActorRunRevision: {
          actor_run: ROOT_RUN,
          session: SESSION_KEY,
          role: 'root',
          parent_actor_run: null,
          native_session_id: SESSION,
          native_actor_id: null,
          native_actor_type: null,
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'message',
      2,
      'message-compact-summary',
      {
        MessageRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          native_message_id: 'compact-summary-1',
          role: 'user',
          ordered_content_block_keys: ['o:0'],
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'content_block',
      3,
      'block-compact-summary',
      {
        ContentBlockRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          message: 'message-compact-summary',
          native_content_block_id: null,
          ordinal: 0,
          content: {
            kind: 'text',
            text: 'This session is being continued from a previous conversation that ran out of context.',
          },
          native_tool_call_or_result_id: null,
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'message',
      4,
      'message-user',
      {
        MessageRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          native_message_id: 'prompt-1',
          role: 'user',
          ordered_content_block_keys: ['o:0'],
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'content_block',
      5,
      'block-user',
      {
        ContentBlockRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          message: 'message-user',
          native_content_block_id: null,
          ordinal: 0,
          content: { kind: 'text', text: 'Inspect the runtime.' },
          native_tool_call_or_result_id: null,
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'message',
      6,
      'message-assistant',
      {
        MessageRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          native_message_id: 'assistant-1',
          role: 'assistant',
          ordered_content_block_keys: ['o:0'],
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
    semantic(
      'content_block',
      7,
      'block-assistant',
      {
        ContentBlockRevision: {
          session: SESSION_KEY,
          actor_run: ROOT_RUN,
          message: 'message-assistant',
          native_content_block_id: null,
          ordinal: 0,
          content: { kind: 'text', text: 'Typed observer answer.' },
          native_tool_call_or_result_id: null,
          completeness: 'complete',
          operation: 'upsert',
        },
      },
      { phase, actor: rootActor },
    ),
  ];
}

function replacement(batch: AdapterMonitorObservationBatch, family: MonitorFamilyUpdate['family']) {
  return batch.updates.find((update) => update.family === family && update.operation === 'replace');
}

const attachRequest: SemanticObservationAttachRequest = {
  nativeSessionId: SESSION,
  transcriptPath: `/fixture/.claude/projects/-fixture/${SESSION}.jsonl`,
  bootstrap: false,
};

describe('SpaghettiScopedObservationProvider', () => {
  it('maps checklist families into one complete bootstrap replacement', async () => {
    const observer = new FakeSessionObserver();
    observer.push(...bootstrapEvents());
    const diagnostics: SpaghettiScopedObservationDiagnostic[] = [];
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => observer,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const handle = await provider.attach(attachRequest);
    const batches: AdapterMonitorObservationBatch[] = [];
    const semanticEvents = vi.fn();
    handle.onBatch((batch) => batches.push(batch));
    handle.onEvent(semanticEvents);

    await handle.poll();

    expect(batches).toHaveLength(1);
    const bootstrap = batches[0]!;
    expect(bootstrap.phase).toBe('bootstrap');
    expect(bootstrap.readiness).toBe('ready');
    expect(bootstrap.completeness).toBe('complete');
    expect(bootstrap.capabilities).toHaveLength(11);
    expect(semanticEvents).not.toHaveBeenCalled();

    const status = replacement(bootstrap, 'status');
    expect(status?.operation).toBe('replace');
    if (status?.operation !== 'replace') throw new Error('missing status replacement');
    expect(status.values.map(({ value }) => value.kind)).toContain('interaction');
    const question = status.values.find(({ value }) => value.kind === 'interaction')?.value;
    expect(question).toMatchObject({
      kind: 'interaction',
      interactionId: 'toolu-question',
      interactionKind: 'multi-choice',
      state: 'pending',
    });
    const usage = replacement(bootstrap, 'usage');
    if (usage?.operation !== 'replace') throw new Error('missing usage replacement');
    expect(usage.values[0]?.value).toMatchObject({
      kind: 'usage',
      boundary: 'response',
      canonical: true,
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 10,
      cacheReadTokens: 50,
      actor: { nativeAgentId: 'agent-1', nativeAgentType: 'researcher' },
    });

    const planning = replacement(bootstrap, 'planning');
    if (planning?.operation !== 'replace') throw new Error('missing planning replacement');
    expect(planning.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.objectContaining({ kind: 'plan', planId: 'toolu-plan' }) }),
        expect.objectContaining({ value: expect.objectContaining({ kind: 'task', taskId: 'task-1' }) }),
      ]),
    );
    expect(replacement(bootstrap, 'model')).toMatchObject({
      operation: 'replace',
      values: [expect.objectContaining({ value: expect.objectContaining({ providerModelId: 'claude-sonnet-4-6' }) })],
    });
    expect(replacement(bootstrap, 'effort')).toMatchObject({
      operation: 'replace',
      values: [expect.objectContaining({ value: expect.objectContaining({ value: 'high' }) })],
    });
    expect(replacement(bootstrap, 'mode')).toMatchObject({
      operation: 'replace',
      values: [expect.objectContaining({ value: expect.objectContaining({ raw: 'acceptEdits' }) })],
    });
    expect(replacement(bootstrap, 'delegation')).toMatchObject({
      operation: 'replace',
      values: expect.arrayContaining([
        expect.objectContaining({ value: expect.objectContaining({ kind: 'actor' }) }),
        expect.objectContaining({
          value: expect.objectContaining({
            kind: 'team',
            teamId: 'v1:team',
            nativeTeamId: 'adapter-team',
          }),
        }),
        expect.objectContaining({
          value: expect.objectContaining({
            kind: 'team-member',
            membershipId: 'researcher-1',
            teamId: 'v1:team',
            nativeTeamId: 'adapter-team',
            nativeMemberId: 'researcher-1',
            membershipState: 'present',
            state: 'unknown',
          }),
        }),
      ]),
    });
    expect(replacement(bootstrap, 'workflow')).toMatchObject({
      operation: 'replace',
      values: [
        expect.objectContaining({ value: expect.objectContaining({ active: true, actorRunKeys: [CHILD_RUN] }) }),
      ],
    });
    expect(replacement(bootstrap, 'compaction')).toMatchObject({
      operation: 'replace',
      values: [expect.objectContaining({ value: expect.objectContaining({ active: true }) })],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'barrier', phase: 'bootstrap', scopeEpoch: 1 }));
    const barrierDiagnostic = diagnostics.find((diagnostic) => diagnostic.kind === 'barrier');
    expect(barrierDiagnostic).toMatchObject({ actorRunCount: 2, actorRunDigest: expect.any(String) });
    expect(JSON.stringify(barrierDiagnostic)).not.toContain(ROOT_RUN);
    expect(JSON.stringify(barrierDiagnostic)).not.toContain(CHILD_RUN);

    await handle.dispose();
  });

  it('reconstructs resume conversation history from typed message and content-block facts', async () => {
    const observer = new FakeSessionObserver();
    observer.push(...conversationEvents(), barrier('bootstrap_complete', 1, 8));
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => observer,
    });
    const handle = await provider.attach({ ...attachRequest, bootstrap: true });
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));

    await handle.poll();

    expect(events.map(({ event }) => event)).toEqual([
      { type: 'turn.started', turnId: 'prompt-1', prompt: 'Inspect the runtime.' },
      {
        type: 'assistant.message',
        messageId: 'assistant-1',
        turnId: 'prompt-1',
        text: 'Typed observer answer.',
        final: true,
        displayOnly: false,
      },
      {
        type: 'turn.completed',
        turnId: 'prompt-1',
        lastAssistantMessage: 'Typed observer answer.',
      },
    ]);
    expect(events.every(({ replay }) => replay)).toBe(true);

    await handle.dispose();
  });

  it('emits a live assistant only after every ordered content block is present', async () => {
    const observer = new FakeSessionObserver();
    observer.push(
      semantic(
        'actor_run',
        1,
        'actor-root',
        {
          ActorRunRevision: {
            actor_run: ROOT_RUN,
            session: SESSION_KEY,
            role: 'root',
            parent_actor_run: null,
            native_session_id: SESSION,
            native_actor_id: null,
            native_actor_type: null,
          },
        },
        { actor: rootActor },
      ),
      barrier('bootstrap_complete', 1, 2),
    );
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => observer,
    });
    const handle = await provider.attach(attachRequest);
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await handle.poll();

    observer.push(
      semantic(
        'message',
        3,
        'message-live',
        {
          MessageRevision: {
            session: SESSION_KEY,
            actor_run: ROOT_RUN,
            native_message_id: 'assistant-live',
            role: 'assistant',
            ordered_content_block_keys: ['o:0', 'o:1'],
            completeness: 'complete',
            operation: 'upsert',
          },
        },
        { phase: 'live', actor: rootActor },
      ),
      semantic(
        'content_block',
        4,
        'block-live-1',
        {
          ContentBlockRevision: {
            session: SESSION_KEY,
            actor_run: ROOT_RUN,
            message: 'message-live',
            native_content_block_id: null,
            ordinal: 0,
            content: { kind: 'text', text: 'Typed ' },
            native_tool_call_or_result_id: null,
            completeness: 'complete',
            operation: 'upsert',
          },
        },
        { phase: 'live', actor: rootActor },
      ),
    );
    await vi.waitFor(() => expect(events).toHaveLength(0));

    observer.push(
      semantic(
        'content_block',
        5,
        'block-live-2',
        {
          ContentBlockRevision: {
            session: SESSION_KEY,
            actor_run: ROOT_RUN,
            message: 'message-live',
            native_content_block_id: null,
            ordinal: 1,
            content: { kind: 'text', text: 'answer.' },
            native_tool_call_or_result_id: null,
            completeness: 'complete',
            operation: 'upsert',
          },
        },
        { phase: 'live', actor: rootActor },
      ),
    );
    await vi.waitFor(() =>
      expect(events.map(({ event }) => event)).toEqual([
        {
          type: 'assistant.message',
          messageId: 'assistant-live',
          text: 'Typed answer.',
          final: true,
          displayOnly: false,
        },
      ]),
    );

    await handle.dispose();
  });

  it('publishes a later attachment as an atomic resync epoch', async () => {
    const observers = [new FakeSessionObserver(), new FakeSessionObserver()];
    observers[0]!.push(barrier('bootstrap_complete', 1, 1));
    observers[1]!.push(barrier('bootstrap_complete', 1, 1));
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => {
        const observer = observers.shift();
        if (!observer) throw new Error('unexpected attachment');
        return observer;
      },
    });

    const first = await provider.attach(attachRequest);
    const firstBatches: AdapterMonitorObservationBatch[] = [];
    first.onBatch((batch) => firstBatches.push(batch));
    await first.poll();
    await first.dispose();

    const second = await provider.attach(attachRequest);
    const secondBatches: AdapterMonitorObservationBatch[] = [];
    second.onBatch((batch) => secondBatches.push(batch));
    await second.poll();

    expect(firstBatches[0]?.phase).toBe('bootstrap');
    expect(secondBatches[0]?.phase).toBe('resync');
    expect(secondBatches[0]?.producer.epoch).not.toBe(firstBatches[0]?.producer.epoch);
    await second.dispose();
  });

  it('classifies attachment failures without copying source details into the public message', async () => {
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => {
        throw new Error('private source detail: /fixture/.claude/projects/secret.jsonl');
      },
    });

    const failure = await provider.attach(attachRequest).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpaghettiScopedObservationError);
    expect(failure).toMatchObject({
      name: 'SpaghettiScopedObservationError',
      code: 'attach-failed',
      message: 'The Spaghetti scoped observer rejected the Claude session scope',
    });
    expect((failure as Error).message).not.toContain('/fixture');
  });

  it('reduces distinct compaction markers to the latest lifecycle state', async () => {
    const observer = new FakeSessionObserver();
    observer.push(
      semantic('native_marker', 1, 'compact-start', {
        NativeRuntimeMarkerRevision: {
          session: SESSION_KEY,
          actor_run: CHILD_RUN,
          native_marker_id: 'compact-start',
          correlated_native_id: null,
          value: { kind: 'compaction', phase: 'started', trigger: 'auto', pre_tokens: 100 },
          quality: 'exact',
          effective_at: START,
          provenance: { native_field: 'compact', normalization_contract_version: 1 },
          completeness: 'complete',
          operation: 'upsert',
        },
      }),
      semantic('native_marker', 2, 'compact-complete', {
        NativeRuntimeMarkerRevision: {
          session: SESSION_KEY,
          actor_run: CHILD_RUN,
          native_marker_id: 'compact-complete',
          correlated_native_id: 'compact-start',
          value: { kind: 'compaction', phase: 'completed', trigger: 'auto', pre_tokens: null },
          quality: 'exact',
          effective_at: START + 1,
          provenance: { native_field: 'compact', normalization_contract_version: 1 },
          completeness: 'complete',
          operation: 'upsert',
        },
      }),
      barrier('bootstrap_complete', 1, 3),
    );
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => observer,
    });
    const handle = await provider.attach(attachRequest);
    const batches: AdapterMonitorObservationBatch[] = [];
    handle.onBatch((batch) => batches.push(batch));

    await handle.poll();

    expect(replacement(batches[0]!, 'compaction')).toMatchObject({
      operation: 'replace',
      values: [expect.objectContaining({ value: expect.objectContaining({ active: false, outcome: 'completed' }) })],
    });
    await handle.dispose();
  });

  it('stages a replacement epoch atomically and ignores a late old-epoch event', async () => {
    const observer = new FakeSessionObserver();
    observer.push(
      semantic('task', 1, 'task-a', {
        TaskRevision: {
          session: SESSION_KEY,
          actor_run: CHILD_RUN,
          native_task_id: 'task-a',
          subject: 'Old task',
          state: 'created',
          completeness: 'complete',
          operation: 'upsert',
          owned_set: ['task-a'],
        },
      }),
      barrier('bootstrap_complete', 1, 2),
    );
    const provider = new SpaghettiScopedObservationProvider({
      agentRoot: '/fixture/.claude',
      observerFactory: () => observer,
    });
    const handle = await provider.attach(attachRequest);
    const batches: AdapterMonitorObservationBatch[] = [];
    handle.onBatch((batch) => batches.push(batch));
    await handle.poll();

    observer.push(
      {
        type: 'overflow',
        event_id: 'overflow-1',
        sequence: 3,
        scope_epoch: 1,
        reason: 'queue_full',
        last_contiguous_sequence: 2,
        observed_at: START + 3,
      },
      semantic(
        'task',
        4,
        'task-b',
        {
          TaskRevision: {
            session: SESSION_KEY,
            actor_run: CHILD_RUN,
            native_task_id: 'task-b',
            subject: 'Replacement task',
            state: 'completed',
            completeness: 'complete',
            operation: 'upsert',
            owned_set: ['task-b'],
          },
        },
        { epoch: 2, phase: 'correction' },
      ),
      semantic(
        'task',
        5,
        'task-late',
        {
          TaskRevision: {
            session: SESSION_KEY,
            actor_run: CHILD_RUN,
            native_task_id: 'task-late',
            subject: 'Must not leak',
            state: 'created',
            completeness: 'complete',
            operation: 'upsert',
            owned_set: ['task-late'],
          },
        },
        { epoch: 1, phase: 'live' },
      ),
      barrier('resync_complete', 2, 6),
    );
    await vi.waitFor(() => expect(batches.some((batch) => batch.phase === 'resync')).toBe(true));

    const resync = batches.find((batch) => batch.phase === 'resync')!;
    const planning = replacement(resync, 'planning');
    if (planning?.operation !== 'replace') throw new Error('missing planning replacement');
    expect(planning.values).toHaveLength(1);
    expect(planning.values[0]?.value).toMatchObject({ kind: 'task', taskId: 'task-b', status: 'completed' });
    expect(JSON.stringify(resync)).not.toContain('task-a');
    expect(JSON.stringify(resync)).not.toContain('task-late');
    expect(resync.producer.epoch).not.toBe(batches[0]?.producer.epoch);
    expect(batches.find((batch) => batch.readiness === 'degraded')?.completeness).toBe('unavailable');

    await handle.dispose();
  });
});
