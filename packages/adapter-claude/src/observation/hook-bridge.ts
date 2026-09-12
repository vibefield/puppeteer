/**
 * Hook bridge — loopback HTTP endpoint receiving Claude Code hook POSTs
 * (DESIGN §16.4/§16.6; transport verified live in Phase 0 run F).
 *
 * Rules enforced here, per §16.6:
 * - binds loopback only, ephemeral port by default
 * - authenticates every request (bearer token, constant-time compare)
 * - limits request body size; applies a hard socket timeout
 * - acknowledges observational events IMMEDIATELY (Claude's hook timeout is
 *   seconds — nothing downstream of the 200 may block the agent)
 * - parses JSON safely; malformed events are logged to the sink, never thrown
 * - rejects hook/status events for sessions this bridge does not own, and
 *   acknowledges without observing the ones the owner asks it to ignore (a
 *   native resume's throwaway boot session); batched OTLP records are
 *   exact-session filtered by the owning driver after decode
 *
 * Payloads carry no timestamps — `receivedAt` is stamped here and is the
 * ingestion clock retained on the adapter candidate upstream.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export interface NativeHookEnvelope {
  requestId: string;
  receivedAt: string;
  body: Record<string, unknown>;
}

export type NativeStatusLineEnvelope = NativeHookEnvelope;
export type NativeSubagentStatusLineEnvelope = NativeHookEnvelope;
export type NativeOtelLogsEnvelope = NativeHookEnvelope;

export type HookBridgeRequestKind = 'hook' | 'statusline' | 'subagent-statusline' | 'otel-logs';

/**
 * The owner's verdict on one request: observe it, refuse it (403), or
 * acknowledge it and drop it (200, no fan-out) when the session is real but not
 * the one being observed.
 */
export type HookBridgeSessionVerdict = boolean | 'ignore';

export interface HookBridgeOptions {
  /** Explicit hook/status session allow-list; events for other sessions get 403. */
  allowSession: (
    sessionId: string,
    kind: HookBridgeRequestKind,
    body: Readonly<Record<string, unknown>>,
  ) => HookBridgeSessionVerdict;
  port?: number | undefined;
  token?: string | undefined;
  maxBodyBytes?: number | undefined;
  /** OTLP batches can be larger than hooks; defaults to 2 MiB. */
  maxOtlpBodyBytes?: number | undefined;
  onProtocolError?:
    ((kind: 'auth' | 'too-large' | 'malformed' | 'unknown-session', detail: string) => void) | undefined;
}

export interface HookBridge {
  readonly token: string;
  /** http://127.0.0.1:<port>/hooks — available after start(). */
  endpoint(): string;
  /** Authenticated status-line telemetry endpoint on the same loopback server. */
  statusLineEndpoint(): string;
  /** Authenticated child-status telemetry endpoint on the same loopback server. */
  subagentStatusLineEndpoint(): string;
  /** Authenticated OTLP/HTTP JSON logs endpoint on the same loopback server. */
  otelLogsEndpoint(): string;
  start(): Promise<void>;
  onEvent(listener: (envelope: NativeHookEnvelope) => void): () => void;
  onStatusLine(listener: (envelope: NativeStatusLineEnvelope) => void): () => void;
  onSubagentStatusLine(listener: (envelope: NativeSubagentStatusLineEnvelope) => void): () => void;
  onOtelLogs(listener: (envelope: NativeOtelLogsEnvelope) => void): () => void;
  /** Unexpected listener/server failure; intentional dispose does not fire it. */
  onUnavailable(listener: (reason: string) => void): () => void;
  dispose(): Promise<void>;
}

