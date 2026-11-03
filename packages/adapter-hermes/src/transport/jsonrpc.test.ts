import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createHermesGatewayToken } from './gateway-auth.js';
import { HermesJsonRpcClient } from './jsonrpc.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface RecordedUpgrade {
  url: string | undefined;
  origin: string | undefined;
}

/** One unmasked server→client text frame (RFC 6455), short enough for a 16-bit length. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, 0, 0]);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** A loopback endpoint that records each WebSocket upgrade, then completes it or answers 403. */
async function upgradeRecorder(admit: boolean) {
  const upgrades: RecordedUpgrade[] = [];
  const received: Buffer[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    upgrades.push({ url: request.url, origin: request.headers.origin });
    if (!admit) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key'] ?? ''}${WEBSOCKET_GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api/ws`,
    upgrades,
    received,
    send(text: string): void {
      for (const socket of sockets) socket.write(textFrame(text));
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Hermes gateway JSON-RPC client', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('presents its bearer in the query and sends no Origin', async () => {
    const recorder = await upgradeRecorder(true);
    cleanups.push(() => recorder.close());
    const token = createHermesGatewayToken();
    const client = new HermesJsonRpcClient(recorder.url, { token });
    cleanups.push(() => client.close());

    await client.connect();

    // The gateway host refuses any Origin, so the adapter's own client must never send one.
    expect(recorder.upgrades).toEqual([{ url: `/api/ws?token=${token}`, origin: undefined }]);
  });

  it('names only the bare URL when the gateway refuses it', async () => {
    const recorder = await upgradeRecorder(false);
    cleanups.push(() => recorder.close());
    const token = createHermesGatewayToken();
    const client = new HermesJsonRpcClient(recorder.url, { token });
    cleanups.push(() => client.close());

    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(recorder.upgrades).toHaveLength(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`Hermes gateway connect failed: ${recorder.url}`);
  });

  it('hands a server→client request to observers and never answers it', async () => {
    const recorder = await upgradeRecorder(true);
    cleanups.push(() => recorder.close());
    const client = new HermesJsonRpcClient(recorder.url, { token: createHermesGatewayToken() });
    cleanups.push(() => client.close());
    const frames: unknown[] = [];
    client.onFrame((frame) => frames.push(frame));
    await client.connect();

    // The native TUI answers approvals; the first response settles one, so a reply from Puppeteer
    // (even an error) would decide it in the TUI's place.
    const approval = {
      jsonrpc: '2.0',
      id: 'srq-6e813110524b',
      method: 'approval',
      params: { session_id: 'live-1', request_id: 'approval-1', choices: ['once', 'session', 'always', 'deny'] },
    };
    recorder.send(`${JSON.stringify(approval)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(frames).toEqual([approval]);
    expect(recorder.received).toEqual([]);
  });
});
