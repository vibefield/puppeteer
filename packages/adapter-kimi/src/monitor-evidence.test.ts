import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
} from '@vibecook/puppeteer-core/monitor-spi';
import { KIMI_MONITOR_CAPABILITIES, KimiMonitorEvidence } from './monitor-evidence.js';
import type { KimiObservedRecord } from './session-observer.js';

const SESSION = 'kimi-session';
const AT = '2026-08-17T12:00:00.000Z';

function evidence(): KimiMonitorEvidence {
  return new KimiMonitorEvidence({ nativeSessionId: () => SESSION, epoch: 'test' });
}

function observed(
  record: Record<string, unknown>,
  options: { agentId?: string; replay?: boolean; cursorStart?: number; cursorEnd?: number } = {},
): KimiObservedRecord {
  return {
    agentId: options.agentId ?? 'main',
    record,
    timestamp: AT,
    replay: options.replay ?? false,
    cursorStart: options.cursorStart ?? 100,
    cursorEnd: options.cursorEnd ?? 200,
  };
}

function project(batches: AdapterMonitorObservationBatch[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run-kimi',
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'native-log',
    allocatedAt: AT,
    providerId: 'kimi',
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-kimi',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf: '2026-08-17T12:00:30.000Z' });
}

function capturedBatches(
  projector: KimiMonitorEvidence,
  relativePath: string,
  agentId: string,
): AdapterMonitorObservationBatch[] {
  const path = new URL(`../../surface/vendors/kimi/captures/kimi@0.34.0/${relativePath}`, import.meta.url);
  const raw = readFileSync(path, 'utf8');
  const batches: AdapterMonitorObservationBatch[] = [];
  let cursor = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const cursorStart = cursor;
    cursor += Buffer.byteLength(`${line}\n`);
    const record = JSON.parse(line) as Record<string, unknown>;
    const timestamp = typeof record.time === 'number' ? new Date(record.time).toISOString() : AT;
    const batch = projector.recordBatch(
      { agentId, record, timestamp, replay: false, cursorStart, cursorEnd: cursor },
      AT,
    );
    if (batch) batches.push(batch);
  }
  return batches;
}

