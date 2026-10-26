import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession } from '@vibefield/puppeteer-adapter-acp';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  type AdapterMonitorObservationBatch,
  type MonitorFamilyUpdate,
} from '@vibefield/puppeteer-core/monitor-spi';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { readAcpCapture, replayAcpCapture, type CapturedAcpFrame } from '../test-support/acp-capture-replay.js';
import { grokControlOptions } from './acp-control.js';
import { createPendingControlSession } from './control-session.js';

// The committed, sanitized 1.0.70 census captures (binary-only evidence; see
// packages/surface/vendors/grok/findings.md).
const CAPTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../surface/vendors/grok/captures/grok@1.0.70');

type UsageUpsert = Extract<MonitorFamilyUpdate, { family: 'usage'; operation: 'upsert' }>;

function capture(scenario: string, file = 'acp-controller.jsonl'): CapturedAcpFrame[] {
  return readAcpCapture(join(CAPTURES, scenario, file));
}

function notifications(frames: readonly CapturedAcpFrame[], sessionUpdate: string) {
  return frames.flatMap(({ direction, message }) => {
    const params = message.params ?? {};
    const update = params.update as Record<string, unknown> | undefined;
    return direction === 'agent-to-client' &&
      message.method === '_x.ai/session_notification' &&
      update?.sessionUpdate === sessionUpdate
      ? [{ sessionId: params.sessionId as string, update }]
      : [];
  });
}

/** The adapter's real control composition over a replayed capture: adapter-acp, Grok options, and the control path. */
async function replayControl(frames: readonly CapturedAcpFrame[], prompts: number, resume?: string) {
  const replay = replayAcpCapture(frames);
  const acp = await createAcpSession({
    cwd: '/workspace',
    connector: replay.connector,
    ...(resume ? { resume } : {}),
    ...grokControlOptions({ onApproval: () => 'approved' }, { viewer: 'attached' }),
  });
  const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp);
  const projection = projectAgentEvents(binding);
  const turnsEnded = () =>
    projection.envelopes.filter(({ event }) => event.type === 'turn:completed' || event.type === 'turn:failed').length;
  for (let turn = 1; turn <= prompts; turn += 1) {
    await binding.services.prompt.submit({ text: 'replayed prompt' });
    await vi.waitFor(() => expect(turnsEnded()).toBeGreaterThanOrEqual(turn));
  }
  await replay.drain();
  const batches = [...projection.monitorBatches];
  projection.dispose();
  await binding.dispose();
  return { sessionId: acp.sessionId, batches };
}

function monitor(batches: readonly AdapterMonitorObservationBatch[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'run',
    runtimeEpoch: 1,
    providerId: 'grok',
    executionMode: 'native-tui',
    observationLevel: 'structured',
    allocatedAt: batches[0]!.observedAt,
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, { ...batch, kind: 'semantic', runtimeRunId: 'run', runtimeEpoch: 1 }).state;
  }
  return projectAgentMonitorState(state, { asOf: batches.at(-1)!.observedAt });
}

function usageUpserts(batches: readonly AdapterMonitorObservationBatch[]): UsageUpsert[] {
  return batches.flatMap(({ updates }) =>
    updates.filter((update): update is UsageUpsert => update.family === 'usage' && update.operation === 'upsert'),
  );
}

describe('Grok control path over the 1.0.70 captures', () => {
  it('identifies every unsigned live response and reconciles each turn exactly (viewer-session)', async () => {
    const frames = capture('viewer-session');
    const { sessionId, batches } = await replayControl(frames, 5);
    const responses = notifications(frames, 'response_completed');
    const turnTotals = notifications(frames, 'turn_completed').map(
      ({ update }) => (update.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0,
    );
    // The capture's responses carry {sessionUpdate, usage} only: no signature, no _meta.eventId.
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every(({ update }) => Object.keys(update).sort().join() === 'sessionUpdate,usage')).toBe(true);

    const upserts = usageUpserts(batches);
    const perResponse = upserts.filter(({ key }) => key.includes(':response:'));
    expect(new Set(perResponse.map(({ key }) => key)).size).toBe(responses.length);
    expect(perResponse.every(({ key }) => key.startsWith(`grok-turn:${sessionId}:`))).toBe(true);
    // Each turn total equals its streamed responses: the reconciliation adds nothing twice.
    const reconciliations = upserts.filter(({ key }) => !key.includes(':response:'));
    expect(reconciliations.map(({ value }) => value.deltaTokens)).toEqual(
      turnTotals.filter((total) => total > 0).map(() => 0),
    );

    const usage = monitor(batches).usage;
    expect(usage.cumulativeTokens).toBe(turnTotals.reduce((sum, total) => sum + total, 0));
    expect(usage).toMatchObject({ burnRateBoundary: 'response' });
  });

  it('attributes a subagent child’s usage and turn to its actor, keyed by child_session_id (subagent)', async () => {
    const frames = capture('subagent');
    const { sessionId, batches } = await replayControl(frames, 1);
    const [spawned] = notifications(frames, 'subagent_spawned');
    const [finished] = notifications(frames, 'subagent_finished');
    const childSessionId = spawned!.update.child_session_id as string;
    const subagentId = spawned!.update.subagent_id as string;
    expect(childSessionId).not.toBe(sessionId);
    // Grok's own session accounting (usage.json) includes the child's model calls.
    const sessionUsage = (
      readFileSync(join(CAPTURES, 'subagent', 'state.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
        .find(({ method, params }) => method === 'usage.json' && params.sessionId === sessionId)?.params.session as {
        totalTokens: number;
      }
    ).totalTokens;

    const state = monitor(batches);
    expect(state.usage.cumulativeTokens).toBe(sessionUsage);
    expect(state.subagents).toEqual([
      expect.objectContaining({ id: subagentId, cumulativeTokens: finished!.update.tokens_used, working: false }),
    ]);

    const childUsage = usageUpserts(batches).filter(({ value }) => value.actor !== undefined);
    expect(childUsage.length).toBeGreaterThan(0);
    expect(
      childUsage.every(
        ({ key, value }) =>
          key.startsWith(`grok-turn:${childSessionId}:`) &&
          value.actor?.nativeSessionId === childSessionId &&
          value.actor.runKey === `${sessionId}:actor:${subagentId}`,
      ),
    ).toBe(true);

    // The child's running turn is the actor's activity until its turn_completed retracts it.
    const statusUpdates = batches.flatMap(({ updates }) => updates.filter(({ family }) => family === 'status'));
    const childTurn = statusUpdates.find(
      (update): update is Extract<MonitorFamilyUpdate, { family: 'status'; operation: 'upsert' }> =>
        update.operation === 'upsert' && 'actor' in update.value && update.value.actor?.role === 'child',
    );
    expect(childTurn).toMatchObject({
      value: { kind: 'activity', active: true, actor: { nativeSessionId: childSessionId } },
    });
    expect(statusUpdates).toContainEqual({ family: 'status', operation: 'retract', key: childTurn!.key });
  });

  it('keeps replayed session/load history out of live usage (subagent resume)', async () => {
    const live = capture('subagent');
    const sessionId = live.find(({ message }) => message.id === 2 && message.result !== undefined)!.message.result as {
      sessionId: string;
    };
    const { batches } = await replayControl(capture('subagent', 'acp-resume.jsonl'), 0, sessionId.sessionId);
    expect(usageUpserts(batches)).toEqual([]);
    expect(monitor(batches).usage.cumulativeTokens).toBeUndefined();
  });
});
