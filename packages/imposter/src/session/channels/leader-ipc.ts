/**
 * Grok leader IPC: 4-byte big-endian length-prefixed JSON envelopes carrying
 * JSON-RPC ACP payload strings.
 *
 * This deliberately mirrors the public grok-build protocol instead of using a
 * private newline socket. The relay keeps one controller per materialized
 * session and namespaces viewer request ids exactly as the upstream leader
 * does (`<client-id>|<JSON id>`), so a terminal and ACP controller operate the
 * same Imposter session without either process inventing a second one.
 */

import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { PassThrough, Writable, type Readable } from 'node:stream';

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const CLIENT_PREFIX = 'chopsticks-imposter';

type LeaderRole = 'controller' | 'viewer';

interface WireMessage {
  type?: unknown;
  [key: string]: unknown;
}

interface RelayClient {
  id: number;
  socket: Socket;
  role?: LeaderRole;
  sessionId?: string;
  registered: boolean;
}

export interface LeaderRelay {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface LeaderAcpConnection {
  readonly input: Readable;
  readonly output: Writable;
  close(): void;
}

function frame(message: WireMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_FRAME_BYTES) throw new Error(`leader frame exceeds ${MAX_FRAME_BYTES} bytes`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function writeFrame(socket: Socket, message: WireMessage): void {
  if (!socket.destroyed && socket.writable) socket.write(frame(message));
}

function installFrameReader(
  socket: Socket,
  receive: (message: WireMessage) => void,
  invalid: (message: string) => void,
): void {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        invalid(`leader frame exceeds ${MAX_FRAME_BYTES} bytes`);
        socket.destroy();
        return;
      }
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      try {
        const parsed = JSON.parse(body.toString('utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        receive(parsed as WireMessage);
      } catch (error) {
        invalid(`invalid leader JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

function clientType(role: LeaderRole, sessionId: string): string {
  return `${CLIENT_PREFIX}:${role}:${encodeURIComponent(sessionId)}`;
}

function parseClientType(value: unknown): { role: LeaderRole; sessionId: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = new RegExp(`^${CLIENT_PREFIX}:(controller|viewer):(.+)$`).exec(value);
  if (!match) return undefined;
  try {
    const sessionId = decodeURIComponent(match[2]!);
    if (!sessionId) return undefined;
    return { role: match[1] as LeaderRole, sessionId };
  } catch {
    return undefined;
  }
}

function parseRpc(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'string') return undefined;
  try {
    const value = JSON.parse(payload) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rpcPayload(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function namespacedId(clientId: number, id: unknown): string {
  return `${clientId}|${JSON.stringify(id)}`;
}

function restoreId(value: unknown): { clientId: number; id: unknown } | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.indexOf('|');
  if (separator <= 0) return undefined;
  const clientId = Number(value.slice(0, separator));
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return undefined;
  try {
    return { clientId, id: JSON.parse(value.slice(separator + 1)) as unknown };
  } catch {
    return undefined;
  }
}

/** Start the upstream-shaped leader relay at an already-vetted Unix path. */
export async function listenLeaderRelay(
  socketPath: string,
  version: string,
  log: (message: string) => void = () => {},
): Promise<LeaderRelay> {
  let nextClientId = 1;
  const clients = new Map<number, RelayClient>();

  const controllerFor = (sessionId: string): RelayClient | undefined =>
    [...clients.values()].find(
      (client) => client.registered && client.role === 'controller' && client.sessionId === sessionId,
    );

  const routeAcp = (source: RelayClient, payload: unknown): void => {
    if (typeof payload !== 'string' || source.sessionId === undefined || source.role === undefined) {
      writeFrame(source.socket, { type: 'error', code: -32600, message: 'invalid ACP envelope' });
      return;
    }
    const message = parseRpc(payload);
    if (!message) {
      writeFrame(source.socket, { type: 'error', code: -32700, message: 'invalid ACP JSON' });
      return;
    }

    if (source.role === 'viewer') {
      const controller = controllerFor(source.sessionId);
      if (!controller) {
        if (message.id !== undefined) {
          writeFrame(source.socket, {
            type: 'acp',
            payload: rpcPayload({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32001, message: `no controller owns session ${source.sessionId}` },
            }),
          });
        }
        return;
      }
      if (message.id !== undefined) message.id = namespacedId(source.id, message.id);
      writeFrame(controller.socket, { type: 'acp', payload: rpcPayload(message) });
      return;
    }

    const restored = restoreId(message.id);
    if (restored) {
      const target = clients.get(restored.clientId);
      if (target?.sessionId === source.sessionId && target.role === 'viewer') {
        message.id = restored.id;
        writeFrame(target.socket, { type: 'acp', payload: rpcPayload(message) });
      }
      return;
    }

    // Controller notifications are session-scoped broadcasts. Requests without
    // a namespaced id remain on the controller's direct ACP channel (approvals),
    // so the leader never asks a terminal to decide twice.
    if (message.id === undefined && typeof message.method === 'string') {
      for (const target of clients.values()) {
        if (target.role === 'viewer' && target.sessionId === source.sessionId) {
          writeFrame(target.socket, { type: 'acp', payload });
        }
      }
    }
  };

  const server: Server = createServer((socket) => {
    const client: RelayClient = { id: nextClientId++, socket, registered: false };
    clients.set(client.id, client);
    socket.once('close', () => clients.delete(client.id));
    socket.on('error', (error) => log(`leader client ${client.id} failed: ${error.message}`));
    installFrameReader(
      socket,
      (message) => {
        if (!client.registered) {
          if (message.type !== 'register' || message.mode !== 'stdio') {
            writeFrame(socket, { type: 'error', code: -32600, message: 'register must be the first message' });
            socket.destroy();
            return;
          }
          const identity = parseClientType(message.client_type);
          if (!identity) {
            writeFrame(socket, { type: 'error', code: -32602, message: 'unsupported client_type' });
            socket.destroy();
            return;
          }
          if (identity.role === 'controller' && controllerFor(identity.sessionId)) {
            writeFrame(socket, { type: 'error', code: -32000, message: 'session already has a controller' });
            socket.destroy();
            return;
          }
          client.registered = true;
          client.role = identity.role;
          client.sessionId = identity.sessionId;
          writeFrame(socket, {
            type: 'registered',
            client_id: client.id,
            ready: true,
            leader_protocol_version: 1,
            leader_binary_version: version,
            leader_capabilities: {
              control_v1: false,
              runtime_cpu_profile: false,
              profile_formats: [],
              workspace_exposure: false,
              relaunch_v1: false,
            },
          });
          return;
        }
        if (message.type === 'acp') routeAcp(client, message.payload);
        else if (message.type === 'ping') writeFrame(socket, { type: 'pong' });
        else if (message.type === 'disconnect') socket.end();
      },
      (message) => log(message),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients.values()) client.socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Connect one controller/viewer and expose its framed ACP payloads as NDJSON streams. */
export async function connectLeaderAcp(
  socketPath: string,
  role: LeaderRole,
  sessionId: string,
  version: string,
  log: (message: string) => void = () => {},
): Promise<LeaderAcpConnection> {
  const socket = createConnection(socketPath);
  const input = new PassThrough();
  let registered = false;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  installFrameReader(
    socket,
    (message) => {
      if (message.type === 'registered') {
        registered = true;
        if (!settled) {
          settled = true;
          resolveReady();
        }
      } else if (message.type === 'acp' && typeof message.payload === 'string') {
        input.write(`${message.payload}\n`);
      } else if (message.type === 'error') {
        const error = new Error(`leader refused client: ${String(message.message ?? 'unknown error')}`);
        if (!settled) {
          settled = true;
          rejectReady(error);
        } else log(error.message);
      } else if (message.type === 'shutdown') {
        socket.end();
      }
    },
    log,
  );
  socket.once('connect', () => {
    writeFrame(socket, {
      type: 'register',
      client_type: clientType(role, sessionId),
      mode: 'stdio',
      capabilities: { client_version: version },
    });
  });
  socket.once('error', (error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
  });
  socket.once('close', () => {
    input.end();
    if (!settled) {
      settled = true;
      rejectReady(new Error('leader connection closed during registration'));
    }
  });
  await ready;

  let outputBuffer = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!registered) return callback(new Error('leader client is not registered'));
      outputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let newline: number;
      while ((newline = outputBuffer.indexOf('\n')) >= 0) {
        const payload = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (payload) writeFrame(socket, { type: 'acp', payload });
      }
      callback();
    },
  });

  return {
    input,
    output,
    close() {
      if (socket.destroyed) return;
      writeFrame(socket, { type: 'disconnect' });
      socket.end();
    },
  };
}
