import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch, MonitorFamilyUpdate } from '@vibecook/puppeteer-core/monitor-spi';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/puppeteer-core/monitor-spi';
import { CodexMonitorEvidence } from './monitor.js';
import { CodexNotificationNormalizer } from './pipeline.js';

const THREAD = 'a11a5ed0-838b-4c6d-b976-2f0ffe968c93';
const CHILD = 'a11a5ed0-child-4c6d-b976-2f0ffe968c93';
const T0 = '2026-08-16T12:00:00.000Z';

function family(batch: AdapterMonitorObservationBatch, name: MonitorFamilyUpdate['family']) {
  return batch.updates.filter((update) => update.family === name);
}

function project(batches: AdapterMonitorObservationBatch[], asOf: string) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run-codex',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'structured',
    allocatedAt: T0,
    providerId: 'codex',
  });
  for (const batch of batches) {
    if (!batch) continue;
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-codex',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf });
}

describe('CodexMonitorEvidence', () => {
  it('keeps a model round-trip ambiguous and clears a reverted service tier', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD });
    evidence.bootstrapResponseBatch(
      { thread: { id: THREAD, modelProvider: 'openai' }, model: 'gpt-5.4', serviceTier: 'priority' },
      T0,
      'thread/start',
      {},
      true,
    );
    const settings = (model: string, serviceTier: string | null) =>
      evidence.notificationBatch(
        {
          method: 'thread/settings/updated',
          params: { threadId: THREAD, model, serviceTier },
        },
        T0,
      );
    const sample = (multiple: number) =>
      evidence.notificationBatch(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: THREAD,
            tokenUsage: {
              total: {
                totalTokens: 15 * multiple,
                inputTokens: 10 * multiple,
                cachedInputTokens: 0,
                outputTokens: 5 * multiple,
              },
              last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
            },
          },
        },
        T0,
      )!;
    sample(1);
    settings('gpt-5.4-mini', 'priority');
    settings('gpt-5.4', 'priority');
    expect(family(sample(2), 'usage')).toMatchObject([{ value: { pricing: { gap: 'model-change' } } }]);
    settings('gpt-5.4', null);
    sample(3); // Establish the new interval after the tier transition.
    const priced = family(sample(4), 'usage')[0];
    if (priced?.operation !== 'upsert' || priced.family !== 'usage') throw new Error('missing usage');
    expect(priced.value.pricing).toMatchObject({ modelId: 'gpt-5.4', inputTokens: 10, outputTokens: 5 });
    expect(priced.value.pricing?.serviceTier).toBeUndefined();
  });
  it('prices the first request only for a proven newly created thread and ignores duplicate counters', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD });
    evidence.bootstrapResponseBatch(
      { thread: { id: THREAD, modelProvider: 'openai' }, model: 'gpt-5.4' },
      T0,
      'thread/start',
      {},
      true,
    );
    const notification = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: THREAD,
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 3 },
          last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 3 },
        },
      },
    };
    const first = evidence.notificationBatch(notification, T0)!;
    expect(family(first, 'usage')).toMatchObject([
      {
        value: {
          origin: 'protocol',
          pricing: {
            providerId: 'openai',
            modelId: 'gpt-5.4',
            inputTokens: 6,
            cacheReadTokens: 4,
            outputTokens: 5,
            contextTokens: 10,
          },
        },
      },
    ]);
    expect(evidence.notificationBatch(notification, T0)).toBeNull();
    const resumed = new CodexMonitorEvidence({ nativeSessionId: () => THREAD });
    resumed.bootstrapResponseBatch(
      { thread: { id: THREAD, modelProvider: 'openai' }, model: 'gpt-5.4' },
      T0,
      'thread/resume',
    );
    const resumedUsage = family(resumed.notificationBatch(notification, T0)!, 'usage');
    const keys = (updates: MonitorFamilyUpdate[]) =>
      updates.map((update) => (update.operation === 'upsert' ? update.key : undefined));
    expect(keys(resumedUsage)).not.toEqual(keys(family(first, 'usage')));
    expect(resumedUsage).toMatchObject([{ value: { pricing: { gap: 'baseline' } } }]);
  });
  it('adds independent root and child thread counters once without burning bootstrap history', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const child = evidence.notificationBatch(
      {
        method: 'thread/started',
        params: {
          thread: { id: CHILD, parentThreadId: THREAD, status: { type: 'idle' } },
        },
      },
      T0,
    )!;
    const sample = (threadId: string, totalTokens: number, seconds: number, phase: 'bootstrap' | 'live') =>
      evidence.notificationBatch(
        { method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { totalTokens } } } },
        new Date(Date.parse(T0) + seconds * 1000).toISOString(),
        phase,
      )!;
    const baseline = [child, sample(THREAD, 100, 0, 'bootstrap'), sample(CHILD, 40, 0, 'bootstrap')];
    expect(project(baseline, T0).usage.cumulativeTokens).toBeUndefined();
    expect(project(baseline, T0).usage.burnRatePerMin).toBeUndefined();
    const result = project(
      [...baseline, sample(THREAD, 160, 30, 'live'), sample(CHILD, 70, 30, 'live')],
      '2026-08-16T12:00:30.000Z',
    );
    expect(result.usage).toMatchObject({
      cumulativeTokens: 230,
      rootActor: { cumulativeTokens: 160 },
    });
    expect(result.subagentCount).toBe(1);
    expect(result.subagents).toMatchObject([{ id: CHILD, working: false, cumulativeTokens: 70 }]);
    expect(result.usage.burnRatePerMin).toBeUndefined();
  });

  it('declares every family and keeps schema-only or absent surfaces honest', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const capabilities = evidence.capabilitiesBatch(T0).capabilities ?? [];
    expect(capabilities.map(({ family }) => family).sort()).toEqual(
      ['status', 'usage', 'context', 'model', 'effort', 'mode', 'delegation', 'compaction', 'environment'].sort(),
    );
    expect(capabilities.find(({ family }) => family === 'usage')).toMatchObject({ support: 'supported' });
  });

  it('uses captured cumulative total for burn and last for context pressure', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const capabilities = evidence.capabilitiesBatch(T0);
    const baseline = evidence.notificationBatch(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: THREAD,
          turnId: 'turn-1',
          tokenUsage: {
            total: { totalTokens: 19, inputTokens: 12, cachedInputTokens: 0, outputTokens: 7 },
            last: { totalTokens: 19, inputTokens: 12, cachedInputTokens: 0, outputTokens: 7 },
            modelContextWindow: 258_400,
          },
        },
      },
      T0,
      'bootstrap',
    )!;
    const live = evidence.notificationBatch(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: THREAD,
          turnId: 'turn-1',
          tokenUsage: {
            total: { totalTokens: 38, inputTokens: 24, cachedInputTokens: 0, outputTokens: 14 },
            last: { totalTokens: 19, inputTokens: 12, cachedInputTokens: 0, outputTokens: 7 },
            modelContextWindow: 258_400,
          },
        },
      },
      '2026-08-16T12:00:30.000Z',
    )!;

    expect(family(live, 'usage')).toMatchObject([
      {
        operation: 'upsert',
        value: { boundary: 'sample', canonical: false, cumulativeTokens: 38 },
      },
    ]);
    expect(family(live, 'context')).toMatchObject([
      {
        operation: 'upsert',
        value: { usedTokens: 19, capacityTokens: 258_400, percentageSource: 'derived' },
      },
    ]);
    expect(project([capabilities, baseline, live], '2026-08-16T12:00:30.000Z')).toMatchObject({
      usage: { cumulativeTokens: 38 },
      context: { usedTokens: 19, capacityTokens: 258_400 },
    });
  });

  it('maps observed settings, reroute, and compaction without closing the run', () => {
    const evidence = new CodexMonitorEvidence({
      nativeSessionId: () => THREAD,
      epoch: 'test-epoch',
      modelDisplayName: (id) => (id === 'gpt-5.6-sol' ? 'GPT-5.6-Codex' : undefined),
    });
    const batches = [
      evidence.capabilitiesBatch(T0),
      evidence.bootstrapResponseBatch(
        {
          thread: { id: THREAD, cwd: '/workspace' },
          cwd: '/workspace',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'high',
          approvalPolicy: 'on-request',
          sandbox: { type: 'workspaceWrite', writableRoots: ['/redacted'] },
        },
        T0,
        'thread-start',
        { model: 'gpt-5.6-sol', approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' },
      )!,
      evidence.notificationBatch(
        {
          method: 'thread/settings/updated',
          params: {
            threadId: THREAD,
            threadSettings: {
              cwd: '/workspace/packages/app',
              model: 'gpt-5.6-sol',
              effort: 'max',
              collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.6-sol' } },
              approvalPolicy: 'never',
              sandboxPolicy: { type: 'readOnly', networkAccess: false },
            },
          },
        },
        '2026-08-16T12:00:01.000Z',
      )!,
      evidence.notificationBatch(
        {
          method: 'model/rerouted',
          params: { threadId: THREAD, turnId: 'turn-1', fromModel: 'gpt-5.6-sol', toModel: 'gpt-5.6-fast' },
        },
        '2026-08-16T12:00:03.000Z',
      )!,
      evidence.notificationBatch(
        {
          method: 'item/started',
          params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'contextCompaction', id: 'compact-1' } },
        },
        '2026-08-16T12:00:04.000Z',
      )!,
      evidence.notificationBatch(
        {
          method: 'item/completed',
          params: { threadId: THREAD, turnId: 'turn-1', item: { type: 'contextCompaction', id: 'compact-1' } },
        },
        '2026-08-16T12:00:05.000Z',
      )!,
    ];

    expect(project(batches, '2026-08-16T12:00:05.000Z')).toMatchObject({
      model: { id: 'gpt-5.6-fast' },
      effort: { value: 'max' },
      modes: {
        providerSession: { raw: 'plan' },
        providerPermission: { raw: 'approval:never; sandbox:readOnly' },
      },
      compaction: { active: false, count: 1, lastAt: '2026-08-16T12:00:05.000Z' },
      environment: { cwd: '/workspace/packages/app' },
    });
    expect(JSON.stringify(batches)).not.toContain('/redacted');
  });

  it('joins collaboration children by thread id and attributes their live metrics', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const capabilities = evidence.capabilitiesBatch(T0);
    const spawned = evidence.notificationBatch(
      {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: 'turn-1',
          item: {
            type: 'collabAgentToolCall',
            id: 'collab-1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: THREAD,
            receiverThreadIds: [CHILD],
            agentsStates: { [CHILD]: { status: 'running', message: 'private child output' } },
            model: 'gpt-5.6-sol',
            reasoningEffort: 'high',
            prompt: 'private child prompt',
          },
        },
      },
      '2026-08-16T12:00:01.000Z',
    )!;
    const childUsage = evidence.notificationBatch(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: CHILD,
          turnId: 'child-turn',
          tokenUsage: {
            total: { totalTokens: 120 },
            last: { totalTokens: 50 },
            modelContextWindow: 200,
          },
        },
      },
      '2026-08-16T12:00:02.000Z',
    )!;
    const correctedChildUsage = evidence.notificationBatch(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: CHILD,
          turnId: 'child-turn',
          tokenUsage: {
            total: { totalTokens: 100 },
            last: { totalTokens: 40 },
            modelContextWindow: 200,
          },
        },
      },
      '2026-08-16T12:00:04.000Z',
    )!;
    const monitor = project([capabilities, spawned, childUsage, correctedChildUsage], '2026-08-16T12:00:04.000Z');

    expect(monitor.subagents).toMatchObject([
      {
        id: CHILD,
        working: true,
        cumulativeTokens: 100,
        burnRatePerMin: 0,
        modelId: 'gpt-5.6-sol',
        effort: 'high',
      },
    ]);
    expect(family(spawned, 'delegation')).toMatchObject([
      {
        value: {
          actor: {
            runKey: `${THREAD}:codex-thread:${CHILD}`,
            parentRunKey: `${THREAD}:root`,
            nativeSessionId: CHILD,
          },
        },
      },
    ]);
    expect(JSON.stringify([spawned, childUsage, correctedChildUsage])).not.toContain('private child');
  });

  it('tracks child activity to idle and stop', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const capabilities = evidence.capabilitiesBatch(T0);
    const spawned = evidence.notificationBatch(
      {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          item: {
            type: 'collabAgentToolCall',
            id: 'collab-1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: THREAD,
            receiverThreadIds: [CHILD],
            agentsStates: { [CHILD]: { status: 'running' } },
          },
        },
      },
      '2026-08-16T12:00:01.000Z',
    )!;

    const childTurn = evidence.notificationBatch(
      { method: 'turn/started', params: { threadId: CHILD, turn: { id: 'child-turn' } } },
      '2026-08-16T12:00:03.000Z',
    )!;
    const childReasoning = evidence.notificationBatch(
      {
        method: 'item/started',
        params: { threadId: CHILD, turnId: 'child-turn', item: { type: 'reasoning', id: 'reasoning-1' } },
      },
      '2026-08-16T12:00:04.000Z',
    )!;
    const running = project([capabilities, spawned, childTurn, childReasoning], '2026-08-16T12:00:04.000Z');
    expect(running).toMatchObject({
      status: 'working',
      activity: { kind: 'delegating', line: 'Subagent: Subagent reasoning' },
    });
    expect(running.subagents).toMatchObject([{ id: CHILD, working: true, activity: 'Subagent reasoning' }]);

    const reasoningDone = evidence.notificationBatch(
      {
        method: 'item/completed',
        params: { threadId: CHILD, turnId: 'child-turn', item: { type: 'reasoning', id: 'reasoning-1' } },
      },
      '2026-08-16T12:00:05.000Z',
    )!;
    const turnDone = evidence.notificationBatch(
      { method: 'turn/completed', params: { threadId: CHILD, turn: { id: 'child-turn', status: 'completed' } } },
      '2026-08-16T12:00:06.000Z',
    )!;

    const closed = evidence.notificationBatch(
      { method: 'thread/closed', params: { threadId: CHILD } },
      '2026-08-16T12:00:08.000Z',
    )!;
    const final = project(
      [capabilities, spawned, childTurn, childReasoning, reasoningDone, turnDone, closed],
      '2026-08-16T12:00:08.000Z',
    );
    expect(final.subagents).toMatchObject([{ id: CHILD, working: false }]);
  });

  it('preserves unknown future strings without turning missing values into zero', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    const capabilities = evidence.capabilitiesBatch(T0);
    const settings = evidence.notificationBatch(
      {
        method: 'thread/settings/updated',
        params: {
          threadId: THREAD,
          threadSettings: {
            effort: 'ultra-plus',
            collaborationMode: { mode: 'future-mode' },
            approvalPolicy: 'ask-every-time',
            sandboxPolicy: { type: 'containerized' },
          },
        },
      },
      T0,
    )!;

    const monitor = project([capabilities, settings], '2026-08-16T12:00:01.000Z');

    expect(monitor.effort?.value).toBe('ultra-plus');
    expect(monitor.modes.providerSession?.raw).toBe('future-mode');
    expect(monitor.modes.providerPermission?.raw).toBe('approval:ask-every-time; sandbox:containerized');
    expect(monitor.usage.cumulativeTokens).toBeUndefined();
    expect(monitor.context).toBeUndefined();
  });

  it.each([[], [{ step: 'Inspect evidence', status: 'inProgress' }]])(
    'retains native plan updates without a monitor projection (%j)',
    (...steps) => {
      const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
      const notification = { method: 'turn/plan/updated', params: { threadId: THREAD, turnId: 'turn-1', plan: steps } };
      expect(evidence.notificationBatch(notification, T0)).toBeNull();
      expect(new CodexNotificationNormalizer().normalize(notification).events).toEqual([
        { type: 'adapter:native-event', adapter: 'codex', nativeType: 'turn/plan/updated' },
      ]);
    },
  );

  it('degrades every observable family on rail loss without inventing lifecycle evidence', () => {
    const evidence = new CodexMonitorEvidence({ nativeSessionId: () => THREAD, epoch: 'test-epoch' });
    evidence.capabilitiesBatch(T0);
    const lost = evidence.railUnavailableBatch('2026-08-16T12:01:00.000Z', 'transport closed');
    expect(lost).toMatchObject({ readiness: 'degraded', completeness: 'unavailable', updates: [] });
    expect(lost.capabilities?.find(({ family }) => family === 'usage')).toMatchObject({ support: 'degraded' });
    expect(lost.coverage?.every(({ completeness }) => completeness === 'unavailable')).toBe(true);
  });
});
