import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AdoptPreparedSessionResult,
  AgentRuntime,
  CreateAgentSessionOptions,
  PreparedAgentSessionInfo,
} from '@vibecook/puppeteer-runtime';
import type { BuiltinExecutableAgentKind } from '@vibecook/puppeteer-builtin-providers';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface SpawnThroughLaunchRequest {
  type: 'launch';
  token: string;
  agent: BuiltinExecutableAgentKind;
  cwd: string;
  argv: string[];
  pid: number;
  parentPid: number;
  /** Resolved from the launching pane's `CLAUDE_CONFIG_DIR`; no other shell environment crosses the gateway. */
  claudeConfigDir?: string;
  /**
   * The pane asked for the puppeteer imposter (`ai --claude`) rather than the
   * real agent. A FLAG, never a path: the gateway resolves the binary itself,
   * so a request can choose emulation but can never choose what gets executed.
   */
  imposter?: boolean;
}

export interface SpawnThroughExecFailedRequest {
  type: 'exec-failed';
  token: string;
  preparationId: string;
  message: string;
}

export type SpawnThroughRequest = SpawnThroughLaunchRequest | SpawnThroughExecFailedRequest;

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
  runtime: Pick<AgentRuntime, 'prepareSession' | 'adoptPrepared' | 'cancelPrepared'>;
  listSessions(): Promise<SessionSummary[]>;
  onAdopted(adopted: AdoptedSpawnThroughSession): void | Promise<void>;
  /** Absolute path to the imposter's `ai`, when this build can emulate. */
  imposterBin?(): string | undefined;
  /** Isolated durable root shared by an emulated native adapter and persona. */
  imposterHome?(agent: BuiltinExecutableAgentKind): string | undefined;
}

/**
 * Which agents `ai --<vendor>` can stand in for inside a pane.
 *
 * The predicate is "the imposter ships a persona for it AND that persona has a
 * green conformance suite against the real adapter" — the suites are the gate,
 * not this list, which only names what has passed. Codex joined once the
 * persona learned to serve on a unix socket, which is the transport its
 * adapter actually uses
 * (`conformance.codex-socket.test.ts`). Grok is gated by the full leader +
 * ACP + terminal + persisted-log composition in `conformance.grok.test.ts`.
 * Kimi is gated by its native TUI + durable-wire subprocess suite in
 * `conformance.kimi.test.ts`.
 * OpenCode is gated by its private HTTP server + SSE stream + exact attach
 * composition in `conformance.opencode.test.ts` and the adapter's shared
 * adapter-session conformance suite.
 *
 * A vendor listed here without that suite would be worse than a refusal: the
 * pane would look like it worked while the session was bound to nothing.
 */
export const IMPOSTER_AGENTS: readonly BuiltinExecutableAgentKind[] = ['claude', 'codex', 'grok', 'kimi', 'opencode'];

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const KIMI_SESSION_FLAGS = new Set(['-S', '-r', '--resume', '--session']);

type ParsedInvocation = Pick<CreateAgentSessionOptions, 'resume' | 'agentOptions'>;

function parseClaudeInvocation(argv: readonly string[]): ParsedInvocation | { error: string } {
  let resume: string | undefined;
  let resumeInvocation: string[] | undefined;
  const agentOptions: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    settingSources?: Array<'user' | 'project' | 'local'>;
    resumeInvocation?: string[];
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--continue' || argument === '-c') {
      if (resume || resumeInvocation) return { error: 'custom arguments are not spawn-through compatible' };
      resumeInvocation = [argument];
      continue;
    }
    if (argument === '--resume' || argument === '-r') {
      if (resume || resumeInvocation) return { error: 'custom arguments are not spawn-through compatible' };
      const selection = argv[index + 1];
      if (selection && !selection.startsWith('-')) {
        if (UUID.test(selection)) resume = selection;
        else resumeInvocation = [argument, selection];
        index += 1;
      } else {
        resumeInvocation = [argument];
      }
      continue;
    }
    if (argument === '--setting-sources') {
      const value = argv[index + 1];
      const sources = value?.split(',');
      if (
        !value ||
        agentOptions.settingSources !== undefined ||
        !sources ||
        sources.some((source) => !['user', 'project', 'local'].includes(source))
      ) {
        return { error: 'custom arguments are not spawn-through compatible' };
      }
      agentOptions.settingSources = sources as Array<'user' | 'project' | 'local'>;
      index += 1;
      continue;
    }
    const field =
      argument === '--model'
        ? 'model'
        : argument === '--effort'
          ? 'effort'
          : argument === '--permission-mode'
            ? 'permissionMode'
            : undefined;
    const value = field ? argv[index + 1] : undefined;
    if (!field || !value || value.startsWith('-') || agentOptions[field] !== undefined) {
      return { error: 'custom arguments are not spawn-through compatible' };
    }
    agentOptions[field] = value;
    index += 1;
  }

  if (resumeInvocation) agentOptions.resumeInvocation = resumeInvocation;
  return {
    ...(resume ? { resume } : {}),
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
  };
}

