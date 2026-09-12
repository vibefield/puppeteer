import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEventCategory,
  agentEventType,
  createAdapterEventCandidate,
  createEnvelopeStamper,
  type AccountUsageFetchResult,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentProfile,
  type AgentAdapterBinding,
  type ObservationLevel,
  type ProfileService,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { createActionRecorder, isOwnActionV2 } from '@vibecook/puppeteer-record';
import { createWorkspace } from '@vibecook/puppeteer-workspaces';
import { createFileCreationRequestRegistry, type CreationRequestRegistry } from './identity/creation-registry.js';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider, ProfileStore } from './types.js';

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
  fields: Partial<Omit<AgentEventEnvelope, 'type' | 'category' | 'event'>> = {},
): AgentEventEnvelope {
  return {
    sequence: 1,
    sessionId: 'test-native',
    timestamp: new Date().toISOString(),
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    ...fields,
    type: agentEventType(event),
    category: agentEventCategory(event),
    event,
  };
}

function candidateFromEnvelope(envelope: AgentEventEnvelope): AdapterEventCandidate {
  const { sequence: _sequence, category: _category, ...candidate } = envelope;
  return candidate as AdapterEventCandidate;
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
    descriptor: { id: kind, label: kind },
    async createSession(): Promise<AgentAdapterBinding> {
      const n = ++counter;
      const runtimeSessionId = `${kind}-runtime-${n}`;
      const listeners = new Set<(event: AdapterEventCandidate) => void>();
      handles.set(runtimeSessionId, {
        emit: (event) => listeners.forEach((listener) => listener(candidateFromEnvelope(event))),
      });
      return {
        sessionId: `${kind}-native-${n}`,
        runtimeSessionId,
        observationLevel: () => observation,
        events: {
          onCandidate(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        services: {
          prompt: {
            async submit() {
              return { status: 'confirmed', turnId: `${kind}-turn` };
            },
          },
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
    preparedCwd?: string | undefined;
    preparedRuntimeRunId?: string | undefined;
    adoptionGate?: Promise<void> | undefined;
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
      let adopted: AgentAdapterBinding | undefined;
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
          const listeners = new Set<(event: AdapterEventCandidate) => void>();
          adopted = {
            sessionId,
            runtimeSessionId,
            observationLevel: () => 'structured',
            events: {
              onCandidate(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
            services: {
              prompt: {
                async submit() {
                  return { status: 'confirmed', turnId: `${kind}-turn` };
                },
              },
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
  session: AgentAdapterBinding;
  emit: (event: AgentEventEnvelope) => void;
} {
  const listeners = new Set<(event: AdapterEventCandidate) => void>();
  return {
    session: {
      sessionId,
      runtimeSessionId,
      observationLevel: () => 'structured',
      events: {
        onCandidate(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      services: {
        prompt: {
          async submit() {
            return { status: 'confirmed' };
          },
        },
      },
      async dispose() {},
    },
    emit: (event) => listeners.forEach((listener) => listener(candidateFromEnvelope(event))),
  };
}

function standaloneSession(sessionId: string, runtimeSessionId: string): AgentAdapterBinding {
  return sessionHarness(sessionId, runtimeSessionId).session;
}

/** A provider-neutral profile capability whose binding variable is its own root. */
function exampleProfileService(id = 'example', label = 'Example'): ProfileService {
  const variable = `${id.toUpperCase()}_HOME`;
  return {
    provider: {
      id,
      label,
      support: {
        supported: true,
        identity: 'native-status',
        sharedSurfaces: [],
        nativeDefaultRoot: `/home/user/.${id}`,
      },
    },
    bindingEnvironment: (profile) => (profile.kind === 'native-default' ? {} : { [variable]: profile.dataRoot }),
    observationRoot: (profile) => (profile.kind === 'native-default' ? `/home/user/.${id}` : profile.dataRoot),
    loginInvocation: (_profile, options) => ({ command: id, args: ['login'], cwd: options.cwd }),
    async verify() {
      return {
        loggedIn: true,
        verifiedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'native-status', stability: 'documented' },
      };
    },
  };
}

function memoryProfileStore(): ProfileStore {
  let snapshot: { version: 1; profiles: AgentProfile[] } | undefined;
  return {
    async load() {
      return snapshot;
    },
    async save(next) {
      snapshot = next;
    },
  };
}

describe('createAgentRuntime', () => {
  it('normalizes native invocations and resumes opaque continuations without provider quirks in callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-launch-'));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const normalizeInvocation = vi.fn(() => ({
      status: 'accepted' as const,
      resume: 'native-selected',
      options: { profileRoot: '/profiles/example' },
    }));
    const restore = vi.fn((state: string | undefined) => ({ profileRoot: JSON.parse(state!).profileRoot }));
    const provider: AgentProvider = {
      ...preparableProvider('example', hooks),
      descriptor: { id: 'example', label: 'Example' },
      launch: {
        provider: {
          id: 'example',
          label: 'Example',
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'example', executable: '/opt/example' }],
            environmentVariables: ['EXAMPLE_HOME'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation,
        continuation: {
          capture: ({ agentOptions }) => {
            const profileRoot = (agentOptions as { profileRoot?: string } | undefined)?.profileRoot;
            return profileRoot ? JSON.stringify({ profileRoot }) : undefined;
          },
          restore,
        },
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    expect(runtime.launchProviders()).toEqual([provider.launch!.provider]);
    const prepared = await runtime.prepareInvocation({
      providerId: 'example',
      cwd: root,
      argv: ['--resume', 'native-selected'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/profiles/imposter' },
    });
    if ('error' in prepared) throw new Error(prepared.error.message);
    expect(normalizeInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: root,
      argv: ['--resume', 'native-selected'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/profiles/imposter' },
    });
    expect(prepared.continuation).toEqual({
      providerId: 'example',
      nativeSessionId: 'example-prepared-1',
      implementation: 'imposter',
      state: JSON.stringify({ profileRoot: '/profiles/example' }),
    });

    const resumed = await runtime.resume({ continuation: prepared.continuation, cwd: root });
    if ('error' in resumed) throw new Error(resumed.error.message);
    expect(restore).toHaveBeenCalledWith(prepared.continuation.state, { cwd: root });
    expect(resumed.info.continuation).toMatchObject({
      providerId: 'example',
      implementation: 'imposter',
      state: prepared.continuation.state,
    });

    await runtime.cancelPrepared(prepared.preparationId);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects undeclared invocation environment before calling an adapter', async () => {
    const normalizeInvocation = vi.fn(() => ({ status: 'accepted' as const }));
    const provider: AgentProvider = {
      ...preparableProvider('example', { prepareCount: 0, adoptCount: 0, disposeCount: 0 }),
      descriptor: { id: 'example', label: 'Example' },
      launch: {
        provider: {
          id: 'example',
          label: 'Example',
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'example', executable: 'example' }],
            environmentVariables: [],
          },
        },
        normalizeInvocation,
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: '/repo', providers: [provider] });
    await expect(
      runtime.prepareInvocation({
        providerId: 'example',
        cwd: '/repo',
        argv: [],
        environment: { SECRET: 'no' },
        implementation: { kind: 'native' },
      }),
    ).resolves.toMatchObject({ error: { code: 'INVALID_NATIVE_INVOCATION' } });
    expect(normalizeInvocation).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('rejects duplicate provider ids and ambiguous native command ownership at construction', () => {
    const provider = (kind: string, command: string): AgentProvider => ({
      ...fakeProvider(kind, new Map()),
      launch: {
        provider: {
          id: kind,
          label: kind,
          resume: true,
          nativeInvocation: {
            commands: [{ name: command, executable: `/opt/${command}` }],
            environmentVariables: [],
          },
        },
        normalizeInvocation: () => ({ status: 'accepted' }),
      },
    });

    expect(() =>
      createAgentRuntime({ host, defaultCwd: '/repo', providers: [provider('one', 'one'), provider('one', 'two')] }),
    ).toThrow('duplicate agent provider');
    expect(() =>
      createAgentRuntime({
        host,
        defaultCwd: '/repo',
        providers: [provider('one', 'agent'), provider('two', 'agent')],
      }),
    ).toThrow('advertised by both');

    const nonDurableImposter = provider('imposter-without-codec', 'imposter-without-codec');
    nonDurableImposter.launch!.provider.nativeInvocation!.imposter = { state: 'isolated-root' };
    expect(() => createAgentRuntime({ host, defaultCwd: '/repo', providers: [nonDurableImposter] })).toThrow(
      'advertises an imposter without a continuation codec',
    );

    const mislabeledLaunch = provider('mislabeled', 'mislabeled');
    mislabeledLaunch.launch!.provider.label = 'Different label';
    expect(() => createAgentRuntime({ host, defaultCwd: '/repo', providers: [mislabeledLaunch] })).toThrow(
      'does not match agent provider',
    );
  });

  it('validates and defensively exposes the open provider catalog on sessions and Runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-providers-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const configured = fakeProvider('company.agent-v2', handles);
    configured.descriptor.label = 'Company Agent';
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [configured] });

    const firstCatalog = runtime.providers();
    expect(firstCatalog).toEqual([{ id: 'company.agent-v2', label: 'Company Agent' }]);
    firstCatalog[0]!.label = 'mutated consumer copy';
    expect(runtime.providers()).toEqual([{ id: 'company.agent-v2', label: 'Company Agent' }]);

    const spawned = await runtime.spawn({ agent: 'company.agent-v2', cwd: root });
    if ('error' in spawned) throw new Error(spawned.error.message);
    expect(spawned.info.provider).toEqual({ id: 'company.agent-v2', label: 'Company Agent' });
    const info = spawned.info;
    info.provider.label = 'mutated session copy';
    expect(spawned.info.provider.label).toBe('Company Agent');

    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

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

    const turnEvents: string[] = [];
    const contextEvents: number[] = [];
    const conversationEvents: string[] = [];
    let stateSeenByListener: string | undefined;
    let conversationSeenByListener: string | undefined;
    spawned.on('turn:*', (envelope) => turnEvents.push(envelope.type));
    spawned.on('turn:started', () => {
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
    source?.emit(testEnvelope({ type: 'turn:started', turnId: 'turn-1', prompt: 'hello' }));
    source?.emit(testEnvelope({ type: 'context-window:updated', usedTokens: 25, capacityTokens: 100 }));
    source?.emit(
      testEnvelope({
        type: 'conversation:assistant-message',
        turnId: 'turn-1',
        text: 'hi',
        final: true,
        displayOnly: false,
      }),
    );
    source?.emit(testEnvelope({ type: 'turn:completed', turnId: 'turn-1' }));

    expect(turnEvents).toEqual(['turn:started', 'turn:completed']);
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
    const exposedState = spawned.state;
    exposedState.counters.toolsCompleted = 99;
    exposedState.tools.set('forged', { toolCallId: 'forged', state: 'running' });
    expect(spawned.state.counters.toolsCompleted).toBe(0);
    expect(spawned.state.tools.has('forged')).toBe(false);

    const exposedInfo = spawned.info;
    const expectedNativeSessionId = exposedInfo.nativeSession.id;
    const expectedWorkspaceRoot = exposedInfo.workspace.root;
    exposedInfo.nativeSession.id = 'forged';
    exposedInfo.externalRefs.push({ namespace: 'test', id: 'forged', kind: 'other' });
    exposedInfo.workspace.root = '/forged';
    expect(spawned.info.nativeSession.id).toBe(expectedNativeSessionId);
    expect(spawned.info.externalRefs).toHaveLength(0);
    expect(spawned.info.workspace.root).toBe(expectedWorkspaceRoot);

    const compatibilityInfo = runtime.sessionInfo(spawned.terminalSessionId)!;
    compatibilityInfo.nativeSession.id = 'also-forged';
    expect(runtime.sessionInfo(spawned.terminalSessionId)?.nativeSession.id).not.toBe('also-forged');
    await expect(spawned.submitPrompt({ text: 'again' })).resolves.toMatchObject({ status: 'confirmed' });

    await runtime.dispose();
  });

  it('validates adapter candidates before assigning runtime delivery order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-candidates-'));
    const candidateListeners = new Set<(candidate: AdapterEventCandidate) => void>();
    const errors: Error[] = [];
    const provider: AgentProvider = {
      descriptor: { id: 'candidate-provider', label: 'Candidate Provider' },
      async createSession() {
        return {
          sessionId: 'candidate-native-1',
          runtimeSessionId: 'candidate-runtime-1',
          observationLevel: () => 'structured',
          events: {
            onCandidate(listener) {
              candidateListeners.add(listener);
              return () => candidateListeners.delete(listener);
            },
          },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' as const };
              },
            },
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
    const spawned = await runtime.spawn({ agent: provider.descriptor.id, cwd: root });
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
      event: { type: 'turn:started', turnId: 'turn-1' },
    });
    emit({ ...started, sequence: 999 } as AdapterEventCandidate);
    emit(started);
    emit({
      ...createAdapterEventCandidate({
        sessionId: 'candidate-native-1',
        timestamp: '2026-08-25T00:00:01.000Z',
        monotonicTime: 11,
        source: 'native-protocol',
        confidence: 'authoritative',
        event: { type: 'context-window:updated', usedTokens: 10, capacityTokens: 100 },
      }),
      event: { type: 'context-window:updated', usedTokens: 'invalid', capacityTokens: 100 },
    } as unknown as AdapterEventCandidate);
    emit(
      createAdapterEventCandidate({
        sessionId: 'candidate-native-1',
        timestamp: '2026-08-25T00:00:02.000Z',
        monotonicTime: 12,
        source: 'native-protocol',
        confidence: 'authoritative',
        event: { type: 'context-window:updated', usedTokens: 20, capacityTokens: 100 },
      }),
    );

    expect(delivered.map((envelope) => envelope.type)).toEqual(['turn:started', 'context-window:updated']);
    expect(delivered[1]!.sequence).toBe(delivered[0]!.sequence + 1);
    expect(delivered[0]!.sequence).not.toBe(999);
    expect(errors.some((error) => error.message.includes('invalid candidate metadata'))).toBe(true);
    expect(errors.some((error) => error.message.includes('Adapter emitted invalid context-window:updated'))).toBe(true);
    await runtime.dispose();
  });

  it('fetches provider-level account usage without a session and coalesces concurrent reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    let release: (() => void) | undefined;
    let calls = 0;
    const provider: AgentProvider = {
      ...fakeProvider('codex', handles),
      descriptor: { id: 'codex', label: 'Codex' },
      accountUsage: {
        provider: { id: 'codex', label: 'Codex', refresh: { pollIntervalMs: 60_000 } },
        async fetch() {
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
              metrics: [],
            },
          };
        },
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    expect(runtime.accountUsageProviders()).toEqual([
      { id: 'codex', label: 'Codex', refresh: { pollIntervalMs: 60_000 } },
    ]);

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
    const broken: AgentProvider = {
      ...fakeProvider('broken', handles),
      descriptor: { id: 'broken', label: 'Broken' },
      accountUsage: {
        provider: { id: 'broken', label: 'Broken', refresh: { pollIntervalMs: 60_000 } },
        fetch() {
          throw new Error('native secret detail');
        },
      },
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

  it('rejects invalid or misidentified adapter account-usage output at runtime ingress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-validation-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const onError = vi.fn();
    const provider: AgentProvider = {
      ...fakeProvider('example', handles),
      descriptor: { id: 'example', label: 'Example' },
      accountUsage: {
        provider: { id: 'example', label: 'Example', refresh: { pollIntervalMs: 60_000 } },
        async fetch() {
          return {
            status: 'available',
            snapshot: {
              provider: 'different-provider',
              fetchedAt: 'not-an-iso-timestamp',
              scope: 'subscription',
              source: { kind: 'native-protocol', stability: 'documented' },
              metrics: [{ id: 'bad', label: '', kind: 'window', usedPercent: -1 }],
            },
          } as unknown as AccountUsageFetchResult;
        },
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider], onError });

    await expect(runtime.accountUsage('example')).resolves.toEqual({
      status: 'unavailable',
      provider: 'example',
      message: 'account usage fetch failed for example',
      retryable: true,
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('validation') }));
    await runtime.dispose();

    const mismatched: AgentProvider = {
      ...fakeProvider('one', handles),
      accountUsage: {
        provider: { id: 'two', label: 'Two', refresh: { pollIntervalMs: 60_000 } },
        async fetch() {
          return {
            status: 'unsupported',
            provider: 'two',
            message: 'unsupported',
            retryable: false,
          };
        },
      },
    };
    expect(() => createAgentRuntime({ host, defaultCwd: root, providers: [mismatched] })).toThrow(
      'does not match agent provider',
    );
  });

  it('forwards provider push account-usage updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-usage-push-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const pushListeners = new Set<(result: AccountUsageFetchResult) => void>();
    const provider: AgentProvider = {
      ...fakeProvider('claude', handles),
      descriptor: { id: 'claude', label: 'Claude' },
      accountUsage: {
        provider: {
          id: 'claude',
          label: 'Claude',
          refresh: { pollIntervalMs: 60_000, pushUpdatePollIntervalMs: 300_000 },
        },
        async fetch() {
          return {
            status: 'unavailable',
            provider: 'claude',
            message: 'not fetched in this test',
            retryable: true,
          };
        },
        subscribe(listener) {
          pushListeners.add(listener);
          return () => pushListeners.delete(listener);
        },
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const seen: Array<{ agent: string; status: string }> = [];
    const unsubscribe = runtime.onAccountUsage((usageProvider, result) => {
      seen.push({ agent: usageProvider.id, status: result.status });
    });

    for (const listener of pushListeners) {
      listener({
        status: 'available',
        snapshot: {
          provider: 'claude',
          fetchedAt: '2026-07-23T12:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'native-statusline', stability: 'documented' },
          metrics: [],
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
          metrics: [],
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
        type: 'tool:started',
        toolCallId: 'tool-1',
        tool: 'command',
        presentation: { kind: 'command', title: 'Running command' },
      }),
      stamp({
        type: 'tool:completed',
        toolCallId: 'tool-1',
        tool: 'command',
        presentation: { kind: 'command', title: 'Ran command' },
      }),
      stamp({ type: 'adapter:native-event', adapter: 'replay', nativeType: 'future/event' }),
      stamp({ type: 'turn:started', turnId: 'history-turn', prompt: 'Historical question' }),
      stamp(
        {
          type: 'conversation:assistant-message',
          messageId: 'history-answer',
          turnId: 'history-turn',
          text: 'Historical answer',
          final: true,
          displayOnly: false,
        },
        'native-transcript',
        true,
      ),
      stamp({ type: 'turn:completed', turnId: 'history-turn' }),
    ];
    const provider: AgentProvider = {
      descriptor: { id: 'replay', label: 'Replay' },
      async createSession() {
        return {
          sessionId,
          runtimeSessionId,
          observationLevel: () => 'structured',
          events: {
            onCandidate(listener) {
              for (const envelope of replay) listener(candidateFromEnvelope(envelope));
              return () => undefined;
            },
          },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' };
              },
            },
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
      'tool:started',
      'tool:completed',
      'adapter:native-event',
      'turn:started',
      'conversation:assistant-message',
      'turn:completed',
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

    handles
      .get(created.runtimeSessionId)!
      .emit(
        testEnvelope(
          { type: 'environment:updated', currentCwd: second },
          { sequence: 1, sessionId: created.sessionId },
        ),
      );
    handles
      .get(created.runtimeSessionId)!
      .emit(
        testEnvelope(
          { type: 'model:updated', model: { id: 'model-2', displayName: 'Model Two' } },
          { sequence: 2, sessionId: created.sessionId },
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

    emit(envelope(1, { type: 'turn:started', turnId: 'prompt-1', prompt: 'hello' }));
    emit(
      envelope(2, {
        type: 'conversation:assistant-message',
        messageId: 'grok-assistant:prompt-1',
        text: 'hi',
        final: false,
      }),
    );
    emit(envelope(3, { type: 'turn:completed', turnId: 'prompt-1' }));

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
    });
    const created = await runtime.createSession({ agent: 'one' });
    if ('error' in created) throw new Error('unexpected create failure');
    const initialNativeSessionId = created.nativeSession.id;

    handles.get(created.terminalSessionId)!.emit(
      testEnvelope(
        { type: 'session:started', nativeSessionId: 'one-native-corrected' },
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
      .emit(testEnvelope({ type: 'session:ready' }, { sequence: 1, sessionId: first.sessionId, source: 'runtime' }));
    expect(observed).toEqual(['one-runtime-1:session:ready']);
    handles
      .get(first.runtimeSessionId)!
      .emit(
        testEnvelope(
          { type: 'conversation:assistant-message', text: 'duplicate transcript copy' },
          { sequence: 2, sessionId: first.sessionId, monotonicTime: 2, source: 'native-transcript' },
        ),
      );
    expect(observed).toEqual(['one-runtime-1:session:ready']);

    handles.get(first.runtimeSessionId)!.emit(
      testEnvelope(
        { type: 'turn:started', turnId: 'one-turn', prompt: 'hello' },
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
        { type: 'conversation:assistant-message', messageId: 'm1', text: '**hi**', final: false },
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
    const created = await runtime.spawn({
      agent: 'one',
      agentOptions: { token: 'provider-credential-token', environment: { SECRET: 'environment-secret' }, remoteUrl },
    });
    if ('error' in created) throw new Error('unexpected create failure');

    await writeFile(join(root, 'credential-source.ts'), 'raw-diff-secret\n');
    await expect(created.submitPrompt({ text: 'private prompt credential' })).resolves.toEqual({
      status: 'confirmed',
      turnId: 'one-turn',
    });
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
      descriptor: { id: 'one', label: 'One' },
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
      providers: [
        {
          descriptor: { id: 'broken', label: 'Broken' },
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
        { type: 'session:ready' },
        {
          eventId: 'provider-event-1',
          sourceEventRef: {
            namespace: 'provider-semantic',
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
        namespace: 'provider-semantic',
        eventId: 'provider-event-1',
        revisionKey: 'response-1:4',
        sourceGeneration: 3,
        cursorStart: 100,
        cursorEnd: 144,
      },
    });
    expect(observed.at(-1)!.sequence).not.toBe(99);
    const firstRevisionId = observed.at(-1)!.eventId;
    handles.get(created.terminalSessionId)!.emit(
      testEnvelope(
        { type: 'session:ready' },
        {
          sourceEventRef: {
            namespace: 'provider-semantic',
            eventId: 'provider-event-1',
            revisionKey: 'response-1:5',
            sourceGeneration: 3,
            cursorStart: 100,
            cursorEnd: 160,
          },
          sessionId: created.sessionId,
          timestamp: '2026-08-16T18:00:01.000Z',
          monotonicTime: 100,
        },
      ),
    );
    expect(observed.at(-1)!.eventId).not.toBe(firstRevisionId);
    const revisedEventId = observed.at(-1)!.eventId;
    const observedRevisions = observed.length;
    handles.get(created.terminalSessionId)!.emit(
      testEnvelope(
        { type: 'session:ready' },
        {
          sourceEventRef: {
            namespace: 'provider-semantic',
            eventId: 'provider-event-1',
            revisionKey: 'response-1:5',
            sourceGeneration: 3,
            cursorStart: 100,
            cursorEnd: 160,
          },
          sessionId: created.sessionId,
          timestamp: '2026-08-16T18:00:02.000Z',
          monotonicTime: 101,
        },
      ),
    );
    expect(observed).toHaveLength(observedRevisions);
    expect(observed.at(-1)!.eventId).toBe(revisedEventId);
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
      descriptor: { id: 'one', label: 'One' },
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
        { type: 'session:ready' },
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
        { type: 'session:ready' },
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

  it.each([undefined, 'pending-preparation'])(
    'waits for pending preparation cleanup during shutdown (%s)',
    async (creationRequestId) => {
      const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-pending-prepare-'));
      const source = join(root, 'source');
      await mkdir(source);
      const workspacesRoot = join(root, 'copies');
      const recorder = createActionRecorder({ path: join(root, 'own-actions.jsonl') });
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
      const provider = preparableProvider('one', hooks);
      const prepare = provider.prepareSession!;
      provider.prepareSession = async (options) => {
        const prepared = await prepare(options);
        entered();
        await gate;
        return prepared;
      };
      provider.dispose = vi.fn();
      const runtime = createAgentRuntime({
        host,
        defaultCwd: source,
        recorder,
        creationRegistry: createFileCreationRequestRegistry({ directory: join(root, 'registry') }),
        providers: [provider],
      });
      const pending = runtime.prepareSession({
        agent: 'one',
        creationRequestId,
        workspace: { mode: 'copy', workspacesRoot },
      });
      let shutdown: ReturnType<typeof runtime.dispose> | undefined;
      try {
        await started;
        let finished = false;
        shutdown = runtime.dispose().then((result) => {
          finished = true;
          return result;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(finished).toBe(false);
        expect(provider.dispose).not.toHaveBeenCalled();

        release();
        const result = await pending;
        expect(result).toMatchObject({ error: { code: 'PREPARATION_CANCELLED' } });
        await shutdown;
        await runtime.dispose();
        expect(hooks.disposeCount).toBe(1);
        expect(provider.dispose).toHaveBeenCalledTimes(1);
        expect(await readdir(workspacesRoot)).toEqual([]);
        const finals = (await recorder.read()).filter(
          (record) => isOwnActionV2(record) && record.type === 'workspace.finalized',
        );
        expect(finals).toEqual([
          expect.objectContaining({ trigger: 'runtime-disposal', cleanupOutcome: 'removed', retained: false }),
        ]);
      } finally {
        release();
        await pending;
        await shutdown;
        await runtime.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('waits for an anonymous session creation before disposing its provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-pending-create-'));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const provider = fakeProvider('one', new Map());
    const create = provider.createSession;
    const sessionDispose = vi.fn(async () => undefined);
    provider.createSession = async (options) => {
      entered();
      await gate;
      return { ...(await create(options)), dispose: sessionDispose };
    };
    provider.dispose = vi.fn(() => {
      expect(sessionDispose).toHaveBeenCalledTimes(1);
    });
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const pending = runtime.createSession({ agent: 'one' });
    let shutdown: ReturnType<typeof runtime.dispose> | undefined;
    try {
      await started;
      shutdown = runtime.dispose();
      await new Promise((resolve) => setImmediate(resolve));
      expect(provider.dispose).not.toHaveBeenCalled();
      release();
      const result = await pending;
      expect(result).not.toHaveProperty('error');
      await shutdown;
      expect(sessionDispose).toHaveBeenCalledTimes(1);
      expect(provider.dispose).toHaveBeenCalledTimes(1);
      expect(runtime.sessionInfo('one-runtime-1')).toBeUndefined();
    } finally {
      release();
      await pending;
      await shutdown;
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
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
      descriptor: { id: 'monitor-clean', label: 'Monitor Clean' },
      executionMode: 'native-tui',
      async createSession() {
        return {
          sessionId: 'monitor-clean-native',
          runtimeSessionId: 'monitor-clean-terminal',
          observationLevel: () => 'native-hooks',
          events: { onCandidate: () => () => undefined },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' };
              },
            },
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
          { type: 'session:ready' },
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
      descriptor: { id: 'monitor-crash', label: 'Monitor Crash' },
      async createSession() {
        return {
          sessionId: 'monitor-crash-native',
          runtimeSessionId: 'monitor-crash-terminal',
          observationLevel: () => 'terminal-only',
          events: { onCandidate: () => () => undefined },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' };
              },
            },
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
      descriptor: { id: 'monitor-retention', label: 'Monitor Retention' },
      async createSession() {
        const id = ++sequence;
        return {
          sessionId: `monitor-retention-native-${id}`,
          runtimeSessionId: `monitor-retention-terminal-${id}`,
          observationLevel: () => 'terminal-only',
          events: { onCandidate: () => () => undefined },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' };
              },
            },
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
    const eventListeners = new Set<(candidate: AdapterEventCandidate) => void>();
    let eventSubscriptions = 0;
    let artifactReads = 0;
    const provider: AgentProvider = {
      descriptor: { id: 'monitor-artifact', label: 'Monitor Artifact' },
      async createSession() {
        return {
          sessionId: 'monitor-artifact-native',
          runtimeSessionId: 'monitor-artifact-terminal',
          observationLevel: () => 'native-log',
          events: {
            onCandidate(listener) {
              eventSubscriptions += 1;
              eventListeners.add(listener);
              return () => eventListeners.delete(listener);
            },
          },
          services: {
            prompt: {
              async submit() {
                return { status: 'confirmed' };
              },
            },
            artifacts: {
              async read(artifactId) {
                artifactReads += 1;
                return {
                  status: 'ok' as const,
                  artifact: { artifactId, family: 'workflow-definition' as const, availability: 'readable' as const },
                  encoding: 'utf8' as const,
                  content: 'private workflow body',
                };
              },
            },
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
      { type: 'monitor:batch', batch: observation },
      { sessionId: 'monitor-artifact-native' },
    );
    for (const listener of eventListeners) listener(candidateFromEnvelope(semanticEnvelope));

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

  it('makes the three-state monitor an invariant of every live Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-invariant-'));
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('monitor-invariant', new Map())],
    });
    const created = await runtime.createSession({ agent: 'monitor-invariant' });
    if ('error' in created) throw new Error('unexpected create failure');
    const agent = runtime.agent(created.runtimeRunId);
    expect(agent).toBeDefined();
    expect(agent?.monitor).toBe(runtime.monitorState(created.runtimeRunId));
    expect(agent?.status).toBe(agent?.monitor.status);
    expect(agent?.alive).toBe(true);
    expect(agent?.lifecycle).toBe(agent?.state.lifecycle);
    const handle = agent!.observeMonitor();
    await expect(handle.ready).resolves.toBe(agent?.monitor);
    await handle.close();
    await runtime.dispose();
  });

  it('creates and retains the monitor before provider lookup can fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-monitor-start-failure-'));
    const states: Array<{ status: string; alive: boolean }> = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [],
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

  it('binds a spawn to a registered profile and hands the adapter the resolved account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-profile-spawn-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const base = fakeProvider('example', handles);
    const seenProfiles: Array<AgentProfile | undefined> = [];
    const provider: AgentProvider = {
      ...base,
      descriptor: { id: 'example', label: 'Example' },
      createSession(providerOptions) {
        seenProfiles.push(providerOptions.profile);
        return base.createSession(providerOptions);
      },
      profiles: exampleProfileService(),
    };
    const store = memoryProfileStore();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      profiles: { store, rootsDirectory: join(root, 'profiles') },
    });

    expect(runtime.profileProviders()).toEqual([
      {
        id: 'example',
        label: 'Example',
        support: {
          supported: true,
          identity: 'native-status',
          sharedSurfaces: [],
          nativeDefaultRoot: '/home/user/.example',
        },
      },
    ]);

    const changed: string[][] = [];
    runtime.onProfilesChanged((profiles) => changed.push(profiles.map((profile) => profile.id)));
    const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
    if ('status' in created) throw new Error(created.message);
    expect(changed.at(-1)).toEqual(['example:native-default', created.id]);
    await expect(runtime.profiles('example')).resolves.toHaveLength(2);
    await expect(runtime.profile(created.id)).resolves.toMatchObject({ label: 'Work' });

    const spawned = await runtime.spawn({ agent: 'example', profile: created.id });
    if ('error' in spawned) throw new Error(spawned.error.message);
    expect(seenProfiles).toEqual([created]);
    expect(spawned.info.profileId).toBe(created.id);
    expect(runtime.sessionInfo(spawned.info.terminalSessionId)?.profileId).toBe(created.id);

    await expect(runtime.profileBindingEnvironment([created.id])).resolves.toEqual({
      EXAMPLE_HOME: created.dataRoot,
    });
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('answers the observation root from the adapter and says nothing about profiles it cannot resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-profile-observation-'));
    const provider: AgentProvider = {
      ...preparableProvider('example', { prepareCount: 0, adoptCount: 0, disposeCount: 0 }),
      descriptor: { id: 'example', label: 'Example' },
      profiles: exampleProfileService(),
    };
    // A managed row whose provider composes no profile service at all: the
    // runtime has no rule to apply, so it answers undefined rather than guess.
    const foreign: AgentProfile = {
      id: 'foreign',
      provider: 'other',
      label: 'Foreign',
      kind: 'managed',
      dataRoot: '/roots/other/foreign',
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      profiles: {
        store: { load: async () => ({ version: 1, profiles: [foreign] }), save: async () => undefined },
        rootsDirectory: join(root, 'profiles'),
      },
    });

    const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
    if ('status' in created) throw new Error(created.message);
    await expect(runtime.profileObservationRoot(created.id)).resolves.toBe(created.dataRoot);
    await expect(runtime.profileObservationRoot('example:native-default')).resolves.toBe('/home/user/.example');
    await expect(runtime.profileObservationRoot('foreign')).resolves.toBeUndefined();
    await expect(runtime.profileObservationRoot('ghost')).resolves.toBeUndefined();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('fails a spawn with a clear error when the profile is unknown or belongs to another provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-profile-unknown-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const provider: AgentProvider = {
      ...preparableProvider('example', { prepareCount: 0, adoptCount: 0, disposeCount: 0 }),
      descriptor: { id: 'example', label: 'Example' },
      profiles: exampleProfileService(),
    };
    const third: AgentProvider = {
      ...fakeProvider('third', handles),
      descriptor: { id: 'third', label: 'Third' },
      profiles: exampleProfileService('third', 'Third'),
    };
    const withoutProfiles: AgentProvider = {
      ...fakeProvider('other', handles),
      descriptor: { id: 'other', label: 'Other' },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider, third, withoutProfiles],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });

    await expect(runtime.createSession({ agent: 'example', profile: 'nope' })).resolves.toMatchObject({
      error: { code: 'AGENT_PROFILE_NOT_FOUND', message: 'unknown account profile: nope' },
    });
    await expect(runtime.createSession({ agent: 'other', profile: 'example:native-default' })).resolves.toMatchObject({
      error: {
        code: 'AGENT_PROFILE_NOT_FOUND',
        message: 'agent provider does not expose account profiles: other',
      },
    });
    await expect(runtime.prepareSession({ agent: 'example', profile: 'third:native-default' })).resolves.toMatchObject({
      error: {
        code: 'AGENT_PROFILE_NOT_FOUND',
        message: 'account profile third:native-default belongs to third, not example',
      },
    });
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('attributes a native invocation to a profile from its launch environment alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-profile-attribution-'));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const normalizeInvocation = vi.fn(() => ({ status: 'accepted' as const }));
    const provider: AgentProvider = {
      ...preparableProvider('example', hooks),
      descriptor: { id: 'example', label: 'Example' },
      profiles: exampleProfileService(),
      launch: {
        provider: {
          id: 'example',
          label: 'Example',
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'example', executable: '/opt/example' }],
            environmentVariables: ['EXAMPLE_HOME'],
          },
        },
        normalizeInvocation,
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });
    const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
    if ('status' in created) throw new Error(created.message);

    const attribute = async (environment: Record<string, string>): Promise<string | undefined> => {
      const prepared = await runtime.prepareInvocation({
        providerId: 'example',
        cwd: root,
        argv: [],
        environment,
        implementation: { kind: 'native' },
      });
      if ('error' in prepared) throw new Error(prepared.error.message);
      const adopted = await runtime.adoptPrepared(prepared.preparationId, {
        terminalSessionId: `terminal-${prepared.preparationId}`,
      });
      if ('error' in adopted) throw new Error(adopted.error.message);
      await runtime.handleProcessExit(adopted.terminalSessionId, {
        exitCode: 0,
        signal: null,
        reason: 'process-exit',
      });
      return adopted.profileId;
    };

    await expect(attribute({ EXAMPLE_HOME: created.dataRoot })).resolves.toBe(created.id);
    // No binding variable at all is the vendor's own root.
    await expect(attribute({})).resolves.toBe('example:native-default');
    // A root Puppeteer did not allocate is left unattributed rather than mislabelled.
    await expect(attribute({ EXAMPLE_HOME: '/somewhere/else' })).resolves.toBeUndefined();
    // Attribution never rewrites what the adapter was handed.
    expect(normalizeInvocation).toHaveBeenCalledTimes(3);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('reads account usage per profile, stamps the snapshot, and coalesces per account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-profile-usage-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const fetched: Array<string | undefined> = [];
    const gates: Array<() => void> = [];
    const provider: AgentProvider = {
      ...fakeProvider('example', handles),
      descriptor: { id: 'example', label: 'Example' },
      profiles: exampleProfileService(),
      accountUsage: {
        provider: { id: 'example', label: 'Example', refresh: { pollIntervalMs: 60_000 } },
        async fetch(usageOptions) {
          fetched.push(usageOptions?.profile?.id);
          await new Promise<void>((resolve) => gates.push(resolve));
          return {
            status: 'available',
            snapshot: {
              provider: 'example',
              fetchedAt: '2026-09-06T12:00:00.000Z',
              scope: 'subscription',
              source: { kind: 'native-protocol', stability: 'documented' },
              metrics: [],
            },
          };
        },
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });
    const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
    if ('status' in created) throw new Error(created.message);

    const managed = runtime.accountUsage('example', created.id);
    const managedAgain = runtime.accountUsage('example', created.id);
    const nativeDefault = runtime.accountUsage('example', 'example:native-default');
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    for (const release of gates) release();

    // One account has one quota, so the two managed reads share one fetch.
    expect(fetched).toEqual([created.id, undefined]);
    await expect(managed).resolves.toMatchObject({ snapshot: { profileId: created.id } });
    await expect(managedAgain).resolves.toMatchObject({ snapshot: { profileId: created.id } });
    await expect(nativeDefault).resolves.toMatchObject({ snapshot: { profileId: 'example:native-default' } });

    await expect(runtime.accountUsage('example', 'ghost')).resolves.toEqual({
      status: 'unsupported',
      provider: 'example',
      message: 'unknown account profile: ghost',
      retryable: false,
    });
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('exposes distribution providers, inventory, releases, and update receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-distribution-'));
    const binDirectory = join(root, 'bin');
    await mkdir(binDirectory, { recursive: true });
    await writeFile(join(binDirectory, 'example'), '#!/bin/sh\n');
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const distributionProvider = {
      id: 'example',
      label: 'Example',
      commands: ['example'],
      npmPackages: [],
      brewNames: [],
      detectors: [
        {
          kind: 'text' as const,
          id: 'vendor-stable',
          channel: 'stable' as const,
          url: 'https://downloads.example.com/stable',
          versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
        },
      ],
      nativeUpdateCheck: false,
    };
    let version = '1.2.3';
    const provider: AgentProvider = {
      ...fakeProvider('example', handles),
      descriptor: { id: 'example', label: 'Example' },
      distribution: {
        provider: distributionProvider,
        async inspect(candidate) {
          return {
            provider: 'example',
            executable: candidate.executable,
            realPath: candidate.realPath,
            version,
            method: 'standalone-binary',
            autoUpdate: 'unknown',
            detectedAt: '2026-09-06T12:00:00.000Z',
            warnings: [],
          };
        },
        recipeFor: () => ({ kind: 'manual', instructions: 'reinstall from the vendor site' }),
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      distribution: {
        searchPath: binDirectory,
        transcriptsDirectory: join(root, 'updates'),
        fetch: (async () => new Response('1.3.0\n', { status: 200 })) as unknown as typeof fetch,
      },
    });

    expect(runtime.distributionProviders()).toEqual([distributionProvider]);
    const installations = await runtime.inspectInstallations();
    expect(installations).toMatchObject([
      { provider: 'example', executable: join(binDirectory, 'example'), origin: 'path', active: true },
    ]);

    await expect(runtime.checkReleases({ providerId: 'example' })).resolves.toMatchObject({
      releases: [],
      behind: [],
    });
    await expect(runtime.checkReleases({ providerId: 'example', network: true })).resolves.toMatchObject({
      behind: [{ channel: 'stable', version: '1.3.0' }],
    });
    await expect(runtime.checkReleases({ providerId: 'missing' })).resolves.toMatchObject({
      failures: [{ status: 'unsupported', provider: 'missing' }],
    });

    version = '1.3.0';
    // A manual recipe is reported rather than reinvented as a download.
    await expect(runtime.updateInstallation({ providerId: 'example' })).resolves.toMatchObject({
      status: 'unsupported',
      message: 'reinstall from the vendor site',
    });
    await expect(runtime.updateInstallation({ providerId: 'missing' })).resolves.toMatchObject({
      status: 'unsupported',
    });
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('resumes into a registered profile and hands the adapter its root again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-resume-profile-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const base = fakeProvider('example', handles);
    const seenProfiles: Array<AgentProfile | undefined> = [];
    const provider: AgentProvider = {
      ...base,
      descriptor: { id: 'example', label: 'Example' },
      createSession(providerOptions) {
        seenProfiles.push(providerOptions.profile);
        return base.createSession(providerOptions);
      },
      profiles: exampleProfileService(),
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });
    const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
    if ('status' in created) throw new Error(created.message);

    const spawned = await runtime.spawn({ agent: 'example', profile: created.id });
    if ('error' in spawned) throw new Error(spawned.error.message);
    const continuation = spawned.info.continuation;

    const resumed = await runtime.resume({ continuation, profile: created.id });
    if ('error' in resumed) throw new Error(resumed.error.message);
    // The adapter re-binds the root even if the continuation had lost it.
    expect(seenProfiles).toEqual([created, created]);
    expect(resumed.info.profileId).toBe(created.id);
    expect(runtime.sessionInfo(resumed.info.terminalSessionId)?.profileId).toBe(created.id);

    // Without a profile id a resume behaves exactly as it always has.
    const unattributed = await runtime.resume({ continuation });
    if ('error' in unattributed) throw new Error(unattributed.error.message);
    expect(seenProfiles.at(-1)).toBeUndefined();
    expect(unattributed.info.profileId).toBeUndefined();

    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('fails a resume whose profile is unknown or belongs to another provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-resume-profile-unknown-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const provider: AgentProvider = {
      ...fakeProvider('example', handles),
      descriptor: { id: 'example', label: 'Example' },
      profiles: exampleProfileService(),
    };
    const third: AgentProvider = {
      ...fakeProvider('third', handles),
      descriptor: { id: 'third', label: 'Third' },
      profiles: exampleProfileService('third', 'Third'),
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider, third],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });

    const spawned = await runtime.spawn({ agent: 'example' });
    if ('error' in spawned) throw new Error(spawned.error.message);
    const continuation = spawned.info.continuation;

    await expect(runtime.resume({ continuation, profile: 'nope' })).resolves.toMatchObject({
      error: { code: 'AGENT_PROFILE_NOT_FOUND', message: 'unknown account profile: nope' },
    });
    await expect(runtime.resume({ continuation, profile: 'third:native-default' })).resolves.toMatchObject({
      error: {
        code: 'AGENT_PROFILE_NOT_FOUND',
        message: 'account profile third:native-default belongs to third, not example',
      },
    });
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe('stable ingress — re-attaching a run to a process that outlived the host (AR-4 / PU-1)', () => {
  it('threads the host ingress to the provider and lets it report what was bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-ingress-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const seen: unknown[] = [];
    const provider: AgentProvider = {
      ...fakeProvider('one', handles),
      async createSession(options) {
        seen.push(options.ingress);
        options.ingress?.onBound?.({ port: 4242, token: 'minted' });
        return standaloneSession('native-ingress', 'terminal-ingress');
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });
    const bound: unknown[] = [];
    const spawned = await runtime.spawn({
      agent: 'one',
      ingress: { token: 'pinned', onBound: (value) => bound.push(value) },
    });
    if ('error' in spawned) throw new Error(spawned.error.message);
    expect(seen[0]).toMatchObject({ token: 'pinned' });
    expect(bound).toEqual([{ port: 4242, token: 'minted' }]);
    await runtime.dispose();
  });

  it('attaches to a running terminal through the provider and restores the run at the next epoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-attach-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-attach-registry-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const attachCalls: unknown[] = [];
    const providerFor = () =>
      ({
        ...fakeProvider('one', handles),
        async createSession() {
          return standaloneSession('native-attach', 'terminal-attach');
        },
        async attachSession(options) {
          attachCalls.push(options);
          return standaloneSession(options.sessionId, options.runtimeSessionId);
        },
      }) satisfies AgentProvider;

    // The first host: a spawn with a durable creation request, as a host that
    // means to survive itself must make it.
    const first = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [providerFor()],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const created = await first.createSession({ agent: 'one', creationRequestId: 'attach-run-one', cwd: root });
    if ('error' in created) throw new Error(created.error.message);
    expect(created.runtimeEpoch).toBe(1);
    // The host leaves; the terminal (and the process in it) do not. A detach
    // keeps the durable claim allocated — a plain dispose would close the run.
    await first.dispose({ detach: true });

    // The second host re-attaches from what it persisted.
    const second = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [providerFor()],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const attached = await second.attach({
      agent: 'one',
      creationRequestId: 'attach-run-one',
      runtimeRunId: created.runtimeRunId,
      expectedRuntimeEpoch: created.runtimeEpoch,
      sessionId: created.nativeSession.id,
      terminalSessionId: created.terminalSessionId,
      cwd: root,
      ingress: { port: 4242, token: 'pinned' },
    });
    if ('error' in attached) throw new Error(attached.error.message);
    expect(attached.runtimeRunId).toBe(created.runtimeRunId);
    expect(attached.runtimeEpoch).toBe(2);
    expect(attached.terminalSessionId).toBe('terminal-attach');
    expect(attached.nativeSession.id).toBe('native-attach');
    expect(attached.continuation.nativeSessionId).toBe('native-attach');
    expect(attachCalls[0]).toMatchObject({
      sessionId: 'native-attach',
      runtimeSessionId: 'terminal-attach',
      cwd: root,
      ingress: { port: 4242, token: 'pinned' },
      host,
    });
    // The run is live again: the Agent is reachable by its terminal, and the
    // same epoch cannot be restored twice.
    expect(second.agent('terminal-attach')?.runtimeRunId).toBe(created.runtimeRunId);
    expect(second.runtimeRunInfo(created.runtimeRunId)).toMatchObject({ status: 'active' });
    await second.dispose();
  });

  it('answers ATTACH_UNSUPPORTED for a provider without attachSession, ATTACH_FAILED for a binding that names another terminal, and disposes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-attach-refuse-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-attach-refuse-registry-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const plain = fakeProvider('plain', handles);
    let disposed = 0;
    const mismatched: AgentProvider = {
      ...fakeProvider('mismatched', handles),
      async attachSession(options) {
        const binding = standaloneSession(options.sessionId, 'some-other-terminal');
        return { ...binding, dispose: async () => void (disposed += 1) };
      },
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [plain, mismatched],
      creationRegistry: createFileCreationRequestRegistry({ directory: registryDirectory }),
    });
    const base = {
      creationRequestId: 'attach-refuse',
      runtimeRunId: 'run-refuse',
      expectedRuntimeEpoch: 1,
      sessionId: 'native-refuse',
      terminalSessionId: 'terminal-refuse',
      cwd: root,
    };
    const unsupported = await runtime.attach({ ...base, agent: 'plain' });
    expect('error' in unsupported && unsupported.error.code).toBe('ATTACH_UNSUPPORTED');
    const failed = await runtime.attach({ ...base, agent: 'mismatched' });
    expect('error' in failed && failed.error.code).toBe('ATTACH_FAILED');
    expect(disposed).toBe(1);
    const unknown = await runtime.attach({ ...base, agent: 'nope' });
    expect('error' in unknown && unknown.error.code).toBe('AGENT_NOT_FOUND');
    await runtime.dispose();
  });
});

describe('dispose({ detach }) — the host leaves, the sessions stay', () => {
  it('a plain dispose closes the run for good; a detach leaves its claim restorable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-detach-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-detach-registry-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const provider = (): AgentProvider => ({
      ...fakeProvider('one', handles),
      async createSession(options) {
        return standaloneSession(options.resume ?? 'native-detach', `terminal-${options.title ?? 'x'}`);
      },
      async attachSession(options) {
        return standaloneSession(options.sessionId, options.runtimeSessionId);
      },
    });
    const registry = () => createFileCreationRequestRegistry({ directory: registryDirectory });
    const first = createAgentRuntime({ host, defaultCwd: root, providers: [provider()], creationRegistry: registry() });
    const closed = await first.createSession({ agent: 'one', creationRequestId: 'closed-run', cwd: root, title: 'a' });
    const kept = await first.createSession({ agent: 'one', creationRequestId: 'kept-run', cwd: root, title: 'b' });
    if ('error' in closed || 'error' in kept) throw new Error('unexpected create failure');
    // one run closed by the host (its process ended), one merely left behind
    await first.handleProcessExit(closed.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' });
    const finals = await first.dispose({ detach: true });
    expect(finals).toEqual([]);

    const second = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [provider()],
      creationRegistry: registry(),
    });
    const attach = (info: typeof kept, creationRequestId: string) =>
      second.attach({
        agent: 'one',
        creationRequestId,
        runtimeRunId: info.runtimeRunId,
        expectedRuntimeEpoch: info.runtimeEpoch,
        sessionId: info.nativeSession.id,
        terminalSessionId: info.terminalSessionId,
        cwd: root,
      });
    const restored = await attach(kept, 'kept-run');
    expect('error' in restored ? restored.error.code : restored.runtimeEpoch).toBe(2);
    const refused = await attach(closed, 'closed-run');
    expect('error' in refused && refused.error.code).toBe('RUNTIME_RESTORE_FAILED');
    await second.dispose();
  });
});
