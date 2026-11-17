import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createAcpSession, createStdioAcpConnector, type AcpConnector } from '@vibefield/puppeteer-adapter-acp';
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
  translateAgentEventEnvelope,
  type AdapterMonitorObservationBatch,
  type MonitorFamilyUpdate,
} from '@vibefield/puppeteer-core/monitor-spi';
import { projectAgentEvents, type TestAgentProjection } from '@vibefield/puppeteer-testing';
import { readAcpCapture, replayAcpCapture, type CapturedAcpFrame } from '../test-support/acp-capture-replay.js';
import { GROK_QUEUE_CHANGED_METHOD } from '../normalization/queue.js';
import type { GrokObservedEvent, GrokSessionObserver } from '../normalization/types.js';
import { createGrokSessionObserver, type GrokSessionObserverOptions } from '../observation/session-observer.js';
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

/**
 * adapter-acp, real, over a connection its row drives: session/prompt stays in flight until the row rejects it.
 * `written` counts the requests adapter-acp wrote.
 */
async function railInFlight() {
  let rejectPrompt!: (error: Error) => void;
  let closeTransport!: () => void;
  let written = 0;
  const connector: AcpConnector = (toClient) => {
    const agent = {
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      newSession: async () => ({ sessionId: 'grok-session' }),
      prompt: () => {
        written += 1;
        return new Promise<never>((_resolve, reject) => {
          rejectPrompt = reject;
        });
      },
      cancel: async () => undefined,
    };
    toClient(agent as never);
    return {
      agent: agent as never,
      onClose: (handler) => {
        closeTransport = () => handler({ code: 1, signal: null });
      },
      close: () => undefined,
    };
  };
  const acp = await createAcpSession({
    cwd: '/workspace',
    connector,
    ...grokControlOptions({ onApproval: () => 'approved' }, { viewer: 'attached' }),
  });
  return {
    acp,
    written: () => written,
    rejectPrompt: (error: Error) => rejectPrompt(error),
    close: () => closeTransport(),
  };
}

/**
 * adapter-acp on its real stdio connection and the real SDK, to a stand-in agent process whose session/prompt handler
 * is `onPrompt`: only the SDK makes a RequestError, and this package does not depend on it.
 */
