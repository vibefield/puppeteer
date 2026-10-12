import { describe, it, expect, vi } from 'vitest';
import { safeParseAgentEvent, type AdapterEventCandidate, type AgentEventEnvelope } from '@vibecook/puppeteer-core';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  translateAgentEventEnvelope,
} from '@vibecook/puppeteer-core/monitor-spi';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { createCodexObserver } from './observer.js';
import * as rolloutContext from './rollout-context.js';
import type { Transport } from '../transport/app-server-client.js';

/**
 * A controllable in-memory app-server. Auto-answers `initialize` and lets a test
 * decide how many times `thread/resume` fails with "no rollout found" before it
 * succeeds — the shape of the real 0.144.4 behaviour (a thread has no rollout
 * until its first turn produces output).
 */
function controllable(
  resumeFailuresBeforeSuccess: number,
  historyResult: unknown = {},
  options: { deferRead?: boolean; deferCatalog?: boolean } = {},
) {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((i: { code: number | null; signal: string | null }) => void) | undefined;
  let resumeFails = resumeFailuresBeforeSuccess;
  let resumeAttempts = 0;
  const calls: { method?: string; params?: unknown }[] = [];
  const sent: Record<string, unknown>[] = [];
  let deferredReadId: number | undefined;
  let deferredCatalogId: number | undefined;
  const transport: Transport = {
    send: (m) => {
      const msg = m as { id?: number; method?: string; params?: unknown };
      sent.push(msg as Record<string, unknown>);
      if (msg.id === undefined) return; // client notification (e.g. initialized)
      if (msg.method === undefined) return; // response to a server request
      calls.push({ method: msg.method, params: msg.params });
      queueMicrotask(() => {
        if (msg.method === 'thread/resume') {
          resumeAttempts++;
          if (resumeFails > 0) {
            resumeFails--;
            onMsg?.({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'no rollout found for thread id' } });
          } else {
            onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        } else if (msg.method === 'model/list' && options.deferCatalog) {
          deferredCatalogId = msg.id;
        } else if (msg.method === 'thread/read') {
          if (options.deferRead) deferredReadId = msg.id;
          else onMsg?.({ jsonrpc: '2.0', id: msg.id, result: historyResult });
        } else if (msg.method === 'thread/start') {
          onMsg?.({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              thread: {
                id: 'th-owned',
                sessionId: 'th-owned',
                path: '/tmp/rollout-th-owned.jsonl',
              },
            },
          });
        } else {
          onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} }); // initialize, inject_items, …
        }
      });
    },
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => {},
  };
  return {
    transport,
    deliver: (m: unknown) => onMsg?.(m),
    fireClose: () => onCls?.({ code: null, signal: null }),
    resumeAttempts: () => resumeAttempts,
    calls: () => calls,
    sent: () => sent,
    releaseCatalog: (result: unknown = {}) => {
      if (deferredCatalogId === undefined) throw new Error('model/list is not pending');
      onMsg?.({ jsonrpc: '2.0', id: deferredCatalogId, result });
      deferredCatalogId = undefined;
    },
    releaseRead: () => {
      if (deferredReadId === undefined) throw new Error('thread/read is not pending');
      onMsg?.({ jsonrpc: '2.0', id: deferredReadId, result: historyResult });
      deferredReadId = undefined;
    },
  };
}

const threadStarted = { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'th-1' } } };

