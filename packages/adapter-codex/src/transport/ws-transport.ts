/**
 * Local WebSocket transport for the Codex app-server (M5 C6).
 *
 * The app-server's socket transports (unix AND tcp) frame JSON-RPC as
 * WebSocket; only stdio:// is NDJSON (CODEX-SURFACE-FINDINGS §8). For the
 * desktop host we run one private app-server and connect a controller over it.
 * POSIX uses a Unix socket (no port, filesystem-scoped); Windows uses an
 * ephemeral loopback WebSocket because Codex does not expose a named-pipe
 * listener. The same small RFC-6455 client handles both byte transports and is
 * exposed as a `Transport`, so `createCodexSession` stays endpoint-agnostic.
 *
 * Localhost/UDS needs no auth token (the bearer is for remote/pairing).
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from './app-server-client.js';

// ─── RFC 6455 framing ──────────────────────────────────────────────────────

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CONTINUATION = 0x0;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Encode a client frame (client → server frames MUST be masked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Incremental RFC-6455 decoder. Data frames are returned as complete logical
 * messages: fragmented text/binary frames are buffered across continuation
 * frames, while interleaved control frames are delivered immediately.
 */
class FrameDecoder {
  private buf = Buffer.alloc(0);
  private fragmentedOpcode: number | undefined;
  private fragmentedPayloads: Buffer[] = [];
  private fragmentedBytes = 0;

  feed(chunk: Buffer): DecodedFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const first = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) throw new Error('unsupported WebSocket extension bits');
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const wideLength = this.buf.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_MESSAGE_BYTES)) throw new Error('WebSocket frame exceeds message limit');
        len = Number(wideLength);
        off = 10;
      }
      if (len > MAX_MESSAGE_BYTES) throw new Error('WebSocket frame exceeds message limit');
      if (opcode >= OP_CLOSE && (!fin || len > 125)) throw new Error('invalid fragmented WebSocket control frame');
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buf.length < off + 4) break;
        maskKey = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) {
        const u = Buffer.alloc(len);
        for (let i = 0; i < len; i++) u[i] = payload[i]! ^ maskKey[i % 4]!;
        payload = u;
      }
      this.buf = this.buf.subarray(off + len);

      if (opcode >= OP_CLOSE) {
        if (opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
          throw new Error(`unsupported WebSocket control opcode ${opcode}`);
        }
        frames.push({ opcode, payload });
        continue;
      }
      if (opcode === OP_CONTINUATION) {
        if (this.fragmentedOpcode === undefined) throw new Error('unexpected WebSocket continuation frame');
        this.fragmentedPayloads.push(payload);
        this.fragmentedBytes += payload.length;
        if (this.fragmentedBytes > MAX_MESSAGE_BYTES) throw new Error('WebSocket message exceeds message limit');
        if (fin) {
          frames.push({ opcode: this.fragmentedOpcode, payload: Buffer.concat(this.fragmentedPayloads) });
          this.fragmentedOpcode = undefined;
          this.fragmentedPayloads = [];
          this.fragmentedBytes = 0;
        }
        continue;
      }
      if (opcode !== OP_TEXT && opcode !== OP_BINARY) throw new Error(`unsupported WebSocket opcode ${opcode}`);
      if (this.fragmentedOpcode !== undefined) throw new Error('new WebSocket data frame during fragmented message');
      if (fin) {
        frames.push({ opcode, payload });
      } else {
        this.fragmentedOpcode = opcode;
        this.fragmentedPayloads = [payload];
        this.fragmentedBytes = payload.length;
      }
    }
    return frames;
  }
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface WsUnixTransportOptions {
  /** Host header value for the upgrade request (cosmetic for UDS). */
  host?: string;
}

interface RawWebSocketTransportOptions {
  host: string;
  requestTarget?: string;
}

/**
 * Connect to a listening `codex app-server` over a unix socket and expose it as
 * a `Transport`. Messages are delivered/sent as already-parsed JSON objects
 * (same contract as the stdio transport). Sends before the handshake completes
 * are queued and flushed on open.
 */
export function wsOverUnixTransport(socketPath: string, opts: WsUnixTransportOptions = {}): Transport {
  return websocketTransport(net.connect(socketPath), { host: opts.host ?? 'localhost' });
}