function stdioAcp(onPrompt: string) {
  const script = `
    const answer = (id, reply) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n');
    require('node:readline')
      .createInterface({ input: process.stdin })
      .on('line', (line) => {
        const { id, method } = JSON.parse(line);
        if (method === 'initialize') answer(id, { result: { protocolVersion: 1, agentCapabilities: {} } });
        if (method === 'session/new') answer(id, { result: { sessionId: 'grok-session' } });
        if (method === 'session/prompt') { ${onPrompt} }
      });
  `;
  return createAcpSession({
    cwd: '/workspace',
    connector: createStdioAcpConnector({ executable: process.execPath, args: ['-e', script] }),
    ...grokControlOptions({ onApproval: () => 'approved' }, { viewer: 'attached' }),
  });
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
    wake: () => undefined,
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

/** The monitor as Runtime folds a binding: its batches and its agent events, one stream. */
function monitorOf(envelopes: readonly AgentEventEnvelope[]) {
  const identity = { runtimeRunId: 'run', runtimeEpoch: 1 };
  let state = createMonitorAccumulatorState({
    ...identity,
    providerId: 'grok',
    executionMode: 'native-tui',
    observationLevel: 'native-log',
    allocatedAt: envelopes[0]!.timestamp,
  });
  for (const envelope of envelopes) {
    const input =
      envelope.event.type === 'monitor:batch'
        ? { ...envelope.event.batch, ...identity, kind: 'semantic' as const }
        : translateAgentEventEnvelope({ ...identity, envelope });
    state = reduceMonitorAccumulator(state, input).state;
  }
  return projectAgentMonitorState(state);
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
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
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
  it('refuses a prompt for good once the control rail closed, without writing it', async () => {
    for (const observer of [undefined, stubObserver().observer]) {
      const acp = fakeAcp();
      const binding = createPendingControlSession(acp.binding.sessionId, 'rt', () => acp.binding, observer);
      const closed: AgentEvent = { type: 'adapter:native-event', adapter: 'acp', nativeType: 'transport.closed' };
      acp.emit(closed, { code: 1 }, 'runtime');
      await expect(binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 20 })).resolves.toEqual({
        status: 'rejected',
        reason: 'grok control rail unavailable',
        retryable: false,
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
      // adapter-acp's session/prompt request was refused: it fails its own turn, and says Grok answered.
      acp.emit(
        { type: 'turn:failed', turnId: 'acp-turn-1', error: 'rate limited' },
        { method: 'session/prompt', outcome: 'failed', answered: true },
      );
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

  const noAnswer = { status: 'uncertain', reason: 'the grok control rail closed before Grok accepted the prompt' };

  it('answers uncertain when a request in flight fails with no answer and then the rail closes', async () => {
    for (const observer of [undefined, stubObserver().observer]) {
      const rail = await railInFlight();
      const binding = createPendingControlSession(rail.acp.sessionId, 'rt', () => rail.acp, observer);
      try {
        const receipt = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 1_000 });
        await flush();
        // The SDK's close() rejects what is in flight before stdio's close reaches the rail, and the leader runs on.
        rail.rejectPrompt(new Error('ACP connection closed'));
        await flush();
        rail.close();
        await expect(receipt).resolves.toEqual(noAnswer);
      } finally {
        await binding.dispose();
      }
    }
  });

  it('answers uncertain once when the rail closes first and the request fails after it', async () => {
    const rail = await railInFlight();
    const binding = createPendingControlSession(rail.acp.sessionId, 'rt', () => rail.acp, stubObserver().observer);
    const projection = projectAgentEvents(binding);
    try {
      const receipt = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 1_000 });
      await flush();
      rail.close();
      await expect(receipt).resolves.toEqual(noAnswer);
      rail.rejectPrompt(new Error('ACP connection closed'));
      await flush();
      // The late failure settles nothing: it stays one diagnostic, and the turn stays the log's.
      const codes = projection.state.diagnostics.map(({ code }) => code);
      expect(codes.filter((code) => code === 'grok-control-prompt-failed')).toHaveLength(1);
      expect(projection.envelopes.some(({ event }) => event.type === 'turn:failed')).toBe(false);
    } finally {
      projection.dispose();
      await binding.dispose();
    }
  });

  it('refuses every later prompt for good once a request failed with no answer, without writing it', async () => {
    for (const observer of [undefined, stubObserver().observer]) {
      const rail = await railInFlight();
      const binding = createPendingControlSession(rail.acp.sessionId, 'rt', () => rail.acp, observer);
      try {
        const first = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 1_000 });
        await flush();
        // The SDK closed: it rejects what is in flight and writes nothing more, whether or not the rail hears it.
        rail.rejectPrompt(new Error('ACP connection closed'));
        await flush();
        await expect(binding.services.prompt.submit({ text: 'again', confirmationTimeoutMs: 20 })).resolves.toEqual({
          status: 'rejected',
          reason: 'grok control rail unavailable',
          retryable: false,
        });
        expect(rail.written()).toBe(1);
        await expect(first).resolves.toEqual(noAnswer);
      } finally {
        await binding.dispose();
      }
    }
  });

  it('answers rejected, with Grok’s message, when Grok answers the request with an error', async () => {
    const acp = await stdioAcp(`answer(id, { error: { code: -32000, message: 'rate limited' } });`);
    const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, stubObserver().observer);
    try {
      const receipt = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 15_000 });
      await expect(receipt).resolves.toEqual({ status: 'rejected', reason: 'rate limited' });
    } finally {
      await binding.dispose();
    }
  }, 20_000);

  it('answers uncertain when the agent process dies with the request in flight, in whichever order', async () => {
    const acp = await stdioAcp('process.exit(1);');
    const binding = createPendingControlSession(acp.sessionId, 'rt', () => acp, stubObserver().observer);
    try {
      const receipt = binding.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 15_000 });
      await expect(receipt).resolves.toEqual(noAnswer);
    } finally {
      await binding.dispose();
    }
  }, 20_000);
});

