import { describe, expect, it } from 'vitest';
import type { AdapterMonitorObservationBatch, MonitorFamilyUpdate } from '@vibecook/puppeteer-core/monitor-spi';
import { ClaudeMonitorEvidence } from './monitor-evidence.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000b2';
const AT = '2026-08-16T20:00:00.000Z';

function family(batch: AdapterMonitorObservationBatch, name: MonitorFamilyUpdate['family']) {
  return batch.updates.find((update) => update.family === name);
}

describe('ClaudeMonitorEvidence', () => {
  it('declares every monitor family and leaves workflow support to the semantic capability merge', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    const capabilities = evidence.capabilitiesBatch(AT).capabilities ?? [];
    expect(capabilities.map(({ family }) => family).sort()).toEqual(
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
    expect(capabilities.find(({ family }) => family === 'workflow')).toMatchObject({ support: 'unsupported' });
  });

  it('marks observable families unavailable when the hook rail is lost without inventing workflow support', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    evidence.capabilitiesBatch(AT);
    const unavailable = evidence.hookRailUnavailableBatch('2026-08-16T20:00:01.000Z', 'test hook disconnect');

    expect(unavailable).toMatchObject({
      phase: 'live',
      readiness: 'degraded',
      completeness: 'unavailable',
      quality: 'unknown',
      updates: [],
    });
    expect(unavailable.capabilities?.find(({ family }) => family === 'status')).toMatchObject({
      support: 'degraded',
    });
    expect(unavailable.capabilities?.find(({ family }) => family === 'workflow')).toMatchObject({
      support: 'unsupported',
    });
    expect(unavailable.coverage).toHaveLength(10);
    expect(unavailable.coverage?.every(({ completeness }) => completeness === 'unavailable')).toBe(true);
  });

  it('preserves provider context percentage and observed model/effort changes without treating context as usage', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    const first = evidence.rootStatusBatch(
      {
        session_id: SESSION_ID,
        model: { id: 'claude-opus-5', display_name: 'Opus 5' },
        effort: { level: 'high' },
        context_window: {
          context_window_size: 200_000,
          used_percentage: 19.5,
          current_usage: {
            input_tokens: 10_000,
            cache_creation_input_tokens: 2_000,
            cache_read_input_tokens: 3_000,
          },
        },
      },
      AT,
      'status-1',
    );
    if (!first) throw new Error('expected a root batch');

    expect(family(first, 'context')).toMatchObject({
      operation: 'replace',
      values: [
        {
          value: {
            usedTokens: 15_000,
            capacityTokens: 200_000,
            usedPercentage: 19.5,
            percentageSource: 'provider',
          },
        },
      ],
    });
    expect(family(first, 'usage')).toBeUndefined();
    expect(family(first, 'model')).toMatchObject({
      values: [{ value: { providerModelId: 'claude-opus-5', displayName: 'Opus 5', intent: 'observed' } }],
    });
    expect(family(first, 'effort')).toMatchObject({
      values: [{ value: { value: 'high', intent: 'observed' } }],
    });

    const changed = evidence.rootStatusBatch(
      { session_id: SESSION_ID, model: { id: 'claude-sonnet-5' }, effort: { level: 'max' } },
      '2026-08-16T20:00:01.000Z',
      'status-2',
    );
    expect(changed?.producer.sequence).toBe(2);
    expect(family(changed!, 'model')).toMatchObject({
      values: [{ value: { providerModelId: 'claude-sonnet-5' } }],
    });
    expect(family(changed!, 'effort')).toMatchObject({ values: [{ value: { value: 'max' } }] });

    const unsupported = evidence.rootStatusBatch(
      { session_id: SESSION_ID, model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' } },
      '2026-08-16T20:00:02.000Z',
      'status-3',
    );
    expect(unsupported?.producer.sequence).toBe(3);
    expect(family(unsupported!, 'model')).toMatchObject({
      values: [
        {
          value: {
            providerModelId: 'claude-haiku-4-5-20251001',
            displayName: 'Haiku 4.5',
            intent: 'observed',
          },
        },
      ],
    });
    expect(family(unsupported!, 'effort')).toEqual({
      family: 'effort',
      operation: 'replace',
      values: [],
      coverage: 'complete',
    });
  });

  it('clears status-owned root context when a native hook invalidates history', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    const status = evidence.rootStatusBatch(
      {
        session_id: SESSION_ID,
        context_window: {
          context_window_size: 200_000,
          current_usage: { input_tokens: 10_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000 },
        },
      },
      AT,
      'status-context',
    );
    if (!status) throw new Error('expected a root status batch');

    const invalidated = evidence.rootContextInvalidationBatch('2026-08-16T20:00:01.000Z', 'post-compact-request');

    expect(invalidated).toMatchObject({
      batchId: 'root:2',
      producer: { id: 'claude:status-root', epoch: status.producer.epoch, sequence: 2 },
      phase: 'live',
      scope: { nativeSessionId: SESSION_ID },
      evidence: [{ namespace: 'claude-native-hook', id: 'post-compact-request' }],
    });
    expect(family(invalidated, 'context')).toEqual({
      family: 'context',
      operation: 'replace',
      values: [],
      coverage: 'complete',
    });
  });

  it('keeps task-row identity separate until an exact native agent id joins it', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    const payload = {
      session_id: SESSION_ID,
      tasks: [
        {
          id: 'agent-7',
          name: 'reviewer',
          status: 'running',
          label: 'Reviewing patch',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          contextWindowSize: 200_000,
          tokenCount: 42_000,
          tokenSamples: [10_000, 20_000, 30_000, 42_000],
        },
      ],
    };
    const unjoined = evidence.childStatusBatch(payload, AT, 'child-1');
    if (!unjoined) throw new Error('expected a child batch');
    const unjoinedContext = family(unjoined, 'context');
    expect(unjoinedContext).toMatchObject({
      operation: 'replace',
      values: [{ value: { actor: { runKey: `${SESSION_ID}:status-task:agent-7` }, usedPercentage: 21 } }],
    });
    expect(family(unjoined, 'usage')).toMatchObject({
      operation: 'replace',
      values: [{ value: { canonical: false, boundary: 'sample', cumulativeTokens: 42_000 } }],
    });
    expect(family(unjoined, 'status')).toMatchObject({
      operation: 'upsert',
      value: {
        active: true,
        activityKind: 'delegating',
        line: 'Reviewing patch',
        leaseId: `claude-child-status:${SESSION_ID}:agent-7`,
      },
    });

    evidence.observeNativeAgent('agent-7', 'Explore');
    const joined = evidence.childStatusBatch(payload, '2026-08-16T20:00:01.000Z', 'child-2');
    const joinedContext = family(joined!, 'context');
    expect(joinedContext).toMatchObject({
      values: [
        {
          value: {
            actor: {
              runKey: `${SESSION_ID}:actor:agent-7`,
              nativeAgentId: 'agent-7',
              nativeAgentType: 'Explore',
            },
          },
        },
      ],
    });
    const joinedUsage = family(joined!, 'usage');
    if (joinedUsage?.operation !== 'replace' || joinedUsage.family !== 'usage') {
      throw new Error('expected child usage replacement');
    }
    expect(joinedUsage.values).toHaveLength(2);
    expect(joinedUsage.values.every(({ value }) => value.actor?.runKey === `${SESSION_ID}:actor:agent-7`)).toBe(true);
  });

  it('does not let a stale running status snapshot reopen a hook-stopped child', () => {
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => SESSION_ID, epoch: 'status-epoch' });
    const payload = {
      session_id: SESSION_ID,
      tasks: [{ id: 'agent-7', type: 'Explore', status: 'running', tokenCount: 10 }],
    };

    evidence.observeNativeAgentStarted('agent-7', 'Explore');
    expect(family(evidence.childStatusBatch(payload, AT, 'child-running')!, 'status')).toMatchObject({
      value: { active: true },
    });

    evidence.observeNativeAgentStopped('agent-7', 'Explore');
    expect(
      family(evidence.childStatusBatch(payload, '2026-08-16T20:00:01.000Z', 'child-stale')!, 'status'),
    ).toMatchObject({ value: { active: false } });

    evidence.observeNativeAgentStarted('agent-7', 'Explore');
    expect(
      family(evidence.childStatusBatch(payload, '2026-08-16T20:00:02.000Z', 'child-resumed')!, 'status'),
    ).toMatchObject({ value: { active: true } });
  });

  it('starts independent replacement epochs for root and child status after native session rotation', () => {
    let sessionId = SESSION_ID;
    const evidence = new ClaudeMonitorEvidence({ nativeSessionId: () => sessionId, epoch: 'status-epoch' });
    const firstRoot = evidence.rootStatusBatch(
      { session_id: sessionId, model: { id: 'claude-opus-5' } },
      AT,
      'root-1',
    )!;
    const firstChild = evidence.childStatusBatch(
      { session_id: sessionId, tasks: [{ id: 'task-1', tokenCount: 10 }] },
      AT,
      'child-1',
    )!;

    sessionId = '00000000-0000-4000-8000-0000000000b3';
    evidence.observeNativeSession(sessionId);
    const rotatedRoot = evidence.rootStatusBatch(
      { session_id: sessionId, model: { id: 'claude-sonnet-5' } },
      '2026-08-16T20:01:00.000Z',
      'root-2',
    )!;
    const rotatedChild = evidence.childStatusBatch(
      { session_id: sessionId, tasks: [] },
      '2026-08-16T20:01:00.000Z',
      'child-2',
    )!;

    expect(rotatedRoot).toMatchObject({ phase: 'resync', producer: { sequence: 1 } });
    expect(rotatedChild).toMatchObject({ phase: 'resync', producer: { sequence: 1 } });
    expect(rotatedRoot.producer.epoch).not.toBe(firstRoot.producer.epoch);
    expect(rotatedChild.producer.epoch).not.toBe(firstChild.producer.epoch);
    expect(family(rotatedChild, 'usage')).toMatchObject({ operation: 'replace', values: [] });
  });
});
