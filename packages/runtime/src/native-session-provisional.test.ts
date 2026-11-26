import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentEventCategory,
  agentEventType,
  type AdapterEventCandidate,
  type AgentAdapterBinding,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentHost,
} from '@vibefield/puppeteer-core';
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

function candidate(
  event: AgentEvent,
  fields: Partial<Omit<AgentEventEnvelope, 'type' | 'category' | 'event'>> = {},
): AdapterEventCandidate {
  const envelope: AgentEventEnvelope = {
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
  const { sequence: _sequence, category: _category, ...stamped } = envelope;
  return stamped as AdapterEventCandidate;
}

/** A binding the test drives: `provisional` is the adapter's word, read at each call; absent = no predicate. */
function binding(
  kind: string,
  sessionId: string,
  runtimeSessionId: string,
  listeners: Set<(candidate: AdapterEventCandidate) => void>,
  provisional?: { value: boolean },
): AgentAdapterBinding {
  const word = provisional;
  return {
    sessionId,
    runtimeSessionId,
    observationLevel: () => 'native-log',
    ...(word === undefined ? {} : { nativeSessionProvisional: () => word.value }),
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
}

function provider(kind: string, sessionId: string, provisional?: { value: boolean }) {
  const listeners = new Set<(candidate: AdapterEventCandidate) => void>();
  const created: AgentProvider = {
    descriptor: { id: kind, label: kind },
    async createSession() {
      return binding(kind, sessionId, `${kind}-runtime-1`, listeners, provisional);
    },
  };
  const emit = (event: AgentEvent, fields: Partial<AgentEventEnvelope> = {}) =>
    listeners.forEach((listener) => listener(candidate(event, fields)));
  return { provider: created, emit };
}

describe('a continuation is provisional while its adapter has not named the session', () => {
  it('says provisional under the minted id, and drops the word once a start names the agent’s own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provisional-bound-'));
    const provisional = { value: true };
    const { provider: minted, emit } = provider('minted', 'minted-pending-1', provisional);
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [minted] });
    const created = await runtime.createSession({ agent: 'minted' });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(created.continuation).toEqual({
      providerId: 'minted',
      nativeSessionId: 'minted-pending-1',
      implementation: 'native',
      provisional: true,
    });

    // Evidence that names no session leaves the placeholder as it is.
    emit({ type: 'environment:updated', currentCwd: root }, { sessionId: 'minted-pending-1', source: 'runtime' });
    expect(runtime.sessionInfo(created.terminalSessionId)?.continuation.provisional).toBe(true);

    // The adapter turns its word false before it publishes under the agent's own id.
    provisional.value = false;
    emit(
      { type: 'session:started', nativeSessionId: 'minted-native-1', startSource: 'native-wire-bind' },
      { eventId: 'minted-bound', sessionId: 'minted-native-1' },
    );
    const info = runtime.sessionInfo(created.terminalSessionId);
    expect(info?.nativeSession.id).toBe('minted-native-1');
    expect(info?.continuation).toEqual({
      providerId: 'minted',
      nativeSessionId: 'minted-native-1',
      implementation: 'native',
    });
    expect(info?.continuation).not.toHaveProperty('provisional');
    await runtime.dispose();
  });

  it('rebuilds a provisional continuation under the current claim once the binding no longer says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provisional-same-'));
    const provisional = { value: true };
    const { provider: minted, emit } = provider('minted', 'minted-native-2', provisional);
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [minted] });
    const created = await runtime.createSession({ agent: 'minted' });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(created.continuation.provisional).toBe(true);

    // The id does not move, so no revision rebuilds the continuation: the next event does.
    provisional.value = false;
    emit({ type: 'session:ready' }, { sessionId: 'minted-native-2', nativeSessionId: 'minted-native-2' });
    const info = runtime.sessionInfo(created.terminalSessionId);
    expect(info?.continuation).toEqual({
      providerId: 'minted',
      nativeSessionId: 'minted-native-2',
      implementation: 'native',
    });
    expect(info?.nativeSessionRevision).toBe(created.nativeSessionRevision);
    await runtime.dispose();
  });

  it('a binding that does not say is never provisional', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provisional-silent-'));
    const { provider: silent, emit } = provider('silent', 'silent-native-1');
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [silent] });
    const created = await runtime.createSession({ agent: 'silent' });
    if ('error' in created) throw new Error('unexpected create failure');
    expect(created.continuation).not.toHaveProperty('provisional');

    emit(
      { type: 'session:started', nativeSessionId: 'silent-native-2', rebind: true, startSource: 'clear' },
      { eventId: 'silent-rotated', sessionId: 'silent-native-2' },
    );
    const info = runtime.sessionInfo(created.terminalSessionId);
    expect(info?.nativeSession.id).toBe('silent-native-2');
    expect(info?.continuation).not.toHaveProperty('provisional');
    await runtime.dispose();
  });

  it('an adopted run is provisional only if the adopted binding says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-provisional-adopted-'));
    const provisional = { value: true };
    const listeners = new Set<(candidate: AdapterEventCandidate) => void>();
    const preparable: AgentProvider = {
      descriptor: { id: 'picker', label: 'picker' },
      async createSession() {
        throw new Error('this provider only prepares');
      },
      async prepareSession(options) {
        return {
          sessionId: 'picker-minted-1',
          launch: { command: '/opt/picker', args: [], cwd: options.cwd, env: {} },
          async adopt(runtimeSessionId) {
            return binding('picker', 'picker-minted-1', runtimeSessionId, listeners, provisional);
          },
          async dispose() {},
        };
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [preparable] });
    const prepared = await runtime.prepareSession({ agent: 'picker' });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    // No binding yet: nothing has said the id is a placeholder.
    expect(prepared.continuation).not.toHaveProperty('provisional');

    const adopted = await runtime.adoptPrepared(prepared.preparationId, { terminalSessionId: 'picker-pane' });
    if ('error' in adopted) throw new Error('unexpected adopt failure');
    expect(adopted.continuation).toEqual({
      providerId: 'picker',
      nativeSessionId: 'picker-minted-1',
      implementation: 'native',
      provisional: true,
    });
    await runtime.dispose();
  });
});