const HOST = '127.0.0.1';
const DEFAULT_MAX_BODY = 256 * 1024;
const DEFAULT_MAX_OTLP_BODY = 2 * 1024 * 1024;

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function createHookBridge(options: HookBridgeOptions): HookBridge {
  const token = options.token ?? randomUUID();
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxOtlpBody = options.maxOtlpBodyBytes ?? DEFAULT_MAX_OTLP_BODY;
  const listeners = new Set<(e: NativeHookEnvelope) => void>();
  const statusLineListeners = new Set<(e: NativeStatusLineEnvelope) => void>();
  const subagentStatusLineListeners = new Set<(e: NativeSubagentStatusLineEnvelope) => void>();
  const otelLogsListeners = new Set<(e: NativeOtelLogsEnvelope) => void>();
  const unavailableListeners = new Set<(reason: string) => void>();
  let server: Server | null = null;
  let port = 0;
  let listening = false;
  let intentionalClose = false;
  let unavailableReported = false;
  let unavailableReason: string | undefined;

  function reportUnavailable(reason: string): void {
    if (intentionalClose || unavailableReported) return;
    unavailableReported = true;
    unavailableReason = reason;
    for (const listener of unavailableListeners) {
      try {
        listener(reason);
      } catch {
        // Observation diagnostics cannot destabilize the bridge.
      }
    }
  }

  function reject(
    res: ServerResponse,
    status: number,
    kind: 'auth' | 'too-large' | 'malformed' | 'unknown-session',
    detail: string,
  ): void {
    options.onProtocolError?.(kind, detail);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url?.split('?', 1)[0];
    const requestKind: HookBridgeRequestKind | undefined =
      path === '/v1/logs'
        ? 'otel-logs'
        : path === '/subagent-statusline'
          ? 'subagent-statusline'
          : path === '/statusline'
            ? 'statusline'
            : path === '/hooks'
              ? 'hook'
              : undefined;
    const targetListeners =
      requestKind === 'otel-logs'
        ? otelLogsListeners
        : requestKind === 'subagent-statusline'
          ? subagentStatusLineListeners
          : requestKind === 'statusline'
            ? statusLineListeners
            : requestKind === 'hook'
              ? listeners
              : undefined;
    if (!requestKind || !targetListeners) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      reject(res, 401, 'auth', 'bad or missing bearer token');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    const bodyLimit = requestKind === 'otel-logs' ? maxOtlpBody : maxBody;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimit) {
        overflowed = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('close', () => {
      if (overflowed) options.onProtocolError?.('too-large', `body exceeded ${bodyLimit} bytes`);
    });

    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch (err) {
        reject(res, 400, 'malformed', err instanceof Error ? err.message : String(err));
        return;
      }

      if (requestKind !== 'otel-logs') {
        const sessionId = body.session_id;
        const verdict = typeof sessionId === 'string' ? options.allowSession(sessionId, requestKind, body) : false;
        if (verdict === false) {
          reject(res, 403, 'unknown-session', String(sessionId ?? 'missing session_id'));
          return;
        }
        if (verdict === 'ignore') {
          // Claude delivered a legitimate hook for a session nobody observes;
          // a refusal would only make Claude record a failure against it.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
      }

      // Ack before fan-out: listeners must never hold Claude's hook open.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');

      const envelope: NativeHookEnvelope = {
        requestId: randomUUID(),
        receivedAt: new Date().toISOString(),
        body,
      };
      for (const listener of targetListeners) {
        try {
          listener(envelope);
        } catch {
          // A misbehaving consumer must not affect the agent-facing endpoint.
        }
      }
    });
  }

  return {
    token,
    endpoint: () => `http://${HOST}:${port}/hooks`,
    statusLineEndpoint: () => `http://${HOST}:${port}/statusline`,
    subagentStatusLineEndpoint: () => `http://${HOST}:${port}/subagent-statusline`,
    otelLogsEndpoint: () => `http://${HOST}:${port}/v1/logs`,

    start(): Promise<void> {
      if (server) return Promise.resolve();
      return new Promise((resolve, reject_) => {
        server = createServer(handle);
        server.on('error', (error) => {
          if (!listening) reject_(error);
          else reportUnavailable(error.message);
        });
        server.on('close', () => {
          const wasListening = listening;
          listening = false;
          if (wasListening) reportUnavailable('hook bridge listener closed unexpectedly');
        });
        // Hooks are tiny POSTs; anything lingering is a stuck client.
        server.requestTimeout = 10_000;
        server.listen(options.port ?? 0, HOST, () => {
          const address = server!.address();
          port = typeof address === 'object' && address ? address.port : 0;
          listening = true;
          resolve();
        });
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatusLine(listener) {
      statusLineListeners.add(listener);
      return () => statusLineListeners.delete(listener);
    },
    onSubagentStatusLine(listener) {
      subagentStatusLineListeners.add(listener);
      return () => subagentStatusLineListeners.delete(listener);
    },
    onOtelLogs(listener) {
      otelLogsListeners.add(listener);
      return () => otelLogsListeners.delete(listener);
    },
    onUnavailable(listener) {
      unavailableListeners.add(listener);
      if (unavailableReason) {
        try {
          listener(unavailableReason);
        } catch {
          // Same isolation guarantee as live unavailable fan-out.
        }
      }
      return () => unavailableListeners.delete(listener);
    },

    dispose(): Promise<void> {
      intentionalClose = true;
      listeners.clear();
      statusLineListeners.clear();
      subagentStatusLineListeners.clear();
      otelLogsListeners.clear();
      unavailableListeners.clear();
      const s = server;
      server = null;
      if (!s) return Promise.resolve();
      return new Promise((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    },
  };
}
