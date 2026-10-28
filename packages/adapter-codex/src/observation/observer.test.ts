import { describe, it, expect, vi } from 'vitest';
import { safeParseAgentEvent, type AdapterEventCandidate, type AgentEventEnvelope } from '@vibefield/puppeteer-core';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  translateAgentEventEnvelope,
} from '@vibefield/puppeteer-core/monitor-spi';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createCodexObserver } from './observer.js';
import { CODEX_HISTORY_LIMITS } from './thread-history.js';
import * as rolloutContext from './rollout-context.js';
import type { Transport } from '../transport/app-server-client.js';

/**
 * Which app-server generation the fake answers as. `paginated` is rust-v0.151.0 and later
 * (0.164.0 census `history-hydration`): `thread/resume` takes `excludeTurns` and history pages
 * through `thread/turns/list`. `gated` is 0.150.x and 0.147.0: both are behind `experimentalApi`
 * and refused with the exact -32600 answers of the 0.150.0 pagination probe, so history comes from
 * the full `thread/resume` and `thread/read {includeTurns}`.
 */
type ServerGeneration = 'paginated' | 'gated';

interface ControllableOptions {
  deferRead?: boolean;
  deferCatalog?: boolean;
  server?: ServerGeneration;
  /** Turns per `thread/turns/list` page. Default: every turn on one page. */
  pageSize?: number;
  /** Answer this `thread/turns/list` page (0-based) with an error instead. */
  turnsListError?: { page: number; code: number; message: string };
  /** Never answer this `thread/turns/list` page (0-based). */
  turnsListUnanswered?: number;
  /** Answer `thread/read` with this error instead. */
  threadReadError?: { code: number; message: string };
  /** Answer every `thread/turns/list` page with the same turns and the same cursor. */
  repeatCursor?: boolean;
  /** Serve this many `thread/turns/list` pages of one new turn each, every one with a new cursor. */
  distinctPages?: number;
}

const GATED = {
  excludeTurns: 'thread/resume.excludeTurns requires experimentalApi capability',
  turnsList: 'thread/turns/list requires experimentalApi capability',
};

/**
 * A controllable in-memory app-server. Auto-answers `initialize` and lets a test
 * decide how many times `thread/resume` fails with "no rollout found" before it
 * succeeds — the shape of the real 0.144.4 behaviour (a thread has no rollout
 * until its first turn produces output). `historyResult` is the thread as
 * `thread/read {includeTurns: true}` returns it; the paginated server pages the
 * same turns.
 */
