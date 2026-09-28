import {
  AgentLaunchCommandSchema,
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

/**
 * Why a launch was not exec'd, one code per place the kit declines — stable,
 * for a host to switch on (its own words, its records). The `reason` beside it
 * is for people and logs, and may change.
 */
export const SPAWN_THROUGH_DECLINE_CODES = [
  // The gateway's own: it could not read or trust the request.
  'unauthenticated', // a wrong bearer, or a request of the wrong shape: one answer for both
  'request-too-large', // over MAX_REQUEST_BYTES
  'handler-failed', // the host's handler threw
  // The request: its process identity or its intent does not parse.
  'invalid-request',
  // What the invocation is: not a session at all.
  'passthrough', // the adapter says: a utility, a one-shot, an agent that lives elsewhere
  'not-interactive', // its input or output is not a terminal: a one-shot run
  // Where it is.
  'outside-host-terminals', // no terminal of the host's holds the process
  // A session in one of the host's terminals that the host cannot manage.
  'unsupported-agent', // the runtime offers no managed native invocation for it
  'invalid-invocation', // the runtime would not put it to the adapter, or the implementation does not fit
  'rejected-argument', // the adapter's grammar: an argument the managed launch cannot carry
  'imposter-unavailable', // the imposter route it asked for is not available beside this host
  'prepare-failed',
  'terminal-conflict', // the terminal already runs a managed session (the runtime's RUNTIME_SESSION_CONFLICT)
  'adopt-failed',
] as const;
export type SpawnThroughDeclineCode = (typeof SPAWN_THROUGH_DECLINE_CODES)[number];

/** A refusal's words: at most this many characters, on at most two lines. The shim holds them to it too. */
export const MAX_REFUSAL_MESSAGE_LENGTH = 400;

// Controls (C0, C1), format characters (bidirectional overrides among them), private use, unassigned, and
// the Unicode line and paragraph separators some terminals break a line on.
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * Text for a person's terminal: printable characters only, at most two lines
 * (a third and later join the second), at most
 * {@link MAX_REFUSAL_MESSAGE_LENGTH} characters, `…` marking a cut. Empty when
 * nothing printable is left.
 */
export function boundSpawnThroughText(text: string): string {
  const [first, ...rest] = text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.replace(UNPRINTABLE, ' ').replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0);
  const characters = Array.from([first, rest.join(' ')].filter(Boolean).join('\n'));
  return characters.length <= MAX_REFUSAL_MESSAGE_LENGTH
    ? characters.join('')
    : `${characters.slice(0, MAX_REFUSAL_MESSAGE_LENGTH - 1).join('')}…`;
}

const HOST_LABEL = /^[^\p{C}\p{Zl}\p{Zp}]{1,64}$/u;

/**
 * A host's name for the shim's own sentences ("waiting for <label> to start
 * it…"), which it says in place of "the host": 1–64 printable characters.
 */
export function isSpawnThroughHostLabel(value: unknown): value is string {
  return typeof value === 'string' && HOST_LABEL.test(value);
}

/** The kit's own sentence for a refusal: what a person reads when the host has no words of its own. */
export function spawnThroughRefusalMessage({ reason }: { reason: string }): string {
  return `not started, because it could not be run as a managed session: ${reason}`;
}

export interface SpawnThroughLaunchRequest extends AgentNativeInvocationIntent {
  type: 'launch';
  token: string;
  /** The shim's pid, which its exec keeps: the managed process's pid. */
  pid: number;
  parentPid: number;
  /** A flag only. The host resolves the imposter's executable and state root. */
  imposter?: boolean;
  /** The name the person typed (`ai` for the imposter's route), for the words a refused person reads. */
  command?: string;
  /**
   * Whether the agent's input and output are both a terminal. A launch whose
   * input or output is not (`<name> "x" > out.txt`, a pipe) is a one-shot run,
   * never a session, whatever its argv says.
   */
  interactive: boolean;
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
  | { action: 'fallback'; code: SpawnThroughDeclineCode; reason: string }
  /**
   * Strict hosts only: exec nothing, print `message` (bounded by
   * {@link boundSpawnThroughText}), exit {@link SPAWN_THROUGH_EXIT_REFUSED}.
   * `placed`: the host resolved the terminal that holds the process, and the
   * shim obeys. An unplaced refusal (the gateway could not read or trust the
   * request) binds only where the shim finds itself in one of the host's
   * terminals, by its own ancestry (terminals.ts).
   */
  | { action: 'refuse'; code: SpawnThroughDeclineCode; reason: string; message: string; placed: boolean }
  | { action: 'ack' };

/** Why a launch was declined: the stable code, and the reason for people and logs. */
export interface SpawnThroughDecline {
  code: SpawnThroughDeclineCode;
  reason: string;
}

/**
 * The answer to a launch the host will not manage: without `refusal`, the
 * real executable runs unmanaged; with it, nothing runs and the person reads
 * `refusal.message`, bounded here — or the kit's own sentence when no words
 * are given or none survive the bound. `placed` says whether the host
 * resolved the terminal that holds the process.
 */
export function declineSpawnThrough(
  decline: SpawnThroughDecline,
  refusal?: { message?: string | undefined; placed: boolean } | undefined,
): SpawnThroughResponse {
  const { code, reason } = decline;
  if (refusal === undefined) return { action: 'fallback', code, reason };
  const message =
    boundSpawnThroughText(refusal.message ?? '') || boundSpawnThroughText(spawnThroughRefusalMessage(decline));
  return { action: 'refuse', code, reason, message, placed: refusal.placed };
}

/** Core's rule for a command name: what a launcher can be written for, and nothing a terminal would act on. */
export function isSpawnThroughCommandName(value: unknown): value is string {
  return typeof value === 'string' && AgentLaunchCommandSchema.shape.name.safeParse(value).data === value;
}

const DECLINE_CODES: ReadonlySet<string> = new Set(SPAWN_THROUGH_DECLINE_CODES);

function isDeclineCode(value: unknown): value is SpawnThroughDeclineCode {
  return typeof value === 'string' && DECLINE_CODES.has(value);
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
      'command',
      'interactive',
    ])
  ) {
    return undefined;
  }
  const { pid, parentPid, imposter, command, interactive } = value;
  if (!positivePid(pid) || !positivePid(parentPid)) return undefined;
  if (imposter !== undefined && typeof imposter !== 'boolean') return undefined;
  if (interactive !== undefined && typeof interactive !== 'boolean') return undefined;
  if (command !== undefined && !isSpawnThroughCommandName(command)) return undefined;
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
    ...(typeof command === 'string' ? { command } : {}),
    // Absent: a shim from before this field, which never looked. Its launch is read as every launch was then.
    interactive: interactive ?? true,
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
      return isDeclineCode(value.code) && typeof value.reason === 'string'
        ? { action: 'fallback', code: value.code, reason: value.reason }
        : undefined;
    case 'refuse':
      return isDeclineCode(value.code) &&
        typeof value.reason === 'string' &&
        typeof value.message === 'string' &&
        typeof value.placed === 'boolean'
        ? { action: 'refuse', code: value.code, reason: value.reason, message: value.message, placed: value.placed }
        : undefined;
    case 'ack':
      return { action: 'ack' };
    default:
      return undefined;
  }
}
