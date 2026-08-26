import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEventService,
  agentServiceEventType,
  createAdapterEventCandidate,
  createEnvelopeStamper,
  type AccountUsageFetchResult,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentAdapterSession,
  type ObservationLevel,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { createActionRecorder, isOwnActionV2 } from '@vibecook/puppeteer-record';
import { createWorkspace } from '@vibecook/puppeteer-workspaces';
import { createFileCreationRequestRegistry, type CreationRequestRegistry } from './creation-registry.js';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider } from './types.js';

const host: AgentHost = {
  async spawnTerminal() {
    throw new Error('fake providers do not spawn');
  },
  async automateTerminal() {
    return { accepted: true };
  },
};

const execFileAsync = promisify(execFile);

function testEnvelope(
  event: AgentEvent,
  fields: Partial<Omit<AgentEventEnvelope, 'type' | 'service' | 'event'>> = {},
): AgentEventEnvelope {
  return {
    sequence: 1,
    sessionId: 'test-native',
    timestamp: new Date().toISOString(),
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    ...fields,
    type: agentServiceEventType(event),
    service: agentEventService(event),
    event,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-repo-'));
  const run = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
  await run('init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await run('add', '.');
  await run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return repo;
}

function fakeProvider(
  kind: string,
  handles: Map<string, { emit: (event: AgentEventEnvelope) => void }>,
  observation: ObservationLevel = 'structured',
): AgentProvider {
  let counter = 0;
  return {
    kind,
    async createSession(): Promise<AgentAdapterSession> {
      const n = ++counter;
      const runtimeSessionId = `${kind}-runtime-${n}`;
      const listeners = new Set<(event: AgentEventEnvelope) => void>();
      handles.set(runtimeSessionId, {
        emit: (event) => listeners.forEach((listener) => listener(event)),
      });
      return {
        sessionId: `${kind}-native-${n}`,
        runtimeSessionId,
        observationLevel: () => observation,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async submitPrompt() {
          return { status: 'confirmed', turnId: `${kind}-turn` };
        },
        async dispose() {},
      };
    },
  };
}

function preparableProvider(
  kind: string,
  hooks: {
    prepareCount: number;
    adoptCount: number;
    disposeCount: number;
    preparedCwd?: string;
    preparedRuntimeRunId?: string;
    adoptionGate?: Promise<void>;
  },
): AgentProvider {
  const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
  const managed = fakeProvider(kind, handles);
  return {
    ...managed,
    async prepareSession(options) {
      hooks.prepareCount += 1;
      hooks.preparedCwd = options.cwd;
      hooks.preparedRuntimeRunId = options.runtimeRunId;
      const sessionId = `${kind}-prepared-${hooks.prepareCount}`;
      let disposed = false;
      let adopted: AgentAdapterSession | undefined;
      return {
        sessionId,
        launch: {
          command: `/opt/${kind}`,
          args: ['--session-id', sessionId],
          cwd: options.cwd,
          env: { PREPARED_TOKEN: 'secret' },
        },
        async adopt(runtimeSessionId) {
          hooks.adoptCount += 1;
          await hooks.adoptionGate;
          if (adopted) return adopted;
          const listeners = new Set<(event: AgentEventEnvelope) => void>();
          adopted = {
            sessionId,
            runtimeSessionId,
            observationLevel: () => 'structured',
            onEvent(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            async submitPrompt() {
              return { status: 'confirmed', turnId: `${kind}-turn` };
            },
            async dispose() {
              if (disposed) return;
              disposed = true;
              hooks.disposeCount += 1;
            },
          };
          return adopted!;
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          hooks.disposeCount += 1;
        },
      };
    },
  };
}

function sessionHarness(
  sessionId: string,
  runtimeSessionId: string,
): {
  session: AgentAdapterSession;
  emit: (event: AgentEventEnvelope) => void;
} {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  return {
    session: {
      sessionId,
      runtimeSessionId,
      observationLevel: () => 'structured',
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async submitPrompt() {
        return { status: 'confirmed' };
      },
      async dispose() {},
    },
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}

function standaloneSession(sessionId: string, runtimeSessionId: string): AgentAdapterSession {
  return sessionHarness(sessionId, runtimeSessionId).session;
}

describe('createAgentRuntime', () => {
  it('spawns one Agent instance and observes namespaced service events through Agent.on()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-agent-api-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [fakeProvider('one', handles)] });

    const spawned = await runtime.spawn({ agent: 'one', cwd: root });
    if ('error' in spawned) throw new Error(spawned.error.message);

    expect(runtime.agent(spawned.terminalSessionId)).toBe(spawned);
    expect(runtime.agent(spawned.runtimeRunId)).toBe(spawned);
    expect('accept' in spawned).toBe(false);
    expect('dispose' in spawned).toBe(false);

    const stateEvents: string[] = [];
    const contextEvents: number[] = [];
    const conversationEvents: string[] = [];
    let stateSeenByListener: string | undefined;
    let conversationSeenByListener: string | undefined;
    spawned.on('state:*', (envelope) => stateEvents.push(envelope.type));
    spawned.on('state:turn-started', () => {
      stateSeenByListener = spawned.state.lifecycle;
    });
    spawned.on('context-window:updated', (envelope) => contextEvents.push(envelope.event.usedTokens));
    spawned.on('conversation:*', (envelope) => {
      conversationEvents.push(envelope.event.text);
      const assistant = spawned.conversation.items.find(
        (item) => item.kind === 'assistant' && item.markdown === envelope.event.text,
      );
      if (assistant?.kind === 'assistant') conversationSeenByListener = assistant.markdown;
    });

    const source = handles.get(spawned.terminalSessionId);
    source?.emit(testEnvelope({ type: 'turn.started', turnId: 'turn-1', prompt: 'hello' }));
    source?.emit(testEnvelope({ type: 'context-window.updated', usedTokens: 25, capacityTokens: 100 }));
    source?.emit(
      testEnvelope({
        type: 'assistant.message',
        turnId: 'turn-1',
        text: 'hi',
        final: true,
        displayOnly: false,
      }),
    );
    source?.emit(testEnvelope({ type: 'turn.completed', turnId: 'turn-1' }));

    expect(stateEvents).toEqual(['state:turn-started', 'state:turn-completed']);
    expect(stateSeenByListener).toBe('running');
    expect(contextEvents).toEqual([25]);
    expect(conversationEvents).toEqual(['hi']);
    expect(conversationSeenByListener).toBe('hi');
    expect(spawned.state).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'hi' });
    expect(spawned.conversation.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'hello' }),
        expect.objectContaining({ kind: 'assistant', markdown: 'hi', streaming: false }),
      ]),
    );
    await expect(spawned.submitPrompt({ text: 'again' })).resolves.toMatchObject({ status: 'confirmed' });

    await runtime.dispose();
  });

  it('validates adapter candidates before assigning runtime delivery order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-candidates-'));
    const candidateListeners = new Set<(candidate: AdapterEventCandidate) => void>();
    const errors: Error[] = [];
    const provider: AgentProvider = {
      kind: 'candidate-provider',
      async createSession() {
        return {
          sessionId: 'candidate-native-1',
          runtimeSessionId: 'candidate-runtime-1',
          observationLevel: () => 'structured',
          onEventCandidate(listener) {
            candidateListeners.add(listener);
            return () => candidateListeners.delete(listener);
          },
          onEvent() {
            throw new Error('runtime should prefer candidate ingress');
          },
          async submitPrompt() {
            return { status: 'confirmed' as const };
          },
          async dispose() {},
        };
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      onError: (error) => errors.push(error),
    });
    const spawned = await runtime.spawn({ agent: provider.kind, cwd: root });
    if ('error' in spawned) throw new Error(spawned.error.message);
    const delivered: AgentEventEnvelope[] = [];
    spawned.on('*', (envelope) => delivered.push(envelope));

    const emit = (candidate: AdapterEventCandidate): void => {
      for (const listener of candidateListeners) listener(candidate);
    };
    const started = createAdapterEventCandidate({
      sessionId: 'candidate-native-1',
      timestamp: '2026-08-25T00:00:00.000Z',
      monotonicTime: 10,
      source: 'native-protocol',
      confidence: 'authoritative',
      event: { type: 'turn.started', turnId: 'turn-1' },
    });
    emit({ ...started, sequence: 999 } as AdapterEventCandidate);
    emit({
      ...createAdapterEventCandidate({
        sessionId: 'candidate-native-1',
        timestamp: '2026-08-25T00:00:01.000Z',
        monotonicTime: 11,
        source: 'native-protocol',
        confidence: 'authoritative',
        event: { type: 'context-window.updated', usedTokens: 10, capacityTokens: 100 },
      }),
      event: { type: 'context-window.updated', usedTokens: 'invalid', capacityTokens: 100 },
    } as unknown as AdapterEventCandidate);
    emit(
      createAdapterEventCandidate({
        sessionId: 'candidate-native-1',
        timestamp: '2026-08-25T00:00:02.000Z',
        monotonicTime: 12,
        source: 'native-protocol',
        confidence: 'authoritative',
        event: { type: 'context-window.updated', usedTokens: 20, capacityTokens: 100 },
      }),
    );

    expect(delivered.map((envelope) => envelope.type)).toEqual(['state:turn-started', 'context-window:updated']);
    expect(delivered[1]!.sequence).toBe(delivered[0]!.sequence + 1);
    expect(delivered[0]!.sequence).not.toBe(999);
    expect(errors.some((error) => error.message.includes('Adapter emitted invalid context-window:updated'))).toBe(true);
    await runtime.dispose();
  });

  it('fetches provider-level account usage without a session and coalesces concurrent reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const provider = fakeProvider('codex', handles);
    let release: (() => void) | undefined;
    let calls = 0;
    provider.fetchAccountUsage = async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        status: 'available',
        snapshot: {
          provider: 'codex',
          fetchedAt: '2026-07-23T00:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-protocol', stability: 'documented' },
          limits: [],
        },
      };
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    const first = runtime.accountUsage('codex');
    const second = runtime.accountUsage('codex');
    await vi.waitFor(() => expect(calls).toBe(1));
    release?.();

    await expect(first).resolves.toMatchObject({ status: 'available' });
    await expect(second).resolves.toMatchObject({ status: 'available' });
    expect(runtime.sessionInfo('codex')).toBeUndefined();
    await runtime.dispose();
  });

  it('returns typed unsupported and sanitized unavailable results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-errors-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const unsupported = fakeProvider('acp', handles);
    const broken = fakeProvider('broken', handles);
    broken.fetchAccountUsage = () => {
      throw new Error('native secret detail');
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [unsupported, broken],
    });

    await expect(runtime.accountUsage('missing')).resolves.toEqual({
      status: 'unsupported',
      provider: 'missing',
      message: 'unknown agent provider: missing',
      retryable: false,
    });
    await expect(runtime.accountUsage('acp')).resolves.toEqual({
      status: 'unsupported',
      provider: 'acp',
      message: 'agent provider does not expose account usage: acp',
      retryable: false,
    });
    const failed = await runtime.accountUsage('broken');
    expect(failed).toEqual({
      status: 'unavailable',
      provider: 'broken',
      message: 'account usage fetch failed for broken',
      retryable: true,
    });
    expect(JSON.stringify(failed)).not.toContain('native secret detail');
    await runtime.dispose();
  });

  it('forwards provider push account-usage updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-push-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const provider = fakeProvider('claude', handles);
    const pushListeners = new Set<(result: AccountUsageFetchResult) => void>();
    provider.onAccountUsage = (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const seen: Array<{ agent: string; status: string }> = [];
    const unsubscribe = runtime.onAccountUsage((agent, result) => {
      seen.push({ agent, status: result.status });
    });

    for (const listener of pushListeners) {
      listener({
        status: 'available',
        snapshot: {
          provider: 'claude',
          fetchedAt: '2026-07-23T12:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-statusline', stability: 'documented' },
          limits: [],
        },
      });
    }
    expect(seen).toEqual([{ agent: 'claude', status: 'available' }]);

    unsubscribe();
    for (const listener of pushListeners) {
      listener({
        status: 'available',
        snapshot: {
          provider: 'claude',
          fetchedAt: '2026-07-23T12:01:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-statusline', stability: 'documented' },
          limits: [],
        },
      });
    }
    expect(seen).toHaveLength(1);
    await runtime.dispose();
  });

  it('projects provider replay history from the normalized stream exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-replay-'));
    const sessionId = 'replay-native';
    const runtimeSessionId = 'replay-runtime';
    const stamper = createEnvelopeStamper();
    const stamp = (
      event: AgentEventEnvelope['event'],
      source: AgentEventEnvelope['source'] = 'native-protocol',
      replayed = false,
    ): AgentEventEnvelope =>
      stamper.next({
        sessionId,
        timestamp: new Date().toISOString(),
        monotonicTime: performance.now(),
        source,
        confidence: 'authoritative',
        ...(replayed ? { replay: true } : {}),
        event,
      });
    const replay = [
      stamp({
        type: 'tool.started',
        toolCallId: 'tool-1',
        tool: 'command',
        presentation: { kind: 'command', title: 'Running command' },
      }),
      stamp({
        type: 'tool.completed',
        toolCallId: 'tool-1',
        tool: 'command',
        presentation: { kind: 'command', title: 'Ran command' },
      }),
      stamp({ type: 'adapter.native-event', adapter: 'replay', nativeType: 'future/event' }),
      stamp({ type: 'turn.started', turnId: 'history-turn', prompt: 'Historical question' }),
      stamp(
        {
          type: 'assistant.message',
          messageId: 'history-answer',
          turnId: 'history-turn',
          text: 'Historical answer',
          final: true,
          displayOnly: false,
        },
        'native-transcript',
        true,
      ),
      stamp({ type: 'turn.completed', turnId: 'history-turn' }),
    ];
    const provider: AgentProvider = {
      kind: 'replay',
      async createSession() {
        return {
          sessionId,
          runtimeSessionId,
          observationLevel: () => 'structured',
          onEvent(listener) {
            for (const envelope of replay) listener(envelope);
            return () => undefined;
          },
          async submitPrompt() {
            return { status: 'confirmed' };
          },
          async dispose() {},
        };
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const projected: string[] = [];
    runtime.onEvent((_id, envelope) => projected.push(envelope.event.type));

    const created = await runtime.createSession({ agent: 'replay', cwd: root });
    if ('error' in created) throw new Error('unexpected create failure');

    expect(runtime.sessionState(runtimeSessionId)?.counters).toMatchObject({
      toolsCompleted: 1,
      toolsFailed: 0,
      unknownEvents: 1,
    });
    expect(projected.slice(0, replay.length)).toEqual([
      'tool.started',
      'tool.completed',
      'adapter.native-event',
      'turn.started',
      'assistant.message',
      'turn.completed',
    ]);
    expect(runtime.conversationSnapshot(runtimeSessionId)?.items).toEqual([
      expect.objectContaining({ kind: 'activity', activity: 'command', status: 'completed' }),
      expect.objectContaining({ kind: 'user', text: 'Historical question' }),
      expect.objectContaining({ kind: 'assistant', markdown: 'Historical answer', streaming: false }),
    ]);
    await runtime.dispose();
  });

  it('tracks provider cwd/model and resolves the matching live Git branch', async () => {
    const first = await makeRepo();
    const second = await makeRepo();
    await execFileAsync('git', ['-C', second, 'checkout', '-b', 'feature/environment']);
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: first,
      providers: [fakeProvider('environment-provider', handles)],
    });
    const created = await runtime.createSession({ agent: 'environment-provider', cwd: first });
    if ('error' in created) throw new Error('unexpected create failure');

    await vi.waitFor(() => {
      expect(runtime.sessionState(created.runtimeSessionId)?.environment.git?.value).toMatchObject({ branch: 'main' });
    });

    handles.get(created.runtimeSessionId)!.emit(
      testEnvelope(
        {
          type: 'session.environment.updated',
          currentCwd: second,
          model: { id: 'model-2', displayName: 'Model Two' },
        },
        { sequence: 1, sessionId: created.sessionId },
      ),
    );
    expect(runtime.sessionState(created.runtimeSessionId)?.environment.git).toBeUndefined();
    await vi.waitFor(() => {
      expect(runtime.sessionState(created.runtimeSessionId)?.environment).toMatchObject({
        currentCwd: { value: second, source: 'native-protocol', confidence: 'authoritative' },
        model: { value: { id: 'model-2', displayName: 'Model Two' } },
        git: { value: { branch: 'feature/environment' }, source: 'runtime', confidence: 'derived' },
      });
    });
    await runtime.dispose();
  });

  it('projects native-log assistant messages instead of filtering them as structured duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-native-log-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('grok-like', handles, 'native-log')],
    });
    const created = await runtime.createSession({ agent: 'grok-like' });
    if ('error' in created) throw new Error('unexpected create failure');
    const emit = handles.get(created.runtimeSessionId)!.emit;
    const envelope = (sequence: number, event: AgentEventEnvelope['event']): AgentEventEnvelope =>
      testEnvelope(event, {
        sequence,
        sessionId: created.sessionId,
        nativeSessionId: 'selected-native-session',
        promptId: 'prompt-1',
        turnId: 'prompt-1',
        monotonicTime: sequence,
        source: 'native-transcript',
      });

    emit(envelope(1, { type: 'turn.started', turnId: 'prompt-1', prompt: 'hello' }));
    emit(
      envelope(2, {
        type: 'assistant.message',
        messageId: 'grok-assistant:prompt-1',
        text: 'hi',
        final: false,
      }),
    );
    emit(envelope(3, { type: 'turn.completed', turnId: 'prompt-1' }));

    expect(runtime.conversationSnapshot(created.runtimeSessionId)).toMatchObject({
      responding: false,
      items: [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', markdown: 'hi', streaming: false },
      ],
    });
    expect(runtime.sessionInfo(created.runtimeSessionId)?.sessionId).toBe('selected-native-session');
    expect(runtime.sessionInfo(created.runtimeSessionId)).toMatchObject({
      runtimeRunId: created.runtimeRunId,
      runtimeEpoch: 1,
      terminalSessionId: created.runtimeSessionId,
      nativeSession: { namespace: 'grok-like', id: 'selected-native-session' },
      nativeSessionRevision: 2,
    });
    await runtime.dispose();
  });

  it('records native-session corrections without changing run or terminal identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-native-correction-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-native-correction-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', handles)],
      features: { agentMonitorStateV2: true },
    });
    const created = await runtime.createSession({ agent: 'one' });
    if ('error' in created) throw new Error('unexpected create failure');
    const initialNativeSessionId = created.nativeSession.id;

    handles.get(created.terminalSessionId)!.emit(
      testEnvelope(
        { type: 'session.started', nativeSessionId: 'one-native-corrected' },
        {
          eventId: 'native-session-rotated',
          sequence: 1,
          sessionId: created.sessionId,
          nativeSessionId: 'one-native-corrected',
          timestamp: '2026-08-16T20:00:00.000Z',
          monotonicTime: 1,
        },
      ),
    );

    const correlations = (await recorder.read()).filter(
      (action) => isOwnActionV2(action) && action.type === 'native-session.correlated',
    );
    expect(correlations).toHaveLength(2);
    expect(correlations[0]).toMatchObject({
      runtimeRunId: created.runtimeRunId,
      terminalSessionId: created.terminalSessionId,
      nativeSessionRevision: 1,
      nativeSession: { id: initialNativeSessionId },
    });
    expect(correlations[1]).toMatchObject({
      runtimeRunId: created.runtimeRunId,
      terminalSessionId: created.terminalSessionId,
      nativeSessionRevision: 2,
      nativeSession: { id: 'one-native-corrected' },
      correctionOfRecordId: correlations[0]!.recordId,
      effectiveAt: '2026-08-16T20:00:00.000Z',
      evidence: [{ namespace: 'one', id: 'native-session-rotated' }],
    });
    expect(runtime.sessionInfo(created.terminalSessionId)).toMatchObject({
      runtimeRunId: created.runtimeRunId,
      terminalSessionId: created.terminalSessionId,
      nativeSession: { id: 'one-native-corrected' },
    });
    expect(runtime.monitorState(created.runtimeRunId)?.session.nativeSessionId).toBe('one-native-corrected');
    await runtime.dispose();
  });

  it('drives different providers through one create/observe/control/exit surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-'));
    const one = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-one-'));
    const two = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-two-'));
    const recorder = createActionRecorder({ path: join(root, 'actions.jsonl') });
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', handles), fakeProvider('two', handles)],
    });

    const first = await runtime.createSession({ agent: 'one', cwd: one });
    const second = await runtime.createSession({ agent: 'two', cwd: two });
    expect('error' in first).toBe(false);
    expect('error' in second).toBe(false);
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');
    expect(first).toMatchObject({ agent: 'one', sessionId: 'one-native-1', runtimeSessionId: 'one-runtime-1' });
    expect(second).toMatchObject({ agent: 'two', sessionId: 'two-native-1', runtimeSessionId: 'two-runtime-1' });

    const observed: string[] = [];
    runtime.onEvent((id, envelope) => observed.push(`${id}:${envelope.event.type}`));
    handles
      .get(first.runtimeSessionId)!
      .emit(testEnvelope({ type: 'session.ready' }, { sequence: 1, sessionId: first.sessionId, source: 'runtime' }));
    expect(observed).toEqual(['one-runtime-1:session.ready']);
    handles
      .get(first.runtimeSessionId)!
      .emit(
        testEnvelope(
          { type: 'assistant.message', text: 'duplicate transcript copy' },
          { sequence: 2, sessionId: first.sessionId, monotonicTime: 2, source: 'native-transcript' },
        ),
      );
    expect(observed).toEqual(['one-runtime-1:session.ready']);

    handles.get(first.runtimeSessionId)!.emit(
      testEnvelope(
        { type: 'turn.started', turnId: 'one-turn', prompt: 'hello' },
        {
          sequence: 3,
          sessionId: first.sessionId,
          turnId: 'one-turn',
          monotonicTime: 3,
          source: 'native-hook',
        },
      ),
    );
    handles.get(first.runtimeSessionId)!.emit(
      testEnvelope(
        { type: 'assistant.message', messageId: 'm1', text: '**hi**', final: false },
        {
          sequence: 4,
          sessionId: first.sessionId,
          turnId: 'one-turn',
          monotonicTime: 4,
          source: 'native-hook',
        },
      ),
    );
    expect(runtime.conversationSnapshot(first.runtimeSessionId)).toMatchObject({
      responding: true,
      items: [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', markdown: '**hi**', streaming: true },
      ],
    });

    expect(await runtime.submitPrompt(second.runtimeSessionId, { text: 'hello' })).toEqual({
      status: 'confirmed',
      turnId: 'two-turn',
    });
    const final = await runtime.handleProcessExit(second.runtimeSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });
    expect(final?.runtimeSessionId).toBe(second.runtimeSessionId);
    expect(runtime.sessionInfo(second.runtimeSessionId)).toBeUndefined();
    const secondRunActions = (await recorder.read()).filter(
      (action) => isOwnActionV2(action) && action.runtimeRunId === second.runtimeRunId,
    );
    expect(secondRunActions.map((action) => action.type)).toEqual([
      'run.allocated',
      'workspace.allocated',
      'workspace.baseline',
      'process.spawned',
      'native-session.correlated',
      'injection.receipt',
      'process.exited',
      'workspace.finalized',
    ]);

    await runtime.dispose();
  });

  it('keeps v2 records private while preserving lifecycle evidence', async () => {
    const root = await makeRepo();
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-private-records-'));
    const path = join(recordRoot, 'own-actions.jsonl');
    const recorder = createActionRecorder({ path });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
    });
    const remoteUrl = 'https://user:credential-password@example.invalid/private.git';
    const created = await runtime.createSession({
      agent: 'one',
      agentOptions: { token: 'provider-credential-token', environment: { SECRET: 'environment-secret' }, remoteUrl },
    });
    if ('error' in created) throw new Error('unexpected create failure');

    await writeFile(join(root, 'credential-source.ts'), 'raw-diff-secret\n');
    await expect(
      runtime.submitPrompt(created.terminalSessionId, { text: 'private prompt credential' }),
    ).resolves.toEqual({ status: 'confirmed', turnId: 'one-turn' });
    await runtime.handleProcessExit(created.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' });

    const contents = await readFile(path, 'utf8');
    for (const excluded of [
      'provider-credential-token',
      'environment-secret',
      remoteUrl,
      'private prompt credential',
      'raw-diff-secret',
      'credential-source.ts',
      root,
    ]) {
      expect(contents).not.toContain(excluded);
    }
    expect(await recorder.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'injection.receipt', promptPersistence: 'metadata-only' }),
        expect.objectContaining({ type: 'workspace.finalized', filesTouchedCount: 1 }),
      ]),
    );
    expect((await recorder.read()).every(isOwnActionV2)).toBe(true);
    await runtime.dispose();
  });

  it('persists policy-safe workspace provenance with reachable commits and no local paths', async () => {
    const root = await makeRepo();
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provenance-worktrees-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provenance-records-'));
    const path = join(recordRoot, 'own-actions.jsonl');
    const recorder = createActionRecorder({ path });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      features: { workspaceProvenanceV2: true },
    });
    const created = await runtime.createSession({
      agent: 'one',
      workspace: { mode: 'worktree', workspacesRoot },
    });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(created.workspace).toMatchObject({
      workspaceInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      id: created.workspace.workspaceInstanceId,
      isolation: 'managed-isolated',
      baselineCompleteness: 'complete',
      repositoryDigest: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });

    await writeFile(join(created.workspace.root, 'private-file-name.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['-C', created.workspace.root, 'add', '.']);
    await execFileAsync('git', [
      '-C',
      created.workspace.root,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      'session work',
    ]);
    const final = await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });
    expect(final).toMatchObject({ retained: false, metadata: { provenance: { outcome: 'complete' } } });

    const records = (await recorder.read()).filter(isOwnActionV2);
    expect(records.find((record) => record.type === 'workspace.allocated')).toMatchObject({
      repositoryKind: 'git',
      repositoryDigest: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      isolation: 'managed-isolated',
      knownConcurrentClaims: 0,
    });
    expect(records.find((record) => record.type === 'workspace.baseline')).toMatchObject({
      capturedAt: expect.any(String),
      git: { state: 'attached', headRef: expect.stringContaining('refs/heads/puppeteer/') },
    });
    expect(records.find((record) => record.type === 'workspace.finalized')).toMatchObject({
      quality: 'strong',
      completeness: 'complete',
      outcome: 'complete',
      trigger: 'clean-exit',
      cleanupOutcome: 'removed',
      retained: false,
      filesTouchedCount: 1,
      insertions: 1,
      reachableCommits: {
        relation: 'fast-forward',
        commits: [expect.stringMatching(/^[0-9a-f]+$/)],
        totalCount: 1,
        truncated: false,
      },
      filesFingerprint: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain(created.workspace.root);
    expect(persisted).not.toContain('private-file-name.ts');
    await runtime.dispose();
  });

  it('carries cooperative concurrency into shared-workspace quality and interference', async () => {
    const root = await makeRepo();
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-concurrency-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      features: { workspaceProvenanceV2: true },
    });
    const first = await runtime.createSession({ agent: 'one' });
    const second = await runtime.createSession({ agent: 'one' });
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(second.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' });
    await runtime.handleProcessExit(first.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' });

    const secondRecords = (await recorder.read()).filter(
      (record) => isOwnActionV2(record) && record.runtimeRunId === second.runtimeRunId,
    );
    expect(secondRecords.find((record) => record.type === 'workspace.allocated')).toMatchObject({
      isolation: 'shared',
      knownConcurrentClaims: 1,
    });
    expect(secondRecords.find((record) => record.type === 'workspace.finalized')).toMatchObject({
      quality: 'estimated',
      knownConcurrentClaims: 1,
      interference: [expect.objectContaining({ kind: 'known-concurrent-claim', count: 1 })],
    });
    await runtime.dispose();
  });

  it('does not let recorder degradation reject prompts or process cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-recorder-failure-'));
    const fileAsParent = join(root, 'not-a-directory');
    await writeFile(fileAsParent, 'file');
    const recorder = createActionRecorder({ path: join(fileAsParent, 'own-actions.jsonl') });
    const readiness: string[] = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
    });
    runtime.onRecordingStatus((status) => readiness.push(status.readiness));

    const created = await runtime.createSession({ agent: 'one' });
    if ('error' in created) throw new Error('recorder failure leaked into session creation');
    await expect(runtime.submitPrompt(created.terminalSessionId, { text: 'still runs' })).resolves.toMatchObject({
      status: 'confirmed',
    });
    await expect(
      runtime.handleProcessExit(created.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' }),
    ).resolves.toMatchObject({ runtimeRunId: created.runtimeRunId });

    expect(runtime.recordingStatus()).toMatchObject({ readiness: 'degraded', failureCount: expect.any(Number) });
    expect(readiness).toContain('degraded');
    expect(runtime.sessionInfo(created.terminalSessionId)).toBeUndefined();
    await runtime.dispose();
  });

  it('allows direct concurrency and enforces exclusive claims independently of provider', async () => {
    const root = await makeRepo();
    const roots = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-worktrees-'));
    const nested = join(root, 'nested');
    await mkdir(nested);
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', handles), fakeProvider('two', handles)],
    });

    const directOne = await runtime.createSession({ agent: 'one' });
    const directTwo = await runtime.createSession({ agent: 'two', workspace: { mode: 'direct', path: nested } });
    expect('error' in directOne).toBe(false);
    expect('error' in directTwo).toBe(false);
    expect(await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });

    if ('error' in directOne || 'error' in directTwo) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(directOne.runtimeSessionId, { exitCode: 0, signal: null, reason: 'completed' });
    expect(await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    await runtime.handleProcessExit(directTwo.runtimeSessionId, { exitCode: 0, signal: null, reason: 'completed' });

    const exclusive = await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } });
    expect('error' in exclusive).toBe(false);
    expect(await runtime.createSession({ agent: 'two' })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    expect(await runtime.createSession({ agent: 'two', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    expect(
      'error' in
        (await runtime.createSession({
          agent: 'two',
          workspace: { mode: 'worktree', workspacesRoot: roots },
        })),
    ).toBe(false);
    expect(await runtime.createSession({ agent: 'missing' })).toMatchObject({
      runtimeEpoch: 1,
      error: { code: 'AGENT_NOT_FOUND', message: 'unknown agent provider: missing' },
    });

    await runtime.dispose();
  }, 20_000);

  it('reserves an exclusive claim before asynchronous provider creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-atomic-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void; input: number[] }>();
    const inner = fakeProvider('one', handles);
    let signalStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
    const provider: AgentProvider = {
      ...inner,
      async createSession(options) {
        signalStarted();
        await providerGate;
        return inner.createSession(options);
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    const firstPending = runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } });
    await started;
    expect(await runtime.createSession({ agent: 'one' })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    releaseProvider();
    expect('error' in (await firstPending)).toBe(false);

    await runtime.dispose();
  });

  it('passes provider-owned launch options through without interpreting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-options-'));
    let received: unknown;
    const provider: AgentProvider = {
      kind: 'one',
      async createSession(options) {
        received = options.agentOptions;
        return fakeProvider('one', new Map()).createSession(options);
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    const result = await runtime.createSession({
      agent: 'one',
      agentOptions: { futureProviderFlag: true },
    });

    expect('error' in result).toBe(false);
    expect(received).toEqual({ futureProviderFlag: true });
    await runtime.dispose();
  });

  it('coalesces concurrent idempotent creation into one workspace and provider invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-idempotent-source-'));
    await writeFile(join(root, 'file.txt'), 'source');
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-idempotent-copies-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-idempotent-registry-'));
    const inner = fakeProvider('one', new Map());
    let calls = 0;
    let signalStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
    const provider: AgentProvider = {
      ...inner,
      async createSession(options) {
        calls += 1;
        signalStarted();
        await providerGate;
        return inner.createSession(options);
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const request = {
      agent: 'one',
      creationRequestId: 'create-one',
      workspace: { mode: 'copy' as const, workspacesRoot },
      agentOptions: { model: 'one-model' },
    };

    const firstPending = runtime.createSession(request);
    await started;
    const secondPending = runtime.createSession(request);
    expect(calls).toBe(1);
    expect(await readdir(workspacesRoot)).toHaveLength(1);
    releaseProvider();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(second).toEqual(first);
    if ('error' in first) throw new Error('unexpected create failure');
    expect(first).toMatchObject({
      runtimeEpoch: 1,
      terminalSessionId: first.runtimeSessionId,
      externalRefs: [],
    });
    expect(runtime.runtimeRunInfo(first.runtimeRunId)).toMatchObject({ status: 'active' });
    await runtime.dispose();
  });

  it('links run allocation evidence to the winning durable creation claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-claim-evidence-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-claim-evidence-registry-'));
    const recordDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-claim-evidence-records-'));
    const recordPath = join(recordDirectory, 'own-actions.jsonl');
    const backingRegistry = createFileCreationRequestRegistry({ directory: registryDirectory });
    let winningRef: Awaited<ReturnType<CreationRequestRegistry['claim']>>['claim']['ref'] | undefined;
    const creationRegistry: CreationRequestRegistry = {
      async claim(input) {
        const result = await backingRegistry.claim(input);
        winningRef = result.claim.ref;
        return result;
      },
      markTerminal: (input) => backingRegistry.markTerminal(input),
      incrementRuntimeEpoch: (input) => backingRegistry.incrementRuntimeEpoch(input),
    };
    const recorder = createActionRecorder({ path: recordPath });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      creationRegistry,
    });

    const created = await runtime.createSession({
      agent: 'one',
      creationRequestId: 'claim-evidence-one',
      externalRefs: [{ namespace: 'test', kind: 'caller', id: 'caller-one' }],
    });
    if ('error' in created) throw new Error('unexpected create failure');
    const allocation = (await recorder.read()).find(
      (action) =>
        isOwnActionV2(action) && action.type === 'run.allocated' && action.runtimeRunId === created.runtimeRunId,
    );
    expect(winningRef).toBeDefined();
    expect(allocation).toMatchObject({
      schemaVersion: 2,
      runtimeEpoch: 1,
      creationClaim: winningRef,
      externalRefs: [{ namespace: 'test', kind: 'caller', id: 'caller-one' }],
    });
    expect(runtime.runtimeRunInfo(created.runtimeRunId)?.creationClaim).toEqual(winningRef);

    if (!allocation || !isOwnActionV2(allocation)) throw new Error('missing allocation record');
    const restartedRecorder = createActionRecorder({ path: recordPath });
    await expect(restartedRecorder.recordV2(allocation)).resolves.toMatchObject({ status: 'duplicate' });
    const physicalAllocations = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { recordId?: string })
      .filter((record) => record.recordId === allocation.recordId);
    expect(physicalAllocations).toHaveLength(1);
    await runtime.dispose();
  });

  it('rejects a conflicting in-flight request id without another workspace or provider side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-conflict-source-'));
    await writeFile(join(root, 'file.txt'), 'source');
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-conflict-copies-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-conflict-registry-'));
    const inner = fakeProvider('one', new Map());
    let calls = 0;
    let signalStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
    const provider: AgentProvider = {
      ...inner,
      async createSession(options) {
        calls += 1;
        signalStarted();
        await providerGate;
        return inner.createSession(options);
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const base = {
      agent: 'one',
      creationRequestId: 'same-request',
      workspace: { mode: 'copy' as const, workspacesRoot },
    };

    const firstPending = runtime.createSession({ ...base, title: 'first' });
    await started;
    const conflict = await runtime.createSession({ ...base, title: 'different' });
    expect(conflict).toMatchObject({ error: { code: 'CREATION_REQUEST_CONFLICT' } });
    expect(calls).toBe(1);
    expect(await readdir(workspacesRoot)).toHaveLength(1);
    releaseProvider();
    const first = await firstPending;
    if ('error' in first || !('error' in conflict)) throw new Error('unexpected idempotency result');
    expect(conflict.runtimeRunId).toBe(first.runtimeRunId);
    await runtime.dispose();
  });

  it('returns the persisted run allocation on a new host without spawning it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-recovery-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-recovery-registry-'));
    let firstCalls = 0;
    let secondCalls = 0;
    const firstInner = fakeProvider('one', new Map());
    const secondInner = fakeProvider('one', new Map());
    const firstProvider: AgentProvider = {
      ...firstInner,
      async createSession(options) {
        firstCalls += 1;
        return firstInner.createSession(options);
      },
    };
    const secondProvider: AgentProvider = {
      ...secondInner,
      async createSession(options) {
        secondCalls += 1;
        return secondInner.createSession(options);
      },
    };
    const request = { agent: 'one', creationRequestId: 'recover-one' };
    const firstRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [firstProvider],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const first = await firstRuntime.createSession(request);
    if ('error' in first) throw new Error('unexpected create failure');

    const recoveredRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [secondProvider],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const retry = await recoveredRuntime.createSession(request);
    expect(retry).toMatchObject({
      runtimeRunId: first.runtimeRunId,
      runtimeEpoch: 1,
      error: { code: 'CREATION_REQUEST_RECOVERY_REQUIRED' },
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    await recoveredRuntime.dispose();
    await firstRuntime.dispose();
  });

  it('returns the persisted terminal outcome instead of recreating completed work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-terminal-retry-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-terminal-registry-'));
    const request = { agent: 'one', creationRequestId: 'terminal-one' };
    const firstRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', new Map())],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const created = await firstRuntime.createSession(request);
    if ('error' in created) throw new Error('unexpected create failure');
    await firstRuntime.handleProcessExit(created.terminalSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });

    let calls = 0;
    const provider = fakeProvider('one', new Map());
    const retryRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [
        {
          ...provider,
          async createSession(options) {
            calls += 1;
            return provider.createSession(options);
          },
        },
      ],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    expect(await retryRuntime.createSession(request)).toMatchObject({
      runtimeRunId: created.runtimeRunId,
      error: { code: 'CREATION_REQUEST_TERMINAL' },
      terminalOutcome: { kind: 'closed', reason: 'process-exit' },
    });
    expect(calls).toBe(0);
    await retryRuntime.dispose();
    await firstRuntime.dispose();
  });

  it('fails idempotent creation before workspace/provider work when no durable registry is available', async () => {
    let calls = 0;
    const provider = fakeProvider('one', new Map());
    const runtime = createAgentRuntime({
      host,
      defaultCwd: '/path-that-must-not-be-opened',
      providers: [
        {
          ...provider,
          async createSession(options) {
            calls += 1;
            return provider.createSession(options);
          },
        },
      ],
    });

    const result = await runtime.createSession({ agent: 'one', creationRequestId: 'needs-durability' });
    expect(result).toMatchObject({
      runtimeEpoch: 1,
      error: { code: 'CREATION_CLAIM_STORE_UNAVAILABLE' },
    });
    expect(calls).toBe(0);
    expect(runtime.runtimeRunInfo(result.runtimeRunId)).toMatchObject({ status: 'terminal' });
    await runtime.dispose();
  });

  it('rejects non-JSON provider options only when idempotency requires a deterministic fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-fingerprint-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-fingerprint-registry-'));
    let calls = 0;
    const inner = fakeProvider('one', new Map());
    const provider: AgentProvider = {
      ...inner,
      async createSession(options) {
        calls += 1;
        return inner.createSession(options);
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const agentOptions = { callback: () => undefined };

    expect(
      await runtime.createSession({ agent: 'one', creationRequestId: 'fingerprinted', agentOptions }),
    ).toMatchObject({ error: { code: 'CREATION_REQUEST_NOT_FINGERPRINTABLE' } });
    expect(calls).toBe(0);
    expect('error' in (await runtime.createSession({ agent: 'one', agentOptions }))).toBe(false);
    expect(calls).toBe(1);
    await runtime.dispose();
  });

  it('returns stable run identity for workspace and provider creation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-failures-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-failure-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    let calls = 0;
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      features: { workspaceProvenanceV2: true },
      providers: [
        {
          kind: 'broken',
          async createSession() {
            calls += 1;
            throw new Error('provider secret detail');
          },
        },
      ],
    });

    const workspaceFailure = await runtime.createSession({
      agent: 'broken',
      workspace: { mode: 'direct', path: join(root, 'missing') },
    });
    expect(workspaceFailure).toMatchObject({ runtimeEpoch: 1, error: { code: 'WORKSPACE_CREATE_FAILED' } });
    expect(runtime.runtimeRunInfo(workspaceFailure.runtimeRunId)).toMatchObject({ status: 'terminal' });
    expect(calls).toBe(0);

    const providerFailure = await runtime.createSession({ agent: 'broken' });
    expect(providerFailure).toMatchObject({ runtimeEpoch: 1, error: { code: 'AGENT_SESSION_CREATE_FAILED' } });
    expect(JSON.stringify(providerFailure)).not.toContain('provider secret detail');
    expect(runtime.runtimeRunInfo(providerFailure.runtimeRunId)).toMatchObject({ status: 'terminal' });
    expect(calls).toBe(1);
    const records = (await recorder.read()).filter(isOwnActionV2);
    expect(
      records.filter((record) => record.runtimeRunId === workspaceFailure.runtimeRunId).map((record) => record.type),
    ).toEqual(['run.allocated', 'run.start-failed']);
    expect(
      records.filter((record) => record.runtimeRunId === providerFailure.runtimeRunId).map((record) => record.type),
    ).toEqual([
      'run.allocated',
      'workspace.allocated',
      'workspace.baseline',
      'run.start-failed',
      'workspace.finalized',
    ]);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.start-failed', stage: 'workspace', code: 'WORKSPACE_CREATE_FAILED' }),
        expect.objectContaining({
          type: 'run.start-failed',
          stage: 'process-spawn',
          code: 'AGENT_SESSION_CREATE_FAILED',
        }),
        expect.objectContaining({
          type: 'workspace.finalized',
          runtimeRunId: providerFailure.runtimeRunId,
          trigger: 'preparation-failure',
          cleanupOutcome: 'not-applicable',
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain('provider secret detail');
    await runtime.dispose();
  });

  it('keeps run and terminal registries distinct and preserves provider event identity while restamping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-event-identity-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [fakeProvider('one', handles)] });
    const observed: Array<{
      terminalSessionId: string;
      eventId: string;
      runtimeRunId: string;
      runtimeEpoch: number;
      sequence: number;
      sourceEventRef: unknown;
    }> = [];
    runtime.onEvent((terminalSessionId, envelope) => {
      observed.push({
        terminalSessionId,
        eventId: envelope.eventId,
        runtimeRunId: envelope.runtimeRunId,
        runtimeEpoch: envelope.runtimeEpoch,
        sequence: envelope.sequence,
        sourceEventRef: envelope.sourceEventRef,
      });
    });
    const created = await runtime.createSession({ agent: 'one' });
    if ('error' in created) throw new Error('unexpected create failure');

    expect(runtime.sessionInfo(created.terminalSessionId)?.runtimeRunId).toBe(created.runtimeRunId);
    expect(runtime.sessionInfo(created.runtimeRunId)).toBeUndefined();
    expect(runtime.runtimeRunInfo(created.runtimeRunId)?.terminalSessionId).toBe(created.terminalSessionId);
    expect(runtime.runtimeRunInfo(created.terminalSessionId)).toBeUndefined();

    handles.get(created.terminalSessionId)!.emit(
      testEnvelope(
        { type: 'session.ready' },
        {
          eventId: 'provider-event-1',
          sourceEventRef: {
            namespace: 'spaghetti',
            eventId: 'provider-event-1',
            revisionKey: 'response-1:4',
            sourceGeneration: 3,
            cursorStart: 100,
            cursorEnd: 144,
          },
          sequence: 99,
          sessionId: created.sessionId,
          timestamp: '2026-08-16T18:00:00.000Z',
          monotonicTime: 99,
        },
      ),
    );
    expect(observed.at(-1)).toEqual({
      terminalSessionId: created.terminalSessionId,
      eventId: expect.stringMatching(/^source:[0-9a-f]{64}$/),
      runtimeRunId: created.runtimeRunId,
      runtimeEpoch: 1,
      sequence: expect.any(Number),
      sourceEventRef: {
        namespace: 'spaghetti',
        eventId: 'provider-event-1',
        revisionKey: 'response-1:4',
        sourceGeneration: 3,
        cursorStart: 100,
        cursorEnd: 144,
      },
    });
    expect(observed.at(-1)!.sequence).not.toBe(99);
    await runtime.dispose();
  });

  it('does not alias run and terminal registries even when their opaque ids are equal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-equal-identities-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-equal-registry-'));
    const creationRegistry = createFileCreationRequestRegistry({ directory: registryDirectory });
    await creationRegistry.claim({
      creationRequestId: 'equal-identities',
      canonicalFingerprint: '{}',
      proposedRuntimeRunId: 'same-opaque-id',
      operation: 'create',
    });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', new Map())],
      creationRegistry,
    });
    const session = standaloneSession('native-one', 'same-opaque-id');
    const workspace = await createWorkspace({ mode: 'direct', path: root });
    const restored = await runtime.restoreSession({
      creationRequestId: 'equal-identities',
      runtimeRunId: 'same-opaque-id',
      expectedRuntimeEpoch: 1,
      agent: 'one',
      session,
      workspace,
    });
    if ('error' in restored) throw new Error('unexpected restore failure');

    expect(runtime.sessionInfo('same-opaque-id')).toMatchObject({ terminalSessionId: 'same-opaque-id' });
    expect(runtime.runtimeRunInfo('same-opaque-id')).toMatchObject({
      runtimeRunId: 'same-opaque-id',
      status: 'active',
    });
    expect(runtime.sessionInfo('same-opaque-id')).not.toBe(runtime.runtimeRunInfo('same-opaque-id'));
    await runtime.dispose();
  });

  it('keeps two resumed runs distinct while joining them through one native session claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-resume-identity-'));
    let counter = 0;
    const provider: AgentProvider = {
      kind: 'one',
      async createSession(options) {
        return standaloneSession(options.resume ?? 'new-native', `terminal-${++counter}`);
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const first = await runtime.createSession({ agent: 'one', resume: 'shared-native' });
    const second = await runtime.createSession({ agent: 'one', resume: 'shared-native' });
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');

    expect(first.nativeSession.id).toBe('shared-native');
    expect(second.nativeSession.id).toBe('shared-native');
    expect(first.runtimeRunId).not.toBe(second.runtimeRunId);
    expect(first.terminalSessionId).not.toBe(second.terminalSessionId);
    await runtime.dispose();
  });

  it('restores an allocated run with one epoch increment and restarts local delivery order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-restore-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-restore-registry-'));
    const request = {
      agent: 'one',
      creationRequestId: 'restore-run-one',
      externalRefs: [{ namespace: 'test', kind: 'caller' as const, id: 'caller-1' }],
    };
    const originalRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', new Map())],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const original = await originalRuntime.createSession(request);
    if ('error' in original) throw new Error('unexpected create failure');

    const restoredRuntime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', new Map())],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const observed: Array<{ epoch: number; sequence: number }> = [];
    restoredRuntime.onEvent((_terminalSessionId, envelope) => {
      observed.push({ epoch: envelope.runtimeEpoch, sequence: envelope.sequence });
    });
    const restoredHarness = sessionHarness(original.nativeSession.id, 'restored-terminal');
    const restoredSession = restoredHarness.session;
    const restoredWorkspace = await createWorkspace({ mode: 'direct', path: root });
    const restored = await restoredRuntime.restoreSession({
      creationRequestId: request.creationRequestId,
      runtimeRunId: original.runtimeRunId,
      expectedRuntimeEpoch: 1,
      agent: 'one',
      session: restoredSession,
      workspace: restoredWorkspace,
      externalRefs: request.externalRefs,
    });
    if ('error' in restored) throw new Error(`unexpected restore failure: ${restored.error.code}`);

    expect(restored).toMatchObject({
      runtimeRunId: original.runtimeRunId,
      runtimeEpoch: 2,
      terminalSessionId: 'restored-terminal',
    });
    expect(observed[0]).toEqual({ epoch: 2, sequence: 1 });
    restoredHarness.emit({
      ...testEnvelope(
        { type: 'session.ready' },
        {
          eventId: 'old-runtime-event',
          sequence: 99,
          sessionId: original.nativeSession.id,
          timestamp: '2026-08-16T18:00:00.000Z',
          monotonicTime: 99,
          source: 'runtime',
          confidence: 'derived',
        },
      ),
      runtimeRunId: original.runtimeRunId,
      runtimeEpoch: 1,
    } as AgentEventEnvelope);
    expect(observed).toEqual([{ epoch: 2, sequence: 1 }]);
    restoredHarness.emit(
      testEnvelope(
        { type: 'session.ready' },
        {
          eventId: 'current-provider-event',
          sequence: 1,
          sessionId: original.nativeSession.id,
          timestamp: '2026-08-16T18:00:01.000Z',
          monotonicTime: 100,
        },
      ),
    );
    expect(observed.at(-1)).toEqual({ epoch: 2, sequence: 2 });
    expect(
      await restoredRuntime.restoreSession({
        creationRequestId: request.creationRequestId,
        runtimeRunId: original.runtimeRunId,
        expectedRuntimeEpoch: 1,
        agent: 'one',
        session: restoredSession,
        workspace: restoredWorkspace,
        externalRefs: request.externalRefs,
      }),
    ).toEqual(restored);
    expect(restoredRuntime.runtimeRunInfo(original.runtimeRunId)?.runtimeEpoch).toBe(2);
    await restoredRuntime.dispose();
    await originalRuntime.dispose();
  });

  it('prepares without spawning, binds before exec, and adopts the same pane idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-prepare-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-prepare-registry-'));
    const hooks: {
      prepareCount: number;
      adoptCount: number;
      disposeCount: number;
      preparedRuntimeRunId?: string;
    } = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [preparableProvider('one', hooks)],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });

    const prepareRequest = { agent: 'one', creationRequestId: 'prepare-one' };
    const prepared = await runtime.prepareSession(prepareRequest);
    expect('error' in prepared).toBe(false);
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    expect(await runtime.prepareSession(prepareRequest)).toEqual(prepared);
    expect(hooks.prepareCount).toBe(1);
    expect(hooks.preparedRuntimeRunId).toBe(prepared.runtimeRunId);
    expect(prepared).toMatchObject({
      agent: 'one',
      runtimeEpoch: 1,
      sessionId: 'one-prepared-1',
      launch: {
        command: '/opt/one',
        args: ['--session-id', 'one-prepared-1'],
        cwd: prepared.workspace.root,
        env: { PREPARED_TOKEN: 'secret' },
      },
    });
    expect(runtime.sessionInfo('existing-pane')).toBeUndefined();

    const first = await runtime.adoptPrepared(prepared.preparationId, {
      runtimeRunId: prepared.runtimeRunId,
      terminalSessionId: 'existing-pane',
      processId: 4242,
    });
    expect(first).toMatchObject({
      agent: 'one',
      runtimeRunId: prepared.runtimeRunId,
      runtimeEpoch: 1,
      sessionId: prepared.sessionId,
      terminalSessionId: 'existing-pane',
      runtimeSessionId: 'existing-pane',
      preparationId: prepared.preparationId,
      processId: 4242,
    });
    expect(runtime.runtimeRunInfo(prepared.runtimeRunId)).toMatchObject({
      runtimeRunId: prepared.runtimeRunId,
      terminalSessionId: 'existing-pane',
      status: 'active',
    });
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'existing-pane' })).toEqual(first);
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'other-pane' })).toMatchObject({
      error: { code: 'PREPARATION_ALREADY_ADOPTED' },
    });
    expect(hooks.adoptCount).toBe(1);
    expect(await runtime.submitPrompt('existing-pane', { text: 'hello' })).toMatchObject({ status: 'confirmed' });

    await runtime.handleProcessExit('existing-pane', { exitCode: 0, signal: null, reason: 'completed' });
    expect(runtime.sessionInfo('existing-pane')).toBeUndefined();
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });

  it('reports unsupported providers and terminal conflicts without consuming the preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-unsupported-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('plain', handles), preparableProvider('prepared', hooks)],
    });

    expect(await runtime.prepareSession({ agent: 'plain' })).toMatchObject({
      error: { code: 'PREPARATION_UNSUPPORTED' },
    });
    const existing = await runtime.createSession({ agent: 'plain' });
    if ('error' in existing) throw new Error('unexpected create failure');
    const prepared = await runtime.prepareSession({ agent: 'prepared' });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    expect(
      await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: existing.runtimeSessionId }),
    ).toMatchObject({ error: { code: 'RUNTIME_SESSION_CONFLICT' } });
    expect(hooks.adoptCount).toBe(0);
    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    await runtime.dispose();
  });

  it('expires unused preparations, cleans their copy workspace, and returns a typed error', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-expiry-'));
    await writeFile(join(root, 'file.txt'), 'source');
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-expiry-copies-'));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      preparationTtlMs: 25,
      providers: [preparableProvider('one', hooks)],
    });

    const prepared = await runtime.prepareSession({
      agent: 'one',
      workspace: { mode: 'copy', workspacesRoot },
    });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    const preparedRoot = prepared.workspace.root;
    expect(existsSync(preparedRoot)).toBe(true);

    await vi.advanceTimersByTimeAsync(25);
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'late-pane' })).toMatchObject({
      error: { code: 'PREPARATION_EXPIRED' },
    });
    expect(existsSync(preparedRoot)).toBe(false);
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });

  it('finalizes a cancelled preparation once before removing its workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-cancel-provenance-'));
    await writeFile(join(root, 'file.txt'), 'source');
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-cancel-copies-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-cancel-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [preparableProvider('one', hooks)],
      features: { workspaceProvenanceV2: true },
    });
    const prepared = await runtime.prepareSession({
      agent: 'one',
      workspace: { mode: 'copy', workspacesRoot },
    });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    expect(existsSync(prepared.workspace.root)).toBe(true);

    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(existsSync(prepared.workspace.root)).toBe(false);
    const finals = (await recorder.read()).filter(
      (record) =>
        isOwnActionV2(record) &&
        record.runtimeRunId === prepared.runtimeRunId &&
        (record.type === 'workspace.finalized' || record.type === 'workspace.finalization-failed'),
    );
    expect(finals).toEqual([
      expect.objectContaining({
        type: 'workspace.finalized',
        trigger: 'cancellation',
        cleanupOutcome: 'removed',
        retained: false,
      }),
    ]);
    await runtime.dispose();
  });

  it('linearizes concurrent adoption and lets the shim cancel after an exec failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-adopt-race-'));
    let releaseAdoption!: () => void;
    const adoptionGate = new Promise<void>((resolve) => (releaseAdoption = resolve));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0, adoptionGate };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [preparableProvider('one', hooks)],
    });
    const prepared = await runtime.prepareSession({ agent: 'one' });
    if ('error' in prepared) throw new Error('unexpected prepare failure');

    const first = runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'pane' });
    const second = runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'pane' });
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'other-pane' })).toMatchObject({
      error: { code: 'PREPARATION_ALREADY_ADOPTED' },
    });
    releaseAdoption();
    expect(await second).toEqual(await first);
    expect(hooks.adoptCount).toBe(1);

    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(runtime.sessionInfo('pane')).toBeUndefined();
    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });

  it('retains a dirty worktree with one complete finalization record', async () => {
    const root = await makeRepo();
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-retained-worktrees-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-retained-records-'));
    const path = join(recordRoot, 'own-actions.jsonl');
    const recorder = createActionRecorder({ path });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      features: { workspaceProvenanceV2: true },
    });
    const created = await runtime.createSession({
      agent: 'one',
      workspace: { mode: 'worktree', workspacesRoot },
    });
    if ('error' in created) throw new Error('unexpected create failure');
    await writeFile(join(created.workspace.root, 'uncommitted-private-name.ts'), 'work\n');

    const final = await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });
    expect(final).toMatchObject({ retained: true, metadata: { filesTouched: ['uncommitted-private-name.ts'] } });
    expect(existsSync(created.workspace.root)).toBe(true);
    const terminalRecords = (await recorder.read()).filter(
      (record) =>
        isOwnActionV2(record) &&
        record.runtimeRunId === created.runtimeRunId &&
        (record.type === 'workspace.finalized' || record.type === 'workspace.finalization-failed'),
    );
    expect(terminalRecords).toEqual([
      expect.objectContaining({
        type: 'workspace.finalized',
        outcome: 'complete',
        cleanupOutcome: 'retained-dirty',
        retained: true,
        filesTouchedCount: 1,
      }),
    ]);
    expect(await readFile(path, 'utf8')).not.toContain('uncommitted-private-name.ts');
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', created.workspace.root, '--force']);
    await runtime.dispose();
  });

  it('records one failed finalization when crash-time workspace evidence is unavailable', async () => {
    const root = await makeRepo();
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-failed-final-worktrees-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-failed-final-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      features: { workspaceProvenanceV2: true },
    });
    const created = await runtime.createSession({
      agent: 'one',
      workspace: { mode: 'worktree', workspacesRoot },
    });
    if ('error' in created) throw new Error('unexpected create failure');
    await rm(created.workspace.root, { recursive: true, force: true });

    await expect(
      runtime.handleProcessExit(created.terminalSessionId, { exitCode: 1, signal: null, reason: 'crash' }),
    ).resolves.toBeUndefined();
    await runtime.dispose();
    const terminalRecords = (await recorder.read()).filter(
      (record) =>
        isOwnActionV2(record) &&
        record.runtimeRunId === created.runtimeRunId &&
        (record.type === 'workspace.finalized' || record.type === 'workspace.finalization-failed'),
    );
    expect(terminalRecords).toEqual([
      expect.objectContaining({
        type: 'workspace.finalization-failed',
        outcome: 'failed',
        trigger: 'crash',
        cleanupOutcome: 'failed',
        retained: true,
      }),
    ]);
    await execFileAsync('git', ['-C', root, 'worktree', 'prune']);
  });

  it('finalizes an active workspace once when the runtime is disposed repeatedly', async () => {
    const root = await makeRepo();
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-disposal-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', new Map())],
      features: { workspaceProvenanceV2: true },
    });
    const created = await runtime.createSession({ agent: 'one' });
    if ('error' in created) throw new Error('unexpected create failure');

    await runtime.dispose();
    await runtime.dispose();
    const terminalRecords = (await recorder.read()).filter(
      (record) =>
        isOwnActionV2(record) &&
        record.runtimeRunId === created.runtimeRunId &&
        (record.type === 'workspace.finalized' || record.type === 'workspace.finalization-failed'),
    );
    expect(terminalRecords).toEqual([
      expect.objectContaining({ type: 'workspace.finalized', trigger: 'runtime-disposal' }),
    ]);
  });

  it('publishes the host exit before cleanup and removes a clean monitor last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-clean-'));
    const timeline: string[] = [];
    const provider: AgentProvider = {
      kind: 'monitor-clean',
      executionMode: 'native-tui',
      async createSession() {
        return {
          sessionId: 'monitor-clean-native',
          runtimeSessionId: 'monitor-clean-terminal',
          observationLevel: () => 'native-hooks',
          onEvent: () => () => undefined,
          async submitPrompt() {
            return { status: 'confirmed' };
          },
          async dispose() {
            timeline.push('resource:disposed');
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      features: { agentMonitorStateV2: true },
    });
    runtime.onMonitorState((state) => {
      if (!state.alive) timeline.push(`state:${state.status}`);
    });
    runtime.onMonitorNotification((notice) => timeline.push(`notice:${notice.type}`));
    runtime.onMonitorRemoved(() => timeline.push('monitor:removed'));

    const created = await runtime.createSession({ agent: 'monitor-clean' });
    if ('error' in created) throw new Error('unexpected create failure');
    const handle = runtime.observeMonitor(created.runtimeRunId);
    await expect(handle.ready).resolves.toMatchObject({
      runtimeRunId: created.runtimeRunId,
      alive: true,
      modes: { execution: 'native-tui' },
      freshness: { level: 'native-hooks' },
    });

    await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });

    expect(timeline).toEqual(['state:idle', 'notice:session.ended', 'resource:disposed', 'monitor:removed']);
    expect(runtime.monitorState(created.runtimeRunId)).toBeUndefined();
    await runtime.dispose();
  });

  it('normalizes host terminal outcomes before deciding whether to retain a failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-host-exit-'));
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('monitor-host-exit', new Map())],
      features: { agentMonitorStateV2: true },
    });
    const notices: string[] = [];
    runtime.onMonitorNotification((notice) => notices.push(notice.type));

    const created = await runtime.createSession({ agent: 'monitor-host-exit' });
    if ('error' in created) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'unknown',
      requestedTermination: 'application',
    });

    expect(runtime.runtimeRunInfo(created.runtimeRunId)).toMatchObject({
      status: 'terminal',
      terminalOutcome: { kind: 'cancelled' },
    });
    expect(runtime.monitorState(created.runtimeRunId)).toBeUndefined();
    expect(notices).toContain('session.ended');
    expect(notices).not.toContain('blocked.entered');
    await runtime.dispose();
  });

  it('closes an adopted process disappearance without inventing a failure', async () => {
    const root = await makeRepo();
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-unclassified-exit-records-'));
    const recorder = createActionRecorder({ path: join(recordRoot, 'own-actions.jsonl') });
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('monitor-unclassified-exit', new Map())],
      features: { agentMonitorStateV2: true, workspaceProvenanceV2: true },
    });
    const notices: string[] = [];
    runtime.onMonitorNotification((notice) => notices.push(notice.type));

    const created = await runtime.createSession({ agent: 'monitor-unclassified-exit' });
    if ('error' in created) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: null,
      signal: null,
      reason: 'process-exited',
    });

    expect(runtime.runtimeRunInfo(created.runtimeRunId)).toMatchObject({
      status: 'terminal',
      terminalOutcome: { kind: 'closed', reason: 'unclassified-process-exit' },
    });
    expect(runtime.monitorState(created.runtimeRunId)).toBeUndefined();
    expect(notices).toContain('session.ended');
    expect(notices).not.toContain('blocked.entered');
    expect(await recorder.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'process.exited', reason: 'unknown' }),
        expect.objectContaining({ type: 'workspace.finalized', trigger: 'unclassified-exit' }),
      ]),
    );
    await runtime.dispose();
  });

  it('uses concrete exit data when a terminal host supplies no semantic reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-derived-crash-'));
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('monitor-derived-crash', new Map())],
      features: { agentMonitorStateV2: true },
    });

    const created = await runtime.createSession({ agent: 'monitor-derived-crash' });
    if ('error' in created) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(created.terminalSessionId, {
      exitCode: 1,
      signal: null,
      reason: 'process-exited',
    });

    expect(runtime.runtimeRunInfo(created.runtimeRunId)).toMatchObject({
      status: 'terminal',
      terminalOutcome: { kind: 'failed', code: 'crash' },
    });
    expect(runtime.monitorState(created.runtimeRunId)).toMatchObject({
      alive: false,
      status: 'blocked',
      blockers: [{ kind: 'failure', failure: { code: 'crash' } }],
    });
    await runtime.dispose();
  });

  it('keeps an adopted provider in starting state until provider readiness evidence arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-starting-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('monitor-starting', handles)],
      features: { agentMonitorStateV2: true },
    });

    const created = await runtime.createSession({ agent: 'monitor-starting' });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(runtime.sessionState(created.terminalSessionId)?.lifecycle).toBe('preparing');
    expect(runtime.monitorState(created.runtimeRunId)).toMatchObject({
      status: 'working',
      activity: { kind: 'starting' },
      alive: true,
    });

    handles
      .get(created.terminalSessionId)!
      .emit(
        testEnvelope(
          { type: 'session.ready' },
          { eventId: 'provider-ready', sequence: 1, sessionId: created.sessionId },
        ),
      );
    await vi.waitFor(() => expect(runtime.monitorState(created.runtimeRunId)?.status).toBe('idle'));
    expect(runtime.sessionState(created.terminalSessionId)?.lifecycle).toBe('ready');
    await runtime.dispose();
  });

  it('retains an unexpected-death failure monitor until idempotent acknowledgment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-crash-'));
    const timeline: string[] = [];
    const provider: AgentProvider = {
      kind: 'monitor-crash',
      async createSession() {
        return {
          sessionId: 'monitor-crash-native',
          runtimeSessionId: 'monitor-crash-terminal',
          observationLevel: () => 'terminal-only',
          onEvent: () => () => undefined,
          async submitPrompt() {
            return { status: 'confirmed' };
          },
          async dispose() {
            timeline.push('resource:disposed');
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      features: { agentMonitorStateV2: true },
    });
    runtime.onMonitorState((state) => {
      if (!state.alive) timeline.push(`state:${state.status}`);
    });
    runtime.onMonitorNotification((notice) => timeline.push(`notice:${notice.type}`));
    runtime.onMonitorRemoved(() => timeline.push('monitor:removed'));

    const created = await runtime.createSession({ agent: 'monitor-crash' });
    if ('error' in created) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(created.terminalSessionId, { exitCode: 1, signal: null, reason: 'crash' });

    expect(timeline).toEqual(['state:blocked', 'notice:blocked.entered', 'notice:session.ended', 'resource:disposed']);
    expect(runtime.sessionInfo(created.terminalSessionId)).toBeUndefined();
    expect(runtime.monitorState(created.runtimeRunId)).toMatchObject({
      alive: false,
      status: 'blocked',
      blockers: [{ id: 'run:runtime', kind: 'failure', failure: { code: 'crash' } }],
    });
    await expect(runtime.acknowledgeFailureBlocker(created.runtimeRunId, 'not-a-failure')).resolves.toBe(false);
    await expect(runtime.acknowledgeFailureBlocker(created.runtimeRunId, 'run:runtime')).resolves.toBe(true);
    expect(timeline.slice(-2)).toEqual(['state:idle', 'monitor:removed']);
    await expect(runtime.acknowledgeFailureBlocker(created.runtimeRunId, 'run:runtime')).resolves.toBe(true);
    expect(timeline.filter((item) => item === 'monitor:removed')).toHaveLength(1);
    await runtime.dispose();
  });

  it('bounds retained failure monitors and preserves terminal run summaries after eviction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-retention-'));
    let sequence = 0;
    const provider: AgentProvider = {
      kind: 'monitor-retention',
      async createSession() {
        const id = ++sequence;
        return {
          sessionId: `monitor-retention-native-${id}`,
          runtimeSessionId: `monitor-retention-terminal-${id}`,
          observationLevel: () => 'terminal-only',
          onEvent: () => () => undefined,
          async submitPrompt() {
            return { status: 'confirmed' };
          },
          async dispose() {},
        };
      },
    };
    const removed: string[] = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      features: { agentMonitorStateV2: true },
      terminalFailureCapacity: 1,
    });
    runtime.onMonitorRemoved((runtimeRunId) => removed.push(runtimeRunId));

    const first = await runtime.createSession({ agent: 'monitor-retention' });
    const second = await runtime.createSession({ agent: 'monitor-retention' });
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(first.terminalSessionId, { exitCode: 1, signal: null, reason: 'crash' });
    await runtime.handleProcessExit(second.terminalSessionId, { exitCode: 1, signal: null, reason: 'crash' });

    expect(runtime.monitorState(first.runtimeRunId)).toBeUndefined();
    expect(runtime.runtimeRunInfo(first.runtimeRunId)).toMatchObject({
      status: 'terminal',
      terminalOutcome: { kind: 'failed', code: 'crash' },
    });
    expect(runtime.monitorState(second.runtimeRunId)).toMatchObject({ status: 'blocked', alive: false });
    expect(removed).toEqual([first.runtimeRunId]);
    await runtime.dispose();
  });

  it('routes one semantic observer and audits successful artifact content reads without persisting content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-artifact-'));
    const recordRoot = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-artifact-record-'));
    const path = join(recordRoot, 'actions.jsonl');
    const recorder = createActionRecorder({ path });
    const eventListeners = new Set<(envelope: AgentEventEnvelope) => void>();
    let eventSubscriptions = 0;
    let artifactReads = 0;
    const provider: AgentProvider = {
      kind: 'monitor-artifact',
      async createSession() {
        return {
          sessionId: 'monitor-artifact-native',
          runtimeSessionId: 'monitor-artifact-terminal',
          observationLevel: () => 'native-log',
          onEvent(listener) {
            eventSubscriptions += 1;
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
          },
          async readMonitorArtifact(artifactId) {
            artifactReads += 1;
            return {
              status: 'ok',
              artifact: { artifactId, family: 'workflow-definition', availability: 'readable' },
              encoding: 'utf8',
              content: 'private workflow body',
            };
          },
          async submitPrompt() {
            return { status: 'confirmed' };
          },
          async dispose() {},
        };
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      recorder,
      features: { agentMonitorStateV2: true },
    });
    const created = await runtime.createSession({ agent: 'monitor-artifact' });
    if ('error' in created) throw new Error('unexpected create failure');
    runtime.observeMonitor(created.runtimeRunId);
    runtime.observeMonitor(created.runtimeRunId);
    expect(eventSubscriptions).toBe(1);

    const observation: AdapterMonitorObservationBatch = {
      schemaVersion: 1,
      batchId: 'workflow-batch-1',
      producer: { id: 'workflow-observer', epoch: 'epoch-1', sequence: 1 },
      phase: 'live',
      observedAt: new Date().toISOString(),
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      updates: [
        {
          family: 'workflow',
          operation: 'upsert',
          key: 'workflow-1',
          value: {
            kind: 'workflow',
            workflowId: 'workflow-1',
            active: true,
            actorRunKeys: [],
            artifactRefs: [
              {
                artifactId: 'opaque:workflow-1',
                family: 'workflow-definition',
                mediaType: 'text/yaml',
                availability: 'readable',
              },
            ],
          },
        },
      ],
      sourceWatermarks: [],
      evidence: [],
    };
    const semanticEnvelope = testEnvelope(
      { type: 'monitor.batch', batch: observation },
      { sessionId: 'monitor-artifact-native' },
    );
    for (const listener of eventListeners) listener(semanticEnvelope);

    await expect(runtime.readMonitorArtifact(created.runtimeRunId, '/tmp/not-an-opaque-id')).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(artifactReads).toBe(0);
    await expect(runtime.readMonitorArtifact(created.runtimeRunId, 'opaque:workflow-1')).resolves.toMatchObject({
      status: 'ok',
      content: 'private workflow body',
    });
    expect(artifactReads).toBe(1);

    const records = (await recorder.read()).filter(
      (record) => isOwnActionV2(record) && record.type === 'artifact.read',
    );
    expect(records).toEqual([
      expect.objectContaining({
        runtimeRunId: created.runtimeRunId,
        artifactId: 'opaque:workflow-1',
        outcome: 'ok',
        returnedBytes: 21,
        mediaType: 'text/yaml',
      }),
    ]);
    expect(await readFile(path, 'utf8')).not.toContain('private workflow body');
    expect(await readFile(path, 'utf8')).not.toContain('/tmp/not-an-opaque-id');
    await runtime.dispose();
  });

  it('keeps the v1-only behavior when monitor v2 is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-disabled-'));
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('monitor-disabled', new Map())],
    });
    const created = await runtime.createSession({ agent: 'monitor-disabled' });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(runtime.monitorState(created.runtimeRunId)).toBeUndefined();
    expect(() => runtime.observeMonitor(created.runtimeRunId)).toThrow('monitor not found or disabled');
    await runtime.dispose();
  });

  it('creates and retains the monitor before provider lookup can fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-start-failure-'));
    const states: Array<{ status: string; alive: boolean }> = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [],
      features: { agentMonitorStateV2: true },
    });
    runtime.onMonitorState((state) => states.push({ status: state.status, alive: state.alive }));

    const result = await runtime.createSession({ agent: 'missing-provider' });
    if (!('error' in result)) throw new Error('expected create failure');
    expect(states[0]).toEqual({ status: 'working', alive: true });
    expect(states.at(-1)).toEqual({ status: 'blocked', alive: false });
    expect(runtime.monitorState(result.runtimeRunId)).toMatchObject({
      status: 'blocked',
      alive: false,
      blockers: [{ id: 'run:runtime', failure: { code: 'AGENT_NOT_FOUND' } }],
    });
    await expect(runtime.acknowledgeFailureBlocker(result.runtimeRunId, 'run:runtime')).resolves.toBe(true);
    expect(runtime.monitorState(result.runtimeRunId)).toBeUndefined();
    await runtime.dispose();
  });
});
