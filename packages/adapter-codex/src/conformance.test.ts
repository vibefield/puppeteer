import {
  runAgentMonitorConformance,
  runAgentAdapterConformance,
  type AgentMonitorAdapterHarness,
  type AgentAdapterHarness,
} from '@vibefield/puppeteer-testing/conformance';
import { createCodexSession } from './driver.js';
import type { Transport } from './transport/app-server-client.js';

const THREAD = '019f5d86-423a-7083-ab79-2deb044599c1';
const TURN = 'turn-conformance-1';
const REPLY = 'pong';

interface ScriptedAppServer {
  transport: Transport;
  deliver(message: unknown): void;
  drop(): void;
  closed(): boolean;
}

/** A minimal scripted `codex app-server` that completes one turn with `reply`. */
function scriptedAppServer(reply: string): ScriptedAppServer {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let isClosed = false;
  const emit = (m: unknown): void => void queueMicrotask(() => onMsg?.(m));
  const thread = { id: THREAD, sessionId: THREAD, path: '/rollout.jsonl', status: { type: 'idle' } };
  const userItem = { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'go' }] };

  const transport: Transport = {
    send: (raw) => {
      const m = raw as Record<string, unknown>;
      if (typeof m.method !== 'string' || m.id === undefined) return;
      switch (m.method) {
        case 'initialize':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          break;
        case 'thread/start':
          emit({ jsonrpc: '2.0', id: m.id, result: { thread } });
          emit({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          break;
        case 'thread/resume':
          emit({ jsonrpc: '2.0', id: m.id, result: { thread } });
          emit({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          emit({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId: THREAD,
              turnId: 'history-turn',
              item: { type: 'agentMessage', id: 'history-message', text: reply, phase: 'final_answer' },
            },
          });
          emit({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: 'history-turn', status: 'completed', error: null } },
          });
          break;
        case 'turn/start':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          {
            const params = m.params as Record<string, unknown>;
            const echoedUserItem = { ...userItem, clientId: params.clientUserMessageId };
            emit({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } },
            });
            emit({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: { item: echoedUserItem, threadId: THREAD, turnId: TURN },
            });
            emit({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: {
                item: { type: 'agentMessage', id: 'msg', text: reply, phase: 'final_answer' },
                threadId: THREAD,
                turnId: TURN,
              },
            });
            emit({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null } },
            });
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
    deliver: (message) => onMsg?.(message),
    drop: () => onCls?.({ code: 1, signal: null }),
    closed: () => isClosed,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function codexHarness(resume?: string): Promise<AgentAdapterHarness> {
  const server = scriptedAppServer(REPLY);
  const session = await createCodexSession({ cwd: '/x', transport: server.transport, resume });
  await tick(); // let the thread/started notification apply -> ready
  return {
    binding: session,
    reply: REPLY,
    resume: () => codexHarness(session.sessionId),
    assertNoOrphans: async () => {
      if (!server.closed()) throw new Error('Codex app-server transport survived dispose()');
      let observedLateEvent = false;
      const off = session.events.onCandidate(() => {
        observedLateEvent = true;
      });
      server.deliver({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'late' } } });
      await tick();
      off();
      if (observedLateEvent) {
        throw new Error('Codex adapter observed a buffered notification after dispose()');
      }
    },
    driveTurn: async () => {
      const done = new Promise<void>((resolve) => {
        const off = session.events.onCandidate((e) => {
          if (e.event.type === 'turn:completed') {
            off();
            resolve();
          }
        });
      });
      await session.services.prompt.submit({ text: 'go' });
      await done;
    },
  };
}

runAgentAdapterConformance('codex', codexHarness);

async function codexMonitorHarness(): Promise<AgentMonitorAdapterHarness> {
  const server = scriptedAppServer(REPLY);
  const session = await createCodexSession({ cwd: '/x', transport: server.transport });
  await tick();
  return { binding: session, closeObservationRail: () => server.drop() };
}

runAgentMonitorConformance('codex', codexMonitorHarness);
