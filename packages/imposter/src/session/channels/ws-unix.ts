/**
 * WebSocket-over-unix-socket transport for the app-server channel
 * (docs/archive/IMPOSTER.md §9.3).
 *
 * Codex frames JSON-RPC as WebSocket on every socket transport; ONLY stdio is
 * NDJSON (CODEX-SURFACE-FINDINGS §8). Since `adapter-codex` runs
 * `codex app-server --listen unix://<sock>` for every real session and talks to
 * it over exactly this, an imposter that spoke stdio alone had a hole where the
 * adapter carries the most weight — and could not stand in for codex inside a
 * pane at all.
 *
 * This is a TRANSPORT, not a second channel: each accepted connection is handed
 * back as an NDJSON `Readable`/`Writable` pair, so `createAppServerChannel`
 * drives a socket client byte-for-byte the way it drives stdio, with one serve
 * table and one op timeline behind both. Framing lives here and nowhere else.
 *
 * Hand-rolled for the same reason the adapter's client half is: node's built-in
 * WebSocket is TCP-only, and a unix socket is the whole point (no port, no
 * network exposure, filesystem-scoped).
 */

import { createHash, randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { rmSync } from 'node:fs';
import { PassThrough, Writable, type Readable } from 'node:stream';

/** RFC 6455 §1.3 — the constant every handshake accept is derived from. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Both halves live here because they are one protocol seen from two ends, and
 * splitting them is how the masking rule gets broken: client frames MUST be
 * masked, server frames MUST NOT be. Keeping the pair adjacent makes that
 * asymmetry legible rather than a bug waiting in one file.
 */

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Matches the adapter's client ceiling, so neither side is the odd one out. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Encode one frame. `mask` is required client→server and forbidden the other way (§5.1). */
function encodeFrame(opcode: number, payload: Buffer, mask = false): Buffer {
  const length = payload.length;
  const flag = mask ? 0x80 : 0;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, flag | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = flag | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = flag | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index]! ^ key[index % 4]!;
  return Buffer.concat([header, key, masked]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Incremental frame decoder.
 *
 * `requireMask` is the direction: a server MUST reject an unmasked client frame
 * (§5.1), and a client receives frames that are never masked. Fragmented data
 * frames are reassembled; control frames interleave and are returned as they
 * arrive.
 */
class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private fragmentOpcode: number | undefined;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  // A plain field, not a constructor parameter property: `ai` runs its own
  // sources under node's type stripping, which erases annotations and cannot
  // synthesize the assignment a parameter property implies.
  private readonly requireMask: boolean;

  constructor(requireMask: boolean) {
    this.requireMask = requireMask;
  }

  feed(chunk: Buffer): DecodedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      if ((first & 0x70) !== 0) throw new Error('unsupported WebSocket extension bits');
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (this.requireMask && !masked) throw new Error('client frame is not masked');

      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) break;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('WebSocket frame is too large');
        length = Number(big);
        offset += 8;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) break;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
      offset += maskBytes;
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        const byte = this.buffer[offset + index]!;
        payload[index] = mask ? byte ^ mask[index % 4]! : byte;
      }
      this.buffer = this.buffer.subarray(offset + length);

      // Control frames are never fragmented and must not disturb a message
      // being reassembled around them.
      if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
        frames.push({ opcode, payload });
        continue;
      }
      if (opcode === OP_CONTINUATION) {
        if (this.fragmentOpcode === undefined) throw new Error('continuation frame with nothing to continue');
        this.fragments.push(payload);
      } else {
        if (this.fragmentOpcode !== undefined) throw new Error('new data frame while a fragmented one is open');
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = 0;
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new Error('WebSocket message is too large');
      if (!fin) continue;
      frames.push({ opcode: this.fragmentOpcode!, payload: Buffer.concat(this.fragments) });
      this.fragmentOpcode = undefined;
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    return frames;
  }
}

/** One connected client, as the NDJSON stream pair the channel expects. */
export interface WebSocketConnection {
  input: Readable;
  output: Writable;
  close(): void;
}

export interface UnixWebSocketServerOptions {
  socketPath: string;
  onConnection(connection: WebSocketConnection): void;
  log?(message: string): void;
}

export interface UnixWebSocketServer {
  socketPath: string;
  close(): Promise<void>;
}

