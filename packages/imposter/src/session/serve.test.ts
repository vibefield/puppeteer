/**
 * The app-server channel and the serve table (docs/archive/IMPOSTER.md §9.3).
 *
 * These are the two things the hook family never needed: a server that answers,
 * and a state machine in front of it. Both are exercised here against a pair of
 * in-memory streams — the real transport is the adapter spawning
 * `<bin> app-server` and talking NDJSON over stdio, which the conformance
 * suite covers.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OpInvocation, Persona } from '../persona/types.ts';
import { loadPersona } from '../persona/load.ts';
import { createAppServerChannel, RpcError, type AppServerChannelOptions } from './channels/jsonrpc.ts';
import { createServeDispatcher, type ServeDocument, type ServeRequestContext } from './serve.ts';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function wire(
  document: ServeDocument,
  overrides: Partial<Parameters<typeof createServeDispatcher>[0]> = {},
  requestContext: ServeRequestContext = {},
  initialBindings: Record<string, unknown> = {},
  channelOverrides: Pick<AppServerChannelOptions, 'validateOutbound'> = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  // Interleaving, recorded as it happens. Ordering between a reply and the ops
  // it schedules cannot be checked after the fact — see the ordering test.
  const order: string[] = [];
  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      written.push(message);
      order.push(`reply:${String(message.id ?? message.method)}`);
    }
  });

  const ran: OpInvocation[] = [];
  const bindings: Record<string, unknown> = { ...initialBindings };
  const dispatcher = createServeDispatcher({
    persona: { vendor: 'codex' } as Persona,
    document,
    bindings,
    runOps: async (invocations) => {
      order.push(`ops:${invocations.map((entry) => entry.op).join(',')}`);
      ran.push(...invocations);
    },
    runBehavior: async (stimulus) => {
      order.push('ops:$behavior');
      ran.push({ op: '$behavior', with: stimulus });
    },
    ...overrides,
  });
  const channel = createAppServerChannel({
    input,
    output,
    serve: (method, params) => dispatcher.serve(method, params, requestContext),
    notified: dispatcher.notified,
    jsonrpc: document.$server?.jsonrpc,
    notificationFields: () => document.$server?.notification ?? {},
    validateOutbound: channelOverrides.validateOutbound,
    validateResult: overrides.validateResult,
  });
  const send = (message: Record<string, unknown>) => input.write(`${JSON.stringify(message)}\n`);
  const sendRaw = (line: string) => input.write(`${line}\n`);
  return { channel, dispatcher, send, sendRaw, written, ran, bindings, order };
}

const CODEX_LIKE: ServeDocument = {
  $server: { gate: { until: 'initialize', error: { code: -32600, message: 'Not initialized' } } },
  initialize: { result: { userAgent: '$vendorVersion' } },
  'thread/start': {
    bind: { $threadId: '$uuid:thread' },
    result: { thread: { id: '$threadId', status: { type: 'idle' } } },
    then: [{ op: 'session.start' }],
  },
  'turn/start': { result: {}, then: '$behavior' },
};

describe('the app-server channel', () => {
  it('omits `jsonrpc` on output, exactly as the vendor does', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    // Adding the field would teach the adapter that codex sends it, and mask
    // the day the adapter starts depending on it (C1b finding 5).
    expect(written[0]).toEqual({ id: 1, result: { userAgent: '$vendorVersion' } });
    expect(written[0]).not.toHaveProperty('jsonrpc');
  });

  it('emits strict JSON-RPC 2.0 when the vendor declares it', async () => {
    const strict: ServeDocument = {
      ...CODEX_LIKE,
      $server: { ...CODEX_LIKE.$server, jsonrpc: '2.0' },
    };
    const { send, written } = wire(strict);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await settle();
    expect(written[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { userAgent: '$vendorVersion' } });
  });

  it('validates the complete strict carrier after adding the JSON-RPC version', async () => {
    const strict: ServeDocument = {
      ...CODEX_LIKE,
      $server: { ...CODEX_LIKE.$server, jsonrpc: '2.0' },
    };
    const validated: Array<Record<string, unknown>> = [];
    const { channel, written } = wire(
      strict,
      {},
      {},
      {},
      {
        validateOutbound: (_method, record) => {
          validated.push(record);
          return record.jsonrpc === '2.0' ? [] : ['missing required field "jsonrpc"'];
        },
      },
    );

    channel.notify('session/update', { sessionId: 'one' });
    await settle();

    expect(validated).toEqual([
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'one' },
      },
    ]);
    expect(written).toEqual(validated);
  });

  it('rejects inbound messages that omit the vendor-declared JSON-RPC version', async () => {
    const strict: ServeDocument = {
      ...CODEX_LIKE,
      $server: { ...CODEX_LIKE.$server, jsonrpc: '2.0' },
    };
    const { send, written, ran } = wire(strict);
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    expect(written).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'jsonrpc must be 2.0' },
      },
    ]);
    expect(ran).toEqual([]);
  });

  it('ignores non-JSON banner lines rather than failing, as the vendor does', async () => {
    const { send, sendRaw, written } = wire(CODEX_LIKE);
    // The adapter's own transport skips these on the way in; the imposter has
    // to survive them on the way out for the same reason.
    sendRaw('codex-cli 0.147.0 starting up');
    sendRaw('');
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    expect(written).toEqual([{ id: 1, result: { userAgent: '$vendorVersion' } }]);
  });

  it('correlates a server request with the client reply that answers it', async () => {
    const { channel, send, written } = wire(CODEX_LIKE);
    const pending = channel.request('item/commandExecution/requestApproval', { command: 'curl' });
    await settle();
    const request = written.at(-1)!;
    expect(request.method).toBe('item/commandExecution/requestApproval');
    send({ id: request.id, result: { decision: 'decline' } });
    await expect(pending).resolves.toEqual({ decision: 'decline' });
  });

  it('preserves vendor-declared notification carrier fields', async () => {
    const document: ServeDocument = {
      ...CODEX_LIKE,
      $server: { ...CODEX_LIKE.$server, notification: { emittedAtMs: 1_767_225_600_000 } },
    };
    const { channel, written } = wire(document);
    channel.notify('thread/started', { thread: { id: 'one' } });
    await settle();
    expect(written).toEqual([
      {
        method: 'thread/started',
        params: { thread: { id: 'one' } },
        emittedAtMs: 1_767_225_600_000,
      },
    ]);
  });

  it('refuses persona fields that could replace notification protocol fields', () => {
    const document: ServeDocument = {
      ...CODEX_LIKE,
      $server: { ...CODEX_LIKE.$server, notification: { method: 'hijacked' } },
    };
    const { channel } = wire(document);
    expect(() => channel.notify('thread/started', { thread: { id: 'one' } })).toThrow(
      /notification fields may not override method/,
    );
  });

  it('rejects in-flight server requests when the client goes away', async () => {
    const { channel } = wire(CODEX_LIKE);
    const pending = channel.request('item/commandExecution/requestApproval', {});
    channel.close();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
  });

  it('validates the client result of an agent-originated request', async () => {
    const { channel, send, written } = wire(CODEX_LIKE, {
      validateResult: (method, result) =>
        method === 'item/commandExecution/requestApproval' && (result as { decision?: unknown })?.decision !== 'accept'
          ? ['field "decision" value not in enum']
          : [],
    });
    const pending = channel.request('item/commandExecution/requestApproval', {});
    await settle();
    send({ id: written[0]?.id, result: { decision: 'invented' } });
    await expect(pending).rejects.toMatchObject({ code: -32602 });
  });
});

describe('the serve table', () => {
  it('gates everything behind initialize, as codex does', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'thread/start', params: {} });
    await settle();
    expect(written[0]).toEqual({ id: 1, error: { code: -32600, message: 'Not initialized' } });

    send({ id: 2, method: 'initialize', params: {} });
    send({ id: 3, method: 'thread/start', params: {} });
    await settle();
    expect(written[2]).toMatchObject({ id: 3, result: { thread: { status: { type: 'idle' } } } });
  });

  it('mints an id once, so the reply and the ops that follow agree', async () => {
    const { send, written, bindings } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/start', params: {} });
    await settle();
    const reply = written[1] as { result: { thread: { id: string } } };
    // Two independent `$uuid:` draws would give the client one id and the
    // notifications another, and nothing downstream would correlate.
    expect(reply.result.thread.id).toBe(bindings.$threadId);
    expect(reply.result.thread.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes the reply BEFORE running the ops the method schedules', async () => {
    // Two earlier versions of this test PASSED while `thread/started` was
    // actually going out ahead of the `thread/start` result — one compared
    // totals after the fact, the other polled on a 1 ms timer that could not
    // fire before a microtask. Ordering has to be recorded as it happens.
    const { send, order } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/start', params: {} });
    await settle();
    // An imposter that emitted first would announce a thread the client has not
    // been told about yet.
    expect(order).toEqual(['reply:1', 'reply:2', 'ops:session.start']);
  });

  it('completes `before` ops BEFORE writing the reply', async () => {
    const acpLike: ServeDocument = {
      initialize: { result: {} },
      'session/new': { result: { sessionId: 'one' }, before: [{ op: 'session.start' }] },
    };
    const { send, order } = wire(acpLike);
    send({ id: 1, method: 'session/new', params: {} });
    await settle();
    expect(order).toEqual(['ops:session.start', 'reply:1']);
  });

  it('hands turn/start its prompt as the behaviour stimulus', async () => {
    const { send, ran } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'turn/start', params: { input: [{ type: 'text', text: 'summarise the repo' }] } });
    await settle();
    expect(ran).toEqual([{ op: '$behavior', with: { text: 'summarise the repo' } }]);
  });

  it('hands ACP session/prompt content to the behaviour before replying', async () => {
    const acpLike: ServeDocument = {
      'session/prompt': { result: { stopReason: 'end_turn' }, before: '$behavior' },
    };
    const { send, ran, order } = wire(acpLike);
    send({ id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'hello ACP' }] } });
    await settle();
    expect(ran).toEqual([{ op: '$behavior', with: { text: 'hello ACP' } }]);
    expect(order).toEqual(['ops:$behavior', 'reply:1']);
  });

  it('refuses an unserved method instead of hanging the client', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'fs/readFile', params: {} });
    await settle();
    expect(written[1]).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it('turns an off-model params payload into an error reply, never a crash', async () => {
    const { send, written } = wire(CODEX_LIKE, {
      validateParams: (method) => (method === 'turn/start' ? ['field "input" is missing'] : []),
    });
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'turn/start', params: {} });
    await settle();
    // This is what makes the imposter a conformance test of the adapter's
    // CLIENT — something the hook family structurally cannot do (§9.3).
    expect(written[1]).toMatchObject({ id: 2, error: { code: -32602 } });
    expect((written[1] as { error: { message: string } }).error.message).toContain('input');
  });

  it('refuses an off-model server result as an internal error before follow-up ops run', async () => {
    const { send, written, ran, dispatcher } = wire(CODEX_LIKE, {
      validateResult: (method) => (method === 'initialize' ? ['missing required field "codexHome"'] : []),
    });
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    expect(written[0]).toMatchObject({ id: 1, error: { code: -32603 } });
    expect((written[0] as { error: { message: string } }).error.message).toContain('codexHome');
    expect(dispatcher.opened).toBe(false);
    expect(ran).toEqual([]);
  });
});

/**
 * Against the REAL codex serve table, not a fixture — the bug this guards was a
 * one-word mistake in that document, and a fixture would have copied it.
 */
