import { describe, expect, it } from 'vitest';
import type { Transport } from '../transport/app-server-client.js';
import { createCodexModelSwitch } from './model-switch.js';

interface Sent {
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type Answer = { result: unknown } | { error: { code: number; message: string } } | 'silent';

/** One app-server connection: it records what is sent, answers requests by method, and can speak first. */
function connection(answers: Record<string, Answer> = {}) {
  const sent: Sent[] = [];
  let deliver: (message: unknown) => void = () => undefined;
  let closed: (info: { code: number | null; signal: string | null }) => void = () => undefined;
  let closes = 0;
  const transport: Transport = {
    send(message) {
      const frame = message as Sent & { result?: unknown };
      sent.push(frame);
      if (frame.id === undefined || frame.method === undefined) return;
      const answer = answers[frame.method] ?? { result: {} };
      if (answer === 'silent') return;
      queueMicrotask(() => deliver({ jsonrpc: '2.0', id: frame.id, ...answer }));
    },
    onMessage(handler) {
      deliver = handler;
    },
    onClose(handler) {
      closed = handler;
    },
    close() {
      closes += 1;
    },
  };
  return {
    transport,
    sent,
    requests: () => sent.filter((frame) => frame.id !== undefined && frame.method !== undefined),
    replies: () => sent.filter((frame) => frame.method === undefined),
    say: (message: unknown) => deliver(message),
    drop: () => closed({ code: null, signal: null }),
    closes: () => closes,
  };
}

function codex(answers: Record<string, Answer>[] = [{}], attached = true) {
  const thread = attached ? 'thread-1' : undefined;
  const connections = answers.map((each) => connection(each));
  const heard: Record<string, unknown>[] = [];
  let next = 0;
  let disposed = false;
  const service = createCodexModelSwitch({
    connect: () => {
      const made = connections[next];
      next += 1;
      if (!made) throw new Error('no connection left');
      return made.transport;
    },
    threadId: () => thread,
    isDisposed: () => disposed,
    onSettings: (params) => heard.push(params),
    requestTimeoutMs: 40,
  });
  return {
    service,
    connections,
    heard,
    opened: () => next,
    dispose: () => (disposed = true),
  };
}

const REFUSED = {
  status: 'rejected',
  reason: 'not a model or an effort level Codex can be asked for',
  retryable: false,
};

describe('createCodexModelSwitch', () => {
  it('offers the model and the effort, and says a switch stays with the session', () => {
    expect(codex().service.offer).toEqual({ model: true, controls: ['effort'], persistence: 'session' });
  });

  it('opts its own connection into the experimental API, subscribes to the thread, then asks for the model', async () => {
    const { service, connections } = codex();
    await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex-max' })).resolves.toEqual({ status: 'sent' });
    expect(connections[0]!.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: 'initialize',
        params: {
          clientInfo: { name: 'puppeteer-settings', version: expect.any(String) },
          capabilities: { experimentalApi: true },
        },
      },
      { method: 'initialized', params: {} },
      { method: 'thread/resume', params: { threadId: 'thread-1', excludeTurns: true } },
      { method: 'thread/settings/update', params: { threadId: 'thread-1', model: 'gpt-5.1-codex-max' } },
    ]);
  });

