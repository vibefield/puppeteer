import { rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createUnixWebSocketTapProxy,
  createWebSocketTapProxy,
  wsOverTcpTransport,
  wsOverUnixTransport,
} from './ws-transport.js';
import { defaultAppServerTransportKind } from './app-server-process.js';

function frame(opcode: number, payload: Buffer, options: { fin?: boolean; masked?: boolean } = {}): Buffer {
  const fin = options.fin ?? true;
  const maskedFrame = options.masked ?? false;
  const mask = Buffer.from([1, 2, 3, 4]);
  if (payload.length >= 126) throw new Error('test frame is too large');
  const first = (fin ? 0x80 : 0) | opcode;
  if (!maskedFrame) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([first, 0x80 | payload.length]), mask, masked]);
}

// Node maps filesystem socket paths to named pipes on Windows, while Codex uses
// loopback WebSocket there. Keep the POSIX-specific checks and exercise the
// endpoint-neutral TCP path on every platform below.
const posix = process.platform !== 'win32';

describe('Codex app-server endpoint selection', () => {
  it('uses UDS on POSIX and loopback WebSocket on Windows', () => {
    expect(defaultAppServerTransportKind('darwin')).toBe('unix');
    expect(defaultAppServerTransportKind('linux')).toBe('unix');
    expect(defaultAppServerTransportKind('win32')).toBe('websocket');
  });
});

describe.skipIf(!posix)('createUnixWebSocketTapProxy', () => {
  it('forwards bytes unchanged while observing a masked TUI thread/resume request', async () => {
    const upstreamPath = join(realpathSync(tmpdir()), `cx-up-${process.pid}.sock`);
    const upstreamBytes: Buffer[] = [];
    const upstream = createServer((socket) => socket.on('data', (chunk) => upstreamBytes.push(chunk)));
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(upstreamPath, resolve);
    });
    const observed: unknown[] = [];
    const tap = createUnixWebSocketTapProxy(upstreamPath, (message) => observed.push(message));
    await tap.ready();
    const client = createConnection(tap.socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const message = JSON.stringify({ method: 'thread/resume', params: { threadId: 'thread-from-picker' } });
    const midpoint = Math.floor(message.length / 2);
    const sent = Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
      frame(0x1, Buffer.from(message.slice(0, midpoint)), { fin: false, masked: true }),
      frame(0x0, Buffer.from(message.slice(midpoint)), { masked: true }),
    ]);
    client.write(sent);

    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));
    await vi.waitFor(() => expect(Buffer.concat(upstreamBytes)).toEqual(sent));

    client.destroy();
    await tap.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(upstreamPath, { force: true });
  });
});

describe('createWebSocketTapProxy over TCP', () => {
  it('forwards bytes unchanged while observing a native resume request', async () => {
    const upstreamBytes: Buffer[] = [];
    const upstream = createServer((socket) => socket.on('data', (chunk) => upstreamBytes.push(chunk)));
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind TCP');
    const observed: unknown[] = [];
    const tap = createWebSocketTapProxy(
      { kind: 'websocket', url: `ws://127.0.0.1:${upstreamAddress.port}` },
      (message) => observed.push(message),
    );
    await tap.ready();
    const tapEndpoint = tap.endpoint();
    expect(tapEndpoint.kind).toBe('websocket');
    if (tapEndpoint.kind !== 'websocket') throw new Error('tap did not bind TCP');
    const tapAddress = new URL(tapEndpoint.url);
    const client = createConnection({ host: tapAddress.hostname, port: Number(tapAddress.port) });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const message = JSON.stringify({ method: 'thread/resume', params: { threadId: 'thread-from-windows-picker' } });
    const sent = Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
      frame(0x1, Buffer.from(message), { masked: true }),
    ]);
    client.write(sent);

    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));
    await vi.waitFor(() => expect(Buffer.concat(upstreamBytes)).toEqual(sent));

    client.destroy();
    await tap.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});

describe.skipIf(!posix)('wsOverUnixTransport', () => {
  it('reassembles fragmented app-server responses before parsing JSON', async () => {
    const socketPath = join(realpathSync(tmpdir()), `cx-fragmented-${process.pid}.sock`);
    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    const midpoint = Math.floor(message.length / 2);
    const server = createServer((socket) => {
      let request = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        request = Buffer.concat([request, chunk]);
        if (!request.includes('\r\n\r\n')) return;
        socket.write(
          Buffer.concat([
            Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
            frame(0x1, Buffer.from(message.slice(0, midpoint)), { fin: false }),
            frame(0x0, Buffer.from(message.slice(midpoint))),
          ]),
        );
        request = Buffer.alloc(0);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    const transport = wsOverUnixTransport(socketPath);
    const observed: unknown[] = [];
    transport.onMessage((value) => observed.push(value));
    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));

    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  });
});

describe('wsOverTcpTransport', () => {
  it('reassembles fragmented app-server responses before parsing JSON', async () => {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { windows: true } });
    const midpoint = Math.floor(message.length / 2);
    const server = createServer((socket) => {
      let request = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        request = Buffer.concat([request, chunk]);
        if (!request.includes('\r\n\r\n')) return;
        socket.write(
          Buffer.concat([
            Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
            frame(0x1, Buffer.from(message.slice(0, midpoint)), { fin: false }),
            frame(0x0, Buffer.from(message.slice(midpoint))),
          ]),
        );
        request = Buffer.alloc(0);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test app-server did not bind TCP');

    const transport = wsOverTcpTransport(`ws://127.0.0.1:${address.port}`);
    const observed: unknown[] = [];
    transport.onMessage((value) => observed.push(value));
    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));

    await transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
