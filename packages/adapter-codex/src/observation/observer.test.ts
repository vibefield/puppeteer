import { describe, it, expect, vi } from 'vitest';
import { safeParseAgentEvent, type AdapterEventCandidate } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { createCodexObserver } from './observer.js';
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
  options: { deferRead?: boolean } = {},
) {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((i: { code: number | null; signal: string | null }) => void) | undefined;
  let resumeFails = resumeFailuresBeforeSuccess;
  let resumeAttempts = 0;
  const calls: { method?: string; params?: unknown }[] = [];
  const sent: Record<string, unknown>[] = [];
  let deferredReadId: number | undefined;
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
    releaseRead: () => {
      if (deferredReadId === undefined) throw new Error('thread/read is not pending');
      onMsg?.({ jsonrpc: '2.0', id: deferredReadId, result: historyResult });
      deferredReadId = undefined;
    },
  };
}

const threadStarted = { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'th-1' } } };

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
    const events: Array<{ replay?: boolean; event: { type: string; text?: string } }> = [];
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