  it('asks for the effort alone, on the connection it already has', async () => {
    const { service, connections, opened } = codex();
    await service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' });
    await expect(service.submit({ kind: 'control', controlId: 'effort', value: 'xhigh' })).resolves.toEqual({
      status: 'sent',
    });
    expect(opened()).toBe(1);
    expect(connections[0]!.requests().map(({ method, params }) => ({ method, params }))).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      expect.objectContaining({ method: 'thread/resume' }),
      { method: 'thread/settings/update', params: { threadId: 'thread-1', model: 'gpt-5.1-codex' } },
      { method: 'thread/settings/update', params: { threadId: 'thread-1', effort: 'xhigh' } },
    ]);
  });

  it('asks for nothing that is not a model, an effort level, or a control it knows', async () => {
    const { service, opened } = codex();
    for (const modelId of ['', 'gpt 5', '-gpt', 'gpt;ls', 'gpt\n5', 'a'.repeat(257)])
      await expect(service.submit({ kind: 'model', modelId })).resolves.toEqual(REFUSED);
    for (const value of ['', 'High', 'high now', 'high\r', '1high'])
      await expect(service.submit({ kind: 'control', controlId: 'effort', value })).resolves.toEqual(REFUSED);
    await expect(service.submit({ kind: 'control', controlId: 'thinking', value: 'high' })).resolves.toEqual(REFUSED);
    expect(opened()).toBe(0);
  });

  it('hands the observer the settings the app-server reports for its thread, and no other', async () => {
    const { service, connections, heard } = codex();
    await service.listen();
    const settings = { threadId: 'thread-1', threadSettings: { model: 'gpt-5.1-codex', effort: 'high' } };
    connections[0]!.say({ jsonrpc: '2.0', method: 'thread/settings/updated', params: settings });
    connections[0]!.say({
      jsonrpc: '2.0',
      method: 'thread/settings/updated',
      params: { threadId: 'thread-2', threadSettings: { model: 'other' } },
    });
    connections[0]!.say({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });
    expect(heard).toEqual([settings]);
    // Listening asked for no change.
    expect(connections[0]!.requests().map(({ method }) => method)).toEqual(['initialize', 'thread/resume']);
  });

  it('subscribes its open connection to the thread the TUI moved to, once, and then hears that thread', async () => {
    const link = connection();
    const heard: Record<string, unknown>[] = [];
    let observed: string | undefined = 'thread-1';
    let opened = 0;
    const service = createCodexModelSwitch({
      connect: () => {
        opened += 1;
        return link.transport;
      },
      threadId: () => observed,
      isDisposed: () => false,
      onSettings: (params) => heard.push(params),
      requestTimeoutMs: 40,
    });
    // a connection not open yet subscribes when it opens: following moves nothing
    service.follow('thread-1');
    expect(opened).toBe(0);
    await service.listen();
    observed = 'thread-2';
    service.follow('thread-2');
    service.follow('thread-2');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(link.requests().map(({ method, params }) => [method, params?.threadId])).toEqual([
      ['initialize', undefined],
      ['thread/resume', 'thread-1'],
      ['thread/resume', 'thread-2'],
    ]);
    expect(link.requests().at(-1)!.params).toEqual({ threadId: 'thread-2', excludeTurns: true });
    expect(opened).toBe(1);
    const moved = { threadId: 'thread-2', threadSettings: { model: 'gpt-5.1-codex' } };
    link.say({
      jsonrpc: '2.0',
      method: 'thread/settings/updated',
      params: { threadId: 'thread-1', threadSettings: {} },
    });
    link.say({ jsonrpc: '2.0', method: 'thread/settings/updated', params: moved });
    expect(heard).toEqual([moved]);
    await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex-max' })).resolves.toEqual({ status: 'sent' });
    expect(link.requests().at(-1)).toMatchObject({
      method: 'thread/settings/update',
      params: { threadId: 'thread-2', model: 'gpt-5.1-codex-max' },
    });
    await service.dispose();
  });

  it("answers none of the thread's requests: an approval is the person's, in the TUI", async () => {
    const { service, connections } = codex();
    await service.listen();
    connections[0]!.say({
      jsonrpc: '2.0',
      id: 'approval-7',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connections[0]!.replies()).toEqual([]);
  });

  it('says so, and never again, when this Codex does not take the request', async () => {
    const gate = { code: -32600, message: 'thread/settings/update requires experimentalApi capability' };
    for (const error of [gate, { code: -32601, message: 'Method not found' }]) {
      const { service } = codex([{ 'thread/settings/update': { error } }]);
      await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual({
        status: 'rejected',
        reason: 'this Codex does not take a settings change',
        retryable: false,
      });
    }
  });

  it("passes on Codex's own refusal, which a later attempt may not meet", async () => {
    const { service } = codex([
      { 'thread/settings/update': { error: { code: -32600, message: 'thread not found: thread-1' } } },
    ]);
    await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual({
      status: 'rejected',
      reason: 'Codex refused the change: thread not found: thread-1',
    });
  });

  it('reports a change Codex never answered, and one asked for while another is in flight', async () => {
    const { service } = codex([{ 'thread/settings/update': 'silent' }]);
    const first = service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' });
    await expect(service.submit({ kind: 'control', controlId: 'effort', value: 'low' })).resolves.toEqual({
      status: 'rejected',
      reason: 'another model switch is active',
    });
    await expect(first).resolves.toEqual({ status: 'rejected', reason: 'Codex did not answer the change' });
  });

  it('opens a new connection after one that failed to open or was lost', async () => {
    const { service, connections, opened } = codex([
      { 'thread/resume': { error: { code: -32600, message: 'no rollout found for thread id thread-1' } } },
      {},
      {},
    ]);
    await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual({
      status: 'rejected',
      reason: 'Codex refused the change: no rollout found for thread id thread-1',
    });
    expect(connections[0]!.closes()).toBe(1);
    await expect(service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual({ status: 'sent' });
    connections[1]!.drop();
    await expect(service.submit({ kind: 'control', controlId: 'effort', value: 'low' })).resolves.toEqual({
      status: 'sent',
    });
    expect(opened()).toBe(3);
  });

  it('asks for nothing before a thread is attached, or after the binding is disposed', async () => {
    const unattached = codex([{}], false);
    await expect(unattached.service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual({
      status: 'rejected',
      reason: 'no Codex thread is attached yet',
    });
    await expect(unattached.service.listen()).rejects.toThrow('no Codex thread is attached yet');
    expect(unattached.opened()).toBe(0);

    const gone = { status: 'rejected', reason: 'the agent binding is disposed', retryable: false };
    const disposed = codex();
    disposed.dispose();
    await expect(disposed.service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual(gone);

    const closed = codex();
    await closed.service.listen();
    await closed.service.dispose();
    await closed.service.dispose();
    expect(closed.connections[0]!.closes()).toBe(1);
    await expect(closed.service.submit({ kind: 'model', modelId: 'gpt-5.1-codex' })).resolves.toEqual(gone);
    closed.connections[0]!.say({
      jsonrpc: '2.0',
      method: 'thread/settings/updated',
      params: { threadId: 'thread-1', threadSettings: { model: 'late' } },
    });
    expect(closed.heard).toEqual([]);
  });
});
