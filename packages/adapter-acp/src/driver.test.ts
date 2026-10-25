import { describe, it, expect, vi } from 'vitest';
import { safeParseAgentEvent, type AdapterEventCandidate } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, Client, ClientCapabilities, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AcpConnector } from './transport/connection.js';
import { createAcpSession } from './driver.js';
import { scriptedAcpConnector } from './test-support/scripted-connector.js';

const SID = '019f5e50-ce8b-7152-abcd-000000000001';

/** Drive one turn to completion, resolving when turn:completed is observed. */
async function driveTurn(session: Awaited<ReturnType<typeof createAcpSession>>, text: string): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = session.events.onCandidate((e) => {
      if (e.event.type === 'turn:completed' || e.event.type === 'turn:failed') {
        off();
        resolve();
      }
    });
  });
  await session.services.prompt.submit({ text });
  await done;
}

describe('createAcpSession', () => {
  it('awaits transport cleanup for every concurrent dispose call', async () => {
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => closed);
    const connector = scriptedAcpConnector({ sessionId: SID, reply: 'pong' });
    const session = await createAcpSession({
      cwd: '/x',
      connector: (toClient) => ({ ...connector(toClient), close }),
    });
    const completed = vi.fn();
    const first = session.dispose().then(completed);
    const second = session.dispose().then(completed);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it.each(['initialize', 'newSession', 'loadSession'] as const)(
    'awaits cleanup when %s fails during bootstrap',
    async (method) => {
      const failure = new Error('bootstrap failed');
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = vi.fn(() => closed);
      const connector = scriptedAcpConnector({ sessionId: SID, reply: 'pong' });
      const rejected = vi.fn((error: unknown) => error);
      const creating = createAcpSession({
        cwd: '/x',
        ...(method === 'loadSession' ? { resume: SID } : {}),
        connector: (toClient) => {
          const connection = connector(toClient);
          connection.agent[method] = vi.fn().mockRejectedValue(failure);
          return { ...connection, close };
        },
      }).catch(rejected);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(rejected).not.toHaveBeenCalled();
      finish();
      await expect(creating).resolves.toBe(failure);
    },
  );

  it('exposes the ACP session id and a structured observation level', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    const projection = projectAgentEvents(session);
    try {
      expect(session.sessionId).toBe(SID);
      expect(session.runtimeSessionId).toBe(SID);
      expect(session.observationLevel()).toBe('structured');
      expect(projection.state.environment.currentCwd?.value).toBe('/x');
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('bootstraps the active model card from session config options', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({
        sessionId: SID,
        reply: 'pong',
        configOptions: [
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'grok-4.5',
            options: [{ value: 'grok-4.5', name: 'Grok 4.5' }],
          },
        ],
      }),
    });
    const projection = projectAgentEvents(session);
    try {
      expect(projection.state.environment.model?.value).toEqual({ id: 'grok-4.5', displayName: 'Grok 4.5' });
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('drives a turn: running while active, ready after, reply sealed, deterministic receipt', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    const lifecycles = new Set<string>();
    const projection = projectAgentEvents(session, (state) => lifecycles.add(state.lifecycle));
    lifecycles.add(projection.state.lifecycle);
    try {
      const receipt = await session.services.prompt.submit({ text: 'say pong' });
      expect(receipt.status).toBe('confirmed');
      if (receipt.status === 'confirmed') expect(receipt.turnId).toBe('acp-turn-1');

      // wait for turn:completed
      await new Promise<void>((resolve) => {
        const stop = session.events.onCandidate((e) => {
          if (e.event.type === 'turn:completed') {
            stop();
            resolve();
          }
        });
      });

      expect(lifecycles.has('running')).toBe(true);
      expect(projection.state.lifecycle).toBe('ready');
      expect(projection.state.activeTurn).toBeUndefined();
      expect(projection.state.lastAssistantMessage).toBe('pong');
      const seqs = projection.envelopes.map(({ sequence }) => sequence);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('publishes unstamped, catalog-routed candidates for runtime ingress', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    const candidates: AdapterEventCandidate[] = [];
    expect(session.events.onCandidate).toBeTypeOf('function');
    const off = session.events.onCandidate!((candidate) => candidates.push(candidate));
    try {
      await driveTurn(session, 'say pong');
      const assistant = candidates.find(({ type }) => type === 'conversation:assistant-message');
      expect(assistant?.event.type).toBe('conversation:assistant-message');
      expect(assistant).not.toHaveProperty('sequence');
      expect(assistant && safeParseAgentEvent(assistant.type, assistant.event).success).toBe(true);
      expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
      expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);
    } finally {
      off();
      await session.dispose();
    }
  });

  it('records tool completion through a tool turn', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'done', toolTurn: true }),
    });
    const projection = projectAgentEvents(session);
    try {
      await driveTurn(session, 'use a tool');
      expect(projection.state.counters.toolsCompleted).toBe(1);
      expect(projection.state.tools.size).toBe(0);
      expect(projection.state.lastAssistantMessage).toBe('done');
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('surfaces thought presence, retains the raw payload, and closes reasoning before the answer', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'done', thought: 'private thought text' }),
    });
    const projection = projectAgentEvents(session);
    const envelopes: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((envelope) => envelopes.push(envelope));
    try {
      await driveTurn(session, 'think first');
      const started = envelopes.find((envelope) => envelope.event.type === 'reasoning:started');
      const completed = envelopes.find((envelope) => envelope.event.type === 'reasoning:completed');
      const answer = envelopes.find((envelope) => envelope.event.type === 'conversation:assistant-message');
      expect(started?.event).toEqual({ type: 'reasoning:started', reasoningId: 'thought-1' });
      expect(started?.nativeEvent).toMatchObject({
        update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'private thought text' } },
      });
      expect(completed?.confidence).toBe('derived');
      expect(envelopes.indexOf(completed!)).toBeLessThan(envelopes.indexOf(answer!));
      expect(JSON.stringify(started?.event)).not.toContain('private thought text');
      expect(projection.state.activeReasoning).toBeUndefined();
    } finally {
      off();
      projection.dispose();
      await session.dispose();
    }
  });

  it('forwards client capabilities and structured approvals to the ACP seam', async () => {
    const clientCapabilities: ClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: true,
    };
    let initializedCapabilities: ClientCapabilities | undefined;
    let permissionResponse: RequestPermissionResponse | undefined;
    let client!: Client;
    const connector: AcpConnector = (toClient) => {
      const agent = {
        async initialize(params: { clientCapabilities?: ClientCapabilities }) {
          initializedCapabilities = params.clientCapabilities;
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: SID };
        },
        async prompt() {
          permissionResponse = await client.requestPermission({
            sessionId: SID,
            toolCall: {
              toolCallId: 'tool-1',
              title: 'Write file',
              kind: 'edit',
              rawInput: { path: 'README.md' },
            },
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
            ],
          });
          return { stopReason: 'end_turn' as const };
        },
        async cancel() {},
      };
      client = toClient(agent as unknown as Agent);
      return {
        agent: agent as unknown as Agent,
        onClose() {},
        close() {},
      };
    };
    const onApproval = vi.fn(() => 'approved' as const);
    const session = await createAcpSession({ cwd: '/x', connector, clientCapabilities, onApproval });
    const events: string[] = [];
    const off = session.events.onCandidate((envelope) => events.push(envelope.event.type));

    try {
      await driveTurn(session, 'write the file');
      expect(initializedCapabilities).toEqual(clientCapabilities);
      expect(onApproval).toHaveBeenCalledWith({
        toolCallId: 'tool-1',
        tool: 'Write file',
        input: { path: 'README.md' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(events).toEqual(
        expect.arrayContaining(['interaction:permission-requested', 'interaction:permission-resolved']),
      );
    } finally {
      off();
      await session.dispose();
    }
  });

  it('detects structured ACP questions with choices and resolves them from the elicitation callback', async () => {
    let initializedCapabilities: ClientCapabilities | undefined;
    let client!: Client;
    let elicitationResponse: unknown;
    const connector: AcpConnector = (toClient) => {
      const agent = {
        async initialize(params: { clientCapabilities?: ClientCapabilities }) {
          initializedCapabilities = params.clientCapabilities;
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: SID };
        },
        async prompt() {
          elicitationResponse = await client.unstable_createElicitation?.({
            mode: 'form',
            sessionId: SID,
            message: 'Choose a database',
            requestedSchema: {
              type: 'object',
              properties: {
                database: {
                  type: 'string',
                  title: 'Database',
                  oneOf: [
                    { const: 'sqlite', title: 'SQLite', description: 'Local file' },
                    { const: 'postgres', title: 'PostgreSQL', description: 'Server database' },
                  ],
                },
              },
            },
          });
          return { stopReason: 'end_turn' as const };
        },
        async cancel() {},
      };
      client = toClient(agent as unknown as Agent);
      return { agent: agent as unknown as Agent, onClose() {}, close() {} };
    };
    const onElicitation = vi.fn(() => ({ action: 'accept' as const, content: { database: 'sqlite' } }));
    const session = await createAcpSession({ cwd: '/x', connector, onElicitation });
    const events: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((envelope) => events.push(envelope));

    try {
      await driveTurn(session, 'pick one');
      expect(initializedCapabilities?.elicitation).toEqual({ form: {}, url: {} });
      expect(onElicitation).toHaveBeenCalledWith({
        interactionId: 'acp-elicitation-1',
        request: expect.objectContaining({ mode: 'form', message: 'Choose a database' }),
        questions: [
          {
            id: 'database',
            header: 'Database',
            prompt: 'Choose a database',
            options: [
              { label: 'SQLite', description: 'Local file' },
              { label: 'PostgreSQL', description: 'Server database' },
            ],
            allowMultiple: false,
            allowFreeForm: false,
          },
        ],
      });
      expect(elicitationResponse).toEqual({ action: 'accept', content: { database: 'sqlite' } });
      expect(events.map(({ event }) => event.type)).toEqual(
        expect.arrayContaining(['interaction:question-requested', 'interaction:question-resolved']),
      );
      expect(events.find(({ event }) => event.type === 'interaction:question-resolved')?.event).toMatchObject({
        outcome: 'answered',
      });
    } finally {
      off();
      await session.dispose();
    }
  });

  it('dispose() is idempotent', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    await session.dispose();
    await expect(session.dispose()).resolves.toBeUndefined();
  });
});

