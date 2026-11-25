import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Client, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/** One fake leader client connection, as the stdio connector would hand it to the ACP SDK. */
interface FakeConnection {
  readonly options: { executable: string; args?: readonly string[]; cwd?: string };
  readonly agent: {
    initialize: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
  };
  client?: Client;
  readonly close: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  /** What the fake leader does on session/load, given the client it is talking to. */
  onLoad: undefined as ((client: Client) => Promise<unknown>) | undefined,
}));

vi.mock('@vibefield/puppeteer-adapter-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vibefield/puppeteer-adapter-acp')>()),
  createStdioAcpConnector: (options: FakeConnection['options']) => (toClient: (agent: Agent) => Client) => {
    const connection: FakeConnection = {
      options,
      agent: {
        initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } })),
        loadSession: vi.fn(async () => (mocks.onLoad ? mocks.onLoad(connection.client!) : {})),
        newSession: vi.fn(async () => ({ sessionId: 'never' })),
      },
      close: vi.fn(async () => undefined),
    };
    connection.client = toClient(connection.agent as unknown as Agent);
    mocks.connections.push(connection);
    return { agent: connection.agent, onClose: () => undefined, close: connection.close };
  },
}));

import { reassertGrokServers } from './acp-control.js';

const servers = { field: { command: 'door', args: ['--stdio'], env: { TOKEN: 'secret' } } };

function permissionRequest() {
  return {
    sessionId: 'run-session',
    toolCall: { toolCallId: 'tool-1', title: 'Run a command', rawInput: { command: 'ls' } },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' as const },
    ],
  };
}

describe('reassertGrokServers: a short-lived client of the run leader that names the run servers', () => {
  beforeEach(() => {
    mocks.connections.length = 0;
    mocks.onLoad = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the run session with its servers through the run leader, then closes', async () => {
    await reassertGrokServers('/real/grok', '/a', '/tmp/leader.sock', 'run-session', servers);
    expect(mocks.connections).toHaveLength(1);
    const [connection] = mocks.connections;
    expect(connection!.options).toMatchObject({
      executable: '/real/grok',
      args: ['agent', '--leader', '--leader-socket', '/tmp/leader.sock', 'stdio'],
      cwd: '/a',
    });
    expect(connection!.agent.loadSession).toHaveBeenCalledWith({
      sessionId: 'run-session',
      cwd: '/a',
      mcpServers: [{ name: 'field', command: 'door', args: ['--stdio'], env: [{ name: 'TOKEN', value: 'secret' }] }],
    });
    expect(connection!.agent.newSession).not.toHaveBeenCalled();
    expect(connection!.close).toHaveBeenCalledOnce();
  });

  it('never answers a permission request the leader shows it: the client leaves, it does not reply', async () => {
    // A request still open in the session is shown to a client that joins (1.0.70 probe). Nobody has answered it
    // yet; the person answers in the viewer. A reply from this client could be the first one the leader takes.
    let reply: RequestPermissionResponse | undefined;
    let replied = false;
    mocks.onLoad = async (client) => {
      void Promise.resolve(client.requestPermission(permissionRequest())).then(
        (response) => {
          replied = true;
          reply = response;
        },
        () => {
          replied = true;
        },
      );
      return {};
    };
    await reassertGrokServers('/real/grok', '/a', '/tmp/leader.sock', 'run-session', servers);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.connections[0]!.close).toHaveBeenCalledOnce();
    expect({ replied, reply }).toEqual({ replied: false, reply: undefined });
  });

  it('gives up on a load that never answers, and closes its client', async () => {
    vi.useFakeTimers();
    mocks.onLoad = () => new Promise(() => undefined);
    const reassert = reassertGrokServers('/real/grok', '/a', '/tmp/leader.sock', 'run-session', servers);
    const outcome = reassert.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.connections[0]!.close).toHaveBeenCalledOnce();
    await expect(outcome).resolves.toBe('rejected');
  });

  it('closes its client at once when its run stops', async () => {
    mocks.onLoad = () => new Promise(() => undefined);
    const stop = new AbortController();
    const reassert = reassertGrokServers('/real/grok', '/a', '/tmp/leader.sock', 'run-session', servers, undefined, {
      signal: stop.signal,
    });
    const outcome = reassert.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(mocks.connections[0]?.agent.loadSession).toHaveBeenCalledOnce());
    stop.abort();
    await vi.waitFor(() => expect(mocks.connections[0]!.close).toHaveBeenCalledOnce());
    await expect(outcome).resolves.toBe('rejected');
  });
});
