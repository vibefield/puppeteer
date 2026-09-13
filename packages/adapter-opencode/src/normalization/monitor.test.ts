import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { OpenCodeMessage } from '../transport/client.js';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { OPENCODE_MONITOR_CAPABILITIES, OpenCodeMonitorEvidence, openCodeStructuredQuestions } from './monitor.js';

const T0 = '2026-01-01T00:00:00.000Z';

function fixture(name: string): OpenCodeSseRecord[] {
  const path = fileURLToPath(
    new URL(`../../../surface/vendors/opencode/captures/opencode@1.18.16/${name}/events.jsonl`, import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as OpenCodeSseRecord);
}

function rootSessionID(records: readonly OpenCodeSseRecord[]): string {
  const created = records.find((record) => record.type === 'session.created');
  const info = created?.properties.info as { id?: unknown } | undefined;
  if (typeof info?.id !== 'string') throw new Error('fixture has no root session');
  return info.id;
}

function projector(root: string, capacity?: number): OpenCodeMonitorEvidence {
  return new OpenCodeMonitorEvidence({
    nativeSessionId: () => root,
    ...(capacity === undefined ? {} : { contextWindowCapacityTokens: capacity }),
    epoch: 'test',
  });
}

function batchesForFixture(
  name: string,
  options: { capacity?: number; phase?: 'bootstrap' | 'live' | 'resync'; through?: string } = {},
): { root: string; evidence: OpenCodeMonitorEvidence; batches: AdapterMonitorObservationBatch[] } {
  const records = fixture(name);
  const root = rootSessionID(records);
  const evidence = projector(root, options.capacity);
  const selected = options.through
    ? records.slice(0, records.findIndex((record) => record.type === options.through) + 1)
    : records;
  const batches = selected.flatMap((record, index) => {
    const observedAt = new Date(Date.parse(T0) + index * 1_000).toISOString();
    const batch = evidence.recordBatch(record, observedAt, options.phase ?? 'live');
    return batch ? [batch] : [];
  });
  return { root, evidence, batches };
}

function project(batches: readonly AdapterMonitorObservationBatch[], asOf = '2026-01-01T00:00:59.000Z') {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run-opencode',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'structured',
    allocatedAt: T0,
    providerId: 'opencode',
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-opencode',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf });
}

describe('OpenCodeMonitorEvidence', () => {
  it('declares the complete unified monitor matrix', () => {
    expect(OPENCODE_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
      ['status', 'usage', 'context', 'model', 'effort', 'mode', 'delegation', 'compaction', 'environment'].sort(),
    );
    expect(OPENCODE_MONITOR_CAPABILITIES.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'supported',
      actorScope: 'current-actors',
    });
    for (const family of ['context', 'effort', 'delegation'] as const) {
      expect(OPENCODE_MONITOR_CAPABILITIES.find((capability) => capability.family === family)).toMatchObject({
        support: 'degraded',
      });
    }
  });

  it('maps captured response burn, context pressure, applied model, and provider mode', () => {
    const { batches } = batchesForFixture('turn', { capacity: 100 });
    const completed = batches.find((batch) =>
      batch.updates.some(
        (update) => update.family === 'usage' && update.operation === 'upsert' && update.value.deltaTokens === 18,
      ),
    );
    expect(completed?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'usage',
          operation: 'upsert',
          value: expect.objectContaining({
            boundary: 'response',
            canonical: true,
            deltaTokens: 18,
            inputTokens: 11,
            outputTokens: 7,
          }),
        }),
        expect.objectContaining({
          family: 'context',
          operation: 'upsert',
          value: expect.objectContaining({ usedTokens: 18, capacityTokens: 100, percentageSource: 'derived' }),
        }),
      ]),
    );
    expect(
      batches.some((batch) =>
        batch.updates.some(
          (update) =>
            update.family === 'model' &&
            update.operation === 'upsert' &&
            update.value.providerModelId === 'test/test-model',
        ),
      ),
    ).toBe(true);
    expect(
      batches.some((batch) =>
        batch.updates.some(
          (update) => update.family === 'mode' && update.operation === 'upsert' && update.value.raw === 'build',
        ),
      ),
    ).toBe(true);

    const state = project(batches);
    expect(state.usage).toMatchObject({ cumulativeTokens: 18, burnRateBoundary: 'response' });
    expect(state.context).toMatchObject({ usedTokens: 18, capacityTokens: 100, usedPercent: 18 });
  });

  it('attributes captured child response usage and activity to the stable child session actor', () => {
    const { batches, root } = batchesForFixture('task-child');
    const childUsage = batches
      .flatMap((batch) => batch.updates)
      .find(
        (update) =>
          update.family === 'usage' &&
          update.operation === 'upsert' &&
          update.value.actor?.role === 'child' &&
          (update.value.deltaTokens ?? 0) > 0,
      );
    expect(childUsage).toMatchObject({
      family: 'usage',
      operation: 'upsert',
      value: {
        actor: {
          rootSessionKey: root,
          runKey: `${root}:actor:ses_a11a5ed0a84e8d6d6a9ea922a5`,
          nativeSessionId: 'ses_a11a5ed0a84e8d6d6a9ea922a5',
        },
        canonical: true,
      },
    });
    expect(
      batches.some((batch) =>
        batch.updates.some(
          (update) =>
            update.family === 'delegation' &&
            update.operation === 'upsert' &&
            update.value.kind === 'actor' &&
            update.value.actor.nativeAgentId === 'ses_a11a5ed0a84e8d6d6a9ea922a5' &&
            update.value.state === 'stopped',
        ),
      ),
    ).toBe(true);
  });

  it('detects native option questions with default custom input and resolves them independently of permissions', () => {
    const records = fixture('question-reply');
    const root = rootSessionID(records);
    const evidence = projector(root);
    const batches: AdapterMonitorObservationBatch[] = [];
    for (const [index, record] of records.entries()) {
      const batch = evidence.recordBatch(record, new Date(Date.parse(T0) + index * 1_000).toISOString());
      if (batch) batches.push(batch);
      if (record.type === 'question.asked') break;
    }
    const blocked = project(batches);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockers).toMatchObject([
      {
        kind: 'question',
        questions: [
          {
            header: '<redacted:header>',
            prompt: '<redacted:question>',
            allowMultiple: false,
            allowFreeForm: true,
            options: [
              { label: '<redacted:label>', description: '<redacted:description>' },
              { label: '<redacted:label>', description: '<redacted:description>' },
            ],
          },
        ],
      },
    ]);

    const replied = records.find((record) => record.type === 'question.replied')!;
    const resolved = evidence.recordBatch(replied, '2026-01-01T00:00:59.000Z')!;
    expect(project([...batches, resolved]).blockers).toEqual([]);
    expect(resolved.updates[0]).toMatchObject({
      family: 'status',
      value: { kind: 'interaction', interactionKind: 'mixed', state: 'resolved' },
    });
  });

  it('preserves multi-choice and free-form flags from native question structure', () => {
    expect(
      openCodeStructuredQuestions([
        {
          header: 'Scope',
          question: 'Choose services',
          multiple: true,
          custom: true,
          options: [{ label: 'API', description: 'Backend API' }],
        },
      ]),
    ).toEqual([
      {
        id: '0',
        header: 'Scope',
        prompt: 'Choose services',
        options: [{ label: 'API', description: 'Backend API' }],
        allowMultiple: true,
        allowFreeForm: true,
      },
    ]);

    expect(
      openCodeStructuredQuestions([
        {
          header: 'Scope',
          question: 'Choose exactly one service',
          custom: false,
          options: [{ label: 'API', description: 'Backend API' }],
        },
      ]),
    ).toMatchObject([{ allowMultiple: false, allowFreeForm: false }]);
  });

  it('leaves todo snapshots outside monitor state', () => {
    const evidence = projector('ses_root');
    const batch = evidence.recordBatch(
      {
        id: 'evt_todo',
        type: 'todo.updated',
        properties: {
          sessionID: 'ses_root',
          todos: [
            { content: 'Inspect', status: 'completed', priority: 'high' },
            { content: 'Implement', status: 'in_progress', priority: 'medium' },
          ],
        },
      },
      T0,
    )!;
    expect(batch).toBeNull();
  });

  it('reports raw model variants as degraded effort and observes mid-session changes', () => {
    const evidence = projector('ses_root');
    const capabilities = evidence.capabilitiesBatch(T0);
    const high = evidence.recordBatch(
      {
        id: 'evt_high',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_root',
          info: {
            id: 'msg_high',
            parentID: 'msg_user',
            sessionID: 'ses_root',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5',
            variant: 'high',
            mode: 'build',
            time: { created: Date.parse(T0) },
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      T0,
    )!;
    const max = evidence.recordBatch(
      {
        id: 'evt_max',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_root',
          info: {
            id: 'msg_max',
            parentID: 'msg_user_2',
            sessionID: 'ses_root',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5',
            variant: 'max',
            mode: 'build',
            time: { created: Date.parse(T0) + 1_000 },
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      '2026-01-01T00:00:01.000Z',
    )!;
    expect(project([capabilities, high, max]).effort).toMatchObject({ value: 'max' });
  });

  it('uses stable response identity for corrections and excludes bootstrap replay from burn rate', () => {
    const evidence = projector('ses_root');
    const messages: OpenCodeMessage[] = [
      {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_root',
          role: 'assistant',
          parentID: 'msg_user',
          time: { created: Date.parse(T0), completed: Date.parse(T0) + 1_000 },
          tokens: { total: 12, input: 8, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'stop',
        },
        parts: [],
      },
    ];
    const first = evidence.recordBatch(
      {
        id: 'evt_initial',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_root',
          info: { ...messages[0]!.info, tokens: { total: 10, input: 7, output: 3, cache: { read: 0, write: 0 } } },
        },
      },
      T0,
      'bootstrap',
    )!;
    const corrected = evidence.historySnapshotBatch(messages, '2026-01-01T00:00:02.000Z', 'bootstrap');
    const state = project([first, corrected], '2026-01-01T00:00:03.000Z');
    expect(state.usage.cumulativeTokens).toBe(12);
    expect(state.usage.burnRatePerMin).toBeUndefined();
  });

  it('tracks verified compaction start/completion and clears stale context', () => {
    const { batches } = batchesForFixture('auto-compaction', { capacity: 128 });
    expect(
      batches.some((batch) =>
        batch.updates.some(
          (update) =>
            update.family === 'compaction' &&
            update.operation === 'upsert' &&
            update.value.active &&
            update.value.trigger === 'automatic',
        ),
      ),
    ).toBe(true);
    expect(
      batches.some((batch) =>
        batch.updates.some(
          (update) => update.family === 'compaction' && update.operation === 'upsert' && !update.value.active,
        ),
      ),
    ).toBe(true);
  });

  it('degrades the structured rail without changing unsupported claims', () => {
    const batch = projector('ses_root').railUnavailableBatch(T0, 'test disconnect');
    expect(batch).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
    expect(batch.capabilities?.find(({ family }) => family === 'usage')).toMatchObject({ support: 'degraded' });
  });
});
