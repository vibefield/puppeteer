import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/chopsticks-core/monitor-spi';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { ACP_MONITOR_CAPABILITIES, AcpMonitorEvidence, acpElicitationQuestions } from './monitor-evidence.js';

const SESSION = 'acp-session';
const T0 = '2026-08-17T12:00:00.000Z';

function evidence(): AcpMonitorEvidence {
  return new AcpMonitorEvidence({ nativeSessionId: () => SESSION, epoch: 'test' });
}

function notification(update: SessionNotification['update']): SessionNotification {
  return { sessionId: SESSION, update };
}

function project(batches: AdapterMonitorObservationBatch[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run-acp',
    runtimeEpoch: 1,
    executionMode: 'acp',
    observationLevel: 'structured',
    allocatedAt: T0,
    providerId: 'acp',
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-acp',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf: '2026-08-17T12:00:30.000Z' });
}

describe('AcpMonitorEvidence', () => {
  it('declares all checklist families without treating context occupancy as burn', () => {
    expect(ACP_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
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
    expect(ACP_MONITOR_CAPABILITIES.find(({ family }) => family === 'context')).toMatchObject({
      support: 'supported',
      actorScope: 'root',
    });
    expect(ACP_MONITOR_CAPABILITIES.find(({ family }) => family === 'planning')).toMatchObject({
      support: 'degraded',
    });
    for (const family of ['usage', 'delegation', 'workflow', 'compaction'] as const) {
      expect(ACP_MONITOR_CAPABILITIES.find((capability) => capability.family === family)).toMatchObject({
        support: 'unsupported',
      });
    }
  });

  it('bootstraps cwd, model card, thought level, and provider session mode', () => {
    const projector = evidence();
    const capabilities = projector.capabilitiesBatch(T0);
    const bootstrap = projector.bootstrapBatch(
      {
        cwd: '/workspace',
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'plan', name: 'Plan' },
            { id: 'agent', name: 'Agent' },
          ],
        },
        configOptions: [
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'claude-sonnet-4-6',
            options: [{ value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
          },
          {
            type: 'select',
            id: 'thought',
            name: 'Thinking',
            category: 'thought_level',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
      },
      T0,
    );

    const state = project([capabilities, bootstrap]);
    expect(state.context).toBeUndefined();
    expect(state).toMatchObject({
      model: { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      effort: { value: 'high' },
      modes: { providerSession: { raw: 'plan' } },
      environment: { cwd: '/workspace' },
    });
    expect(bootstrap.phase).toBe('bootstrap');
  });

  it('maps live context, model, effort, and mode changes while leaving usage empty', () => {
    const projector = evidence();
    const batches = [
      projector.capabilitiesBatch(T0),
      projector.sessionUpdateBatch(
        notification({ sessionUpdate: 'usage_update', used: 50_000, size: 200_000 }),
        '2026-08-17T12:00:01.000Z',
      )!,
      projector.sessionUpdateBatch(
        notification({
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'model-b',
              options: [{ value: 'model-b', name: 'Model B' }],
            },
            {
              type: 'select',
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              currentValue: 'max',
              options: [{ value: 'max', name: 'Maximum' }],
            },
          ],
        }),
        '2026-08-17T12:00:02.000Z',
      )!,
      projector.sessionUpdateBatch(
        notification({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }),
        '2026-08-17T12:00:03.000Z',
      )!,
    ];

    expect(batches[1]!.updates.some(({ family }) => family === 'usage')).toBe(false);
    const state = project(batches);
    expect(state.usage.cumulativeTokens).toBeUndefined();
    expect(state.usage.burnRatePerMin).toBeUndefined();
    expect(state).toMatchObject({
      usage: { samples: [] },
      context: { usedTokens: 50_000, capacityTokens: 200_000, usedPercent: 25, percentageSource: 'derived' },
      model: { id: 'model-b', displayName: 'Model B' },
      effort: { value: 'max' },
      modes: { providerSession: { raw: 'auto' } },
    });
  });

  it('maps complete standard and identified item plans but not file or markdown guesses', () => {
    const projector = evidence();
    const root = projector.sessionUpdateBatch(
      notification({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect', priority: 'high', status: 'completed' },
          { content: 'Implement', priority: 'medium', status: 'in_progress' },
        ],
      }),
      T0,
    );
    const identified = projector.sessionUpdateBatch(
      notification({
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'plan-2',
          entries: [{ content: 'Verify', priority: 'high', status: 'pending' }],
        },
      }),
      T0,
    );
    const removed = projector.sessionUpdateBatch(notification({ sessionUpdate: 'plan_removed', planId: 'plan-2' }), T0);
    const file = projector.sessionUpdateBatch(
      notification({
        sessionUpdate: 'plan_update',
        plan: { type: 'file', planId: 'plan-file', uri: 'file:///plan.md' },
      }),
      T0,
    );

    expect(root?.updates).toMatchObject([
      {
        family: 'planning',
        operation: 'upsert',
        key: 'plan:root',
        value: {
          planId: 'acp:root-plan',
          steps: [
            { text: 'Inspect', status: 'completed' },
            { text: 'Implement', status: 'in_progress' },
          ],
        },
      },
    ]);
    expect(identified?.updates[0]).toMatchObject({
      operation: 'upsert',
      key: 'plan:plan-2',
      value: { planId: 'plan-2', steps: [{ text: 'Verify', status: 'pending' }] },
    });
    expect(removed?.updates).toEqual([{ family: 'planning', operation: 'retract', key: 'plan:plan-2' }]);
    expect(file).toBeNull();
  });

  it('keeps malformed future context values unknown instead of manufacturing zeros', () => {
    const projector = evidence();
    const malformed = projector.sessionUpdateBatch(
      notification({ sessionUpdate: 'usage_update', used: Number.NaN, size: 0 }),
      T0,
    );
    expect(malformed).toBeNull();
  });

  it('degrades supported rails without changing unsupported claims', () => {
    const batch = evidence().railUnavailableBatch(T0);
    expect(batch).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
    expect(batch.capabilities?.find(({ family }) => family === 'context')).toMatchObject({ support: 'degraded' });
    expect(batch.capabilities?.find(({ family }) => family === 'usage')).toMatchObject({ support: 'unsupported' });
  });
});

