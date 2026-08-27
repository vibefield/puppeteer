import { createServer, type Server, type Socket } from 'node:net';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  AgentNativeInvocationIntentSchema,
  type AgentLaunchProvider,
  type AgentNativeInvocationIntent,
} from '@vibecook/puppeteer-core';
import type { AdoptPreparedSessionResult, AgentRuntime, PreparedAgentSessionInfo } from '@vibecook/puppeteer-runtime';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface SpawnThroughLaunchRequest extends AgentNativeInvocationIntent {
  type: 'launch';
  token: string;
  pid: number;
  parentPid: number;
  /** A flag only. The trusted main process resolves the executable and state root. */
  imposter?: boolean;
}

export interface SpawnThroughExecFailedRequest {
  type: 'exec-failed';
  token: string;
  preparationId: string;
  message: string;
}

export type SpawnThroughRequest = SpawnThroughLaunchRequest | SpawnThroughExecFailedRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

/** Strict gateway boundary: unknown fields and unbounded strings are rejected. */
export function parseSpawnThroughRequest(value: unknown): SpawnThroughRequest | undefined {
  if (!isRecord(value) || typeof value.token !== 'string' || !value.token || value.token.length > 256) return undefined;
  if (value.type === 'exec-failed') {
    if (!hasOnlyKeys(value, ['type', 'token', 'preparationId', 'message'])) return undefined;
    if (typeof value.preparationId !== 'string' || !value.preparationId || value.preparationId.length > 8_192) {
      return undefined;
    }
    if (typeof value.message !== 'string' || value.message.length > 8_192) return undefined;
    return { type: 'exec-failed', token: value.token, preparationId: value.preparationId, message: value.message };
  }
  if (value.type !== 'launch') return undefined;
  if (
    !hasOnlyKeys(value, [
      'type',
      'token',
      'providerId',
      'cwd',
      'argv',
      'environment',
      'pid',
      'parentPid',
      'imposter',
    ]) ||
    !positivePid(value.pid as number) ||
    !positivePid(value.parentPid as number) ||
    (value.imposter !== undefined && typeof value.imposter !== 'boolean')
  ) {
    return undefined;
  }
  const intent = AgentNativeInvocationIntentSchema.safeParse({
    providerId: value.providerId,
    cwd: value.cwd,
    argv: value.argv,
    environment: value.environment,
  });
  if (!intent.success) return undefined;
  return {
    type: 'launch',
    token: value.token,
    ...intent.data,
    pid: value.pid as number,
    parentPid: value.parentPid as number,
    ...(value.imposter === true ? { imposter: true } : {}),
  };
}

export type SpawnThroughResponse =
  | {
      action: 'exec';
      preparationId: string;
      launch: PreparedAgentSessionInfo['launch'];
    }
  | { action: 'fallback'; reason: string }
  | { action: 'ack' };

export interface AdoptedSpawnThroughSession {
  info: Exclude<AdoptPreparedSessionResult, { error: unknown }>;
  session: SessionSummary;
  processId: number;
  preparationId: string;
}

export interface PrepareSpawnThroughDependencies {
  runtime: Pick<AgentRuntime, 'launchProviders' | 'prepareInvocation' | 'adoptPrepared' | 'cancelPrepared'>;
  listSessions(): Promise<SessionSummary[]>;
  onAdopted(adopted: AdoptedSpawnThroughSession): void | Promise<void>;
  /** Absolute path to the imposter's `ai`, when this build can emulate. */
  imposterBin?(): string | undefined;
  /** Host-owned state root when the adapter descriptor requests isolation. */
  imposterStateRoot?(providerId: string): string | undefined;
}

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function launchProvider(
  providers: readonly AgentLaunchProvider[],
  providerId: string,
): AgentLaunchProvider | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export function matchingTerminalSession(
  sessions: readonly SessionSummary[],
  request: Pick<SpawnThroughLaunchRequest, 'pid' | 'parentPid'>,
): SessionSummary | undefined {
  const live = sessions.filter((session) => !session.exited && session.pid !== null);
  return (
    live.find((session) => session.pid === request.parentPid) ?? live.find((session) => session.pid === request.pid)
  );
}

export async function prepareSpawnThroughLaunch(
  request: SpawnThroughLaunchRequest,
  dependencies: PrepareSpawnThroughDependencies,
): Promise<SpawnThroughResponse> {
  if (!positivePid(request.pid) || !positivePid(request.parentPid)) {
    return { action: 'fallback', reason: 'invalid process identity' };
  }
  const intent = AgentNativeInvocationIntentSchema.safeParse({
    providerId: request.providerId,
    cwd: request.cwd,
    argv: request.argv,
    environment: request.environment,
  });
  if (!intent.success) {
    return { action: 'fallback', reason: 'invalid launch request' };
  }
  const provider = launchProvider(dependencies.runtime.launchProviders(), intent.data.providerId);
  const capability = provider?.nativeInvocation;
  if (!capability) return { action: 'fallback', reason: 'agent does not support managed native invocation' };

  let implementation: { kind: 'native' } | { kind: 'imposter'; executable: string; stateRoot?: string } = {
    kind: 'native',
  };
  if (request.imposter) {
    const imposter = capability.imposter;
    if (!imposter) return { action: 'fallback', reason: 'agent does not advertise a conformant pane imposter' };
    const executable = dependencies.imposterBin?.();
    if (!executable) return { action: 'fallback', reason: 'the puppeteer imposter is not installed beside Godview' };
    if (imposter.state === 'isolated-root') {
      const stateRoot = dependencies.imposterStateRoot?.(provider.id);
      if (!stateRoot) return { action: 'fallback', reason: 'an isolated imposter state root is unavailable' };
      implementation = { kind: 'imposter', executable, stateRoot };
    } else {
      implementation = { kind: 'imposter', executable };
    }
  }

  const session = matchingTerminalSession(await dependencies.listSessions(), request);
  if (!session) return { action: 'fallback', reason: 'containing Ghosttea terminal was not found' };

  const prepared = await dependencies.runtime.prepareInvocation({
    ...intent.data,
    implementation,
  });
  if ('error' in prepared) return { action: 'fallback', reason: prepared.error.message };

  const adopted = await dependencies.runtime.adoptPrepared(prepared.preparationId, {
    runtimeSessionId: session.id,
    processId: request.pid,
  });
  if ('error' in adopted) {
    await dependencies.runtime.cancelPrepared(prepared.preparationId);
    return { action: 'fallback', reason: adopted.error.message };
  }

  await dependencies.onAdopted({
    info: adopted,
    session,
    processId: request.pid,
    preparationId: prepared.preparationId,
  });
  return { action: 'exec', preparationId: prepared.preparationId, launch: prepared.launch };
}

export interface SpawnThroughGateway {
  port: number;
  close(): Promise<void>;
}

function writeResponse(socket: Socket, response: SpawnThroughResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

export async function startSpawnThroughGateway(
  token: string,
  handle: (request: SpawnThroughRequest) => Promise<SpawnThroughResponse>,
): Promise<SpawnThroughGateway> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, { action: 'fallback', reason: 'spawn-through request is too large' });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = parseSpawnThroughRequest(JSON.parse(input.slice(0, newline)));
          if (!request || request.token !== token) {
            writeResponse(socket, { action: 'fallback', reason: 'spawn-through authentication failed' });
            return;
          }
          writeResponse(socket, await handle(request));
        } catch (error) {
          writeResponse(socket, {
            action: 'fallback',
            reason: error instanceof Error ? error.message : String(error),
          });
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
        // half-written authenticated request must not hold application quit
        // for its 30-second read timeout.
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
