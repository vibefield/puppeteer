/**
 * The imposter's control client (docs/archive/IMPOSTER.md §5): dial the plane's one
 * socket and hold the connection.
 *
 * The direction is inverted from the PoC on purpose. An imposter that dials out
 * serves nothing, needs no port, no state file, and no second bearer token; the
 * plane learns it died the moment the socket closes rather than by failing a
 * poll. Because the connection is held, the plane can push work in — which is
 * what makes `scenario.control` pause/step possible at all.
 *
 * Standalone is a first-class mode (§4.2): every failure here logs and returns
 * `undefined`, and the session runs on exactly as it would in CI.
 */

import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import type { SurfaceBehavior } from '@vibecook/chopsticks-surface';
import { createPeer } from './peer.ts';
import {
  ControlError,
  defaultSocketPath,
  defaultTokenPath,
  INVALID_PARAMS,
  MAX_SOCKET_PATH_BYTES,
  METHOD_NOT_FOUND,
  parseFault,
  parseOpRequest,
  parseScenarioControl,
  parseScenarioRun,
  parseTrigger,
  REFUSED,
  type EmittedEntry,
  type FaultRequest,
  type ScenarioDriverView,
  type OpDescriptor,
  type NativeEventDescriptor,
  type ScenarioControlAction,
  type ScenarioRunProgressView,
  type ScenarioRunRequest,
  type RunflowDescriptor,
} from './protocol.ts';

const DIAL_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 3_000;

export interface ControlClientOptions {
  vendor: string;
  version: string;
  sessionId: string;
  cwd: string;
  nativeBehavior: SurfaceBehavior;
  nativeEvents: NativeEventDescriptor[];
  ops: OpDescriptor[];
  /** Curated persona scenarios. Optional keeps older embedding clients wire-compatible. */
  runflows?: RunflowDescriptor[];
  /** Live channels, re-read per request so a dropped channel is never stale. */
  channels(): string[];
  /** Portable scenario intent, separate from the native Surface graph. */
  scenarioDriver(): ScenarioDriverView;
  emitted(): readonly EmittedEntry[];
  trigger(event: string, payload: Record<string, unknown>, channel?: string): Promise<void>;
  /** Run one semantic op through the timeline — the organic counterpart to `trigger`. */
  runOp(op: string, argument: Record<string, unknown>): Promise<void>;
  runScenario(request: ScenarioRunRequest): Promise<void>;
  scenarioControl(action: ScenarioControlAction): void;
  fault(request: FaultRequest): Promise<void>;
  socketPath?: string;
  tokenPath?: string;
  log?(message: string): void;
}

export interface ImposterControl {
  readonly socketPath: string;
  /** Push one emission. Dropped silently when the socket is backed up. */
  pushEmitted(entry: EmittedEntry): void;
  pushChannels(channels: string[]): void;
  pushScenarioDriver(driver: ScenarioDriverView): void;
  pushScenarioRun(run: ScenarioRunProgressView): void;
  close(reason?: string): Promise<void>;
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    // The listener stays attached past connect so the socket is never without
    // one; it simply stops mattering once `settled` is true.
    socket.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    });
    socket.setTimeout(DIAL_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`connect to ${path} timed out`));
    });
    socket.once('connect', () => {
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

/** Anything the session throws is the imposter declining, not a protocol fault. */
async function refusing<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(REFUSED, error instanceof Error ? error.message : String(error));
  }
}

