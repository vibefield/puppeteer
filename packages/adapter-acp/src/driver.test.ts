import { describe, it, expect, vi } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/puppeteer-core';
import { projectAgentSession } from '@vibecook/puppeteer-testing';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, Client, ClientCapabilities, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AcpConnector } from './connection.js';
import { createAcpSession } from './driver.js';
import { scriptedAcpConnector } from './scripted-connector.js';

const SID = '019f5e50-ce8b-7152-abcd-000000000001';

/** Drive one turn to completion, resolving when turn.completed is observed. */
async function driveTurn(session: Awaited<ReturnType<typeof createAcpSession>>, text: string): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = session.onEvent((e) => {
      if (e.event.type === 'turn.completed' || e.event.type === 'turn.failed') {
        off();
        resolve();
      }
    });
  });
  await session.submitPrompt({ text });
  await done;
}

describe('createAcpSession', () => {
  it('exposes the ACP session id and a structured observation level', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    const projection = projectAgentSession(session);
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
    const projection = projectAgentSession(session);
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
    const projection = projectAgentSession(session, (state) => lifecycles.add(state.lifecycle));
    lifecycles.add(projection.state.lifecycle);
    try {
      const receipt = await session.submitPrompt({ text: 'say pong' });
      expect(receipt.status).toBe('confirmed');
      if (receipt.status === 'confirmed') expect(receipt.turnId).toBe('acp-turn-1');

      // wait for turn.completed
      await new Promise<void>((resolve) => {
        const stop = session.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
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

  it('records tool completion through a tool turn', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'done', toolTurn: true }),
    });
    const projection = projectAgentSession(session);
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
    const projection = projectAgentSession(session);
    const envelopes: AgentEventEnvelope[] = [];
    const off = session.onEvent((envelope) => envelopes.push(envelope));
    try {
      await driveTurn(session, 'think first');
      const started = envelopes.find((envelope) => envelope.event.type === 'reasoning.started');
      const completed = envelopes.find((envelope) => envelope.event.type === 'reasoning.completed');
      const answer = envelopes.find((envelope) => envelope.event.type === 'assistant.message');
      expect(started?.event).toEqual({ type: 'reasoning.started', reasoningId: 'thought-1' });
      expect(started?.nativeEvent).toMatchObject({
        update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'private thought text' } },
      });
      expect(completed?.confidence).toBe('derived');
      expect(completed!.sequence).toBeLessThan(answer!.sequence);
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
    const off = session.onEvent((envelope) => events.push(envelope.event.type));

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
      expect(events).toEqual(expect.arrayContaining(['permission.requested', 'permission.resolved']));
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
    const events: AgentEventEnvelope[] = [];
    const off = session.onEvent((envelope) => events.push(envelope));

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
        expect.arrayContaining(['question.requested', 'question.resolved']),
      );
      expect(events.find(({ event }) => event.type === 'question.resolved')?.event).toMatchObject({
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