/** Connect to a TCP WebSocket endpoint exposed by a loopback app-server. */
export function wsOverTcpTransport(remoteAddress: string): Transport {
  const endpoint = new URL(remoteAddress);
  if (endpoint.protocol !== 'ws:') throw new Error(`expected a ws:// app-server endpoint, got ${remoteAddress}`);
  if (endpoint.username || endpoint.password)
    throw new Error('app-server WebSocket endpoint must not contain credentials');
  const port = endpoint.port ? Number(endpoint.port) : 80;
  const hostname = endpoint.hostname.startsWith('[') ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
  return websocketTransport(net.connect({ host: hostname, port }), {
    host: endpoint.host,
    requestTarget: `${endpoint.pathname}${endpoint.search}`,
  });
}

function websocketTransport(sock: net.Socket, opts: RawWebSocketTransportOptions): Transport {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let closedEmitted = false;

  const decoder = new FrameDecoder();
  let handshakeDone = false;
  let headerBuf = Buffer.alloc(0);
  let open = false;
  const sendQueue: string[] = [];

  sock.setNoDelay(true);

  const emitClose = (info: { code: number | null; signal: string | null }): void => {
    if (closedEmitted) return;
    closedEmitted = true;
    onCls?.(info);
  };

  const deliverText = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    onMsg?.(parsed);
  };

  const handleFrames = (chunk: Buffer): void => {
    try {
      for (const f of decoder.feed(chunk)) {
        if (f.opcode === OP_TEXT || f.opcode === OP_BINARY) deliverText(f.payload.toString('utf8'));
        else if (f.opcode === OP_PING) sock.write(encodeFrame(OP_PONG, f.payload));
        else if (f.opcode === OP_CLOSE) sock.destroy();
      }
    } catch (error) {
      sock.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  };

  sock.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write(
      `GET ${opts.requestTarget ?? '/'} HTTP/1.1\r\n` +
        `Host: ${opts.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

  sock.on('data', (chunk) => {
    if (!handshakeDone) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = headerBuf.subarray(0, headerBuf.indexOf('\r\n')).toString();
      if (!statusLine.includes('101')) {
        sock.destroy(new Error(`app-server WS handshake failed: ${statusLine}`));
        return;
      }
      handshakeDone = true;
      open = true;
      const rest = headerBuf.subarray(idx + 4);
      headerBuf = Buffer.alloc(0);
      for (const q of sendQueue) sock.write(encodeFrame(OP_TEXT, Buffer.from(q, 'utf8')));
      sendQueue.length = 0;
      if (rest.length) handleFrames(rest);
      return;
    }
    handleFrames(chunk);
  });

  sock.on('close', () => emitClose({ code: null, signal: null }));
  sock.on('error', () => emitClose({ code: null, signal: null }));

  return {
    send: (message) => {
      const s = JSON.stringify(message);
      if (open) sock.write(encodeFrame(OP_TEXT, Buffer.from(s, 'utf8')));
      else sendQueue.push(s);
    },
    onMessage: (h) => {
      onMsg = h;
    },
    onClose: (h) => {
      onCls = h;
    },
    close: () => {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

export type AppServerEndpoint =
  { readonly kind: 'unix'; readonly path: string } | { readonly kind: 'websocket'; readonly url: string };

export function appServerRemoteAddress(endpoint: AppServerEndpoint): string {
  return endpoint.kind === 'unix' ? `unix://${endpoint.path}` : endpoint.url;
}

export function connectAppServerEndpoint(endpoint: AppServerEndpoint): Transport {
  return endpoint.kind === 'unix' ? wsOverUnixTransport(endpoint.path) : wsOverTcpTransport(endpoint.url);
}

function connectEndpoint(endpoint: AppServerEndpoint): net.Socket {
  if (endpoint.kind === 'unix') return net.connect(endpoint.path);
  const parsed = new URL(endpoint.url);
  if (parsed.protocol !== 'ws:' || !parsed.port)
    throw new Error(`invalid app-server WebSocket endpoint: ${endpoint.url}`);
  const hostname = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return net.connect({ host: hostname, port: Number(parsed.port) });
}

export interface WebSocketTapProxy {
  /** Available after `ready()`; the native TUI connects to this endpoint. */
  endpoint(): AppServerEndpoint;
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

let tapCounter = 0;

/**
 * Transparent local proxy for a native Codex TUI connection. Bytes remain
 * untouched; client WebSocket text frames are decoded only to discover which
 * thread a native resume picker selected. The proxy mirrors the upstream
 * endpoint kind, so the picker works over both POSIX UDS and Windows loopback.
 */
export function createWebSocketTapProxy(
  upstreamEndpoint: AppServerEndpoint,
  onClientMessage: (message: unknown) => void,
): WebSocketTapProxy {
  const socketPath =
    upstreamEndpoint.kind === 'unix'
      ? join(realpathSync(tmpdir()), `cx-tap-${process.pid}-${tapCounter++}.sock`)
      : undefined;
  let localEndpoint: AppServerEndpoint | undefined = socketPath ? { kind: 'unix', path: socketPath } : undefined;
  let disposal: Promise<void> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  let readySucceeded = false;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void readyPromise.catch(() => undefined);
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const server = net.createServer((downstream) => {
    const upstream = connectEndpoint(upstreamEndpoint);
    track(downstream);
    track(upstream);
    let decoder = new FrameDecoder();
    let upgraded = false;
    let requestHeaders = Buffer.alloc(0);

    upstream.on('data', (chunk) => downstream.write(chunk));
    downstream.on('data', (chunk) => {
      upstream.write(chunk);
      let framed = chunk;
      if (!upgraded) {
        requestHeaders = Buffer.concat([requestHeaders, chunk]);
        const end = requestHeaders.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        framed = requestHeaders.subarray(end + 4);
        requestHeaders = Buffer.alloc(0);
      }
      try {
        for (const frame of decoder.feed(framed)) {
          if (frame.opcode !== OP_TEXT && frame.opcode !== OP_BINARY) continue;
          try {
            onClientMessage(JSON.parse(frame.payload.toString('utf8')));
          } catch {
            // Non-JSON frames remain transparently forwarded.
          }
        }
      } catch {
        // Observation must never disturb the transparent byte stream. Reset
        // after malformed/unsupported framing and keep forwarding untouched.
        decoder = new FrameDecoder();
      }
    });
    const close = (): void => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on('close', () => upstream.destroy());
    downstream.on('error', close);
    upstream.on('close', () => downstream.destroy());
    upstream.on('error', close);
  });
  server.on('error', (error) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  });
  const listening = (): void => {
    if (!localEndpoint) {
      const address = server.address();
      if (!address || typeof address === 'string') {
        readySettled = true;
        rejectReady(new Error('Codex WebSocket tap did not bind a TCP port'));
        return;
      }
      localEndpoint = { kind: 'websocket', url: `ws://127.0.0.1:${address.port}` };
    }
    readySucceeded = true;
    readySettled = true;
    resolveReady();
  };
  if (socketPath) server.listen(socketPath, listening);
  else server.listen(0, '127.0.0.1', listening);

  return {
    endpoint() {
      if (!localEndpoint || !readySucceeded) throw new Error('Codex WebSocket tap endpoint requested before ready');
      return localEndpoint;
    },
    ready: () => readyPromise,
    dispose() {
      if (disposal) return disposal;
      for (const socket of sockets) socket.destroy();
      disposal = new Promise<void>((resolve) => {
        const finish = (): void => {
          if (socketPath) rmSync(socketPath, { force: true });
          resolve();
        };
        if (!server.listening) finish();
        else server.close(finish);
      });
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('Codex WebSocket tap disposed before ready'));
      }
      return disposal;
    },
  };
}

/** @deprecated Prefer the endpoint-neutral `createWebSocketTapProxy`. */
export interface UnixWebSocketTapProxy {
  readonly socketPath: string;
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

/** @deprecated Prefer the endpoint-neutral `createWebSocketTapProxy`. */
export function createUnixWebSocketTapProxy(
  upstreamPath: string,
  onClientMessage: (message: unknown) => void,
): UnixWebSocketTapProxy {
  const proxy = createWebSocketTapProxy({ kind: 'unix', path: upstreamPath }, onClientMessage);
  return {
    get socketPath() {
      const endpoint = proxy.endpoint();
      if (endpoint.kind !== 'unix') throw new Error('Codex Unix tap unexpectedly selected a TCP endpoint');
      return endpoint.path;
    },
    ready: () => proxy.ready(),
    dispose: () => proxy.dispose(),
  };
}