function handshakeResponse(request: string): string | undefined {
  // Header names are case-insensitive on the wire, so match them that way
  // rather than trusting the one spelling the adapter happens to send.
  const key = /\r\nsec-websocket-key:[ \t]*([^\r\n]+)/i.exec(request)?.[1]?.trim();
  if (!key) return undefined;
  if (!/\r\nupgrade:[ \t]*websocket/i.test(request)) return undefined;
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function serveConnection(socket: Socket, options: UnixWebSocketServerOptions): void {
  const log = options.log ?? ((): void => {});
  const decoder = new FrameDecoder(true);
  const input = new PassThrough();
  let upgraded = false;
  let headers = '';
  let closed = false;

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    input.end();
    socket.destroy();
  };

  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      // The channel writes one complete NDJSON line per call; the newline is
      // framing for stdio and has no business inside a WebSocket message.
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (!closed && socket.writable) socket.write(encodeFrame(OP_TEXT, Buffer.from(line, 'utf8')));
      }
      callback();
    },
  });

  socket.on('data', (chunk: Buffer) => {
    if (!upgraded) {
      headers += chunk.toString('binary');
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) {
        // A handshake this large is not a handshake.
        if (headers.length > 16 * 1024) shutdown();
        return;
      }
      const response = handshakeResponse(headers.slice(0, end + 4));
      if (!response) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const remainder = Buffer.from(headers.slice(end + 4), 'binary');
      headers = '';
      upgraded = true;
      socket.write(response);
      options.onConnection({ input, output, close: shutdown });
      if (remainder.length > 0) socket.emit('data', remainder);
      return;
    }

    let frames: DecodedFrame[];
    try {
      frames = decoder.feed(chunk);
    } catch (error) {
      log(`app-server socket framing failed: ${error instanceof Error ? error.message : String(error)}`);
      shutdown();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OP_CLOSE) {
        if (!closed && socket.writable) socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
        shutdown();
        return;
      }
      if (frame.opcode === OP_PING) {
        if (!closed && socket.writable) socket.write(encodeFrame(OP_PONG, frame.payload));
        continue;
      }
      if (frame.opcode !== OP_TEXT && frame.opcode !== OP_BINARY) continue;
      // Back to NDJSON for the channel, which splits on newlines exactly as it
      // does over stdio.
      input.write(`${frame.payload.toString('utf8')}\n`);
    }
  });

  socket.on('error', shutdown);
  socket.on('close', shutdown);
}

/**
 * Connect to an app-server on a unix socket, as the vendor's own TUI does when
 * it is handed `--remote unix://…`.
 *
 * The imposter needs this to ATTACH: a pane running `ai --codex resume <id>
 * --remote …` owns no session of its own, it joins one someone else owns. The
 * client half is written here rather than borrowed from `adapter-codex`,
 * because an imposter importing the adapter it stands in for would make the
 * conformance suite a mirror — both sides would agree by construction, and
 * agreeing is the thing under test.
 */
export async function connectUnixWebSocket(socketPath: string): Promise<WebSocketConnection> {
  const socket = connect(socketPath);
  const decoder = new FrameDecoder(false);
  const input = new PassThrough();
  let closed = false;

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    input.end();
    socket.destroy();
  };

  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (!closed && socket.writable) socket.write(encodeFrame(OP_TEXT, Buffer.from(line, 'utf8'), true));
      }
      callback();
    },
  });

  await new Promise<void>((resolve, reject) => {
    let upgraded = false;
    let headers = Buffer.alloc(0);
    const fail = (error: Error): void => {
      shutdown();
      reject(error);
    };
    socket.once('error', fail);
    socket.on('close', shutdown);
    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        headers = Buffer.concat([headers, chunk]);
        const end = headers.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = headers.subarray(0, headers.indexOf('\r\n')).toString();
        if (!status.includes('101')) return fail(new Error(`app-server refused the upgrade: ${status}`));
        upgraded = true;
        const remainder = headers.subarray(end + 4);
        headers = Buffer.alloc(0);
        socket.off('error', fail);
        socket.on('error', shutdown);
        resolve();
        if (remainder.length > 0) socket.emit('data', remainder);
        return;
      }
      try {
        for (const frame of decoder.feed(chunk)) {
          if (frame.opcode === OP_CLOSE) return shutdown();
          if (frame.opcode === OP_PING) {
            if (socket.writable) socket.write(encodeFrame(OP_PONG, frame.payload, true));
            continue;
          }
          if (frame.opcode !== OP_TEXT && frame.opcode !== OP_BINARY) continue;
          input.write(`${frame.payload.toString('utf8')}\n`);
        }
      } catch {
        shutdown();
      }
    });
  });

  return { input, output, close: shutdown };
}

/**
 * Listen for app-server clients on a unix socket.
 *
 * The socket file is removed on close because the adapter's readiness probe is
 * `existsSync(socketPath)` (ws-transport.ts): a stale file left behind by a
 * dead imposter would report ready and then refuse every connection.
 */
export async function listenUnixWebSocket(options: UnixWebSocketServerOptions): Promise<UnixWebSocketServer> {
  // Tracked so `close()` can end them. `Server.close()` stops accepting and
  // then waits for existing connections, which on a long-lived app-server means
  // waiting forever — the controller and the TUI have no reason to hang up just
  // because the process was asked to stop.
  const live = new Set<Socket>();
  const server: Server = createServer((socket) => {
    live.add(socket);
    socket.once('close', () => live.delete(socket));
    serveConnection(socket, options);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  return {
    socketPath: options.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            rmSync(options.socketPath, { force: true });
          } catch {
            // Losing the race to remove it is not a failure worth reporting.
          }
          resolve();
        });
        for (const socket of live) socket.destroy();
        live.clear();
      }),
  };
}
