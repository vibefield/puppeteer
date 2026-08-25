import { describe, it, expect } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@vibecook/puppeteer-core';
import { projectAgentSession } from '@vibecook/puppeteer-testing';
import { createCodexSession } from './driver.js';
import type { Transport } from './transport/app-server-client.js';

const THREAD = '019f5d86-423a-7083-ab79-2deb044599c1';
const TURN = '019f5d86-42e2-7a03-844c-0de529f5ae8d';
const MSG = 'msg_pong';
const REASONING = 'reasoning_1';
const ROLLOUT = '/Users/x/.codex/sessions/2026/07/13/rollout-019f5d86.jsonl';
const PROMPT = 'say pong';

const userItem = { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: PROMPT }] };

/** The C1-shaped notification stream for one completed turn. */
function turnStream(clientUserMessageId: string | null = null): unknown[] {
  const echoedUserItem = { ...userItem, clientId: clientUserMessageId };
  return [
    { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } },
    { jsonrpc: '2.0', method: 'item/started', params: { item: echoedUserItem, threadId: THREAD, turnId: TURN } },
    { jsonrpc: '2.0', method: 'item/completed', params: { item: echoedUserItem, threadId: THREAD, turnId: TURN } },
    {
      jsonrpc: '2.0',
      method: 'item/started',
      params: { item: { type: 'reasoning', id: REASONING, summary: [] }, threadId: THREAD, turnId: TURN },
    },
    {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: THREAD, turnId: TURN, itemId: REASONING, delta: 'private thought text' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: THREAD, turnId: TURN, itemId: REASONING, delta: 'Checked the request.' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          type: 'reasoning',
          id: REASONING,
          content: ['private thought text'],
          summary: ['Checked the request.'],
        },
        threadId: THREAD,
        turnId: TURN,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: TURN, itemId: MSG, delta: 'pong' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: MSG, text: 'pong', phase: 'final_answer' },
        threadId: THREAD,
        turnId: TURN,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null, durationMs: 1 } },
    },
  ];
}

interface Scripted {
  transport: Transport;
  sent: Array<Record<string, unknown>>;
  deliver(message: unknown): void;
  fireClose(info?: { code: number | null; signal: string | null }): void;
  closed(): boolean;
}