/** Translate only argv forms whose semantics adapters can preserve exactly. */
export function parseSpawnThroughInvocation(
  agent: BuiltinExecutableAgentKind,
  argv: readonly string[],
): ParsedInvocation | { error: string } {
  if (argv.length === 0) return {};

  if (agent === 'claude') return parseClaudeInvocation(argv);

  if (agent === 'codex' && argv[0] === 'resume') {
    if (argv.some((argument) => argument === '--remote' || argument === '--remote-auth-token-env')) {
      return { error: 'Codex remote transport arguments are owned by Puppeteer' };
    }
    if (argv.length === 2 && UUID.test(argv[1]!)) return { resume: argv[1] };
    return { agentOptions: { resumeInvocation: [...argv] } };
  }

  if (agent === 'grok') {
    if ((argv[0] === '--continue' || argv[0] === '-c') && argv.length === 1) {
      return { agentOptions: { resumeLatest: true } };
    }
    if ((argv[0] === '--resume' || argv[0] === '-r') && argv.length <= 2) {
      return argv[1] ? { resume: argv[1] } : { agentOptions: { resumeLatest: true } };
    }
  }

  if (
    agent === 'kimi' &&
    KIMI_SESSION_FLAGS.has(argv[0]!) &&
    argv.length === 2 &&
    argv[1] !== '.' &&
    argv[1] !== '..' &&
    SAFE_NATIVE_SESSION_ID.test(argv[1]!)
  ) {
    return { resume: argv[1] };
  }

  if (
    agent === 'opencode' &&
    (argv[0] === '-s' || argv[0] === '--session') &&
    argv.length === 2 &&
    argv[1] !== '.' &&
    argv[1] !== '..' &&
    SAFE_NATIVE_SESSION_ID.test(argv[1]!)
  ) {
    return { resume: argv[1] };
  }

  return { error: 'custom arguments are not spawn-through compatible' };
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
  if (!request.cwd || !Array.isArray(request.argv) || request.argv.some((argument) => typeof argument !== 'string')) {
    return { action: 'fallback', reason: 'invalid launch request' };
  }
  if (
    request.claudeConfigDir !== undefined &&
    (request.agent !== 'claude' ||
      typeof request.claudeConfigDir !== 'string' ||
      !request.claudeConfigDir ||
      !isAbsolute(request.claudeConfigDir))
  ) {
    return { action: 'fallback', reason: 'invalid Claude configuration root' };
  }
  const invocation = parseSpawnThroughInvocation(request.agent, request.argv);
  if ('error' in invocation) return { action: 'fallback', reason: invocation.error };

  let executable: string | undefined;
  let isolatedImposterHome: string | undefined;
  if (request.imposter) {
    if (!IMPOSTER_AGENTS.includes(request.agent)) {
      return { action: 'fallback', reason: `the imposter cannot stand in for ${request.agent} in a pane yet` };
    }
    executable = dependencies.imposterBin?.();
    if (!executable) return { action: 'fallback', reason: 'the puppeteer imposter is not installed beside Godview' };
    if (request.agent === 'kimi' || request.agent === 'opencode') {
      isolatedImposterHome = dependencies.imposterHome?.(request.agent);
      if (!isolatedImposterHome) {
        return { action: 'fallback', reason: `an isolated ${request.agent} imposter store is unavailable` };
      }
    }
  }

  const session = matchingTerminalSession(await dependencies.listSessions(), request);
  if (!session) return { action: 'fallback', reason: 'containing Ghosttea terminal was not found' };

  const agentOptions: Record<string, unknown> = {
    ...(invocation.agentOptions as Record<string, unknown> | undefined),
    ...(request.agent === 'claude' && request.claudeConfigDir ? { configDir: request.claudeConfigDir } : {}),
    ...(executable
      ? {
          executable,
          ...(request.agent === 'kimi' && isolatedImposterHome
            ? {
                kimiHome: isolatedImposterHome,
                env: {
                  AI_PERSONA: request.agent,
                  KIMI_CODE_HOME: isolatedImposterHome,
                  PUPPETEER_IMPOSTER_HOME: isolatedImposterHome,
                },
              }
            : request.agent === 'opencode' && isolatedImposterHome
              ? {
                  env: {
                    AI_PERSONA: request.agent,
                    PUPPETEER_IMPOSTER_HOME: isolatedImposterHome,
                  },
                }
              : { appServerEnv: { AI_PERSONA: request.agent } }),
        }
      : {}),
  };
  const prepared = await dependencies.runtime.prepareSession({
    agent: request.agent,
    cwd: request.cwd,
    ...invocation,
    // Per session, not per process: every other pane still launches the user's
    // real agent, which is the whole point of asking for `ai` by name.
    //
    // Codex/Grok use `appServerEnv` for cooperating processes outside the
    // terminal recipe. Kimi and OpenCode instead expose `env`; OpenCode's copy
    // reaches both its private HTTP backend and exact native attach.
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
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
  // The adapter owns argv and builds the vendor's real launch recipe, so the
  // persona cannot be selected with a flag — it rides in the environment
  // instead. Merged here rather than inside the runtime, which has no business
  // knowing that one of its executables is an imposter.
  const launch = executable
    ? { ...prepared.launch, env: { ...prepared.launch.env, AI_PERSONA: request.agent } }
    : prepared.launch;
  return { action: 'exec', preparationId: prepared.preparationId, launch };
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
          const request = JSON.parse(input.slice(0, newline)) as SpawnThroughRequest;
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