describe('KimiMonitorEvidence', () => {
  it('declares the full checklist without claiming context percentage, teams, or workflows', () => {
    expect(KIMI_MONITOR_CAPABILITIES.map(({ family }) => family).sort()).toEqual(
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
    expect(KIMI_MONITOR_CAPABILITIES.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'supported',
      actorScope: 'current-actors',
    });
    expect(KIMI_MONITOR_CAPABILITIES.find(({ family }) => family === 'context')).toMatchObject({
      support: 'degraded',
    });
    expect(KIMI_MONITOR_CAPABILITIES.find(({ family }) => family === 'delegation')).toMatchObject({
      support: 'degraded',
    });
    expect(KIMI_MONITOR_CAPABILITIES.find(({ family }) => family === 'workflow')).toMatchObject({
      support: 'unsupported',
    });
    expect(KIMI_MONITOR_CAPABILITIES.find(({ family }) => family === 'context')?.limitations.join(' ')).toContain(
      'maxTokens',
    );
  });

  it('projects pinned 0.34.0 root and child captures without copying retained payloads', () => {
    const projector = evidence();
    const root = capturedBatches(projector, 'basic-turn/wire.jsonl', 'main');
    const child = capturedBatches(projector, 'subagent-turn/agents/agent-0.jsonl', 'agent-0');
    const rootUpdates = root.flatMap(({ updates }) => updates);
    const childUpdates = child.flatMap(({ updates }) => updates);

    expect(rootUpdates.filter(({ family }) => family === 'usage')).toHaveLength(1);
    expect(rootUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'usage',
          value: expect.objectContaining({ inputTokens: 31, outputTokens: 9, canonical: true }),
        }),
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'puppeteer-kimi-census', intent: 'observed' }),
        }),
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({ raw: 'auto', intent: 'observed' }),
        }),
      ]),
    );
    expect(childUpdates.filter(({ family }) => family === 'usage')).toHaveLength(2);
    expect(childUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'delegation',
          value: expect.objectContaining({
            actor: expect.objectContaining({ nativeAgentId: 'agent-0', nativeAgentType: 'coder' }),
          }),
        }),
        expect.objectContaining({
          family: 'usage',
          value: expect.objectContaining({
            actor: expect.objectContaining({ nativeAgentId: 'agent-0' }),
            inputTokens: 28,
            outputTokens: 6,
          }),
        }),
      ]),
    );
    expect(JSON.stringify([root, child])).not.toContain('<redacted:');
  });

  it('separates configured model/modes from applied model and effort observations', () => {
    const projector = evidence();
    expect(
      projector.configuredBatch(
        { cwd: '/workspace', model: 'configured-alias', permissionMode: 'manual', plan: true },
        AT,
      ),
    ).toMatchObject({
      phase: 'bootstrap',
      updates: expect.arrayContaining([
        expect.objectContaining({ family: 'environment', value: expect.objectContaining({ cwd: '/workspace' }) }),
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'configured-alias', intent: 'configured' }),
        }),
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({ modeKind: 'provider-permission', raw: 'manual', intent: 'configured' }),
        }),
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({ modeKind: 'provider-session', raw: 'plan', intent: 'configured' }),
        }),
      ]),
    });

    expect(
      projector.recordBatch(
        observed({
          type: 'profile.bind',
          modelAlias: 'profile-alias',
          profileName: 'agent',
          thinkingEffort: 'on',
          environmentDisclosure: { cwd: '/native-workspace' },
        }),
        AT,
      ),
    ).toMatchObject({
      updates: expect.arrayContaining([
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'profile-alias', intent: 'configured' }),
        }),
        expect.objectContaining({
          family: 'effort',
          value: expect.objectContaining({ value: 'on', intent: 'configured' }),
        }),
      ]),
    });

    expect(
      projector.recordBatch(
        observed({
          type: 'llm.request',
          provider: 'openai',
          model: 'kimi-k2-applied',
          modelAlias: 'profile-alias',
          thinkingEffort: 'high',
          maxTokens: 32_768,
        }),
        AT,
      ),
    ).toMatchObject({
      updates: expect.arrayContaining([
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'kimi-k2-applied', intent: 'observed' }),
        }),
        expect.objectContaining({
          family: 'effort',
          value: expect.objectContaining({ value: 'high', intent: 'observed' }),
        }),
      ]),
    });
    expect(projector.recordBatch(observed({ type: 'permission.set_mode', mode: 'auto' }), AT)).toMatchObject({
      updates: [
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({ raw: 'auto', intent: 'observed' }),
        }),
      ],
    });
    expect(
      projector.recordBatch(
        observed({ type: 'permission.set_mode', mode: 'future-review-mode' }, { cursorEnd: 300 }),
        AT,
      ),
    ).toMatchObject({
      quality: 'unknown',
      provisional: true,
      updates: [
        expect.objectContaining({
          family: 'mode',
          value: expect.objectContaining({ raw: 'future-review-mode', intent: 'observed' }),
        }),
      ],
    });
  });

  it('maps each root and child usage record as replay-safe canonical burn and input-only context', () => {
    const projector = evidence();
    const root = projector.recordBatch(
      observed(
        {
          type: 'usage.record',
          model: 'alias',
          usageScope: 'turn',
          usage: { inputOther: 40, output: 10, inputCacheRead: 5, inputCacheCreation: 3 },
        },
        { replay: true, cursorStart: 400, cursorEnd: 500 },
      ),
      AT,
    );
    expect(root).toMatchObject({
      phase: 'bootstrap',
      effectiveAt: AT,
      evidence: [{ cursorStart: 400, cursorEnd: 500 }],
      updates: expect.arrayContaining([
        {
          family: 'usage',
          operation: 'upsert',
          key: `kimi-response:${SESSION}:main:500`,
          value: expect.objectContaining({
            usageId: `kimi-response:${SESSION}:main:500`,
            boundary: 'response',
            canonical: true,
            inputTokens: 40,
            outputTokens: 10,
            cacheReadTokens: 5,
            cacheCreationTokens: 3,
          }),
        },
        expect.objectContaining({
          family: 'context',
          value: expect.objectContaining({ usedTokens: 48, percentageSource: 'unavailable' }),
        }),
      ]),
    });
    expect(JSON.stringify(root)).not.toContain('capacityTokens');
    expect(JSON.stringify(root)).not.toContain('usedPercentage');

    const child = projector.recordBatch(
      observed(
        {
          type: 'usage.record',
          model: 'alias',
          usageScope: 'session',
          usage: { inputOther: 20, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
        },
        { agentId: 'agent-0', cursorStart: 800, cursorEnd: 900 },
      ),
      AT,
    );
    expect(child).toMatchObject({
      phase: 'live',
      scope: { actorRunKey: `${SESSION}:actor:agent-0` },
      updates: expect.arrayContaining([
        expect.objectContaining({
          family: 'usage',
          value: expect.objectContaining({
            usageId: `kimi-response:${SESSION}:agent-0:900`,
            actor: expect.objectContaining({ runKey: `${SESSION}:actor:agent-0`, nativeAgentId: 'agent-0' }),
          }),
        }),
        expect.objectContaining({
          family: 'context',
          value: expect.objectContaining({
            actor: expect.objectContaining({ runKey: `${SESSION}:actor:agent-0` }),
            usedTokens: 23,
            percentageSource: 'unavailable',
          }),
        }),
      ]),
    });

    const monitor = project([root!, child!]);
    expect(monitor.usage).toMatchObject({ cumulativeTokens: 85, burnRatePerMin: 27, burnRateBoundary: 'response' });
    expect(monitor.context).toMatchObject({ usedTokens: 48, percentageSource: 'unavailable' });
    expect(monitor.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-0',
          cumulativeTokens: 27,
          burnRatePerMin: 27,
        }),
      ]),
    );
  });

  it('tracks child activity and per-child applied model/effort without inventing a team', () => {
    const projector = evidence();
    const profile = projector.recordBatch(
      observed(
        {
          type: 'profile.bind',
          profileName: 'coder',
          modelAlias: 'child-alias',
          thinkingEffort: 'on',
          environmentDisclosure: { cwd: '/private/cwd' },
        },
        { agentId: 'agent-0' },
      ),
      AT,
    );
    const request = projector.recordBatch(
      observed(
        { type: 'llm.request', model: 'child-applied', thinkingEffort: 'low' },
        { agentId: 'agent-0', cursorEnd: 300 },
      ),
      AT,
    );
    const ended = projector.recordBatch(
      observed({ type: 'turn.ended', turnId: 1, reason: 'completed' }, { agentId: 'agent-0', cursorEnd: 400 }),
      AT,
    );
    projector.recordBatch(
      observed(
        {
          type: 'task.terminated',
          info: { taskId: 'agent-task', kind: 'agent', status: 'completed', agentId: 'agent-0' },
        },
        { cursorEnd: 500 },
      ),
      AT,
    );
    const lateChildReplay = projector.recordBatch(
      observed(
        { type: 'profile.bind', profileName: 'coder', thinkingEffort: 'on' },
        { agentId: 'agent-0', replay: true, cursorEnd: 600 },
      ),
      AT,
    );

    expect(profile?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'delegation',
          value: expect.objectContaining({
            kind: 'actor',
            state: 'active',
            actor: expect.objectContaining({ nativeAgentId: 'agent-0', nativeAgentType: 'coder' }),
          }),
        }),
      ]),
    );
    expect(request?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'model',
          value: expect.objectContaining({ providerModelId: 'child-applied', intent: 'observed' }),
        }),
        expect.objectContaining({
          family: 'effort',
          value: expect.objectContaining({ value: 'low', intent: 'observed' }),
        }),
      ]),
    );
    expect(ended?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'delegation', value: expect.objectContaining({ state: 'idle' }) }),
      ]),
    );
    expect(lateChildReplay?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'delegation', value: expect.objectContaining({ state: 'stopped' }) }),
      ]),
    );
    expect(
      [profile, request, ended].flatMap((batch) => batch?.updates ?? []).some(({ family }) => family === 'workflow'),
    ).toBe(false);
    expect(
      [profile, request, ended]
        .flatMap((batch) => batch?.updates ?? [])
        .some((update) => update.operation === 'upsert' && update.value.kind === 'team'),
    ).toBe(false);
    expect(JSON.stringify([profile, request, ended])).not.toContain('/private/cwd');
  });

  it('projects verified process tasks and source-only plan revisions without private content', () => {
    const projector = evidence();
    const started = projector.recordBatch(
      observed({
        type: 'task.started',
        info: {
          taskId: 'task-1',
          kind: 'process',
          description: 'private command description',
          command: 'private command output',
          status: 'running',
        },
      }),
      AT,
    );
    const terminated = projector.recordBatch(
      observed(
        {
          type: 'task.terminated',
          info: { taskId: 'task-1', kind: 'process', description: 'private', status: 'failed' },
          outputTail: 'private output tail',
        },
        { cursorEnd: 300 },
      ),
      AT,
    );
    const plan = projector.recordBatch(
      observed(
        {
          type: 'plan.revision',
          id: 'plan-1',
          version: 2,
          path: '/private/plan.md',
          sha256: 'safe-content-hash',
          bytes: 123,
        },
        { cursorEnd: 400 },
      ),
      AT,
    );

    expect(started).toMatchObject({
      quality: 'exact',
      provisional: false,
      updates: [
        expect.objectContaining({ family: 'planning', value: expect.objectContaining({ status: 'in-progress' }) }),
      ],
    });
    expect(terminated).toMatchObject({
      quality: 'exact',
      provisional: false,
      updates: [expect.objectContaining({ family: 'planning', value: expect.objectContaining({ status: 'failed' }) })],
    });
    expect(plan).toMatchObject({
      quality: 'unknown',
      completeness: 'partial',
      provisional: true,
      evidence: [{ revisionKey: 'plan-1:2:safe-content-hash' }],
      updates: [
        expect.objectContaining({
          family: 'planning',
          value: expect.objectContaining({ kind: 'plan', planId: 'plan-1', steps: [], provisional: true }),
        }),
      ],
    });
    const serialized = JSON.stringify([started, terminated, plan]);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('output tail');
  });

  it('detects bounded structured choices and resolves them without copying answers', () => {
    const projector = evidence();
    const pending = projector.recordBatch(
      observed({
        type: 'interaction.request',
        id: 'question-1',
        kind: 'question',
        request: {
          questions: [
            {
              id: 'deployment',
              header: 'Deploy',
              question: 'Choose a target',
              body: 'private body that should remain native',
              options: [
                { label: 'Staging', description: 'Safe preview' },
                { label: 'Production', description: 'Live traffic' },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      AT,
    );
    expect(pending).toMatchObject({
      quality: 'unknown',
      provisional: true,
      updates: [
        {
          family: 'status',
          operation: 'upsert',
          key: 'question:question-1',
          value: {
            kind: 'interaction',
            interactionId: 'question-1',
            interactionKind: 'mixed',
            state: 'pending',
            detail: 'Kimi needs input',
            questions: [
              {
                id: 'deployment',
                header: 'Deploy',
                prompt: 'Choose a target',
                options: [
                  { label: 'Staging', description: 'Safe preview' },
                  { label: 'Production', description: 'Live traffic' },
                ],
                allowMultiple: false,
                allowFreeForm: true,
              },
            ],
          },
        },
      ],
    });

    const resolved = projector.recordBatch(
      observed(
        { type: 'interaction.resolved', id: 'question-1', response: { answer: 'private selected answer' } },
        { cursorEnd: 300 },
      ),
      AT,
    );
    expect(resolved).toMatchObject({
      updates: [
        expect.objectContaining({
          family: 'status',
          value: expect.objectContaining({ interactionId: 'question-1', state: 'resolved' }),
        }),
      ],
    });
    expect(JSON.stringify([pending, resolved])).not.toContain('private');
  });

  it('tracks plan mode and compaction while leaving swarm, goals, and workflows raw-only', () => {
    const projector = evidence();
    expect(projector.recordBatch(observed({ type: 'plan_mode.enter', id: 'plan-mode-1' }), AT)).toMatchObject({
      quality: 'unknown',
      updates: [expect.objectContaining({ family: 'mode', value: expect.objectContaining({ raw: 'plan' }) })],
    });
    expect(projector.recordBatch(observed({ type: 'plan_mode.exit', id: 'plan-mode-1' }), AT)).toMatchObject({
      updates: [{ family: 'mode', operation: 'retract', key: 'provider-session' }],
    });
    expect(
      projector.recordBatch(observed({ type: 'full_compaction.begin', source: 'auto', instruction: 'private' }), AT),
    ).toMatchObject({
      updates: [
        expect.objectContaining({
          family: 'compaction',
          value: expect.objectContaining({ active: true, trigger: 'auto' }),
        }),
      ],
    });
    const completed = projector.recordBatch(
      observed({ type: 'full_compaction.complete', summary: 'private compacted content' }, { cursorEnd: 300 }),
      AT,
    );
    expect(completed?.updates).toEqual(
      expect.arrayContaining([
        { family: 'context', operation: 'retract', key: 'root' },
        expect.objectContaining({ family: 'compaction', value: expect.objectContaining({ active: false }) }),
      ]),
    );
    expect(projector.recordBatch(observed({ type: 'swarm_mode.enter', trigger: 'manual' }), AT)).toBeNull();
    expect(projector.recordBatch(observed({ type: 'goal.create', id: 'goal-1', objective: 'private' }), AT)).toBeNull();
    expect(JSON.stringify(completed)).not.toContain('private');
  });

  it('degrades the observation rail without a lifecycle claim or sensitive error', () => {
    const projector = evidence();
    const truncated = projector.observerEventBatch(
      {
        event: { type: 'adapter.native-event', adapter: 'kimi', nativeType: 'replay-window-truncated' },
        source: 'runtime',
        confidence: 'authoritative',
        replay: true,
        nativeEvent: { agentId: 'agent-0', path: '/private/journal', omittedBytes: 99_999 },
      },
      AT,
    );
    expect(truncated).toMatchObject({
      phase: 'bootstrap',
      completeness: 'partial',
      readiness: 'ready',
      updates: [],
      coverage: expect.arrayContaining([
        expect.objectContaining({
          family: 'usage',
          completeness: 'partial',
          actor: expect.objectContaining({ nativeAgentId: 'agent-0' }),
        }),
      ]),
    });
    expect(JSON.stringify(truncated)).not.toContain('/private/journal');
    expect(JSON.stringify(truncated)).not.toContain('99999');

    const batch = projector.observerDegradedBatch(AT);
    expect(batch).toMatchObject({
      readiness: 'degraded',
      completeness: 'unavailable',
      quality: 'unknown',
      updates: [],
    });
    expect(batch.coverage?.every(({ completeness }) => completeness === 'unavailable')).toBe(true);
    expect(batch.capabilities?.find(({ family }) => family === 'status')).toMatchObject({ support: 'degraded' });
    expect(batch.capabilities?.find(({ family }) => family === 'workflow')).toMatchObject({ support: 'unsupported' });
    expect(JSON.stringify(batch)).not.toContain('sensitive provider failure');
  });
});
