import {
  AgentNativeInvocationIntentSchema,
  type AgentNativeInvocationIntent,
  type TerminalSpec,
} from '@vibecook/puppeteer-core';

/**
 * The spawn-through wire (docs/guides/spawn-through-hosts.md): one JSON line
 * from the shim, one JSON line back, one request per loopback connection.
 *
 * Any process of the person's uid can read the rendezvous and speak this
 * protocol, so the gateway treats every request as untrusted: unknown keys and
 * unbounded strings are refused, and the intent is held to the Core schema
 * before any host code sees it. The pid a request names is self-asserted; the
 * host's `resolveTerminal` is what binds it to a terminal.
 */

/** A request longer than this is answered without being parsed. */
export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 256;
const MAX_TEXT_LENGTH = 8_192;

/** The shim's exit when a launch is refused (EX_TEMPFAIL): nothing was exec'd. */
export const SPAWN_THROUGH_EXIT_REFUSED = 75;
/** The shim's exit when it cannot run at all or finds no real executable (the shell's own "not found"). */
export const SPAWN_THROUGH_EXIT_UNAVAILABLE = 127;

export interface SpawnThroughLaunchRequest extends AgentNativeInvocationIntent {
  type: 'launch';
  token: string;
  /** The shim's pid, which its exec keeps: the managed process's pid. */
  pid: number;
  parentPid: number;
  /** A flag only. The host resolves the imposter's executable and state root. */
  imposter?: boolean;
}

/** The shim could not exec the recipe it was given; the preparation is the host's to cancel. */
export interface SpawnThroughExecFailedRequest {
  type: 'exec-failed';
  token: string;
  preparationId: string;
  message: string;
}

export type SpawnThroughRequest = SpawnThroughLaunchRequest | SpawnThroughExecFailedRequest;

export type SpawnThroughResponse =
  /** The launch is adopted: exec this recipe in place. */
  | { action: 'exec'; preparationId: string; launch: TerminalSpec }
  /** Not managed: exec the real executable with the original argv. */
  | { action: 'fallback'; reason: string }
  /** Strict hosts only: exec nothing, print `message`, exit {@link SPAWN_THROUGH_EXIT_REFUSED}. */
  | { action: 'refuse'; reason: string; message: string }
  | { action: 'ack' };

/**
 * The answer to a launch the host will not manage: the real executable runs
 * unmanaged, or — for a strict host — nothing runs and the person is told why.
 */
export function declineSpawnThrough(
  reason: string,
  { strict }: { strict?: boolean | undefined },
): SpawnThroughResponse {
  return strict === true
    ? { action: 'refuse', reason, message: `not started, because it could not be run as a managed session: ${reason}` }
    : { action: 'fallback', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function positivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function boundedText(value: unknown, { required }: { required: boolean }): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && (!required || value.length > 0);
}

/** The gateway's boundary: a request with any unknown key or unbounded string is not a request. */
export function parseSpawnThroughRequest(value: unknown): SpawnThroughRequest | undefined {
  if (!isRecord(value) || typeof value.token !== 'string' || !value.token || value.token.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  if (value.type === 'exec-failed') {
    if (!hasOnlyKeys(value, ['type', 'token', 'preparationId', 'message'])) return undefined;
    if (!boundedText(value.preparationId, { required: true })) return undefined;
    if (!boundedText(value.message, { required: false })) return undefined;
    return { type: 'exec-failed', token: value.token, preparationId: value.preparationId, message: value.message };
  }
  if (value.type !== 'launch') return undefined;
  if (
    !hasOnlyKeys(value, ['type', 'token', 'providerId', 'cwd', 'argv', 'environment', 'pid', 'parentPid', 'imposter'])
  ) {
    return undefined;
  }
  const { pid, parentPid, imposter } = value;
  if (!positivePid(pid) || !positivePid(parentPid)) return undefined;
  if (imposter !== undefined && typeof imposter !== 'boolean') return undefined;
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
    pid,
    parentPid,
    ...(imposter === true ? { imposter: true } : {}),
  };
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * The shim's reading of an answer. Tolerant of keys it does not know (a reader
 * of a newer gateway), strict about the ones it acts on: it execs `launch`.
 */
export function parseSpawnThroughResponse(value: unknown): SpawnThroughResponse | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.action) {
    case 'exec': {
      const { preparationId, launch } = value;
      if (typeof preparationId !== 'string' || !preparationId || !isRecord(launch)) return undefined;
      const { command, args, cwd, env } = launch;
      if (typeof command !== 'string' || !command || typeof cwd !== 'string' || !cwd) return undefined;
      if (!Array.isArray(args) || !args.every((argument): argument is string => typeof argument === 'string')) {
        return undefined;
      }
      if (env !== undefined && !stringRecord(env)) return undefined;
      return {
        action: 'exec',
        preparationId,
        launch: { command, args: [...args], cwd, ...(env === undefined ? {} : { env: { ...env } }) },
      };
    }
    case 'fallback':
      return typeof value.reason === 'string' ? { action: 'fallback', reason: value.reason } : undefined;
    case 'refuse':
      return typeof value.reason === 'string' && typeof value.message === 'string'
        ? { action: 'refuse', reason: value.reason, message: value.message }
        : undefined;
    case 'ack':
      return { action: 'ack' };
    default:
      return undefined;
  }
}
