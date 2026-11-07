import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession } from '@vibefield/puppeteer-adapter-acp';
import {
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentAdapterBinding,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentEventSource,
} from '@vibefield/puppeteer-core';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  type AdapterMonitorObservationBatch,
  type MonitorFamilyUpdate,
} from '@vibefield/puppeteer-core/monitor-spi';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { readAcpCapture, replayAcpCapture, type CapturedAcpFrame } from '../test-support/acp-capture-replay.js';
import type { GrokObservedEvent, GrokSessionObserver } from '../normalization/types.js';
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

/** The text of each session/prompt request the captured controller sent, in order. */
function promptTexts(frames: readonly CapturedAcpFrame[]): string[] {
  return frames.flatMap(({ direction, message }) => {
    const text = (message.params?.prompt as Array<{ text?: unknown }> | undefined)?.[0]?.text;
    return direction === 'client-to-agent' && message.method === 'session/prompt' && typeof text === 'string'
      ? [text]
      : [];
  });
}

/** adapter-acp with Grok's control options over a replayed capture, as the driver opens it. */
async function replayedAcp(frames: readonly CapturedAcpFrame[], resume?: string) {
  const replay = replayAcpCapture(frames);
  const acp = await createAcpSession({
    cwd: '/workspace',
    connector: replay.connector,
    ...(resume ? { resume } : {}),
    ...grokControlOptions({ onApproval: () => 'approved' }, { viewer: 'attached' }),
  });
  return { replay, acp };
}

/** A durable-log observer that reads nothing: what the composition publishes comes from the control rail alone. */
function stubObserver() {
  const listeners = new Set<(event: GrokObservedEvent) => void>();
  const observer: GrokSessionObserver = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError: () => () => undefined,
    poll: async () => undefined,
    stop: () => undefined,
  };
  return { observer, emit: (event: GrokObservedEvent) => listeners.forEach((listener) => listener(event)) };
}