function controllable(
  resumeFailuresBeforeSuccess: number,
  historyResult: unknown = {},
  options: ControllableOptions = {},
) {
  const server = options.server ?? 'paginated';
  const storedThread = (historyResult as { thread?: Record<string, unknown> }).thread;
  const storedTurns = Array.isArray(storedThread?.turns) ? (storedThread.turns as unknown[]) : [];
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((i: { code: number | null; signal: string | null }) => void) | undefined;
  let resumeFails = resumeFailuresBeforeSuccess;
  let resumeAttempts = 0;
  let turnsListPages = 0;
  const calls: { method?: string; params?: unknown }[] = [];
  const sent: Record<string, unknown>[] = [];
  let deferredRead: { id: number; result: unknown } | undefined;
  let deferredCatalogId: number | undefined;
  const reply = (id: number | undefined, result: unknown) => onMsg?.({ jsonrpc: '2.0', id, result });
  const refuse = (id: number | undefined, code: number, message: string) =>
    onMsg?.({ jsonrpc: '2.0', id, error: { code, message } });
  const turnsPage = (params: Record<string, unknown>) => {
    if (options.repeatCursor) return { data: storedTurns, nextCursor: 'same', backwardsCursor: null };
    if (options.distinctPages !== undefined) {
      const at = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
      const data = [
        { id: `t${at}`, status: 'completed', items: [{ type: 'agentMessage', id: `a${at}`, text: `${at}` }] },
      ];
      return { data, nextCursor: at + 1 < options.distinctPages ? String(at + 1) : null, backwardsCursor: null };
    }
    const size = options.pageSize ?? Math.max(storedTurns.length, 1);
    const from = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
    const data = storedTurns.slice(from, from + size);
    const next = from + size < storedTurns.length ? String(from + size) : null;
    return { data, nextCursor: next, backwardsCursor: null };
  };
  const transport: Transport = {
    send: (m) => {
      const msg = m as { id?: number; method?: string; params?: Record<string, unknown> };
      sent.push(msg as Record<string, unknown>);
      if (msg.id === undefined) return; // client notification (e.g. initialized)
      if (msg.method === undefined) return; // response to a server request
      calls.push({ method: msg.method, params: msg.params });
      const params = msg.params ?? {};
      queueMicrotask(() => {
        if (msg.method === 'thread/resume') {
          // The gate is checked before the thread is looked up, as on 0.150.0.
          if (server === 'gated' && params.excludeTurns !== undefined) {
            refuse(msg.id, -32600, GATED.excludeTurns);
            return;
          }
          resumeAttempts++;
          if (resumeFails > 0) {
            resumeFails--;
            refuse(msg.id, -1, 'no rollout found for thread id');
          } else if (storedThread) {
            reply(msg.id, { thread: { ...storedThread, turns: params.excludeTurns === true ? [] : storedTurns } });
          } else {
            reply(msg.id, {});
          }
        } else if (msg.method === 'model/list' && options.deferCatalog) {
          deferredCatalogId = msg.id;
        } else if (msg.method === 'thread/turns/list') {
          const page = turnsListPages++;
          if (server === 'gated') refuse(msg.id, -32600, GATED.turnsList);
          else if (options.turnsListError?.page === page) {
            refuse(msg.id, options.turnsListError.code, options.turnsListError.message);
          } else if (options.turnsListUnanswered === page) {
            // Left pending until the transport closes.
          } else if (options.deferRead && page === 0) deferredRead = { id: msg.id!, result: turnsPage(params) };
          else reply(msg.id, turnsPage(params));
        } else if (msg.method === 'thread/read') {
          if (options.threadReadError) refuse(msg.id, options.threadReadError.code, options.threadReadError.message);
          else if (options.deferRead) deferredRead = { id: msg.id!, result: historyResult };
          else reply(msg.id, historyResult);
        } else if (msg.method === 'thread/start') {
          reply(msg.id, {
            thread: {
              id: 'th-owned',
              sessionId: 'th-owned',
              path: '/tmp/rollout-th-owned.jsonl',
            },
          });
        } else {
          reply(msg.id, {}); // initialize, inject_items, …
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
    /** The history read the observer makes on this generation of server. */
    historyRequested: () =>
      calls.some((call) => call.method === (server === 'gated' ? 'thread/read' : 'thread/turns/list')),
    releaseCatalog: (result: unknown = {}) => {
      if (deferredCatalogId === undefined) throw new Error('model/list is not pending');
      onMsg?.({ jsonrpc: '2.0', id: deferredCatalogId, result });
      deferredCatalogId = undefined;
    },
    releaseRead: () => {
      if (deferredRead === undefined) throw new Error('the history read is not pending');
      reply(deferredRead.id, deferredRead.result);
      deferredRead = undefined;
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
      // The TUI is sent the same request, so the host decision races the person.
      signal: expect.any(AbortSignal),
    });
    expect(events).toEqual(
      expect.arrayContaining(['interaction:permission-requested', 'interaction:permission-resolved']),
    );
    await obs.dispose();
  });

  describe('an approval the person answers in the TUI (Q09)', () => {
    // Codex 0.164.0 sends a thread's requests to every subscribed connection and acts on the
    // first reply (codex-rs/app-server outgoing_message.rs), so the TUI is sent this one too.
    const approval = {
      jsonrpc: '2.0',
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'th-owned', turnId: 'turn-1', itemId: 'call-1', command: 'curl https://example.com' },
    };
    const resolved = {
      jsonrpc: '2.0',
      method: 'serverRequest/resolved',
      params: { threadId: 'th-owned', requestId: 7 },
    };
    const answered = (t: ReturnType<typeof controllable>) =>
      t.sent().filter((message) => message.id === 7 && ('result' in message || 'error' in message));
    const settledUnknown = { type: 'interaction:permission-resolved', requestId: '7', outcome: 'unknown' };

    it('never answers it, and reports the wait as blocked until Codex resolves it', async () => {
      const t = controllable(0);
      const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
      const projection = projectAgentEvents(obs);
      // The person's prompt in the TUI: Codex starts the turn, then completes the user message that starts it here.
      t.deliver({ method: 'turn/started', params: { threadId: 'th-owned', turn: { id: 'turn-1' } } });
      t.deliver({
        method: 'item/completed',
        params: {
          threadId: 'th-owned',
          turnId: 'turn-1',
          item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Remove the scratch file' }] },
        },
      });
      t.deliver(approval);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(answered(t)).toEqual([]);
      expect(projection.envelopes.map(({ event }) => event)).toContainEqual({
        type: 'interaction:permission-requested',
        requestId: '7',
        toolCallId: 'call-1',
        tool: 'command',
        input: approval.params,
        presentation: 'native-tui',
      });
      const waiting = monitorFromEvents(projection.envelopes);
      expect(waiting.status).toBe('blocked');
      expect(waiting.blockers).toMatchObject([{ id: '7', kind: 'permission', permission: { tool: 'command' } }]);

      // The person answered in the TUI: Codex tells every connection, naming no decision.
      t.deliver(resolved);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(answered(t)).toEqual([]);
      expect(projection.envelopes.map(({ event }) => event)).toContainEqual(settledUnknown);
      const after = monitorFromEvents(projection.envelopes);
      expect(after.blockers).toEqual([]);
      expect(after.status).toBe('working');
      projection.dispose();
      await obs.dispose();
    });

    it('settles a held wait when the app-server rail closes, and on dispose', async () => {
      const closing = controllable(0);
      const closed = await createCodexObserver({ transport: closing.transport, start: { cwd: '/tmp/ws' } });
      const closedProjection = projectAgentEvents(closed);
      closing.deliver(approval);
      closing.fireClose();

      expect(closedProjection.envelopes.map(({ event }) => event)).toContainEqual(settledUnknown);
      closedProjection.dispose();
      await closed.dispose();

      const disposing = controllable(0);
      const disposed = await createCodexObserver({ transport: disposing.transport, start: { cwd: '/tmp/ws' } });
      const outcomes: string[] = [];
      disposed.events.onCandidate(({ event }) => {
        if (event.type === 'interaction:permission-resolved') outcomes.push(event.outcome);
      });
      disposing.deliver(approval);
      await disposed.dispose();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcomes).toEqual(['unknown']);
      expect(answered(disposing)).toEqual([]);
    });

    it('drops a host decision the person beat in the TUI', async () => {
      const t = controllable(0);
      let decide!: (decision: 'approved') => void;
      let signal: AbortSignal | undefined;
      const obs = await createCodexObserver({
        transport: t.transport,
        start: { cwd: '/tmp/ws' },
        onApproval: (request) => {
          signal = request.signal;
          return new Promise((resolve) => {
            decide = resolve;
          });
        },
      });
      const outcomes: string[] = [];
      obs.events.onCandidate(({ event }) => {
        if (event.type === 'interaction:permission-resolved') outcomes.push(event.outcome);
      });
      t.deliver(approval);
      t.deliver(resolved);

      expect(signal?.aborted).toBe(true);
      decide('approved');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(answered(t)).toEqual([]);
      expect(outcomes).toEqual(['unknown']);
      await obs.dispose();
    });
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

  it('threadId: a resume at a chosen model and effort asks every thread/resume attempt for them', async () => {
    const t = controllable(1);
    const obs = await createCodexObserver({
      transport: t.transport,
      threadId: 'th-resume-me',
      resumeOverrides: { model: 'chosen-model', effort: 'high' },
    });
    const projection = projectAgentEvents(obs);
    try {
      const resumes = t.calls().filter((call) => call.method === 'thread/resume');
      expect(resumes).toHaveLength(2);
      for (const call of resumes) {
        // #38's resume asks for no turns (`excludeTurns`); the selection rides the same request
        expect(call.params).toEqual({
          threadId: 'th-resume-me',
          excludeTurns: true,
          model: 'chosen-model',
          config: { model_reasoning_effort: 'high' },
        });
      }
      expect(projection.monitorBatches.flatMap((batch) => batch.updates)).toContainEqual(
        expect.objectContaining({ family: 'effort', value: { kind: 'effort', value: 'high', intent: 'configured' } }),
      );
    } finally {
      projection.dispose();
      await obs.dispose();
    }
  });

  it('threadId: a server that refuses excludeTurns gets the full resume, at the chosen model and effort', async () => {
    const t = controllable(0, {}, { server: 'gated' });
    const obs = await createCodexObserver({
      transport: t.transport,
      threadId: 'th-resume-me',
      resumeOverrides: { model: 'chosen-model', effort: 'high' },
    });
    try {
      const resumes = t.calls().filter((call) => call.method === 'thread/resume');
      expect(resumes.length).toBeGreaterThan(1);
      for (const call of resumes) {
        expect(call.params).toMatchObject({
          threadId: 'th-resume-me',
          model: 'chosen-model',
          config: { model_reasoning_effort: 'high' },
        });
      }
      expect(resumes.at(-1)?.params).not.toHaveProperty('excludeTurns');
    } finally {
      await obs.dispose();
    }
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

describe.each(['paginated', 'gated'] as const)('createCodexObserver history from a %s app-server', (server) => {
  const historyMethod = (method: string | undefined) =>
    method === 'thread/resume' || method === 'thread/read' || method === 'thread/turns/list';

  it('replays completed resume history to the first subscriber', async () => {
    const t = controllable(
      0,
      {
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
      },
      { server },
    );
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
    expect(projection.envelopes.find(({ event }) => event.type === 'turn:started')?.replay).toBe(true);
    expect(
      t
        .calls()
        .filter(({ method }) => historyMethod(method))
        .map(({ method, params }) => [method, params]),
    ).toEqual(
      server === 'paginated'
        ? [
            ['thread/resume', { threadId: 'th-history', excludeTurns: true }],
            ['thread/turns/list', { threadId: 'th-history', itemsView: 'full', sortDirection: 'asc' }],
          ]
        : [
            ['thread/resume', { threadId: 'th-history', excludeTurns: true }],
            ['thread/resume', { threadId: 'th-history' }],
            ['thread/read', { threadId: 'th-history', includeTurns: true }],
          ],
    );
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
    const t = controllable(0, history, { server });
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
      const t = controllable(
        0,
        {
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
        },
        { server },
      );
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
    const t = controllable(
      0,
      {
        thread: {
          id: 'th-history',
          path: '/tmp/rollout-history.jsonl',
          turns: [{ id: 'turn-old', status: 'completed', items: [{ type: 'contextCompaction', id: 'compact-old' }] }],
        },
      },
      { server },
    );
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
    const t = controllable(
      0,
      {
        thread: {
          id: 'th-history',
          turns: [{ id: 'turn-old', status: 'completed', items: [{ type: 'contextCompaction', id: 'compact-old' }] }],
        },
      },
      { server },
    );
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
    const t = controllable(0, history, { deferRead: true, server });
    const creating = createCodexObserver({ transport: t.transport, threadId: 'th-history' });

    await vi.waitFor(() => expect(t.historyRequested()).toBe(true));

    // This completed turn is already in the eventual history read and must
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
});

describe('createCodexObserver paginated history (0.151.0 and later) with a full-hydration fallback', () => {
  const turn = (id: string, text: string) => ({
    id,
    status: 'completed',
    items: [
      { type: 'userMessage', id: `user-${id}`, content: [{ type: 'text', text: `prompt ${id}` }] },
      { type: 'agentMessage', id: `assistant-${id}`, text },
    ],
  });
  const stored = (...turns: unknown[]) => ({ thread: { id: 'th-paged', path: '/tmp/rollout-paged.jsonl', turns } });
  const replayedAnswers = (projection: ReturnType<typeof projectAgentEvents>) =>
    projection.envelopes
      .filter(({ event }) => event.type === 'conversation:assistant-message')
      .map(({ event, replay }) => [(event as { text?: string }).text, replay]);
  const requests = (t: ReturnType<typeof controllable>, method: string) =>
    t.calls().filter((call) => call.method === method);

  it.each(['paginated', 'gated'] as const)(
    'resumes a thread it just created without hydrating any history (%s server)',
    async (server) => {
      const t = controllable(0, {}, { server });
      const obs = await createCodexObserver({ transport: t.transport, start: { cwd: '/tmp/ws' } });
      const projection = projectAgentEvents(obs);
      expect(projection.state.lifecycle).toBe('ready');
      expect(requests(t, 'thread/resume').map(({ params }) => params)).toEqual(
        server === 'paginated'
          ? [{ threadId: 'th-owned', excludeTurns: true }]
          : [{ threadId: 'th-owned', excludeTurns: true }, { threadId: 'th-owned' }],
      );
      expect(requests(t, 'thread/turns/list')).toEqual([]);
      expect(requests(t, 'thread/read')).toEqual([]);
      projection.dispose();
      await obs.dispose();
    },
  );

  it('falls back once on a gated server and keeps retrying a thread that has no rollout yet', async () => {
    const t = controllable(3, stored(turn('t1', 'first')), { server: 'gated' });
    const obs = await createCodexObserver({ transport: t.transport });
    const projection = projectAgentEvents(obs);
    t.deliver(threadStarted);

    await vi.waitFor(() => expect(projection.state.lifecycle).toBe('ready'), { timeout: 5000 });
    const resumes = requests(t, 'thread/resume').map(({ params }) => params);
    // One refused excludeTurns, then the deprecated resume until the rollout exists.
    expect(resumes[0]).toEqual({ threadId: 'th-1', excludeTurns: true });
    expect(resumes.slice(1)).toEqual(Array.from({ length: 4 }, () => ({ threadId: 'th-1' })));
    expect(requests(t, 'thread/read').map(({ params }) => params)).toEqual([{ threadId: 'th-1', includeTurns: true }]);
    expect(requests(t, 'thread/turns/list')).toEqual([]);
    expect(replayedAnswers(projection)).toEqual([['first', true]]);
    projection.dispose();
    await obs.dispose();
  });

  it('pages oldest first by nextCursor and replays every page in order before live traffic', async () => {
    const t = controllable(0, stored(turn('t1', 'first'), turn('t2', 'second'), turn('t3', 'third')), {
      pageSize: 1,
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    t.deliver({
      method: 'item/completed',
      params: { threadId: 'th-paged', turnId: 't4', item: { type: 'agentMessage', id: 'live', text: 'live' } },
    });
    const projection = projectAgentEvents(obs);

    expect(requests(t, 'thread/turns/list').map(({ params }) => params)).toEqual([
      { threadId: 'th-paged', itemsView: 'full', sortDirection: 'asc' },
      { threadId: 'th-paged', itemsView: 'full', sortDirection: 'asc', cursor: '1' },
      { threadId: 'th-paged', itemsView: 'full', sortDirection: 'asc', cursor: '2' },
    ]);
    expect(replayedAnswers(projection)).toEqual([
      ['first', true],
      ['second', true],
      ['third', true],
      ['live', undefined],
    ]);
    expect(obs.threadPath()).toBe('/tmp/rollout-paged.jsonl');
    expect(requests(t, 'thread/read')).toEqual([]);
    projection.dispose();
    await obs.dispose();
  });

  const historyDiagnostics = (projection: ReturnType<typeof projectAgentEvents>) =>
    projection.state.diagnostics
      .filter(({ code }) => code === 'codex-history-incomplete')
      .map(({ message }) => message);

  it('reads the whole history once in full when the server answers a later page with an error', async () => {
    const t = controllable(0, stored(turn('t1', 'first'), turn('t2', 'second (latest)')), {
      pageSize: 1,
      turnsListError: { page: 1, code: -32603, message: 'internal error' },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(projection.state.lifecycle).toBe('ready');
    expect(replayedAnswers(projection)).toEqual([
      ['first', true],
      ['second (latest)', true],
    ]);
    expect(projection.state.lastAssistantMessage).toBe('second (latest)');
    expect(requests(t, 'thread/read').map(({ params }) => params)).toEqual([
      { threadId: 'th-paged', includeTurns: true },
    ]);
    expect(historyDiagnostics(projection)).toEqual([]);
    projection.dispose();
    await obs.dispose();
  });

  it.each([1, 0])(
    'replays the pages it has and reports the history incomplete when page %i and the full read both fail',
    async (page) => {
      const t = controllable(0, stored(turn('t1', 'first'), turn('t2', 'second (latest)')), {
        pageSize: 1,
        turnsListError: { page, code: -32603, message: 'internal error' },
        threadReadError: { code: -32603, message: 'internal error' },
      });
      const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
      const projection = projectAgentEvents(obs);
      expect(projection.state.lifecycle).toBe('ready');
      expect(replayedAnswers(projection)).toEqual(page === 1 ? [['first', true]] : []);
      expect(historyDiagnostics(projection)).toEqual([
        `Codex thread history could not be read in full (server error -32603); ${page} earliest turn(s) were replayed and later ones are missing.`,
      ]);
      const reported = projection.envelopes.find(({ event }) => event.type === 'adapter:native-event');
      expect(reported?.replay).toBeUndefined();
      expect(reported?.event).toMatchObject({ adapter: 'codex', nativeType: 'thread.history.incomplete' });
      projection.dispose();
      await obs.dispose();
    },
  );

  it('asks nothing more of a server that never answered a page, and reports the history incomplete', async () => {
    const t = controllable(0, stored(turn('t1', 'first'), turn('t2', 'second (latest)')), {
      pageSize: 1,
      turnsListUnanswered: 1,
    });
    const creating = createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    await vi.waitFor(() => expect(requests(t, 'thread/turns/list')).toHaveLength(2));
    t.fireClose();
    const obs = await creating;
    const projection = projectAgentEvents(obs);
    expect(replayedAnswers(projection)).toEqual([['first', true]]);
    expect(requests(t, 'thread/read')).toEqual([]);
    expect(historyDiagnostics(projection)).toEqual([
      'Codex thread history could not be read in full (connection lost); 1 earliest turn(s) were replayed and later ones are missing.',
    ]);
    projection.dispose();
    await obs.dispose();
  });

  it('stops at a cursor it has already followed and replays a repeated turn once', async () => {
    const t = controllable(0, stored(turn('t1', 'first')), { repeatCursor: true });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(requests(t, 'thread/turns/list')).toHaveLength(2);
    expect(replayedAnswers(projection)).toEqual([['first', true]]);
    projection.dispose();
    await obs.dispose();
  });

  it('stops paging a server whose cursors outlast the page limit, and reports the history incomplete', async () => {
    const { pages } = CODEX_HISTORY_LIMITS;
    const t = controllable(0, stored(), { distinctPages: pages * 5 });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(projection.state.lifecycle).toBe('ready');
    expect(requests(t, 'thread/turns/list')).toHaveLength(pages);
    expect(requests(t, 'thread/read')).toEqual([]);
    expect(replayedAnswers(projection)).toHaveLength(pages);
    expect(projection.state.lastAssistantMessage).toBe(String(pages - 1));
    expect(historyDiagnostics(projection)).toEqual([
      `Codex thread history could not be read in full (stopped after ${pages} pages); ${pages} earliest turn(s) were replayed and later ones are missing.`,
    ]);
    projection.dispose();
    await obs.dispose();
  });

  it('reads the full history when the server takes excludeTurns but does not know thread/turns/list', async () => {
    const t = controllable(0, stored(turn('t1', 'first')), {
      turnsListError: { page: 0, code: -32601, message: 'method not found' },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(requests(t, 'thread/read').map(({ params }) => params)).toEqual([
      { threadId: 'th-paged', includeTurns: true },
    ]);
    expect(replayedAnswers(projection)).toEqual([['first', true]]);
    expect(historyDiagnostics(projection)).toEqual([]);
    projection.dispose();
    await obs.dispose();
  });

  it('reports the history incomplete when that full read fails, since the excluded resume carried no turns', async () => {
    const t = controllable(0, stored(turn('t1', 'first')), {
      turnsListError: { page: 0, code: -32601, message: 'method not found' },
      threadReadError: { code: -32603, message: 'internal error' },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(replayedAnswers(projection)).toEqual([]);
    expect(historyDiagnostics(projection)).toHaveLength(1);
    projection.dispose();
    await obs.dispose();
  });

  it('keeps the hydrated resume as the whole history on a gated server whose full read fails', async () => {
    const t = controllable(0, stored(turn('t1', 'first')), {
      server: 'gated',
      threadReadError: { code: -32603, message: 'internal error' },
    });
    const obs = await createCodexObserver({ transport: t.transport, threadId: 'th-paged' });
    const projection = projectAgentEvents(obs);
    expect(replayedAnswers(projection)).toEqual([['first', true]]);
    expect(historyDiagnostics(projection)).toEqual([]);
    projection.dispose();
    await obs.dispose();
  });
});
