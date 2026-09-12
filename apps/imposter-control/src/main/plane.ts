/**
 * The Imposter control plane (docs/archive/IMPOSTER.md §5).
 *
 * One socket, dialed by imposters; one loopback HTTP server, for the browser
 * console. The plane translates between them: browser ⇄ HTTP ⇄ plane ⇄ UDS ⇄
 * imposter.
 *
 * What the inversion deletes, relative to the PoC: the discovery state file,
 * the per-imposter HTTP server, the second bearer token, `prune()`, and the
 * console's 1.5 s poll. Liveness is socket close — instant and correct rather
 * than inferred from a failed round trip — and because the connection is held,
 * the console is fed by push (SSE) instead of polling.
 *
 * This is the sole consumer of the control protocol's server half and is not
 * published API (§7.2).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection, createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { dirname } from 'node:path';
import {
  ControlError,
  createPeer,
  defaultSocketPath,
  defaultTokenPath,
  httpStatusForCode,
  INVALID_REQUEST,
  MAX_SOCKET_PATH_BYTES,
  METHOD_NOT_FOUND,
  NOT_FOUND,
  parseEmitted,
  parseHello,
  parseScenarioDriver,
  parseScenarioRunProgress,
  REFUSED,
  type EmittedEntry,
  type Peer,
  type SessionView,
} from '@vibecook/puppeteer-imposter/control';
import { describeScenarioDriver } from '@vibecook/puppeteer-imposter/scenario-driver';

/** A connection that has not introduced itself by then is not an imposter. */
const HELLO_GRACE_MS = 5_000;
/** A play-mode scenario can legitimately run for a while; everything else is snappy. */
const SCENARIO_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 5_000;
const SSE_KEEPALIVE_MS = 25_000;
/** One trailing authoritative log reconciliation per native burst. */
const PROJECTION_RECONCILE_MS = 150;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A vendor spawn binding supplied by the control center. The plane stays
 * vendor-neutral; wiring lives in the app (docs/archive/EMULATOR.md §6).
 */
export interface EmulatorSpawner {
  vendor: string;
  label: string;
  /** Create one emulated session; resolves once the process is launched. */
  spawn(): Promise<{ sessionId: string }>;
}

/**
 * An optional, downstream view over the native stream.
 *
 * The plane deliberately knows nothing about what a projection means. The
 * normalization devkit uses this seam to consume the exact records Control
 * already exposes, while the native plane remains independently runnable and
 * never imports an adapter or Core reducer.
 */
export interface ControlPlaneProjection {
  /** Stable URL/SSE segment, e.g. `normalization`. */
  readonly id: string;
  join(session: SessionView): void;
  ingest(session: SessionView, entry: EmittedEntry): unknown | undefined | Promise<unknown | undefined>;
  synchronize(session: SessionView, entries: readonly EmittedEntry[]): unknown | Promise<unknown>;
  snapshot(session: SessionView): unknown;
  leave(session: SessionView): void;
}

export interface ControlPlaneOptions {
  socketPath?: string;
  tokenPath?: string;
  /** HTML served at GET / — `{TOKEN}` is replaced with the plane token. */
  uiHtml?: string;
  /** Lazily resolve a bundled renderer asset by its absolute URL path. */
  uiAsset?: (path: string) => { body: string | Uint8Array; contentType: string } | undefined;
  spawners?: EmulatorSpawner[];
  /** Downstream devtools; never part of native Surface truth. */
  projections?: ControlPlaneProjection[];
  log?: (message: string) => void;
}