/** Let a submission reach adapter-acp: microtasks only. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

/** adapter-acp as Grok's control composition sees it: its turn starts inside submit, and it confirms at once. */
function fakeAcp(sessionId = 'grok-session') {
  const listeners = new Set<(candidate: AdapterEventCandidate) => void>();
  const submitted: string[] = [];
  const emit = (event: AgentEvent, nativeEvent?: unknown, source: AgentEventSource = 'native-hook') => {
    const candidate = createAdapterEventCandidate({
      sessionId,
      nativeSessionId: sessionId,
      timestamp: new Date().toISOString(),
      monotonicTime: 0,
      source,
      confidence: 'authoritative',
      event,
      nativeEvent,
    });
    for (const listener of listeners) listener(candidate);
  };
  const binding: AgentAdapterBinding = {
    sessionId,
    runtimeSessionId: sessionId,
    observationLevel: () => 'structured',
    events: {
      onCandidate(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    services: {
      prompt: {
        async submit({ text }) {
          submitted.push(text);
          const turnId = `acp-turn-${submitted.length}`;
          emit({ type: 'turn:started', turnId, prompt: text });
          return { status: 'confirmed', turnId };
        },
      },
    },
    dispose: async () => undefined,
  };
  return { binding, submitted, emit };
}

function startedTurnIds(envelopes: readonly AgentEventEnvelope[]): (string | undefined)[] {
  return envelopes.flatMap(({ event }) => (event.type === 'turn:started' ? [event.turnId] : []));
}

/** The adapter's real control composition over a replayed capture: adapter-acp, Grok options, and the control path. */
async function replayControl(frames: readonly CapturedAcpFrame[], prompts: number, resume?: string) {
  const { replay, acp } = await replayedAcp(frames, resume);
  const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp);
  const projection = projectAgentEvents(binding);
  const turnsEnded = () =>
    projection.envelopes.filter(({ event }) => event.type === 'turn:completed' || event.type === 'turn:failed').length;
  const texts = promptTexts(frames);
  for (let turn = 1; turn <= prompts; turn += 1) {
    // The capture's own request text: Grok's queue lists the prompt under it.
    await binding.services.prompt.submit({ text: texts[turn - 1]! });
    await vi.waitFor(() => expect(turnsEnded()).toBeGreaterThanOrEqual(turn));
  }
  await replay.drain();
  const batches = [...projection.monitorBatches];
  const envelopes = [...projection.envelopes];
  projection.dispose();
  await binding.dispose();
  return { sessionId: acp.sessionId, batches, envelopes };
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

  it('ends the root’s turn with the root’s own assistant text, never its child’s (subagent)', async () => {
    const { envelopes } = await replayControl(capture('subagent'), 1);
    const ends = envelopes.flatMap(({ event }) => (event.type === 'turn:completed' ? [event] : []));
    // acp-controller.jsonl: the root streams two message chunks (lines 33–34); before its prompt answers
    // (line 50) the leader forwards the child's two (lines 42–43) under the child's sessionId.
    expect(ends.map(({ lastAssistantMessage }) => lastAssistantMessage)).toEqual(['<redacted:text>'.repeat(2)]);
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

describe('Grok prompt receipts and rail-started turns over the 1.0.70 captures', () => {
  it('confirms a prompt when Grok runs it, its turn already started under Grok’s id (viewer-session)', async () => {
    const frames = capture('viewer-session');
    const { acp } = await replayedAcp(frames);
    const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, stubObserver().observer);
    const projection = projectAgentEvents(binding);
    try {
      // acp-controller.jsonl: Grok lists the prompt (line 20), then runs it (line 21), before any model output.
      const receipt = await binding.services.prompt.submit({ text: promptTexts(frames)[0]! });
      const startedWhenConfirmed = startedTurnIds(projection.envelopes);
      expect(receipt).toEqual({ status: 'confirmed', turnId: 'a11a5ed0-6f6f-40a0-8790-e989034dc9ff' });
      expect(startedWhenConfirmed).toEqual(['a11a5ed0-6f6f-40a0-8790-e989034dc9ff']);
      expect(projection.envelopes.find(({ event }) => event.type === 'turn:started')).toMatchObject({
        source: 'native-protocol',
        event: { prompt: promptTexts(frames)[0] },
      });
    } finally {
      projection.dispose();
      await binding.dispose();
    }
  });

  it('starts a prompt the person typed at Grok’s running frame (viewer-prompt)', async () => {
    const { replay, acp } = await replayedAcp(capture('viewer-prompt'));
    const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, stubObserver().observer);
    const projection = projectAgentEvents(binding);
    try {
      await replay.drain();
      // acp-controller.jsonl: the viewer's prompt is listed (line 19), then runs (line 20).
      expect(startedTurnIds(projection.envelopes)).toEqual(['a11a5ed0-58e7-45bb-a104-68d5e51d0b0b']);
      expect(projection.envelopes.find(({ event }) => event.type === 'turn:started')).toMatchObject({
        source: 'native-protocol',
        event: { prompt: '<redacted:text>' },
      });
    } finally {
      projection.dispose();
      await binding.dispose();
    }
  });

  it('publishes a prompt’s turn once, whichever rail starts it first (viewer-prompt)', async () => {
    const promptId = 'a11a5ed0-58e7-45bb-a104-68d5e51d0b0b';
    for (const logFirst of [true, false]) {
      const { replay, acp } = await replayedAcp(capture('viewer-prompt'));
      const log = stubObserver();
      const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, log.observer);
      const projection = projectAgentEvents(binding);
      // The durable log starts the turn at a configured user_prompt_submit hook, or at the first model chunk.
      const logStart: GrokObservedEvent = {
        event: { type: 'turn:started', turnId: promptId, prompt: '<redacted:text>' },
        promptId,
        phase: 'live',
        source: 'native-transcript',
        confidence: 'authoritative',
        nativeEvent: {},
      };
      try {
        if (logFirst) log.emit(logStart);
        await replay.drain();
        if (!logFirst) log.emit(logStart);
        expect(startedTurnIds(projection.envelopes), logFirst ? 'the log first' : 'the rail first').toEqual([promptId]);
      } finally {
        projection.dispose();
        await binding.dispose();
      }
    }
  });

  it('starts a running prompt when the log ends the turn before it, in Grok’s order (viewer-prompt)', async () => {
    const promptId = 'a11a5ed0-58e7-45bb-a104-68d5e51d0b0b';
    // acp-controller.jsonl up to the frame that runs the viewer's prompt (line 20), said twice, then one more prompt.
    const frames = capture('viewer-prompt').slice(0, 20);
    const running = frames.at(-1)!;
    const next: CapturedAcpFrame = {
      ...running,
      message: { ...running.message, params: { ...running.message.params, runningPromptId: 'next' } },
    };
    const { replay, acp } = await replayedAcp([...frames, running, next]);
    const log = stubObserver();
    const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, log.observer);
    const projection = projectAgentEvents(binding);
    const logged = (event: GrokObservedEvent['event'], turnId: string): GrokObservedEvent => ({
      event,
      promptId: turnId,
      phase: 'live',
      source: 'native-transcript',
      confidence: 'authoritative',
      nativeEvent: {},
    });
    const turnEvents = () =>
      projection.envelopes.flatMap(({ event }) =>
        event.type === 'turn:started' || event.type === 'turn:completed' ? [`${event.type} ${event.turnId}`] : [],
      );
    try {
      log.emit(logged({ type: 'turn:started', turnId: 'earlier', prompt: 'earlier' }, 'earlier'));
      await replay.drain();
      // Grok is ahead of the log: it ended 'earlier' and ran on before a poll read that end.
      expect(turnEvents()).toEqual(['turn:started earlier']);
      log.emit(logged({ type: 'turn:completed', turnId: 'earlier' }, 'earlier'));
      // The end retracts the root's activity, so the next start lands after it, in the same tick.
      expect(turnEvents()).toEqual(['turn:started earlier', 'turn:completed earlier', `turn:started ${promptId}`]);
      expect(projection.state.activeTurn?.id).toBe(promptId);
      // The log reaches the prompt's own start, which the rail already published, then its end.
      log.emit(logged({ type: 'turn:started', turnId: promptId, prompt: '<redacted:text>' }, promptId));
      log.emit(logged({ type: 'turn:completed', turnId: promptId }, promptId));
      expect(turnEvents()).toEqual([
        'turn:started earlier',
        'turn:completed earlier',
        `turn:started ${promptId}`,
        `turn:completed ${promptId}`,
        'turn:started next',
      ]);
      expect(projection.state.activeTurn?.id).toBe('next');
    } finally {
      projection.dispose();
      await binding.dispose();
    }
  });
});