export async function connectControl(options: ControlClientOptions): Promise<ImposterControl | undefined> {
  const log = options.log ?? (() => {});
  const socketPath = options.socketPath ?? defaultSocketPath();
  const tokenPath = options.tokenPath ?? defaultTokenPath();

  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    log(`control socket path is too long for sun_path (${socketPath}); running standalone`);
    return undefined;
  }

  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
    if (token.length === 0) throw new Error('token file is empty');
  } catch {
    log(`no control token at ${tokenPath}; running standalone`);
    return undefined;
  }

  let socket: Socket;
  try {
    socket = await dial(socketPath);
  } catch (error) {
    log(`no control plane at ${socketPath} (${error instanceof Error ? error.message : String(error)}); standalone`);
    return undefined;
  }

  const handle = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'state':
        return {
          vendor: options.vendor,
          sessionId: options.sessionId,
          pid: process.pid,
          channels: options.channels(),
          scenarioDriver: options.scenarioDriver(),
          emitted: options.emitted().length,
        };
      case 'log':
        return { entries: options.emitted() };
      case 'trigger': {
        const request = parseTrigger(params);
        await refusing(() => options.trigger(request.event, request.with, request.channel));
        return { ok: true };
      }
      case 'op': {
        const request = parseOpRequest(params);
        await refusing(() => options.runOp(request.op, request.with));
        // The reply carries the resulting state so the console can settle
        // without waiting for the push it is also about to receive.
        return { ok: true, scenarioDriver: options.scenarioDriver() };
      }
      case 'scenario.run': {
        const request = parseScenarioRun(params);
        if (request.runflowId) {
          const flow = (options.runflows ?? []).find((candidate) => candidate.id === request.runflowId);
          if (!flow) throw new ControlError(INVALID_PARAMS, `unknown runflow ${request.runflowId}`);
          if (request.name !== flow.scenario) {
            throw new ControlError(INVALID_PARAMS, `runflow ${request.runflowId} must run scenario ${flow.scenario}`);
          }
        }
        await refusing(() => options.runScenario(request));
        return { ok: true };
      }
      case 'scenario.control': {
        const request = parseScenarioControl(params);
        await refusing(() => options.scenarioControl(request.action));
        return { ok: true };
      }
      case 'fault': {
        const request = parseFault(params, options.channels());
        await refusing(() => options.fault(request));
        return { ok: true };
      }
      default:
        throw new ControlError(METHOD_NOT_FOUND, `unknown control method ${method}`);
    }
  };

  const peer = createPeer(socket, {
    handle,
    onClose: (error) => log(`control plane disconnected${error ? `: ${error.message}` : ''}`),
    log,
  });

  try {
    await peer.request(
      'session.hello',
      {
        token,
        vendor: options.vendor,
        version: options.version,
        sessionId: options.sessionId,
        pid: process.pid,
        cwd: options.cwd,
        channels: options.channels(),
        nativeBehavior: options.nativeBehavior,
        nativeEvents: options.nativeEvents,
        ops: options.ops,
        runflows: options.runflows ?? [],
        scenarioDriver: options.scenarioDriver(),
      },
      { timeoutMs: HELLO_TIMEOUT_MS },
    );
  } catch (error) {
    log(`control plane refused the session (${error instanceof Error ? error.message : String(error)}); standalone`);
    peer.close();
    return undefined;
  }
  log(`joined the control plane at ${socketPath}`);

  return {
    socketPath,
    pushEmitted(entry) {
      // A flood is exactly when this matters: drop pushes rather than grow the
      // write buffer without bound. The plane's own log is the backfill.
      if (peer.closed || peer.saturated) return;
      peer.notify('session.emitted', { ...entry });
    },
    pushChannels(channels) {
      peer.notify('session.channels', { channels });
    },
    pushScenarioDriver(driver) {
      // Unlike emissions, a scenario-intent transition is never dropped under
      // saturation: the secondary debug view should not become stale.
      if (peer.closed) return;
      peer.notify('session.scenario-driver', { ...driver });
    },
    pushScenarioRun(run) {
      // Run lifecycle is authoritative control metadata and must survive the
      // same saturation that may intentionally drop high-volume emit pushes.
      if (peer.closed) return;
      peer.notify('session.scenario-run', { ...run });
    },
    async close(reason = 'other') {
      if (peer.closed) return;
      // A request, rather than a notification, lets projection-aware planes
      // reconcile the authoritative rolling log before the socket disappears.
      // Older planes already answer unknown-direction requests through the
      // same handler, so this remains wire-compatible.
      try {
        await peer.request('session.goodbye', { reason }, { timeoutMs: HELLO_TIMEOUT_MS });
      } catch {
        // Socket close remains liveness truth; goodbye is best-effort cleanup.
      }
      peer.close();
    },
  };
}