describe('acpElicitationQuestions', () => {
  it('preserves single-choice, multi-choice, and free-form fields from the form schema', () => {
    const questions = acpElicitationQuestions({
      mode: 'form',
      sessionId: SESSION,
      message: 'Choose deployment settings',
      requestedSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            title: 'Region',
            description: 'Where should it run?',
            oneOf: [
              { const: 'us', title: 'United States', description: 'Lower latency in the US' },
              { const: 'eu', title: 'Europe' },
            ],
          },
          services: {
            type: 'array',
            title: 'Services',
            items: { type: 'string', enum: ['api', 'worker'] },
          },
          note: { type: 'string', title: 'Note' },
        },
      },
    });

    expect(questions).toEqual([
      {
        id: 'region',
        header: 'Region',
        prompt: 'Choose deployment settings — Where should it run?',
        options: [{ label: 'United States', description: 'Lower latency in the US' }, { label: 'Europe' }],
        allowMultiple: false,
        allowFreeForm: false,
      },
      {
        id: 'services',
        header: 'Services',
        prompt: 'Choose deployment settings — Services',
        options: [{ label: 'api' }, { label: 'worker' }],
        allowMultiple: true,
        allowFreeForm: false,
      },
      {
        id: 'note',
        header: 'Note',
        prompt: 'Choose deployment settings — Note',
        allowMultiple: false,
        allowFreeForm: true,
      },
    ]);
  });

  it('detects URL elicitation as user input without inventing choice options', () => {
    expect(
      acpElicitationQuestions({
        mode: 'url',
        sessionId: SESSION,
        elicitationId: 'auth-1',
        message: 'Complete authentication',
        url: 'https://example.invalid/auth',
      }),
    ).toEqual([{ prompt: 'Complete authentication', allowMultiple: false, allowFreeForm: false }]);
  });

  it('does not guess an input style for an unknown future field type', () => {
    expect(
      acpElicitationQuestions({
        mode: 'form',
        sessionId: SESSION,
        message: 'Supply the provider value',
        requestedSchema: {
          properties: { value: { type: '_provider_picker', hint: 'opaque' } },
        },
      }),
    ).toEqual([
      {
        id: 'value',
        prompt: 'Supply the provider value',
        allowMultiple: false,
        allowFreeForm: false,
      },
    ]);
  });
});