function monitorFromEvents(envelopes: readonly AgentEventEnvelope[]) {
  const identity = { runtimeRunId: 'run-codex', runtimeEpoch: 1 };
  let state = createMonitorAccumulatorState({
    ...identity,
    allocatedAt: '2026-09-11T12:00:00.000Z',
    providerId: 'codex',
    executionMode: 'native-tui',
    observationLevel: 'structured',
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

describe('createCodexObserver attach resilience', () => {
  it('keeps retrying thread/resume until it succeeds, then attaches (no one-shot give-up)', async () => {
    const t = controllable(4); // rollout only materializes on the 5th resume
    const obs = await createCodexObserver({ transport: t.transport });
    const projection = projectAgentEvents(obs);
    const seen: string[] = [];
    obs.events.onCandidate((e) => seen.push(e.event.type));

    expect(projection.state.lifecycle).toBe('preparing');
    t.deliver(threadStarted); // the TUI created a thread

    await vi.waitFor(() => expect(projection.state.lifecycle).toBe('ready'), { timeout: 5000 });
    expect(obs.sessionId).toBe('th-1');
    expect(seen).toContain('session:started');
    expect(t.resumeAttempts()).toBeGreaterThan(4);
    projection.dispose();
    await obs.dispose();
  });

  it('stops retrying when disposed before the thread ever materializes', async () => {
    const t = controllable(Number.POSITIVE_INFINITY); // resume never succeeds
    const obs = await createCodexObserver({ transport: t.transport });
    const projection = projectAgentEvents(obs);
    t.deliver(threadStarted);

    await vi.waitFor(() => expect(t.resumeAttempts()).toBeGreaterThan(1), { timeout: 2000 });
    await obs.dispose();
    const attemptsAtDispose = t.resumeAttempts();

    await new Promise((r) => setTimeout(r, 600)); // longer than the backoff cap
    expect(projection.state.lifecycle).toBe('preparing');
    // The loop has stopped: no further resume attempts after dispose (allow one in-flight).
    expect(t.resumeAttempts()).toBeLessThanOrEqual(attemptsAtDispose + 1);
    projection.dispose();
  });
});

describe('createCodexObserver controller-owned bootstrap', () => {
  it('applies requested model and effort when creating the native thread, without changing profile defaults', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({
      transport: t.transport,
      start: { cwd: '/tmp/ws', model: 'chosen-model', effort: 'high' },
    });
    const projection = projectAgentEvents(obs);
    try {
      expect(t.calls().find((call) => call.method === 'thread/start')?.params).toMatchObject({
        model: 'chosen-model',
        config: { model_reasoning_effort: 'high' },
      });
      expect(t.calls().some((call) => call.method?.startsWith('config/'))).toBe(false);
      expect(projection.monitorBatches.flatMap((batch) => batch.updates)).toContainEqual(
        expect.objectContaining({ family: 'effort', value: { kind: 'effort', value: 'high', intent: 'configured' } }),
      );
    } finally {
      projection.dispose();
      await obs.dispose();
    }
    const defaults = controllable(0);
    const inherited = await createCodexObserver({ transport: defaults.transport, start: { cwd: '/tmp/ws' } });
    try {
      expect(defaults.calls().find((call) => call.method === 'thread/start')?.params).not.toHaveProperty('config');
    } finally {
      await inherited.dispose();
    }
  });

  it('publishes the native-TUI observer rail as catalog-routed candidates', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
    const candidates: AdapterEventCandidate[] = [];
    const off = obs.events.onCandidate((candidate) => candidates.push(candidate));

    expect(candidates.some(({ type }) => type === 'session:started')).toBe(true);
    expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
    expect(candidates.every((candidate) => !('sequence' in candidate))).toBe(true);
    expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);

    off();
    await obs.dispose();
  });

  it('reaches native readiness without a catalog reply or fresh-thread history reads', async () => {
    const t = controllable(0, {}, { deferCatalog: true });
    const contextRead = vi.spyOn(rolloutContext, 'readLastCodexContextWindow');
    try {
      const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws', model: 'model-a' } });
      const projection = projectAgentEvents(obs);
      expect(obs.sessionId).toBe('th-owned');
      expect(projection.state.lifecycle).toBe('ready');
      expect(t.calls().map((call) => call.method)).not.toContain('thread/read');
      expect(contextRead).not.toHaveBeenCalled();
      // The model can change before optional metadata arrives. Enrich the
      // latest identity, never restore the model from the bootstrap response.
      const candidates: AdapterEventCandidate[] = [];
      obs.events.onCandidate((candidate) => candidates.push(candidate));
      t.deliver({
        jsonrpc: '2.0',
        method: 'thread/settings/updated',
        params: { threadId: 'th-owned', model: 'model-b' },
      });
      t.releaseCatalog({
        data: [
          { id: 'model-a', displayName: 'A' },
          { id: 'model-b', displayName: 'B' },
        ],
      });
      await vi.waitFor(() =>
        expect(candidates.filter((c) => c.type === 'model:updated').at(-1)?.event).toMatchObject({
          model: { id: 'model-b', displayName: 'B' },
        }),
      );
      const correction = candidates.filter((c) => c.type === 'monitor:batch').at(-1)?.event;
      expect(correction).toMatchObject({
        batch: {
          phase: 'correction',
          updates: expect.arrayContaining([
            expect.objectContaining({
              family: 'model',
              key: 'observed',
              value: expect.objectContaining({ providerModelId: 'model-b', displayName: 'B' }),
            }),
          ]),
        },
      });
      await obs.dispose();
    } finally {
      contextRead.mockRestore();
    }
  });

  it.each(['dispose', 'rail-close'] as const)('does not publish late catalog evidence after %s', async (ending) => {
    const t = controllable(0, {}, { deferCatalog: true });
    const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws', model: 'model-a' } });
    const candidates: AdapterEventCandidate[] = [];
    obs.events.onCandidate((candidate) => candidates.push(candidate));
    if (ending === 'dispose') await obs.dispose();
    else t.fireClose();
    const count = candidates.length;
    t.releaseCatalog({ data: [{ id: 'model-a', displayName: 'A' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(candidates).toHaveLength(count);
    await obs.dispose();
  });

  it('start: thread/start → inject_items → resume → ready with session id', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({
      transport: t.transport,
      start: { cwd: '/tmp/ws', model: 'gpt-5.6-sol', sandbox: 'read-only', approvalPolicy: 'never' },
    });
    const projection = projectAgentEvents(obs);

    // Bootstrap completes before createCodexObserver resolves — ready immediately,
    // no user prompt required (the desktop panel "preparing" fix).
    expect(obs.sessionId).toBe('th-owned');
    expect(obs.threadPath()).toBe('/tmp/rollout-th-owned.jsonl');
    expect(projection.state.lifecycle).toBe('ready');

    const methods = t.calls().map((c) => c.method);
    expect(methods).toContain('thread/start');
    expect(methods).toContain('thread/inject_items');
    expect(methods).toContain('thread/resume');

    const inject = t.calls().find((c) => c.method === 'thread/inject_items');
    expect(inject?.params).toEqual({
      threadId: 'th-owned',
      items: [{ type: 'text', text: '' }],
    });

    const start = t.calls().find((c) => c.method === 'thread/start');
    expect(start?.params).toMatchObject({
      cwd: '/tmp/ws',
      model: 'gpt-5.6-sol',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });

    const monitorBatches = projection.monitorBatches;
    expect(monitorBatches[0]).toMatchObject({ phase: 'bootstrap', capabilities: expect.any(Array) });
    expect(monitorBatches.every(({ phase }) => phase === 'bootstrap')).toBe(true);

    projection.dispose();
    await obs.dispose();
  });

  describe('who decides the permissions left unset', () => {
    const configuredPermission = (projection: ReturnType<typeof projectAgentEvents>): unknown =>
      projection.monitorBatches
        .flatMap(({ updates }) => updates as Array<{ key?: string; value?: { raw?: unknown } }>)
        .find(({ key }) => key === 'provider-permission-configured')?.value?.raw;

    it("keeps the adapter's explicit defaults for a caller that is not a typed launch (a host's own spawn)", async () => {
      const t = controllable(0);
      const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
      const projection = projectAgentEvents(obs);
      expect(t.calls().find((call) => call.method === 'thread/start')?.params).toMatchObject({
        cwd: '/tmp/ws',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      expect(configuredPermission(projection)).toBe('approval:on-request; sandbox:workspace-write');
      projection.dispose();
      await obs.dispose();
    });

    it("leaves them out of thread/start for a typed launch, so the app-server's configuration decides", async () => {
      const t = controllable(0);
      const obs = await createCodexObserver({
        transport: t.transport,
        start: { cwd: '/tmp/ws', permissionDefaults: 'configuration' },
      });
      const projection = projectAgentEvents(obs);
      const params = t.calls().find((call) => call.method === 'thread/start')?.params;
      expect(params).toMatchObject({ cwd: '/tmp/ws' });
      expect(params).not.toHaveProperty('sandbox');
      expect(params).not.toHaveProperty('approvalPolicy');
      expect(configuredPermission(projection)).toBeUndefined();
      projection.dispose();
      await obs.dispose();
    });

    it('sends what a typed launch named and leaves only the rest to the configuration', async () => {
      const t = controllable(0);
      const obs = await createCodexObserver({
        transport: t.transport,
        start: { cwd: '/tmp/ws', sandbox: 'read-only', permissionDefaults: 'configuration' },
      });
      const projection = projectAgentEvents(obs);
      const params = t.calls().find((call) => call.method === 'thread/start')?.params;
      expect(params).toMatchObject({ cwd: '/tmp/ws', sandbox: 'read-only' });
      expect(params).not.toHaveProperty('approvalPolicy');
      expect(configuredPermission(projection)).toBe('sandbox:read-only');
      projection.dispose();
      await obs.dispose();
    });
  });

  it('keeps the observed TUI run alive and degrades monitor readiness when its app-server rail closes', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
    const projection = projectAgentEvents(obs);
    const events: Array<{ type: string }> = [];
    const monitorBatches = projection.monitorBatches;
    obs.events.onCandidate(({ event }) => events.push(event));

    t.fireClose();

    expect(obs.observationLevel()).toBe('terminal-only');
    expect(projection.state.lifecycle).toBe('ready');
    expect(events.some(({ type }) => type === 'process:exited' || type === 'session:exited')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'adapter:native-event',
      nativeType: 'app-server.transport.closed',
    });
    expect(monitorBatches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable', updates: [] });
    projection.dispose();
    await obs.dispose();
  });

  it('observes multiplexed child-thread metrics without reducing them as root TUI events', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
    const projection = projectAgentEvents(obs);
    const events: string[] = [];
    const monitorBatches = projection.monitorBatches;
    obs.events.onCandidate(({ event }) => events.push(event.type));
    events.length = 0;

    t.deliver({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: { id: 'th-child', parentThreadId: 'th-owned', status: { type: 'active' } } },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th-child',
        turnId: 'child-turn',
        tokenUsage: { total: { totalTokens: 90 }, last: { totalTokens: 45 }, modelContextWindow: 180 },
      },
    });

    expect(events).toEqual(['monitor:batch', 'monitor:batch']);
    expect(projection.state.activeTurn).toBeUndefined();
    expect(
      monitorBatches
        .flatMap(({ updates }) => updates)
        .some(
          (update) =>
            update.family === 'usage' &&
            update.operation === 'upsert' &&
            update.value.actor?.nativeSessionId === 'th-child',
        ),
    ).toBe(true);
    projection.dispose();
    await obs.dispose();
  });

  it('routes controller-owned approval requests through the supplied policy', async () => {
    const t = controllable(0);
    const onApproval = vi.fn(() => 'approved' as const);
    const obs = await createCodexObserver({
      transport: t.transport,
      start: { cwd: '/tmp/ws' },
      onApproval,
    });
    const projection = projectAgentEvents(obs);
    const events: string[] = [];
    obs.events.onCandidate((envelope) => events.push(envelope.event.type));

    t.deliver({
      jsonrpc: '2.0',
      id: 999,
      method: 'execCommandApproval',
      params: { command: 'git status' },
    });

    await vi.waitFor(() => {
      expect(t.sent().find((message) => message.id === 999 && 'result' in message)?.result).toEqual({
        decision: 'approved',
      });
    });
    expect(onApproval).toHaveBeenCalledWith({
      method: 'execCommandApproval',
      params: { command: 'git status' },
      requestId: 999,
    });
    expect(events).toEqual(
      expect.arrayContaining(['interaction:permission-requested', 'interaction:permission-resolved']),
    );
    await obs.dispose();
  });

  it('threadId: resumes a known id and is ready immediately', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({
      transport: t.transport,
      threadId: 'th-resume-me',
    });
    const projection = projectAgentEvents(obs);
    expect(obs.sessionId).toBe('th-resume-me');
    expect(projection.state.lifecycle).toBe('ready');
    expect(t.calls().some((c) => c.method === 'thread/start')).toBe(false);
    expect(t.calls().some((c) => c.method === 'thread/resume')).toBe(true);
    projection.dispose();
    await obs.dispose();
  });

  it('replays completed resume history to the first subscriber', async () => {
    const t = controllable(0, {
      thread: {
        id: 'th-history',
        path: '/tmp/rollout-th-history.jsonl',
        turns: [
          {
            id: 'turn-history',
            status: 'completed',
            error: null,
            items: [
              {
                type: 'userMessage',
                id: 'user-history',
                clientId: null,
                content: [{ type: 'text', text: 'What did we decide?', text_elements: [] }],
              },
              { type: 'agentMessage', id: 'assistant-history', text: 'Use the native resume path.' },
            ],
          },
        ],
      },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-history' });
    const projection = projectAgentEvents(obs);
    const events: unknown[] = projection.envelopes
      .filter(({ event }) => event.type !== 'monitor:batch' && event.type !== 'environment:updated')
      .map(({ event }) => event);

    expect(events).toEqual([
      { type: 'session:started', nativeSessionId: 'th-history' },
      { type: 'turn:started', turnId: 'turn-history', prompt: 'What did we decide?' },
      {
        type: 'conversation:assistant-message',
        messageId: 'assistant-history',
        turnId: 'turn-history',
        text: 'Use the native resume path.',
        final: true,
        displayOnly: false,
      },
      { type: 'turn:completed', turnId: 'turn-history' },
    ]);
    expect(projection.state.lastAssistantMessage).toBe('Use the native resume path.');
    expect(t.calls().find((call) => call.method === 'thread/resume')?.params).toEqual({ threadId: 'th-history' });
    expect(t.calls().find((call) => call.method === 'thread/read')?.params).toEqual({
      threadId: 'th-history',
      includeTurns: true,
    });
    projection.dispose();
    await obs.dispose();
  });

  it.each([false, true])('preserves startup and long history before subscription (live turn: %s)', async (liveTurn) => {
    const history = {
      thread: {
        id: 'th-long-history',
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn-old',
            status: 'completed',
            items: [
              { type: 'userMessage', id: 'user-old', content: [{ type: 'text', text: 'Old prompt' }] },
              ...Array.from({ length: 150 }, (_, index) => ({
                type: 'commandExecution',
                id: `command-${index}`,
                command: 'pwd',
                status: 'completed',
                exitCode: 0,
              })),
              { type: 'agentMessage', id: 'assistant-old', text: 'Old answer' },
            ],
          },
        ],
      },
    };
    const t = controllable(0, history);
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-long-history' });
    if (liveTurn) {
      // The TUI can start work after attachment but before runtime subscribes.
      t.deliver({ method: 'turn/started', params: { threadId: 'th-long-history', turn: { id: 'turn-live' } } });
      t.deliver({
        method: 'item/completed',
        params: {
          threadId: 'th-long-history',
          turnId: 'turn-live',
          item: { type: 'userMessage', id: 'user-live', content: [{ type: 'text', text: 'New prompt' }] },
        },
      });
    }
    const projection = projectAgentEvents(obs);
    expect(projection.envelopes.length).toBeGreaterThan(256);
    expect(projection.envelopes.some(({ event }) => event.type === 'session:started')).toBe(true);
    expect(projection.monitorBatches.some((batch) => batch.capabilities?.length)).toBe(true);
    expect(projection.envelopes.filter(({ event }) => event.type === 'tool:completed')).toHaveLength(150);
    expect(projection.state.lastAssistantMessage).toBe('Old answer');
    expect(monitorFromEvents(projection.envelopes).status).toBe(liveTurn ? 'working' : 'idle');
    if (liveTurn) {
      expect(projection.state.activeTurn?.id).toBe('turn-live');
      t.deliver({
        method: 'turn/completed',
        params: { threadId: 'th-long-history', turn: { id: 'turn-live', status: 'completed' } },
      });
      expect(monitorFromEvents(projection.envelopes).status).toBe('idle');
    }
    projection.dispose();
    await obs.dispose();
  });

  it.each(['pendingInit', 'running', 'active', 'inProgress'])(
    'does not treat historical subagent status %s as live work',
    async (status) => {
      const t = controllable(0, {
        thread: {
          id: 'th-history',
          turns: [
            {
              id: 'turn-old',
              status: 'completed',
              items: [
                {
                  type: 'collabAgentToolCall',
                  id: 'spawn-old',
                  tool: 'spawnAgent',
                  status: 'completed',
                  senderThreadId: 'th-history',
                  receiverThreadIds: ['child-old'],
                  agentsStates: { 'child-old': { status } },
                  model: 'gpt-5.6-sol',
                  reasoningEffort: 'high',
                },
              ],
            },
          ],
        },
      });
      const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-history' });
      const projection = projectAgentEvents(obs);
      const restored = monitorFromEvents(projection.envelopes);
      expect(restored.status).toBe('idle');
      expect(restored.subagents).toMatchObject([
        { id: 'child-old', working: false, modelId: 'gpt-5.6-sol', effort: 'high' },
      ]);
      t.deliver({ method: 'turn/started', params: { threadId: 'child-old', turn: { id: 'child-live-turn' } } });
      expect(monitorFromEvents(projection.envelopes).status).toBe('working');
      t.deliver({
        method: 'turn/completed',
        params: { threadId: 'child-old', turn: { id: 'child-live-turn', status: 'completed' } },
      });
      expect(monitorFromEvents(projection.envelopes).status).toBe('idle');
      projection.dispose();
      await obs.dispose();
    },
  );

  it('applies the latest rollout context after replaying old compaction items', async () => {
    const context = vi.spyOn(rolloutContext, 'readLastCodexContextWindow').mockResolvedValue({
      type: 'context-window:updated',
      usedTokens: 42,
      capacityTokens: 100,
    });
    const t = controllable(0, {
      thread: {
        id: 'th-history',
        path: '/tmp/rollout-history.jsonl',
        turns: [{ id: 'turn-old', status: 'completed', items: [{ type: 'contextCompaction', id: 'compact-old' }] }],
      },
    });
    try {
      const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-history' });
      const projection = projectAgentEvents(obs);
      expect(monitorFromEvents(projection.envelopes).context).toMatchObject({ usedTokens: 42, capacityTokens: 100 });
      projection.dispose();
      await obs.dispose();
    } finally {
      context.mockRestore();
    }
  });

  it('keeps connection loss newer than deferred history evidence', async () => {
    const t = controllable(0, {
      thread: {
        id: 'th-history',
        turns: [{ id: 'turn-old', status: 'completed', items: [{ type: 'contextCompaction', id: 'compact-old' }] }],
      },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-history' });
    t.fireClose();
    const projection = projectAgentEvents(obs);
    expect(projection.monitorBatches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
    projection.dispose();
    await obs.dispose();
  });

  it('queues live notifications until history replay finishes, without replay overlap', async () => {
    const history = {
      thread: {
        id: 'th-history',
        turns: [
          {
            id: 'turn-old',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'user-old',
                content: [{ type: 'text', text: 'Old prompt' }],
              },
              { type: 'agentMessage', id: 'assistant-old', text: 'Old answer' },
            ],
          },
          {
            id: 'turn-overlap',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'user-overlap',
                content: [{ type: 'text', text: 'Overlapping prompt' }],
              },
              { type: 'agentMessage', id: 'assistant-overlap', text: 'Overlapping answer' },
            ],
          },
        ],
      },
    };
    const t = controllable(0, history, { deferRead: true });
    const creating = createCodexObserver({ transport: t.transport, threadId: 'th-history' });

    await vi.waitFor(() => expect(t.calls().some((call) => call.method === 'thread/read')).toBe(true));

    // This completed turn is already in the eventual read response and must
    // not be reduced a second time when the replay barrier drains.
    t.deliver({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'th-history', turn: { id: 'turn-overlap' } },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'th-history',
        turnId: 'turn-overlap',
        item: {
          type: 'userMessage',
          id: 'user-overlap',
          content: [{ type: 'text', text: 'Overlapping prompt' }],
        },
      },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'th-history',
        turnId: 'turn-overlap',
        item: { type: 'agentMessage', id: 'assistant-overlap', text: 'Overlapping answer' },
      },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'th-history', turn: { id: 'turn-overlap', status: 'completed' } },
    });

    // This turn is not in the read snapshot and must land strictly after all
    // replayed history.
    t.deliver({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'th-history', turn: { id: 'turn-live' } },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'th-history',
        turnId: 'turn-live',
        item: {
          type: 'userMessage',
          id: 'user-live',
          content: [{ type: 'text', text: 'Live prompt' }],
        },
      },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'th-history',
        turnId: 'turn-live',
        item: { type: 'agentMessage', id: 'assistant-live', text: 'Live answer' },
      },
    });
    t.deliver({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'th-history', turn: { id: 'turn-live', status: 'completed' } },
    });

    t.releaseRead();
    const obs = await creating;
    const events: Array<{ replay?: boolean | undefined; event: { type: string; text?: string | undefined } }> = [];
    obs.events.onCandidate((envelope) => events.push(envelope));

    expect(
      events
        .filter((envelope) => envelope.event.type === 'conversation:assistant-message')
        .map((envelope) => ({ text: envelope.event.text, replay: envelope.replay })),
    ).toEqual([
      { text: 'Old answer', replay: true },
      { text: 'Overlapping answer', replay: true },
      { text: 'Live answer', replay: undefined },
    ]);
    expect(events.filter((envelope) => envelope.event.type === 'turn:completed')).toHaveLength(3);
    await obs.dispose();
  });

  it('rejects threadId + start together', async () => {
    const t = controllable(0);
    await expect(
      createCodexObserver({
        transport: t.transport,
        threadId: 'x',
        start: { cwd: '/tmp' },
      }),
    ).rejects.toThrow(/threadId OR start/);
  });
});
