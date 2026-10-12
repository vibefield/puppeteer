import { createServer, type Server, type Socket } from 'node:net';
import {
  MAX_REQUEST_BYTES,
  declineSpawnThrough,
  parseSpawnThroughRequest,
  type SpawnThroughDeclineCode,
  type SpawnThroughRequest,
  type SpawnThroughResponse,
} from './protocol.js';

export interface SpawnThroughGatewayOptions {
  /** The bearer every request must carry; the host publishes it only in the rendezvous. */
  token: string;
  /** Answers one authenticated, parsed request. A throw is answered as the gateway's own failure. */
  handle(request: SpawnThroughRequest): Promise<SpawnThroughResponse>;
  /**
   * Answer the gateway's own failures (a bad bearer, an oversize or unreadable
   * request, a throwing handler) with `refuse` rather than `fallback`. Such a
   * refusal is UNPLACED — the gateway cannot place a request it could not read
   * or trust — so the shim obeys it only in one of the host's own terminals,
   * by its own ancestry; anywhere else the agent runs as typed. Default false.
   */
  strict?: boolean | undefined;
}

export interface SpawnThroughGateway {
  /** The loopback port the gateway listens on (127.0.0.1, chosen by the OS). */
  port: number;
  close(): Promise<void>;
}

const SOCKET_TIMEOUT_MS = 30_000;

function writeResponse(socket: Socket, response: SpawnThroughResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

/** One loopback listener: one JSON line in, one JSON line out, per connection. */
export async function startSpawnThroughGateway(options: SpawnThroughGatewayOptions): Promise<SpawnThroughGateway> {
  const { token, handle } = options;
  const declined = (code: SpawnThroughDeclineCode, reason: string): SpawnThroughResponse =>
    declineSpawnThrough({ code, reason }, options.strict === true ? { placed: false } : undefined);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A shim can die between its request and our answer (a person's ^C during
    // a slow preparation). The reset reaches this socket as an 'error', and an
    // unheard socket error is thrown into the host's process.
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, declined('request-too-large', 'spawn-through request is too large'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request: SpawnThroughRequest | undefined;
      try {
        request = parseSpawnThroughRequest(JSON.parse(input.slice(0, newline)));
      } catch {
        request = undefined;
      }
      // A line that is not JSON, a malformed request and a wrong bearer get one
      // answer: the gateway tells an unauthenticated caller nothing about its shape.
      if (!request || request.token !== token) {
        writeResponse(socket, declined('unauthenticated', 'spawn-through authentication failed'));
        return;
      }
      const authenticated = request;
      void (async () => {
        try {
          writeResponse(socket, await handle(authenticated));
        } catch (error) {
          writeResponse(socket, declined('handler-failed', error instanceof Error ? error.message : String(error)));
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('spawn-through gateway did not bind a TCP port');
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          for (const socket of sockets) socket.destroy();
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        // `server.close` stops accepting but waits for existing sockets. A
        // half-written authenticated request must not hold the host's quit
        // for its 30-second read timeout.
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
