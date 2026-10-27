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

/** A loopback endpoint that records each WebSocket upgrade, then completes it or answers 403. */
async function upgradeRecorder(admit: boolean) {
  const upgrades: RecordedUpgrade[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
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
});