/** A minimal in-memory `codex app-server`: answers requests + streams notifications. */
function scriptedAppServer(opts?: {
  onTurnStart?: (emit: (m: unknown) => void, id: number, params: Record<string, unknown>) => void;
  turnStartError?: { code: number; message: string };
  threadStartError?: { code: number; message: string };
}): Scripted {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  let isClosed = false;
  const emit = (m: unknown): void => void queueMicrotask(() => onMsg?.(m));
  const thread = { id: THREAD, sessionId: THREAD, path: ROLLOUT, cwd: '/x', status: { type: 'idle' } };

  const transport: Transport = {
    send: (raw) => {
      const m = raw as Record<string, unknown>;
      sent.push(m);
      if (typeof m.method !== 'string' || m.id === undefined) return; // client response/notification
      switch (m.method) {
        case 'initialize':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          break;
        case 'model/list':
          emit({
            jsonrpc: '2.0',
            id: m.id,
            result: { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Codex' }] },
          });
          break;
        case 'thread/start':
          if (opts?.threadStartError) {
            emit({ jsonrpc: '2.0', id: m.id, error: opts.threadStartError });
            break;
          }
          emit({ jsonrpc: '2.0', id: m.id, result: { thread } });
          emit({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          break;
        case 'turn/start':
          if (opts?.turnStartError) {
            emit({ jsonrpc: '2.0', id: m.id, error: opts.turnStartError });
            break;
          }
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          if (opts?.onTurnStart) opts.onTurnStart(emit, m.id as number, m.params as Record<string, unknown>);
          else {
            const value = (m.params as Record<string, unknown>)?.clientUserMessageId;
            const clientUserMessageId = typeof value === 'string' ? value : null;
            for (const n of turnStream(clientUserMessageId)) emit(n);
          }
          break;
        default:
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    },
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => {
      isClosed = true;
      onCls?.({ code: 0, signal: null });
    },
  };
  return {
    transport,
    sent,
    deliver: emit,
    fireClose: (info = { code: 0, signal: null }) => onCls?.(info),
    closed: () => isClosed,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createCodexSession', () => {
  it('closes the app-server transport when bootstrap fails', async () => {
    const s = scriptedAppServer({ threadStartError: { code: -32000, message: 'cannot start thread' } });
    await expect(createCodexSession({ cwd: '/x', transport: s.transport })).rejects.toThrow('cannot start thread');
    expect(s.closed()).toBe(true);
  });

  it('establishes identity and structured observation from thread/start', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport, model: 'gpt-5.6-sol' });
    const projection = projectAgentSession(session);
    expect(session.sessionId).toBe(THREAD);
    expect(session.runtimeSessionId).toBe(THREAD);
    expect(session.threadPath()).toBe(ROLLOUT);
    expect(session.observationLevel()).toBe('structured');
    await flush();
    expect(projection.state.lifecycle).toBe('ready'); // thread/started -> session.started
    expect(projection.state.environment).toMatchObject({
      currentCwd: { value: '/x' },
      model: { value: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Codex' } },
    });
    expect(s.sent.find((message) => message.method === 'thread/start')?.params).toMatchObject({
      model: 'gpt-5.6-sol',
    });
    const monitorBatches = projection.monitorBatches;
    expect(monitorBatches[0]).toMatchObject({ phase: 'bootstrap', capabilities: expect.any(Array) });
    expect(monitorBatches.flatMap(({ updates }) => updates).find(({ family }) => family === 'model')).toMatchObject({
      family: 'model',
      operation: 'upsert',
    });
    expect(monitorBatches.every(({ phase }) => phase === 'bootstrap')).toBe(true);
    projection.dispose();
    await session.dispose();
  });

  it('submitPrompt drives a turn and reduces to a coherent state', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const projection = projectAgentSession(session);
    const events: AgentEvent[] = [];
    const envelopes: AgentEventEnvelope[] = [];
    session.onEvent((e) => {
      events.push(e.event);
      envelopes.push(e);
    });

    const receipt = await session.submitPrompt({ text: PROMPT });
    expect(receipt.status).toBe('confirmed'); // exact echoed client id, not request acceptance alone
    await flush();

    expect(projection.state.lifecycle).toBe('ready');
    expect(projection.state.lastAssistantMessage).toBe('pong');
    expect(events.some((e) => e.type === 'assistant.message' && e.final === true && e.text === 'pong')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(events.some((e) => e.type === 'reasoning.started')).toBe(true);
    expect(events.some((e) => e.type === 'reasoning.summary' && e.text === 'Checked the request.')).toBe(true);
    expect(projection.state.activeReasoning).toBeUndefined();
    const rawThought = envelopes.find((e) => e.event.type === 'reasoning.progress');
    expect(rawThought?.nativeEvent).toMatchObject({
      method: 'item/reasoning/textDelta',
      params: { delta: 'private thought text' },
    });
    expect(JSON.stringify(rawThought?.event)).not.toContain('private thought text');

    // The turn was driven with structured input + a client message id (C4 confirm channel).
    const ts = s.sent.find((m) => m.method === 'turn/start');
    expect((ts?.params as Record<string, unknown>).input).toEqual([{ type: 'text', text: PROMPT }]);
    expect(typeof (ts?.params as Record<string, unknown>).clientUserMessageId).toBe('string');
    projection.dispose();
    await session.dispose();
  });

  it('keeps collaboration child notifications off the root reducer while publishing actor evidence', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const projection = projectAgentSession(session);
    const events: AgentEvent[] = [];
    const monitorBatches = projection.monitorBatches;
    session.onEvent(({ event }) => events.push(event));

    const child = 'child-thread-1';
    s.deliver({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: { id: child, parentThreadId: THREAD, status: { type: 'active' } } },
    });
    s.deliver({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: child, turn: { id: 'child-turn', status: 'inProgress' } },
    });
    s.deliver({
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: child,
        turnId: 'child-turn',
        tokenUsage: { total: { totalTokens: 90 }, last: { totalTokens: 45 }, modelContextWindow: 180 },
      },
    });
    await flush();

    expect(events.some((event) => event.type === 'turn.started' && event.turnId === 'child-turn')).toBe(false);
    expect(projection.state.activeTurn).toBeUndefined();
    expect(
      monitorBatches
        .flatMap(({ updates }) => updates)
        .some(
          (update) =>
            update.family === 'usage' && update.operation === 'upsert' && update.value.actor?.nativeSessionId === child,
        ),
    ).toBe(true);

    await expect(session.submitPrompt({ text: PROMPT })).resolves.toMatchObject({ status: 'confirmed' });
    expect(projection.state.lastAssistantMessage).toBe('pong');
    projection.dispose();
    await session.dispose();
  });

  it('observes and answers structured approval requests via the policy', async () => {
    const s = scriptedAppServer({
      onTurnStart: (emit, _id, params) => {
        const echoed = { ...userItem, clientId: params.clientUserMessageId };
        emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } });
        emit({ jsonrpc: '2.0', method: 'item/completed', params: { item: echoed, threadId: THREAD, turnId: TURN } });
        emit({ jsonrpc: '2.0', id: 999, method: 'execCommandApproval', params: { command: 'ls' } });
      },
    });
    const events: AgentEvent[] = [];
    const session = await createCodexSession({ cwd: '/x', transport: s.transport, onApproval: () => 'approved' });
    session.onEvent((e) => events.push(e.event));

    await session.submitPrompt({ text: 'run ls' });
    await flush();

    expect(events.some((e) => e.type === 'permission.requested' && e.tool === 'execCommandApproval')).toBe(true);
    expect(events.some((e) => e.type === 'permission.resolved' && e.outcome === 'allowed')).toBe(true);
    const resp = s.sent.find((m) => m.id === 999 && 'result' in m);
    expect(resp?.result).toEqual({ decision: 'approved' });
  });

  it('does not resolve or answer an in-flight approval after disposal', async () => {
    let resolveApproval!: (decision: 'approved') => void;
    const s = scriptedAppServer({
      onTurnStart: (emit, _id, params) => {
        const echoed = { ...userItem, clientId: params.clientUserMessageId };
        emit({ jsonrpc: '2.0', method: 'item/completed', params: { item: echoed, threadId: THREAD, turnId: TURN } });
        emit({ jsonrpc: '2.0', id: 999, method: 'execCommandApproval', params: { command: 'ls' } });
      },
    });
    const session = await createCodexSession({
      cwd: '/x',
      transport: s.transport,
      onApproval: () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        }),
    });
    const projection = projectAgentSession(session);

    await session.submitPrompt({ text: 'run ls' });
    await flush();
    expect(projection.state.permissions.size).toBe(1);
    const lastSequence = projection.state.lastSequence;

    await session.dispose();
    resolveApproval('approved');
    await flush();

    expect(projection.state.lastSequence).toBe(lastSequence);
    expect(s.sent.some((message) => message.id === 999 && ('result' in message || 'error' in message))).toBe(false);
    projection.dispose();
  });

  it('rejects submitPrompt when turn/start errors (no uncertain)', async () => {
    const s = scriptedAppServer({ turnStartError: { code: -32000, message: 'busy' } });
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const receipt = await session.submitPrompt({ text: 'x' });
    expect(receipt).toEqual({ status: 'rejected', reason: 'busy' });
  });

  it('does not claim confirmation when the exact client message echo is missing', async () => {
    const s = scriptedAppServer({ onTurnStart: () => undefined });
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const receipt = await session.submitPrompt({ text: 'x', confirmationTimeoutMs: 10 });
    expect(receipt).toEqual({
      status: 'uncertain',
      reason: 'turn/start succeeded but no matching clientUserMessageId arrived within 10ms',
    });
    await session.dispose();
  });

  it('settles an in-flight prompt confirmation when the session is disposed', async () => {
    const s = scriptedAppServer({ onTurnStart: () => undefined });
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const pending = session.submitPrompt({ text: 'x', confirmationTimeoutMs: 10_000 });
    await flush();

    await session.dispose();

    await expect(pending).resolves.toEqual({
      status: 'uncertain',
      reason: 'codex session disposed before matching clientUserMessageId arrived',
    });
  });

  it('settles an in-flight prompt confirmation when the transport closes', async () => {
    const s = scriptedAppServer({ onTurnStart: () => undefined });
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const pending = session.submitPrompt({ text: 'x', confirmationTimeoutMs: 10_000 });
    await flush();

    s.fireClose({ code: 1, signal: null });

    await expect(pending).resolves.toEqual({
      status: 'uncertain',
      reason: 'app-server transport closed before matching clientUserMessageId arrived',
    });
    await session.dispose();
  });

  it('degrades monitor observation without claiming host-process death when the transport closes', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const projection = projectAgentSession(session);
    const events: AgentEvent[] = [];
    const monitorBatches = projection.monitorBatches;
    session.onEvent((e) => events.push(e.event));
    s.fireClose();
    await flush();
    expect(session.observationLevel()).toBe('terminal-only');
    expect(projection.state.lifecycle).toBe('ready');
    expect(events.some((e) => e.type === 'process.exited' || e.type === 'session.exited')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'adapter.native-event',
      adapter: 'codex',
      nativeType: 'app-server.transport.closed',
    });
    expect(monitorBatches.at(-1)).toMatchObject({
      readiness: 'degraded',
      completeness: 'unavailable',
      updates: [],
    });
    projection.dispose();
    await session.dispose();
  });
});
