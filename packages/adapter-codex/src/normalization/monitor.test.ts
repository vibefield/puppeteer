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
    expect(project(baseline, T0).usage).toMatchObject({ cumulativeTokens: 140 });
    expect(project(baseline, T0).usage.burnRatePerMin).toBeUndefined();
    const result = project(
      [...baseline, sample(THREAD, 160, 30, 'live'), sample(CHILD, 70, 30, 'live')],
      '2026-08-16T12:00:30.000Z',
    );
    expect(result.usage).toMatchObject({
      cumulativeTokens: 230,
      burnRatePerMin: 180,
      rootActor: { cumulativeTokens: 160, burnRatePerMin: 120 },
    });
    expect(result.subagentCount).toBe(1);
    expect(result.subagents).toEqual([{ id: CHILD, working: false, cumulativeTokens: 70, burnRatePerMin: 60 }]);
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
      usage: { cumulativeTokens: 38, burnRatePerMin: 38, burnRateBoundary: 'sample' },
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