describe('createAcpSession with deferred approvals', () => {
  const options = [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'deny', name: 'Reject once', kind: 'reject_once' as const },
  ];
  const toolCall = {
    toolCallId: 'tool-1',
    title: 'Write file',
    kind: 'edit' as const,
    rawInput: { path: 'README.md' },
  };

  /** An agent whose permission request another attached client answers; `answer` scripts what it then emits. */
  function deferringAgent(answer: (client: Client) => Promise<'end_turn' | 'cancelled' | 'hang'>) {
    let client!: Client;
    const responses: RequestPermissionResponse[] = [];
    let closed: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const connector: AcpConnector = (toClient) => {
      const agent = {
        async initialize() {
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: SID };
        },
        async prompt() {
          // The agent does not wait for this client: the first answer from any client wins.
          void Promise.resolve(client.requestPermission({ sessionId: SID, toolCall, options })).then((response) => {
            responses.push(response);
          });
          const stopReason = await answer(client);
          if (stopReason === 'hang') return new Promise<never>(() => {});
          return { stopReason };
        },
        async cancel() {},
      };
      client = toClient(agent as unknown as Agent);
      return {
        agent: agent as unknown as Agent,
        onClose(handler) {
          closed = handler;
        },
        close() {},
      };
    };
    return { connector, responses, closeTransport: () => closed?.({ code: 0, signal: null }) };
  }

  const permissionEvents = (events: AdapterEventCandidate[]) =>
    events.flatMap(({ event }) =>
      event.type === 'interaction:permission-requested'
        ? [`requested:${event.presentation}`]
        : event.type === 'interaction:permission-resolved'
          ? [`resolved:${event.outcome}`]
          : [],
    );

  it('leaves the request to the native TUI and settles it from the tool progress that follows', async () => {
    const agent = deferringAgent(async (client) => {
      await client.sessionUpdate({
        sessionId: SID,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' },
      });
      await client.sessionUpdate({
        sessionId: SID,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
      });
      return 'end_turn';
    });
    const session = await createAcpSession({ cwd: '/x', connector: agent.connector, unhandledApproval: 'defer' });
    const events: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((candidate) => events.push(candidate));
    try {
      await driveTurn(session, 'write the file');
      await vi.waitFor(() => expect(agent.responses).toHaveLength(1));
      expect(permissionEvents(events)).toEqual(['requested:native-tui', 'resolved:allowed']);
      expect(agent.responses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
      const resolved = events.findIndex(({ event }) => event.type === 'interaction:permission-resolved');
      const started = events.findIndex(({ event }) => event.type === 'tool:started' || event.type === 'tool:completed');
      expect(started === -1 || resolved < started).toBe(true);
    } finally {
      off();
      await session.dispose();
    }
  });

  it('settles a request no evidence resolved as unknown when its prompt ends', async () => {
    const agent = deferringAgent(async () => 'cancelled');
    const session = await createAcpSession({ cwd: '/x', connector: agent.connector, unhandledApproval: 'defer' });
    const events: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((candidate) => events.push(candidate));
    try {
      await driveTurn(session, 'write the file');
      await vi.waitFor(() => expect(agent.responses).toHaveLength(1));
      expect(permissionEvents(events)).toEqual(['requested:native-tui', 'resolved:unknown']);
    } finally {
      off();
      await session.dispose();
    }
  });

  it('releases a request still pending on dispose and on transport close', async () => {
    for (const end of ['dispose', 'close'] as const) {
      const agent = deferringAgent(async () => 'hang');
      const session = await createAcpSession({ cwd: '/x', connector: agent.connector, unhandledApproval: 'defer' });
      const events: AdapterEventCandidate[] = [];
      const off = session.events.onCandidate((candidate) => events.push(candidate));
      await session.services.prompt.submit({ text: 'write the file' });
      await vi.waitFor(() => expect(permissionEvents(events)).toEqual(['requested:native-tui']));
      if (end === 'close') {
        agent.closeTransport();
        expect(permissionEvents(events)).toEqual(['requested:native-tui', 'resolved:unknown']);
      }
      off();
      await session.dispose();
      await vi.waitFor(() => expect(agent.responses).toEqual([{ outcome: { outcome: 'cancelled' } }]));
    }
  });

  it('publishes the answer the agent acted on when the person answers before the host handler', async () => {
    let asked!: () => void;
    const hostAsked = new Promise<void>((resolve) => (asked = resolve));
    let approve!: (decision: 'approved') => void;
    const signals: (AbortSignal | undefined)[] = [];
    const agent = deferringAgent(async (client) => {
      await hostAsked;
      // The person rejected in the agent's own terminal UI while the host dialog was open.
      await client.sessionUpdate({
        sessionId: SID,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed', _meta: { reason: 'no' } },
      });
      return 'cancelled';
    });
    const session = await createAcpSession({
      cwd: '/x',
      connector: agent.connector,
      unhandledApproval: 'defer',
      deferredApprovalEvidence: (method, params) => {
        const update = params.update as { status?: string; toolCallId?: string } | undefined;
        return method === 'session/update' && update?.status === 'failed'
          ? [{ toolCallId: update.toolCallId, outcome: 'denied' }]
          : [];
      },
      onApproval: (request) => {
        signals.push(request.signal);
        asked();
        return new Promise((resolve) => (approve = resolve));
      },
    });
    const events: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((candidate) => events.push(candidate));
    try {
      await driveTurn(session, 'write the file');
      await vi.waitFor(() => expect(agent.responses).toHaveLength(1));
      expect(permissionEvents(events)).toEqual(['requested:host-ui', 'resolved:denied']);
      // The agent already acted; this client's reply only releases the request.
      expect(agent.responses).toEqual([{ outcome: { outcome: 'cancelled' } }]);
      expect(signals[0]?.aborted).toBe(true);
      approve('approved');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(permissionEvents(events)).toEqual(['requested:host-ui', 'resolved:denied']);
    } finally {
      off();
      await session.dispose();
    }
  });

  it('keeps the immediate deny for compositions that do not defer', async () => {
    const agent = deferringAgent(async () => 'end_turn');
    const session = await createAcpSession({ cwd: '/x', connector: agent.connector });
    const events: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((candidate) => events.push(candidate));
    try {
      await driveTurn(session, 'write the file');
      await vi.waitFor(() => expect(agent.responses).toHaveLength(1));
      expect(agent.responses).toEqual([{ outcome: { outcome: 'selected', optionId: 'deny' } }]);
      expect(permissionEvents(events)).toEqual(['requested:host-ui', 'resolved:denied']);
    } finally {
      off();
      await session.dispose();
    }
  });
});
