/**
 * Shared HTTP + server-sent-event transport for REST-native personas.
 *
 * This module deliberately knows nothing about OpenCode sessions, messages,
 * permissions, or questions. Persona data supplies native route vocabulary;
 * a store handler supplies semantics. The channel owns only HTTP mechanics:
 * bounded JSON parsing, Basic auth, templated path matching, directory scope,
 * response framing, and exact `data: <json>\n\n` SSE delivery.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpServeDocument, HttpServeRoute } from '../../persona/types.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export interface SseRecord {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface HttpSseRequest {
  route: HttpServeRoute;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  /** Query parameter wins over the equivalent header, matching OpenCode. */
  directory?: string | undefined;
  headers: IncomingMessage['headers'];
}

export type HttpSseHandlerResult =
  { status?: number; body?: unknown; headers?: Record<string, string> } | { stream: true; directory?: string };

export interface HttpSseHub {
  readonly clients: number;
  publish(record: SseRecord, directory?: string): void;
  connect(response: ServerResponse, directory?: string): void;
  close(): void;
}

export interface CreateSseHubOptions {
  connected: () => SseRecord;
  validate?: (record: SseRecord) => string[];
  onPublished?: (record: SseRecord, directory?: string) => void;
}

export class HttpSseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpSseError';
    this.status = status;
  }
}

function writeSse(response: ServerResponse, record: SseRecord): void {
  response.write(`data: ${JSON.stringify(record)}\n\n`);
}

export function createSseHub(options: CreateSseHubOptions): HttpSseHub {
  const clients = new Map<ServerResponse, string | undefined>();

  const checked = (record: SseRecord): void => {
    const violations = options.validate?.(record) ?? [];
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model SSE carrier for ${record.type}: ${violations.join('; ')}`);
    }
  };

  return {
    get clients() {
      return clients.size;
    },
    publish(record, directory) {
      checked(record);
      options.onPublished?.(record, directory);
      for (const [response, selectedDirectory] of clients) {
        if (selectedDirectory !== undefined && directory !== undefined && selectedDirectory !== directory) continue;
        writeSse(response, record);
      }
    },
    connect(response, directory) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      clients.set(response, directory);
      const connected = options.connected();
      checked(connected);
      writeSse(response, connected);
      response.once('close', () => clients.delete(response));
    },
    close() {
      for (const response of clients.keys()) response.end();
      clients.clear();
    },
  };
}

interface CompiledRoute {
  route: HttpServeRoute;
  names: string[];
  pattern: RegExp;
}

function compileRoute(route: HttpServeRoute): CompiledRoute {
  const names: string[] = [];
  const escaped = route.path
    .split('/')
    .map((component) => {
      if (component.startsWith(':')) {
        names.push(component.slice(1));
        return '([^/]+)';
      }
      return component.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, names, pattern: new RegExp(`^${escaped}/?$`) };
}

function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  pathname: string,
):
  | {
      route: HttpServeRoute;
      params: Record<string, string>;
    }
  | undefined {
  for (const candidate of routes) {
    if (candidate.route.method !== method) continue;
    const match = candidate.pattern.exec(pathname);
    if (!match) continue;
    return {
      route: candidate.route,
      params: Object.fromEntries(candidate.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])),
    };
  }
  return undefined;
}

function basicAuthorized(request: IncomingMessage, username: string, password: string | undefined): boolean {
  if (password === undefined || password === '') return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const expected = Buffer.from(`${username}:${password}`);
  const actual = Buffer.from(decoded);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpSseError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpSseError(400, 'request body must be valid JSON');
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    ...headers,
  });
  response.end(encoded);
}

export interface ListenHttpSseOptions {
  document: HttpServeDocument;
  hostname: string;
  port: number;
  username: string;
  password?: string;
  hub: HttpSseHub;
  handle(request: HttpSseRequest): Promise<HttpSseHandlerResult>;
  log?: (message: string) => void;
}

export interface HttpSseServer {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

export async function listenHttpSse(options: ListenHttpSseOptions): Promise<HttpSseServer> {
  const routes = options.document.routes.map(compileRoute);
  const log = options.log ?? (() => {});
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (!basicAuthorized(request, options.username, options.password)) {
        sendJson(
          response,
          401,
          { name: 'UnauthorizedError', data: { message: 'Unauthorized' } },
          {
            'WWW-Authenticate': 'Basic realm="opencode"',
          },
        );
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const matched = matchRoute(routes, (request.method ?? 'GET').toUpperCase(), url.pathname);
      if (!matched) throw new HttpSseError(404, `no route for ${request.method ?? 'GET'} ${url.pathname}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const directory =
        query[options.document.$server.directoryQuery] ??
        headerValue(request, options.document.$server.directoryHeader);
      const body = await readBody(request);
      const result = await options.handle({
        ...matched,
        query,
        ...(body === undefined ? {} : { body }),
        directory,
        headers: request.headers,
      });
      if ('stream' in result) {
        options.hub.connect(response, result.directory);
        return;
      }
      sendJson(response, result.status ?? 200, result.body, result.headers);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpSseError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      log(`HTTP ${status}: ${message}`);
      sendJson(response, status, { name: status === 404 ? 'NotFoundError' : 'Error', data: { message } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once('error', failed);
    server.listen(options.port, options.hostname, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return {
    hostname: address.address,
    port: address.port,
    origin: `http://${hostname}:${address.port}`,
    async close() {
      options.hub.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
