/** Fetch for a private loopback backend whose origin a stopped predecessor may have held. */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * `opencode serve --port 0` prefers port 4096, so a backend started after another one stopped usually reappears at
 * the same origin. Node's fetch pools sockets per origin; after an aborted SSE subscription to the stopped backend,
 * the next request on that pool can fail with ECONNRESET before the new backend ever receives it (reproduced on
 * linux-x64 with OpenCode 1.18.16 and 1.19.5, and only when the origin is reused).
 *
 * A reset does not prove the request never left the client: the backend may have read it and then died, or acted on
 * it before the connection dropped. Re-sending is therefore safe only for idempotent methods, which keep one retry
 * (that covers the SSE subscription). Every other method — prompt_async, POST /session, permission and question
 * replies, abort — never rides a pooled socket: each request opens a connection of its own, so a stale socket left
 * by a predecessor cannot fail it, and any failure on that connection surfaces unretried rather than risk a
 * duplicate turn, an orphan session, or a second answer.
 */
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Statuses whose responses carry no body; `Response` refuses one for them. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function staleSocketFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && STALE_SOCKET_CODES.has(code);
}

function requestMethod(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function responseFrom(incoming: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const status = incoming.statusCode ?? 0;
  const init = { status, statusText: incoming.statusMessage ?? '', headers };
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    incoming.resume();
    return new Response(null, init);
  }
  return new Response(Readable.toWeb(incoming) as unknown as ConstructorParameters<typeof Response>[0], init);
}

/** One request on a connection of its own (`agent: false`), closed after the response and never retried. */
export const freshConnectionFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (body !== undefined) headers['content-length'] = String(body.byteLength);
  const { method, signal } = request;
  signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const options = { method, headers, agent: false as const, signal };
    const onResponse = (incoming: IncomingMessage) => resolve(responseFrom(incoming, method));
    const outgoing =
      url.protocol === 'https:' ? httpsRequest(url, options, onResponse) : httpRequest(url, options, onResponse);
    outgoing.on('error', (error) => {
      reject(signal.aborted ? signal.reason : new TypeError('fetch failed', { cause: error }));
    });
    outgoing.end(body);
  });
};

export interface LoopbackFetchOptions {
  /** Pooled fetch for idempotent requests; Node's fetch by default. */
  pooled?: typeof fetch | undefined;
  /** Per-request connection for every other method; {@link freshConnectionFetch} by default. */
  fresh?: typeof fetch | undefined;
}

export function createLoopbackFetch(options: LoopbackFetchOptions = {}): typeof fetch {
  const pooled = options.pooled ?? ((input, init) => fetch(input, init));
  const fresh = options.fresh ?? freshConnectionFetch;
  return async (input, init) => {
    if (!IDEMPOTENT_METHODS.has(requestMethod(input, init))) return fresh(input, init);
    try {
      return await pooled(input, init);
    } catch (error) {
      if (init?.signal?.aborted || !staleSocketFailure(error)) throw error;
      return pooled(input, init);
    }
  };
}

export const loopbackFetch: typeof fetch = createLoopbackFetch();