describe('The control rail and the durable-log observer', () => {
  it('wakes the observer for a live own-session candidate, never for a child’s or a replay’s', async () => {
    const acp = fakeAcp();
    const wake = vi.fn();
    const observer = { ...stubObserver().observer, wake };
    const binding = createPendingControlSession(acp.binding.sessionId, 'rt', () => acp.binding, observer);
    const event: AgentEvent = { type: 'adapter:native-event', adapter: 'grok', nativeType: 'response_completed' };
    const update = { sessionUpdate: 'response_completed' };
    try {
      acp.emit(event, { sessionId: 'child-session', update }, 'native-protocol');
      acp.emit(event, { sessionId: 'grok-session', update, _meta: { isReplay: true } }, 'native-protocol');
      expect(wake).not.toHaveBeenCalled();
      acp.emit(event, { sessionId: 'grok-session', update }, 'native-protocol');
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      await binding.dispose();
    }
  });
});

describe('A launch or resume replay of the durable log', () => {
  const line = (update: Record<string, unknown>, promptId?: string) =>
    JSON.stringify({
      timestamp: 1_784_669_125,
      method: 'session/update',
      params: { sessionId: 'grok-session', update, ...(promptId ? { _meta: { promptId } } : {}) },
    }) + '\n';
  const userLine = line({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } });
  const thoughtLine = line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, 'p1');
  const messageLine = line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, 'p1');
  const endLine = line({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn' });
  const thought2Line = line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, 'p2');
  const end2Line = line({ sessionUpdate: 'turn_completed', prompt_id: 'p2', stop_reason: 'end_turn' });

  const turnEvents = ({ envelopes }: TestAgentProjection) =>
    envelopes.flatMap(({ event }) =>
      event.type === 'turn:started' || event.type === 'turn:completed' ? [`${event.type} ${event.turnId}`] : [],
    );

  /** The observer's options, and `beforeReplay`: the frames the rail delivers at adoption, before a byte is read. */
  type OverLogOptions = GrokSessionObserverOptions & { beforeReplay?: (railRuns: (promptId: string) => void) => void };

  /**
   * The real observer and composition over a log, past its first poll: the whole replay, unless `options` caps a poll.
   * `append` writes live records and reads them; with none, it reads on, as the next poll does. `railRuns` is Grok's
   * running frame for a prompt, as the rail hears it.
   */
  async function overLog(
    records: string[],
    check: (
      projection: TestAgentProjection,
      append: (...live: string[]) => Promise<void>,
      railRuns: (promptId: string) => void,
    ) => Promise<void>,
    { beforeReplay, ...options }: OverLogOptions = {},
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-control-'));
    const updatesPath = join(directory, 'updates.jsonl');
    await writeFile(updatesPath, records.join(''));
    const acp = fakeAcp();
    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000, ...options });
    const binding = createPendingControlSession(acp.binding.sessionId, 'rt', () => acp.binding, observer);
    const projection = projectAgentEvents(binding);
    const railRuns = (promptId: string) =>
      acp.emit(
        { type: 'adapter:native-event', adapter: 'grok', nativeType: GROK_QUEUE_CHANGED_METHOD },
        {
          method: GROK_QUEUE_CHANGED_METHOD,
          params: { sessionId: acp.binding.sessionId, entries: [], runningPromptId: promptId, runningText: promptId },
        },
        'native-protocol',
      );
    try {
      // The binding's first poll is in flight and has read nothing: a frame buffered before adoption lands here.
      beforeReplay?.(railRuns);
      await observer.poll();
      await check(
        projection,
        async (...live) => {
          await appendFile(updatesPath, live.join(''));
          await observer.poll();
        },
        railRuns,
      );
    } finally {
      projection.dispose();
      await binding.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('projects a session its log left mid-turn idle: the replay is a baseline, not work', async () => {
    await overLog(
      [
        userLine,
        line({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'in_progress' }, 'p1'),
        line({ sessionUpdate: 'pending_interaction', tool_call_id: 'q1', kind: 'question' }, 'p1'),
        line({ sessionUpdate: 'subagent_spawned', subagent_id: 's1', subagent_type: 'explore' }, 'p1'),
        line({ sessionUpdate: 'auto_compact_started' }, 'p1'),
        thoughtLine,
      ],
      async (projection) => {
        expect(projection.state.activeTurn).toBeUndefined();
        expect(monitorOf(projection.envelopes)).toMatchObject({
          status: 'idle',
          blockers: [],
          subagents: [expect.objectContaining({ id: 's1', working: false })],
          compaction: { active: false },
        });
      },
    );
  });

  it('projects a session whose log ended in a refused turn idle: what refused it has gone', async () => {
    const refused = {
      sessionUpdate: 'turn_completed',
      prompt_id: 'p1',
      stop_reason: 'end_turn',
      error_kind: 'rate_limit',
    };
    await overLog([userLine, thoughtLine, line(refused)], async (projection) => {
      expect(projection.envelopes.some(({ event }) => event.type === 'turn:failed')).toBe(false);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
    });
  });

  it('ends a turn the leader ran on through the resume by its own record, with its own message', async () => {
    await overLog([userLine, thoughtLine], async (projection, append) => {
      await append(line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, 'p1'));
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
      await append(line({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn' }));
      const ends = projection.envelopes.flatMap(({ event, replay }) =>
        event.type === 'turn:completed' ? [[event.turnId, event.lastAssistantMessage, replay === true]] : [],
      );
      expect(ends).toEqual([
        ['p1', undefined, true],
        ['p1', 'done', false],
      ]);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
    });
  });

  it('holds a rail start behind a settled turn that runs on, and its own end releases it', async () => {
    const liveWork: [name: string, work: string, ...closers: string[]][] = [
      ['message', messageLine],
      ['thought', thoughtLine],
      [
        'tool',
        line({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'in_progress' }, 'p1'),
        line({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, 'p1'),
      ],
    ];
    for (const [name, work, ...closers] of liveWork) {
      await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
        const settled = ['turn:started p1', 'turn:completed p1'];
        await append(work);
        expect(monitorOf(projection.envelopes), name).toMatchObject({ status: 'working' });
        railRuns('q1');
        // No second start says P runs, and Q waits for P's end all the same.
        expect(turnEvents(projection), name).toEqual(settled);
        expect(monitorOf(projection.envelopes), name).toMatchObject({ status: 'working' });
        await append(...closers, endLine);
        expect(turnEvents(projection), name).toEqual([...settled, 'turn:completed p1', 'turn:started q1']);
        expect(projection.state.activeTurn?.id, name).toBe('q1');
        expect(monitorOf(projection.envelopes), name).toMatchObject({ status: 'working' });
      });
    }
  });

  it('reads a reopened turn as working between its records, with a rail start held behind it', async () => {
    const toolOpen = line({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'in_progress' }, 'p1');
    const toolDone = line({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, 'p1');
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      const settled = ['turn:started p1', 'turn:completed p1'];
      await append(toolOpen);
      railRuns('q1');
      // Grok ran a tool and goes on with the turn: no record of P holds anything open between them, and P still runs.
      await append(toolDone);
      expect(turnEvents(projection)).toEqual(settled);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
      await append(endLine);
      expect(turnEvents(projection)).toEqual([...settled, 'turn:completed p1', 'turn:started q1']);
      expect(projection.state.activeTurn?.id).toBe('q1');
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
    });
  });

  it('starts nothing when the rail says again that a reopened turn runs', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      await append(thoughtLine);
      // Grok repeats its running prompt at every queue change, as when a prompt is listed behind it.
      railRuns('p1');
      expect(turnEvents(projection)).toEqual(['turn:started p1', 'turn:completed p1']);
      await append(endLine);
      expect(turnEvents(projection)).toEqual(['turn:started p1', 'turn:completed p1', 'turn:completed p1']);
    });
  });

  it('holds nothing behind a reopened turn that ended, whatever record of it comes late', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      await append(thoughtLine, endLine, thoughtLine);
      railRuns('q1');
      expect(turnEvents(projection).at(-1)).toBe('turn:started q1');
    });
  });

  it('keeps a running turn when the log shows a settled turn’s last records after the rail started it', async () => {
    const refusedLine = line({ sessionUpdate: 'turn_completed', prompt_id: 'p1', error_kind: 'rate_limit' });
    for (const end of [endLine, refusedLine]) {
      await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
        const started = ['turn:started p1', 'turn:completed p1', 'turn:started q1'];
        // Grok ended P and runs Q, and the rail says so before a poll reads P's last records.
        railRuns('q1');
        expect(turnEvents(projection)).toEqual(started);
        await append(messageLine);
        await append(end);
        // A rail start says every earlier prompt is over. P's end was the settle's, and what it opened still closes.
        expect(turnEvents(projection)).toEqual(started);
        expect(projection.envelopes.some(({ event }) => event.type === 'turn:failed')).toBe(false);
        expect(projection.state.lastAssistantMessage).toBe('done');
        expect(projection.state.diagnostics.map(({ code }) => code)).not.toContain('turn-mismatch');
        expect(projection.state.activeTurn?.id).toBe('q1');
        expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working', blockers: [] });
      });
    }
  });

  it('holds nothing behind a bare settled turn, and its late end stays a dropped duplicate', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      const started = ['turn:started p1', 'turn:completed p1', 'turn:started q1'];
      railRuns('q1');
      expect(turnEvents(projection)).toEqual(started);
      await append(endLine);
      expect(turnEvents(projection)).toEqual(started);
      expect(projection.state.activeTurn?.id).toBe('q1');
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
    });
  });

  it('drops a bare settled turn’s late end when nothing runs: the settle already ended it', async () => {
    await overLog([userLine, thoughtLine], async (projection, append) => {
      await append(endLine);
      expect(turnEvents(projection)).toEqual(['turn:started p1', 'turn:completed p1']);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
    });
  });

  it('ends a bare settled turn the rail runs again by its own end, and reads idle after it', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      const restarted = ['turn:started p1', 'turn:completed p1', 'turn:started p1'];
      // Grok still runs P through the resume, and says so before any live record of P: the frame starts it again.
      railRuns('p1');
      expect(turnEvents(projection)).toEqual(restarted);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
      await append(endLine);
      expect(turnEvents(projection)).toEqual([...restarted, 'turn:completed p1']);
      expect(projection.state.activeTurn).toBeUndefined();
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
    });
  });

  it('starts a rail start held behind a bare settled turn the rail runs again, at that turn’s own end', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      const restarted = ['turn:started p1', 'turn:completed p1', 'turn:started p1'];
      railRuns('p1');
      railRuns('q1');
      expect(turnEvents(projection)).toEqual(restarted);
      await append(endLine);
      expect(turnEvents(projection)).toEqual([...restarted, 'turn:completed p1', 'turn:started q1']);
      expect(projection.state.activeTurn?.id).toBe('q1');
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
    });
  });

  it('holds nothing behind a bare settled turn the rail ran again and that ended, whatever comes late', async () => {
    await overLog([userLine, thoughtLine], async (projection, append, railRuns) => {
      railRuns('p1');
      // Its own end took P off the settled turns: a late record of it reopens nothing.
      await append(endLine, thoughtLine);
      railRuns('q1');
      expect(turnEvents(projection).at(-1)).toBe('turn:started q1');
    });
  });

  it('starts what Grok runs during a replay that spans polls at its settle, after every replayed end', async () => {
    // A poll reads P1's start and no further. A long log's replay spans awaited 64 KiB reads, and past 4 MiB polls,
    // and the rail can speak between any two: here, between polls.
    const perPoll = Buffer.byteLength(userLine + thoughtLine);
    const replays: [name: string, records: string[], running: string, replayed: string[]][] = [
      [
        'two ended turns',
        [userLine, thoughtLine, endLine, userLine, thought2Line, end2Line],
        'q1',
        ['turn:started p1', 'turn:completed p1', 'turn:started p2', 'turn:completed p2'],
      ],
      [
        'two dead turns',
        [userLine, thoughtLine, userLine, thought2Line],
        'q1',
        ['turn:started p1', 'turn:started p2', 'turn:completed p2', 'turn:completed p1'],
      ],
      ['its own dead turn', [userLine, thoughtLine, messageLine], 'p1', ['turn:started p1', 'turn:completed p1']],
    ];
    for (const [name, records, running, replayed] of replays) {
      const replayBytes = Buffer.byteLength(records.join(''));
      await overLog(
        records,
        async (projection, append, railRuns) => {
          // Grok runs a prompt, and the rail says so while the log is still replaying.
          railRuns(running);
          expect(turnEvents(projection), name).toEqual(['turn:started p1']);
          for (let read = perPoll; read < replayBytes; read += perPoll) await append();
          // The replay's turns are history: the running prompt starts after every one of their ends, at the settle.
          expect(turnEvents(projection), name).toEqual([...replayed, `turn:started ${running}`]);
          expect(projection.state.activeTurn?.id, name).toBe(running);
          expect(monitorOf(projection.envelopes), name).toMatchObject({ status: 'working' });
        },
        { readChunkBytes: perPoll, maxBytesPerPoll: perPoll },
      );
    }
  });

  it('starts nothing for a rail start heard during a replay that goes on to that prompt’s own end', async () => {
    const perPoll = Buffer.byteLength(userLine + thoughtLine);
    await overLog(
      [userLine, thoughtLine, endLine],
      async (projection, append, railRuns) => {
        // A stale frame names P while the log replays it, and the replay goes on to P's own end, which Grok wrote
        // before the session was opened: P is over, and its start has nothing to start at the settle.
        railRuns('p1');
        await append();
        expect(turnEvents(projection)).toEqual(['turn:started p1', 'turn:completed p1']);
        expect(projection.state.activeTurn).toBeUndefined();
        expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
      },
      { readChunkBytes: perPoll, maxBytesPerPoll: perPoll },
    );
  });

  it('ends a turn the rail started at adoption at its replayed end, so the next one starts at once', async () => {
    await overLog(
      [userLine, thoughtLine, endLine],
      async (projection, _append, railRuns) => {
        // Grok ended P before the session was opened: the next prompt it runs is not held behind P.
        railRuns('q1');
        expect(turnEvents(projection).at(-1)).toBe('turn:started q1');
        expect(projection.state.activeTurn?.id).toBe('q1');
        expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
      },
      // The leader named P running at session/load, and the binding hears that frame at adoption.
      { beforeReplay: (railRuns) => railRuns('p1') },
    );
  });

  it('starts nothing at the settle for a start held at adoption whose turn the replay ended', async () => {
    const thoughtQLine = line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, 'q1');
    const endQLine = line({ sessionUpdate: 'turn_completed', prompt_id: 'q1', stop_reason: 'end_turn' });
    await overLog(
      [userLine, thoughtLine, endLine, userLine, thought2Line, end2Line],
      async (projection, append, railRuns) => {
        // The frame started P1 at adoption, and the replay shows its start again. P1 and P2 both ended before the
        // session was opened, so nothing the rail named runs, and Q is the next turn.
        const replayed = [
          'turn:started p1',
          'turn:started p1',
          'turn:completed p1',
          'turn:started p2',
          'turn:completed p2',
        ];
        expect(turnEvents(projection)).toEqual(replayed);
        railRuns('q1');
        await append(userLine, thoughtQLine, endQLine);
        expect(turnEvents(projection)).toEqual([...replayed, 'turn:started q1', 'turn:completed q1']);
        expect(projection.state.activeTurn).toBeUndefined();
        expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'idle', blockers: [] });
      },
      // The leader ran P1 and then P2, and the binding hears both frames at adoption: P2's start waits behind P1.
      {
        beforeReplay: (railRuns) => {
          railRuns('p1');
          railRuns('p2');
        },
      },
    );
  });

  it('reads a turn the rail started at adoption as working between its records past the settle', async () => {
    const toolOpen = line({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'in_progress' }, 'p1');
    const toolDone = line({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, 'p1');
    await overLog(
      [userLine, thoughtLine],
      async (projection, append, railRuns) => {
        // The log left P open and Grok runs on with it. The settle's end leaves P the open turn, but it retracted the
        // frame's activity: P's live work holds it working, as it holds any reopened turn.
        await append(toolOpen, toolDone);
        expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
        railRuns('q1');
        await append(endLine);
        expect(turnEvents(projection).slice(-2)).toEqual(['turn:completed p1', 'turn:started q1']);
        expect(projection.state.activeTurn?.id).toBe('q1');
      },
      { beforeReplay: (railRuns) => railRuns('p1') },
    );
  });

  it('starts what Grok runs at once over a log with nothing to replay, which no settle follows', async () => {
    await overLog([], async (projection, _append, railRuns) => {
      railRuns('q1');
      expect(turnEvents(projection)).toEqual(['turn:started q1']);
      expect(monitorOf(projection.envelopes)).toMatchObject({ status: 'working' });
    });
  });
});