describe('Grok receipts on a failing control rail', () => {
  it('refuses a prompt once the control rail closed, without writing it', async () => {
    for (const observer of [undefined, stubObserver().observer]) {
      const acp = fakeAcp();
      const binding = createPendingControlSession(acp.binding.sessionId, 'rt', () => acp.binding, observer);
      const closed: AgentEvent = { type: 'adapter:native-event', adapter: 'acp', nativeType: 'transport.closed' };
      acp.emit(closed, { code: 1 }, 'runtime');
      await expect(binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 20 })).resolves.toEqual({
        status: 'rejected',
        reason: 'grok control rail unavailable',
      });
      expect(acp.submitted).toEqual([]);
      await binding.dispose();
    }
  });

  it('rejects a prompt whose request fails before Grok lists it, keeping the failure off the turn', async () => {
    const acp = fakeAcp();
    const log = stubObserver();
    const binding = createPendingControlSession(acp.binding.sessionId, 'rt', () => acp.binding, log.observer);
    const projection = projectAgentEvents(binding);
    try {
      const receipt = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 1_000 });
      await flush();
      expect(acp.submitted).toEqual(['hello']);
      // adapter-acp's session/prompt request was refused: it fails its own turn.
      acp.emit({ type: 'turn:failed', turnId: 'acp-turn-1', error: 'rate limited' });
      await expect(receipt).resolves.toEqual({ status: 'rejected', reason: 'rate limited' });
      expect(projection.envelopes.some(({ event }) => event.type === 'turn:failed')).toBe(false);
      expect(projection.state.diagnostics.at(-1)).toMatchObject({
        code: 'grok-control-prompt-failed',
        message: 'rate limited',
      });
    } finally {
      projection.dispose();
      await binding.dispose();
    }
  });
});
