// The perf harness's imposter control plane: the server half of the imposter's control channel
// (packages/imposter/src/control — newline-delimited JSON-RPC 2.0 over one Unix socket), cut down
// to what a load driver needs. Each imposter dials in and says `session.hello` with the token from
// its token file; the plane then pushes `op` requests at it (`turn.start`, `tool.start`, …), which
// the imposter turns into the same native hooks a real agent sends, so Godview's runtime sees real
// agents change state. Notifications from the imposter (its emitted log) are ignored.
//
// apps/imposter-control's plane is the full console server; it is TypeScript inside an Electron
// app, so the harness speaks the small protocol itself rather than importing it.

import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

/** `sun_path` is ~103 bytes on macOS; the imposter refuses anything longer and runs standalone. */
const MAX_SOCKET_PATH_BYTES = 100;

export async function startControlPlane({ socketPath, tokenPath, log = () => {} }) {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`socket path too long: ${socketPath}`);
  const token = randomBytes(24).toString('hex');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  rmSync(socketPath, { force: true });
  const sessions = new Map();
  const joined = new Set();
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    let session;
    const send = (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (method, params, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    const onMessage = (message) => {
      if (message.method === undefined) {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message ?? 'control error'));
        else waiting.resolve(message.result);
        return;
      }
      if (message.id === undefined) return; // a notification: the imposter's emitted log
      if (message.method === 'session.hello') {
        if (message.params?.token !== token) {
          send({ id: message.id, error: { code: -32000, message: 'bad token' } });
          socket.end();
          return;
        }
        session = {
          sessionId: String(message.params.sessionId),
          pid: message.params.pid,
          cwd: message.params.cwd,
          vendor: message.params.vendor,
          ops: (message.params.ops ?? []).map((op) => op.op),
          op: (op, args = {}) => request('op', { op, with: args }),
        };
        sessions.set(session.sessionId, session);
        send({ id: message.id, result: { ok: true } });
        for (const listener of joined) listener(session);
        log(`imposter ${session.vendor} ${session.sessionId} joined (pid ${session.pid})`);
        return;
      }
      if (message.method === 'session.goodbye') {
        send({ id: message.id, result: { ok: true } });
        return;
      }
      send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          log(`bad control line: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('imposter disconnected'));
      }
      pending.clear();
      if (session) sessions.delete(session.sessionId);
    });
    socket.on('error', () => undefined);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    token,
    sessions,
    onJoin: (listener) => {
      joined.add(listener);
      return () => joined.delete(listener);
    },
    close: () =>
      new Promise((resolve) => {
        // The imposters hold their connections open; the server closes only once they are gone.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        rmSync(socketPath, { force: true });
      }),
  };
}