describe('the shipped codex serve table', () => {
  it('models and validates the adapter-facing request/result contract in both directions', async () => {
    const persona = loadPersona('codex');
    for (const method of [
      'initialize',
      'model/list',
      'account/rateLimits/read',
      'thread/start',
      'thread/resume',
      'thread/read',
      'thread/turns/list',
      'thread/inject_items',
      'turn/start',
    ]) {
      expect(persona.model.events.find((event) => event.event === method)?.direction, method).toBe('client-to-agent');
      expect(persona.resultSchemaFor(method), `${method} result schema`).toBeDefined();
    }
    const { send, written } = wire(
      persona.serve!,
      {
        persona,
        validateParams: (method, params) => persona.validate(method, params),
        validateResult: (method, result) => persona.validateResult(method, result),
      },
      {},
      {
        $vendorVersion: persona.version,
        $threadModel: 'codex-imposter',
        $threadModelProvider: 'imposter',
        $threadApprovalPolicy: 'on-request',
        $threadApprovalsReviewer: 'user',
        $threadSandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        $threadCreatedAt: Math.floor(Date.now() / 1_000),
        $threadUpdatedAt: Math.floor(Date.now() / 1_000),
      },
    );
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '0.0.0' } } });
    send({ id: 2, method: 'thread/start', params: { cwd: '/workspace' } });
    send({
      id: 3,
      method: 'turn/start',
      params: { threadId: 'a5e5f8c8-0000-4000-8000-000000000001', input: [{ type: 'text', text: 'hi' }] },
    });
    await settle();
    expect(written.map((message) => message.error)).toEqual([undefined, undefined, undefined]);
    expect(written[0]).toHaveProperty('result.codexHome');
    expect(written[1]).toHaveProperty('result.thread');
    expect(written[2]).toHaveProperty('result.turn');
  });

  it('resumes the thread it is given rather than minting a new one', async () => {
    const persona = loadPersona('codex');
    let restored = false;
    const { send, written, bindings } = wire(
      persona.serve!,
      { persona },
      {
        restoreSession: async () => {
          restored = true;
        },
      },
    );
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/resume', params: { threadId: 'a5e5f8c8-0000-4000-8000-000000000001' } });
    await settle();

    // A resume that renames the thread breaks nothing loudly: every later
    // notification simply names a thread the observer is not watching, and a
    // pane goes quiet with no error anywhere (found 2026-08-09 in Godview).
    expect(written[1]).toMatchObject({
      id: 2,
      result: { thread: { id: 'a5e5f8c8-0000-4000-8000-000000000001' } },
    });
    expect(bindings.$threadId).toBe('a5e5f8c8-0000-4000-8000-000000000001');
    expect(restored).toBe(true);
  });

  it('answers the paginated history read the observer makes on 0.151.0 and later, on the pinned model', async () => {
    const persona = loadPersona('codex');
    const threadId = 'a5e5f8c8-0000-4000-8000-000000000001';
    const { send, written } = wire(
      persona.serve!,
      {
        persona,
        validateParams: (method, params) => persona.validate(method, params),
        validateResult: (method, result) => persona.validateResult(method, result),
      },
      { restoreSession: async () => {} },
      {
        $vendorVersion: persona.version,
        $threadModel: 'codex-imposter',
        $threadModelProvider: 'imposter',
        $threadApprovalPolicy: 'on-request',
        $threadApprovalsReviewer: 'user',
        $threadSandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        $threadCreatedAt: Math.floor(Date.now() / 1_000),
        $threadUpdatedAt: Math.floor(Date.now() / 1_000),
      },
    );
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '0.0.0' } } });
    send({ id: 2, method: 'thread/resume', params: { threadId, excludeTurns: true } });
    send({ id: 3, method: 'thread/turns/list', params: { threadId, itemsView: 'full', sortDirection: 'asc' } });
    // The pinned params schema still refuses what the vendor refuses.
    send({ id: 4, method: 'thread/turns/list', params: { threadId, itemsView: 'everything' } });
    await settle();
    // Replies are written as each request settles, so they are matched by id.
    const reply = (id: number) => written.find((message) => message.id === id);
    expect([1, 2, 3].map((id) => reply(id)?.error)).toEqual([undefined, undefined, undefined]);
    expect(reply(2)).toMatchObject({ result: { thread: { id: threadId, turns: [] } } });
    expect(reply(3)).toEqual({ id: 3, result: { data: [], nextCursor: null, backwardsCursor: null } });
    expect(reply(4)).toMatchObject({ error: { code: -32602 } });
  });

  it('starts a thread on the cwd the client asked for', async () => {
    const persona = loadPersona('codex');
    const { send, written, bindings } = wire(persona.serve!, { persona });
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/start', params: { cwd: '/somewhere/else' } });
    await settle();
    expect(written[1]).toMatchObject({ id: 2, result: { thread: { cwd: '/somewhere/else' } } });
    expect(bindings.$threadId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