describe('session:forked never moves the run’s native session', () => {
  it('keeps the observed id, its revision and its continuation, and delivers the fork’s id to a listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-forked-'));
    const { provider: observed, emit } = provider('observed', 'observed-native-1');
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [observed] });
    const created = await runtime.createSession({ agent: 'observed' });
    if ('error' in created) throw new Error('unexpected create failure');
    const forks: Array<{ observed: string | undefined; fork: string; startSource: string | undefined }> = [];
    runtime.agent(created.terminalSessionId)?.on('session:forked', (envelope) => {
      forks.push({
        observed: envelope.nativeSessionId,
        fork: envelope.event.nativeSessionId,
        startSource: envelope.event.startSource,
      });
    });

    // As an adapter sends it: the envelope keeps the observed session, the payload names the fork.
    emit(
      { type: 'session:forked', nativeSessionId: 'forked-native-1', startSource: 'fork' },
      { eventId: 'fork-1', sessionId: 'observed-native-1', nativeSessionId: 'observed-native-1' },
    );
    // And with no id on the envelope at all: the payload is still not the run's.
    emit(
      { type: 'session:forked', nativeSessionId: 'forked-native-2' },
      { eventId: 'fork-2', sessionId: 'observed-native-1' },
    );

    const info = runtime.sessionInfo(created.terminalSessionId);
    expect(info?.nativeSession.id).toBe('observed-native-1');
    expect(info?.nativeSessionRevision).toBe(created.nativeSessionRevision);
    expect(info?.sessionId).toBe('observed-native-1');
    expect(info?.continuation).toEqual(created.continuation);
    expect(runtime.monitorState(created.runtimeRunId)?.session.nativeSessionId).toBe('observed-native-1');
    expect(forks).toEqual([
      { observed: 'observed-native-1', fork: 'forked-native-1', startSource: 'fork' },
      { observed: undefined, fork: 'forked-native-2', startSource: undefined },
    ]);
    await runtime.dispose();
  });
});
