import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/puppeteer-core/monitor-spi';
import { HERMES_MONITOR_CAPABILITIES, HermesMonitorEvidence } from './monitor.js';
import { hermesStructuredQuestions } from './interaction.js';
import type { HermesGatewayFrame } from '../transport/jsonrpc.js';

const SESSION = '20260817_120000_c0ffee';
const T0 = '2026-08-17T12:00:00.000Z';

function evidence(): HermesMonitorEvidence {
  return new HermesMonitorEvidence({ nativeSessionId: () => SESSION, liveSessionId: () => 'live-1', epoch: 'test' });
}

function frame(type: string, payload: Record<string, unknown> = {}): HermesGatewayFrame {
  return { jsonrpc: '2.0', method: 'event', params: { type, session_id: 'live-1', payload } };
}

function project(batches: AdapterMonitorObservationBatch[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run-hermes',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'structured',
    allocatedAt: T0,
    providerId: 'hermes',
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-hermes',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf: '2026-08-17T12:01:00.000Z' });
}

describe('HermesMonitorEvidence', () => {
  it('declares every checklist family without claiming teams or workflows', () => {
    expect(HERMES_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
      [
        'status',
        'usage',
        'context',
        'model',
        'effort',
        'mode',
        'planning',
        'delegation',
        'workflow',
        'compaction',
        'environment',
      ].sort(),
    );
    expect(HERMES_MONITOR_CAPABILITIES.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'degraded',
      actorScope: 'current-actors',
    });
    expect(HERMES_MONITOR_CAPABILITIES.find(({ family }) => family === 'delegation')).toMatchObject({
      support: 'degraded',
    });
    expect(HERMES_MONITOR_CAPABILITIES.find(({ family }) => family === 'workflow')).toMatchObject({
      support: 'unsupported',
    });
    expect(HERMES_MONITOR_CAPABILITIES.find(({ family }) => family === 'mode')?.limitations.join(' ')).toContain(
      'Plan',
    );
  });

  it('projects live model, effort, mode, usage burn, context, and cwd changes', () => {
    const projector = evidence();
    const capabilities = projector.capabilitiesBatch(T0);
    const first = projector.recordBatch(
      frame('session.info', {
        provider: 'openai',
        model: 'model-a',
        reasoning_effort: '',
        approval_mode: 'manual',
        cwd: '/workspace/a',
        running: true,
        usage: {
          input: 80,
          output: 20,
          total: 100,
          calls: 1,
          context_used: 40,
          context_max: 200,
          context_percent: 19.5,
          compressions: 0,
        },
      }),
      T0,
      'bootstrap',
    )!;
    const second = projector.recordBatch(
      frame('session.info', {
        provider: 'anthropic',
        model: 'model-b',
        reasoning_effort: 'high',
        approval_mode: 'off',
        yolo: false,
        cwd: '/workspace/b',
        running: false,
        usage: {
          input: 125,
          output: 35,
          total: 160,
          calls: 2,
          context_used: 60,
          context_max: 200,
          context_percent: 30,
          compressions: 0,
        },
      }),
      '2026-08-17T12:00:30.000Z',
    )!;

    const state = project([capabilities, first, second]);
    expect(state).toMatchObject({
      usage: { cumulativeTokens: 160, burnRatePerMin: 120 },
      context: { usedTokens: 60, capacityTokens: 200, usedPercent: 30, percentageSource: 'provider' },
      model: { id: 'anthropic/model-b' },
      effort: { value: 'high' },
      modes: { providerPermission: { raw: 'off', normalized: 'auto' } },
      environment: { cwd: '/workspace/b' },
    });
    expect(first.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'effort', value: expect.objectContaining({ value: 'provider-default' }) }),
      ]),
    );
    expect(second.updates).toContainEqual({ family: 'status', operation: 'retract', key: 'root-activity' });
  });

  it('detects structured questions, native approvals, and authoritative todo snapshots', () => {
    const projector = evidence();
    const capabilities = projector.capabilitiesBatch(T0);
    const question = projector.recordBatch(
      frame('clarify.request', {
        request_id: 'clarify-1',
        question: 'Which lanes?',
        choices: ['Canary', 'Stable'],
        multi_select: true,
      }),
      T0,
    )!;
    const answered = projector.recordBatch(
      frame('tool.complete', { tool_id: 'clarify-tool-1', name: 'clarify' }),
      '2026-08-17T12:00:00.500Z',
    )!;
    const approval = projector.recordBatch(frame('approval.request', { tool_id: 'call-1', name: 'terminal' }), T0)!;
    const todos = projector.recordBatch(
      frame('tool.complete', {
        tool_id: 'todo-1',
        name: 'todo',
        todos: [
          { id: 'inspect', title: 'Inspect', status: 'done' },
          { id: 'ship', title: 'Ship', status: 'in_progress' },
          { title: 'Unidentified note', status: 'pending' },
        ],
      }),
      '2026-08-17T12:00:01.000Z',
    )!;

    expect(question.updates).toMatchObject([
      {
        family: 'status',
        value: {
          interactionId: 'clarify-1',
          interactionKind: 'mixed',
          state: 'pending',
          questions: [
            {
              prompt: 'Which lanes?',
              options: [{ label: 'Canary' }, { label: 'Stable' }],
              allowMultiple: true,
              allowFreeForm: true,
            },
          ],
        },
      },
    ]);
    expect(approval.updates[0]).toMatchObject({
      family: 'status',
      value: { interactionId: 'call-1', interactionKind: 'permission', state: 'pending' },
    });
    expect(answered.updates).toContainEqual(
      expect.objectContaining({
        family: 'status',
        value: expect.objectContaining({ interactionId: 'clarify-1', state: 'resolved' }),
      }),
    );
    expect(todos.updates).toContainEqual(
      expect.objectContaining({
        family: 'planning',
        operation: 'replace',
        coverage: 'complete',
        values: expect.arrayContaining([
          expect.objectContaining({ key: 'plan:root', value: expect.objectContaining({ kind: 'plan' }) }),
          expect.objectContaining({ key: 'task:inspect', value: expect.objectContaining({ status: 'completed' }) }),
          expect.objectContaining({ key: 'task:ship', value: expect.objectContaining({ status: 'in-progress' }) }),
        ]),
      }),
    );

    const state = project([capabilities, question, answered, approval, todos]);
    expect(state.plan?.steps).toHaveLength(3);
    expect(state.tasks).toMatchObject([
      { id: 'ship', status: 'in-progress' },
      { id: 'inspect', status: 'completed' },
    ]);
  });

  it('tracks stable subagent identity, activity, model, and completion totals separately from root usage', () => {
    const projector = evidence();
    const capabilities = projector.capabilitiesBatch(T0);
    const root = projector.recordBatch(
      frame('session.info', { usage: { input: 90, output: 10, total: 100, calls: 1 } }),
      T0,
      'bootstrap',
    )!;
    const started = projector.recordBatch(
      frame('subagent.start', {
        subagent_id: 'child-1',
        child_session_id: 'child-session-1',
        goal: 'Inspect code',
        model: 'child-model',
      }),
      '2026-08-17T12:00:05.000Z',
    )!;
    const completed = projector.recordBatch(
      frame('subagent.complete', {
        subagent_id: 'child-1',
        input_tokens: 20,
        output_tokens: 5,
        reasoning_tokens: 2,
      }),
      '2026-08-17T12:00:15.000Z',
    )!;

    expect(started.scope?.actorRunKey).toBe(`${SESSION}:actor:child-1`);
    expect(started.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'delegation',
          value: expect.objectContaining({
            state: 'active',
            actor: expect.objectContaining({
              nativeAgentId: 'child-1',
              nativeSessionId: 'child-session-1',
              parentRunKey: `${SESSION}:root`,
            }),
          }),
        }),
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'child-model' }),
        }),
      ]),
    );
    expect(completed.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'delegation', value: expect.objectContaining({ state: 'stopped' }) }),
        expect.objectContaining({ family: 'usage', value: expect.objectContaining({ cumulativeTokens: 27 }) }),
      ]),
    );

    const state = project([capabilities, root, started, completed]);
    expect(state.usage.cumulativeTokens).toBe(100);
    expect(state.subagents).toMatchObject([
      { id: 'child-1', active: false, cumulativeTokens: 27, modelId: 'child-model' },
    ]);
  });

  it('observes compaction lifecycle and degrades only otherwise observable families on rail loss', () => {
    const projector = evidence();
    const capabilities = projector.capabilitiesBatch(T0);
    const started = projector.recordBatch(
      frame('status.update', { kind: 'compacting', text: 'Compacting context' }),
      T0,
    )!;
    const completed = projector.recordBatch(
      frame('message.complete', { text: 'done', status: 'complete' }),
      '2026-08-17T12:00:01.000Z',
    )!;
    expect(project([capabilities, started]).compaction.active).toBe(true);
    expect(project([capabilities, started, completed]).compaction).toMatchObject({
      active: false,
      count: 1,
    });

    const unavailable = projector.railUnavailableBatch(T0, 'test disconnect');
    expect(unavailable).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
    expect(unavailable.capabilities?.find(({ family }) => family === 'usage')).toMatchObject({ support: 'degraded' });
    expect(unavailable.capabilities?.find(({ family }) => family === 'workflow')).toMatchObject({
      support: 'unsupported',
    });
    expect(projector.recordBatch(frame('workflow.started', { id: 'unsupported' }), T0)).toBeNull();
  });
});

describe('hermesStructuredQuestions', () => {
  it('preserves options, multi-select, and the native custom-answer branch', () => {
    expect(
      hermesStructuredQuestions({
        request_id: 'clarify-2',
        question: 'Choose environments',
        choices: ['Development', 'Production'],
        multi_select: true,
      }),
    ).toEqual([
      {
        id: 'clarify-2',
        prompt: 'Choose environments',
        options: [{ label: 'Development' }, { label: 'Production' }],
        allowMultiple: true,
        allowFreeForm: true,
      },
    ]);
  });
});