export interface ControlPlane {
  /** Loopback base URL, valid after start(). */
  readonly url: string;
  /** Authenticated browser URL, valid after start(). Treat it as a secret. */
  readonly consoleUrl: string;
  readonly token: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly sessions: SessionView[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SCENARIO_BODY_BYTES = 16 * 1024 * 1024;

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        settled = true;
        req.off('data', onData);
        req.resume();
        reject(new RequestError(413, `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const body = await readBody(req, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RequestError(400, 'request body must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  // Encode before committing headers. A projection can return arbitrary data;
  // if serialization fails, the route-level error handler must still be able
  // to send a complete JSON error response instead of leaving a 200 hanging.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('value is not JSON-serializable');
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(encoded);
}

function secretsEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && secretsEqual(authorization, `Bearer ${token}`)) return true;
  // EventSource cannot set headers, so the SSE stream and the console page
  // itself carry the token in the query string.
  return secretsEqual(url.searchParams.get('token') ?? undefined, token);
}

// ---------------------------------------------------------------------------
// Plane
// ---------------------------------------------------------------------------

interface JoinedSession {
  view: SessionView;
  peer: Peer;
  projectionTail: Promise<void>;
  projectionClosed: boolean;
  projectedThroughSequence: number;
  projectionSnapshots: Map<string, string>;
  reconcileTimer?: NodeJS.Timeout | undefined;
}

const sessionKey = (vendor: string, sessionId: string): string => `${vendor}\0${sessionId}`;

/** True when something is already accepting connections at this path. */
function planeIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const finish = (live: boolean): void => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createControlPlane(options: ControlPlaneOptions = {}): ControlPlane {
  const log = options.log ?? (() => {});
  const projections = options.projections ?? [];
  const projectionIds = new Set<string>();
  for (const projection of projections) {
    if (!/^[a-z][a-z0-9-]*$/.test(projection.id)) {
      throw new Error(`invalid control-plane projection id ${projection.id}`);
    }
    if (projectionIds.has(projection.id)) throw new Error(`duplicate control-plane projection ${projection.id}`);
    projectionIds.add(projection.id);
  }
  const socketPath = options.socketPath ?? defaultSocketPath();
  const tokenPath = options.tokenPath ?? defaultTokenPath();
  // Two secrets, because they guard different doors: the browser gets one in
  // its URL, imposters read the other from a 0600 file next to the socket.
  const token = randomUUID();
  const socketToken = randomUUID();

  const sessions = new Map<string, JoinedSession>();
  const streams = new Set<ServerResponse>();
  let httpServer: Server | undefined;
  let socketServer: SocketServer | undefined;
  let url = '';
  let keepalive: NodeJS.Timeout | undefined;

  const publishEncoded = (event: string, data: string): void => {
    const frame = `event: ${event}\ndata: ${data}\n\n`;
    for (const stream of streams) {
      if (!stream.writableEnded) stream.write(frame);
    }
  };
  const encodeJson = (value: unknown): string => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('value is not JSON-serializable');
    return encoded;
  };
  const publish = (event: string, data: unknown): void => publishEncoded(event, encodeJson(data));

  const sessionViews = (): SessionView[] => [...sessions.values()].map((session) => session.view);
  const publishSessions = (): void => publish('sessions', { sessions: sessionViews() });

  const projectSync = (projection: ControlPlaneProjection, operation: () => unknown): unknown | undefined => {
    try {
      return operation();
    } catch (error) {
      log(`projection ${projection.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const project = async (
    projection: ControlPlaneProjection,
    operation: () => unknown | Promise<unknown>,
  ): Promise<unknown | undefined> => {
    try {
      return await operation();
    } catch (error) {
      log(`projection ${projection.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const publishProjection = (
    session: JoinedSession,
    projection: ControlPlaneProjection,
    kind: 'snapshot' | 'update',
    value: unknown,
  ): void => {
    if (session.projectionClosed) return;
    try {
      const encoded = encodeJson(value);
      if (kind === 'snapshot' && session.projectionSnapshots.get(projection.id) === encoded) return;
      publishEncoded(
        `projection-${projection.id}`,
        `{"vendor":${encodeJson(session.view.vendor)},"sessionId":${encodeJson(session.view.sessionId)},"${kind}":${encoded}}`,
      );
      if (kind === 'snapshot') session.projectionSnapshots.set(projection.id, encoded);
    } catch (error) {
      log(
        `projection ${projection.id} ${kind} could not be published: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const enqueueProjectionTask = <T>(session: JoinedSession, operation: () => Promise<T> | T): Promise<T> => {
    const task = session.projectionTail
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        if (session.projectionClosed) throw new Error(`session ${session.view.sessionId} has left`);
        return operation();
      });
    session.projectionTail = task.then(
      () => undefined,
      (error) => {
        if (!session.projectionClosed) {
          log(`projection queue failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );
    return task;
  };

  const synchronizeJoined = async (
    session: JoinedSession,
    reason: 'join' | 'gap' | 'quiet' | 'request' | 'goodbye' | 'scenario',
    publishSnapshots: boolean,
  ): Promise<Map<string, unknown>> => {
    const rawLog = await session.peer.request('log', {}, { timeoutMs: SESSION_TIMEOUT_MS });
    if (session.projectionClosed) throw new Error(`session ${session.view.sessionId} left during log synchronization`);
    const entriesValue =
      rawLog !== null && typeof rawLog === 'object' && !Array.isArray(rawLog)
        ? (rawLog as { entries?: unknown }).entries
        : undefined;
    if (!Array.isArray(entriesValue)) throw new Error('imposter log reply has no entries array');
    const entries = entriesValue.map((entry) => parseEmitted(entry));
    session.projectedThroughSequence = Math.max(
      session.projectedThroughSequence,
      ...entries.map((entry) => entry.sequence),
    );

    if (publishSnapshots) {
      try {
        const encodedEntries = encodeJson(entries);
        const cacheKey = '\0native';
        if (session.projectionSnapshots.get(cacheKey) !== encodedEntries) {
          publishEncoded(
            'native-snapshot',
            `{"vendor":${encodeJson(session.view.vendor)},"sessionId":${encodeJson(session.view.sessionId)},"reason":${encodeJson(reason)},"entries":${encodedEntries}}`,
          );
          session.projectionSnapshots.set(cacheKey, encodedEntries);
        }
      } catch (error) {
        log(`native snapshot could not be published: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const snapshots = new Map<string, unknown>();
    for (const projection of projections) {
      if (session.projectionClosed) throw new Error(`session ${session.view.sessionId} left during synchronization`);
      const snapshot = await project(projection, () => projection.synchronize(session.view, entries));
      if (session.projectionClosed) throw new Error(`session ${session.view.sessionId} left during synchronization`);
      if (snapshot === undefined) continue;
      snapshots.set(projection.id, snapshot);
      if (publishSnapshots) publishProjection(session, projection, 'snapshot', snapshot);
    }
    return snapshots;
  };

  const ingestProjected = async (session: JoinedSession, entry: EmittedEntry): Promise<void> => {
    if (entry.sequence > session.projectedThroughSequence + 1) {
      await synchronizeJoined(session, 'gap', true);
    }
    if (session.projectionClosed) return;
    for (const projection of projections) {
      if (session.projectionClosed) return;
      const update = await project(projection, () => projection.ingest(session.view, entry));
      if (session.projectionClosed) return;
      if (update !== undefined) publishProjection(session, projection, 'update', update);
    }
    session.projectedThroughSequence = Math.max(session.projectedThroughSequence, entry.sequence);
  };

  const scheduleReconciliation = (session: JoinedSession): void => {
    if (projections.length === 0 || session.projectionClosed) return;
    if (session.reconcileTimer) clearTimeout(session.reconcileTimer);
    session.reconcileTimer = setTimeout(() => {
      session.reconcileTimer = undefined;
      void enqueueProjectionTask(session, () => synchronizeJoined(session, 'quiet', true)).catch(() => undefined);
    }, PROJECTION_RECONCILE_MS);
    session.reconcileTimer.unref?.();
  };

  // -------------------------------------------------------------------------
  // Socket side: imposters dial in
  // -------------------------------------------------------------------------

  const onConnection = (socket: import('node:net').Socket): void => {
    let key: string | undefined;
    let vendor = '';
    let sessionId = '';

    const peer: Peer = createPeer(socket, {
      handle: async (method, params) => {
        if (method === 'session.hello') {
          if (key) throw new ControlError(INVALID_REQUEST, 'this connection already introduced a session');
          const hello = parseHello(params);
          if (!secretsEqual(hello.token, socketToken)) throw new ControlError(REFUSED, 'unauthorized');
          const candidate = sessionKey(hello.vendor, hello.sessionId);
          if (sessions.has(candidate)) {
            throw new ControlError(REFUSED, `${hello.vendor} session ${hello.sessionId} is already connected`);
          }
          key = candidate;
          vendor = hello.vendor;
          sessionId = hello.sessionId;
          const view: SessionView = {
            vendor: hello.vendor,
            version: hello.version,
            sessionId: hello.sessionId,
            pid: hello.pid,
            cwd: hello.cwd,
            channels: hello.channels,
            nativeBehavior: hello.nativeBehavior,
            nativeEvents: hello.nativeEvents,
            ops: hello.ops,
            runflows: hello.runflows,
            scenarioDriver: hello.scenarioDriver,
            joinedAt: new Date().toISOString(),
          };
          const joined: JoinedSession = {
            peer,
            view,
            projectionTail: Promise.resolve(),
            projectionClosed: false,
            projectedThroughSequence: 0,
            projectionSnapshots: new Map(),
          };
          sessions.set(key, joined);
          for (const projection of projections) projectSync(projection, () => projection.join(view));
          if (projections.length > 0) {
            void enqueueProjectionTask(joined, () => synchronizeJoined(joined, 'join', true)).catch(() => undefined);
          }
          log(`${hello.vendor} session ${hello.sessionId} joined (pid ${hello.pid})`);
          publishSessions();
          return { ok: true };
        }

        const joined = key ? sessions.get(key) : undefined;
        if (!joined) throw new ControlError(INVALID_REQUEST, 'session.hello must come first');

        switch (method) {
          case 'session.emitted': {
            const entry: EmittedEntry = parseEmitted(params);
            publish('emitted', { vendor, sessionId, entry });
            if (projections.length > 0) {
              void enqueueProjectionTask(joined, () => ingestProjected(joined, entry)).catch(() => undefined);
              scheduleReconciliation(joined);
            }
            return { ok: true };
          }
          case 'session.scenario-driver': {
            joined.view.scenarioDriver = parseScenarioDriver(params);
            // Kept separate from native emissions: this is portable authoring
            // intent and must never paint a native event as though it happened.
            publish('scenario-driver', { vendor, sessionId, scenarioDriver: joined.view.scenarioDriver });
            return { ok: true };
          }
          case 'session.scenario-run': {
            joined.view.scenarioRun = parseScenarioRunProgress(params);
            // Like scenario intent, execution status is control metadata. The
            // only records sent to projections remain session.emitted entries.
            publish('scenario-run', { vendor, sessionId, scenarioRun: joined.view.scenarioRun });
            if (
              projections.length > 0 &&
              (joined.view.scenarioRun.status === 'completed' || joined.view.scenarioRun.status === 'failed')
            ) {
              // Emission pushes are intentionally lossy under flood. A run's
              // terminal boundary is the deterministic point to repair the
              // projection from the authoritative rolling log.
              void enqueueProjectionTask(joined, () => synchronizeJoined(joined, 'scenario', true)).catch(
                () => undefined,
              );
            }
            return { ok: true };
          }
          case 'session.channels': {
            const channels = params.channels;
            if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string')) {
              throw new ControlError(INVALID_REQUEST, 'channels must be an array of strings');
            }
            joined.view.channels = channels as string[];
            publishSessions();
            return { ok: true };
          }
          case 'session.goodbye':
            // A graceful client waits for this reply before closing, giving
            // the plane one final authoritative log reconciliation. Socket
            // close remains the source of liveness truth for crashes.
            if (joined.reconcileTimer) clearTimeout(joined.reconcileTimer);
            joined.reconcileTimer = undefined;
            if (projections.length > 0) {
              await enqueueProjectionTask(joined, () => synchronizeJoined(joined, 'goodbye', true));
            }
            log(`${vendor} session ${sessionId} said goodbye`);
            return { ok: true };
          default:
            throw new ControlError(METHOD_NOT_FOUND, `unknown control method ${method}`);
        }
      },
      onClose: () => {
        if (!key) return;
        const joined = sessions.get(key);
        if (joined) {
          joined.projectionClosed = true;
          if (joined.reconcileTimer) clearTimeout(joined.reconcileTimer);
          for (const projection of projections) projectSync(projection, () => projection.leave(joined.view));
        }
        sessions.delete(key);
        log(`${vendor} session ${sessionId} left`);
        publishSessions();
      },
      log,
    });

    const grace = setTimeout(() => {
      if (!key) {
        log('dropping a control connection that never introduced itself');
        peer.close();
      }
    }, HELLO_GRACE_MS);
    grace.unref?.();
  };

  // -------------------------------------------------------------------------
  // HTTP side: the browser console
  // -------------------------------------------------------------------------

  const findSession = (sessionId: string, vendor: string | null): JoinedSession => {
    const matches = [...sessions.values()].filter(
      (session) => session.view.sessionId === sessionId && (vendor === null || session.view.vendor === vendor),
    );
    if (matches.length === 0) throw new RequestError(404, `no imposter connected for session ${sessionId}`);
    if (matches.length > 1) {
      throw new RequestError(409, `session ${sessionId} is ambiguous; supply the vendor query parameter`);
    }
    return matches[0]!;
  };

  const call = async (
    res: ServerResponse,
    sessionId: string,
    vendor: string | null,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    const session = findSession(sessionId, vendor);
    try {
      const result = await session.peer.request(method, params, {
        timeoutMs: method === 'scenario.run' ? SCENARIO_TIMEOUT_MS : SESSION_TIMEOUT_MS,
      });
      sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      const code = error instanceof ControlError ? error.code : 0;
      sendJson(res, code ? httpStatusForCode(code) : 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    streams.add(res);
    req.on('close', () => streams.delete(res));
    res.write(`event: sessions\ndata: ${JSON.stringify({ sessions: sessionViews() })}\n\n`);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = requestUrl.pathname;

    if (!authorized(req, requestUrl, token)) return sendJson(res, 401, { error: 'unauthorized' });

    if (path.startsWith('/assets/')) {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return sendJson(res, 405, { error: 'method must be GET' });
      }
      const asset = options.uiAsset?.(path);
      if (!asset) return sendJson(res, 404, { error: 'not found' });
      res
        .writeHead(200, {
          'content-type': asset.contentType,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end(typeof asset.body === 'string' ? asset.body.replaceAll('{ASSET_TOKEN}', token) : asset.body);
      return;
    }

    if (path === '/' && req.method === 'GET') {
      const html = options.uiHtml ?? '<h1>puppeteer imposter control</h1>';
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        })
        .end(html.replaceAll('{TOKEN}', token));
      return;
    }
    if (path === '/api/events' && req.method === 'GET') return openStream(req, res);
    if (path === '/api/scenario-driver' && req.method === 'GET') {
      // Secondary authoring view, served from the same definition that drives
      // ops. The primary native graph travels with each versioned Surface.
      return sendJson(res, 200, describeScenarioDriver());
    }
    if (path === '/api/spawners' && req.method === 'GET') {
      return sendJson(res, 200, {
        spawners: (options.spawners ?? []).map((spawner) => ({ vendor: spawner.vendor, label: spawner.label })),
      });
    }
    if (path === '/api/spawn' && req.method === 'POST') {
      const body = await readJson(req);
      const spawner = (options.spawners ?? []).find((candidate) => candidate.vendor === body.vendor);
      if (!spawner) return sendJson(res, 404, { error: `no spawner for vendor ${String(body.vendor)}` });
      try {
        return sendJson(res, 200, await spawner.spawn());
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: sessionViews() });
    }

    const projectionPath = /^\/api\/sessions\/([^/]+)\/projections\/([^/]+)$/.exec(path);
    if (projectionPath) {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return sendJson(res, 405, { error: 'method must be GET' });
      }
      const [, encodedSessionId, projectionId] = projectionPath;
      const projection = projections.find((candidate) => candidate.id === projectionId);
      if (!projection) return sendJson(res, 404, { error: `no projection ${String(projectionId)}` });
      const session = findSession(decodeURIComponent(encodedSessionId!), requestUrl.searchParams.get('vendor'));
      try {
        const snapshots = await enqueueProjectionTask(session, () => synchronizeJoined(session, 'request', false));
        const snapshot = snapshots.get(projection.id);
        if (snapshot === undefined) throw new Error(`projection ${projection.id} could not synchronize`);
        return sendJson(res, 200, snapshot);
      } catch (error) {
        return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const action = /^\/api\/sessions\/([^/]+)\/(trigger|op|scenario|scenario-control|fault|log)$/.exec(path);
    if (action) {
      const [, encodedSessionId, name] = action;
      const expectedMethod = name === 'log' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) {
        res.setHeader('allow', expectedMethod);
        return sendJson(res, 405, { error: `method must be ${expectedMethod}` });
      }
      const method = {
        trigger: 'trigger',
        op: 'op',
        scenario: 'scenario.run',
        'scenario-control': 'scenario.control',
        fault: 'fault',
        log: 'log',
      }[name!]!;
      return call(
        res,
        decodeURIComponent(encodedSessionId!),
        requestUrl.searchParams.get('vendor'),
        method,
        req.method === 'POST'
          ? await readJson(req, name === 'scenario' ? MAX_SCENARIO_BODY_BYTES : MAX_BODY_BYTES)
          : {},
      );
    }
    sendJson(res, 404, { error: 'not found' });
  };

  const fail = (res: ServerResponse, error: unknown): void => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof RequestError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof ControlError) return sendJson(res, httpStatusForCode(error.code), { error: error.message });
    sendJson(res, 500, { error: 'internal server error' });
  };

  return {
    get url() {
      return url;
    },
    get consoleUrl() {
      return url ? `${url}/?token=${encodeURIComponent(token)}` : '';
    },
    get sessions() {
      return sessionViews();
    },
    token,
    socketPath,
    tokenPath,

    async start() {
      if (httpServer) throw new Error('control plane is already started');
      if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
        throw new Error(`control socket path is too long for sun_path: ${socketPath}`);
      }
      // A socket file outlives an ungraceful exit, so "does the path exist" is
      // not ownership — only "does something answer on it" is.
      if (await planeIsLive(socketPath)) throw new Error(`another imposter control plane owns ${socketPath}`);
      if (process.platform !== 'win32') {
        mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
        rmSync(socketPath, { force: true });
      }
      mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });

      socketServer = createSocketServer(onConnection);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        socketServer!.once('error', onError);
        socketServer!.listen(socketPath, () => {
          socketServer!.off('error', onError);
          resolve();
        });
      });

      httpServer = createHttpServer((req, res) => {
        void handle(req, res).catch((error) => fail(res, error));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer!.once('error', onError);
        httpServer!.listen(0, '127.0.0.1', () => {
          httpServer!.off('error', onError);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address !== 'object') throw new Error('control plane failed to bind');
      url = `http://127.0.0.1:${address.port}`;

      writeFileSync(tokenPath, socketToken, { mode: 0o600 });

      keepalive = setInterval(() => publish('ping', {}), SSE_KEEPALIVE_MS);
      keepalive.unref?.();
      log(`control plane listening on ${socketPath}, console at ${url}`);
    },

    async stop() {
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      for (const stream of streams) stream.end();
      streams.clear();
      // Clear ownership first: peer.close() can synchronously reach onClose,
      // and a projection must observe exactly one leave per joined session.
      const joinedSessions = [...sessions.values()];
      sessions.clear();
      for (const session of joinedSessions) {
        session.projectionClosed = true;
        if (session.reconcileTimer) clearTimeout(session.reconcileTimer);
        for (const projection of projections) projectSync(projection, () => projection.leave(session.view));
        session.peer.close();
      }
      rmSync(tokenPath, { force: true });
      await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
      await new Promise<void>((resolve) => (socketServer ? socketServer.close(() => resolve()) : resolve()));
      if (process.platform !== 'win32') rmSync(socketPath, { force: true });
      httpServer = undefined;
      socketServer = undefined;
      url = '';
    },
  };
}
