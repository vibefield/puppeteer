/**
 * Shared HTTP + server-sent-event transport for REST-native personas.
 *
 * This module deliberately knows nothing about OpenCode sessions, messages,
 * permissions, or questions. Persona data supplies native route vocabulary,
 * the SSE envelope, and the auth challenge; a store handler supplies
 * semantics. The channel owns only HTTP mechanics: bounded JSON parsing, Basic
 * auth, templated path matching, directory scope, response framing, and exact
 * `data: <json>\n\n` SSE delivery.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpServeDocument, HttpServeEnvelope, HttpServeRoute } from '../../persona/types.ts';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * One complete SSE carrier as the vendor frames it. Only `id` and `type` are
 * envelope-independent; the payload sits under the persona's envelope key.
 */
export interface SseRecord {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** The per-aggregate cursor a durable frame carries. */
export interface SseDurable {
  aggregateID: string;
  seq: number;
  version: number;
}

/** A native event without its carrier: what stores and blockers reason about. */
export interface SseEvent {
  type: string;
  payload: Record<string, unknown>;
  /** Present only when the envelope declares `durable` and the frame carries a well-formed cursor. */
  durable?: SseDurable;
}

/** What the store knows about a frame's scope; the envelope decides which of it reaches the wire. */
export interface SseScope {
  directory?: string | undefined;
  aggregateID?: string | undefined;
  /** Assigned by the store, which owns the per-aggregate counter. */
  seq?: number | undefined;
}

export interface SseEnvelopeCodec {
  readonly spec: HttpServeEnvelope;
  /** Frame a payload; key order is id, clock, type, location, payload, durable. */
  wrap(type: string, payload: Record<string, unknown>, scope?: SseScope): SseRecord;
  /** The stream-opening frame, which carries no clock, location, or cursor. */
  connected(): SseRecord;
  /** Whether frames of this type carry a durable cursor, so the store must assign a `seq`. */
  isDurable(type: string): boolean;
  /**
   * The payload of a carrier, or `undefined` when it is not an object. An
   * encoded JSON string is decoded only when the envelope declares `encodedPayload`.
   */
  payloadOf(record: Record<string, unknown>): Record<string, unknown> | undefined;
  /**
   * Narrow a parsed event-stream frame to a carrier with an object payload.
   * Frames without an `id` are refused: every event-stream frame carries one
   * on both lines (2.x's id-less `log.synced` belongs to the separate session
   * log stream, which has no payload key at all).
   */
  read(value: unknown): SseEvent | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function eventId(): string {
  return `evt_${crypto.randomUUID().replaceAll('-', '')}`;
}

function durableOf(value: unknown): SseDurable | undefined {
  if (!isObject(value)) return undefined;
  const { aggregateID, seq, version } = value;
  if (typeof aggregateID !== 'string' || !Number.isInteger(seq) || !Number.isInteger(version)) return undefined;
  return { aggregateID, seq: seq as number, version: version as number };
}

export function createSseEnvelope(spec: HttpServeEnvelope): SseEnvelopeCodec {
  const durableTypes = new Set(spec.durable?.types ?? []);
  const locationless = new Set(spec.location?.omitTypes ?? []);
  const payloadOf = (record: Record<string, unknown>): Record<string, unknown> | undefined => {
    const raw = record[spec.payloadKey];
    if (isObject(raw)) return raw;
    if (spec.encodedPayload !== true || typeof raw !== 'string') return undefined;
    try {
      const decoded = JSON.parse(raw) as unknown;
      return isObject(decoded) ? decoded : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    spec,
    wrap(type, payload, scope = {}) {
      const location =
        spec.location !== undefined && scope.directory !== undefined && !locationless.has(type)
          ? { [spec.location.key]: { directory: scope.directory } }
          : {};
      const durable =
        spec.durable !== undefined &&
        durableTypes.has(type) &&
        scope.aggregateID !== undefined &&
        scope.seq !== undefined
          ? { [spec.durable.key]: { aggregateID: scope.aggregateID, seq: scope.seq, version: spec.durable.version } }
          : {};
      return {
        id: eventId(),
        ...(spec.clockKey === undefined ? {} : { [spec.clockKey]: Date.now() }),
        type,
        ...location,
        [spec.payloadKey]: payload,
        ...durable,
      };
    },
    connected() {
      return { id: eventId(), type: spec.connectedType, [spec.payloadKey]: {} };
    },
    isDurable: (type) => durableTypes.has(type),
    payloadOf,
    read(value) {
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return undefined;
      const payload = payloadOf(value);
      if (payload === undefined) return undefined;
      const durable = spec.durable === undefined ? undefined : durableOf(value[spec.durable.key]);
      return durable === undefined ? { type: value.type, payload } : { type: value.type, payload, durable };
    },
  };
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
        const auth = options.document.$server.auth;
        sendJson(response, 401, auth.unauthorizedBody, { 'WWW-Authenticate': `Basic realm="${auth.realm}"` });
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
