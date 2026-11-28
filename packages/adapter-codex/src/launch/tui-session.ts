/**
 * createCodexTuiSession — the full Codex native-TUI session recipe as one
 * `AgentAdapterBinding` (the host integration, lifted out of the app).
 *
 * A Codex TUI session is three things the adapter owns end to end:
 *   1. a private `codex app-server` on a local platform endpoint (backing service),
 *   2. a controller-owned thread on that server — `thread/start` (or resume of
 *      a known id) plus empty `inject_items` so the rollout materializes without
 *      a user prompt or model turn (probe 2026-07-15),
 *   3. a native `codex resume <id> --remote` TUI spawned through the host's
 *      terminal capability (the tab the user drives), observing the SAME thread.
 *
 * Owning the thread first is what lets the agent panel leave `preparing`
 * immediately (session:started → ready), matching Claude/Grok. Bare
 * `codex --remote` only creates a thread on the first prompt, which left the
 * panel stuck on preparing until the user typed.
 *
 * Injection is still bracketed-paste into the native TUI. A paste is
 * `confirmed` only on the thread's own record of the pasted text, and
 * `uncertain` without it (`prompt-echo.ts`), as the structured driver
 * confirms only on its echoed client id.
 *
 * The thread's model and effort are changed on the app-server, never typed: a
 * third connection, opted into the experimental API, asks for the change and
 * hears every one made (`services/model-switch.ts`).
 */

import {
  announceRunHelper,
  pickAgentBriefing,
  settleAgentBriefing,
  withAgentBriefing,
  type AgentBriefingWithheld,
  type AgentRunBriefing,
} from '@vibefield/puppeteer-core';
import { CODEX_BRIEFING_CAPABILITIES } from './briefing.js';
import { CodexPromptEchoes } from './prompt-echo.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentHost,
  AgentAdapterBinding,
  AgentTuiSessionOptions,
  PromptReceipt,
  PromptSubmission,
  TerminalAutomationResult,
  TerminalSpec,
} from '@vibefield/puppeteer-core';
import { resolveCodexExecutable } from '../detection.js';
import {
  createCodexObserver,
  type CodexFollowedThread,
  type CodexObserver,
  type CodexThreadMove,
} from '../observation/observer.js';
import { createCodexModelSwitch } from '../services/model-switch.js';
import type { CodexApprovalDecision, CodexApprovalRequest } from '../driver.js';
import { spawnAppServer, type AppServerTransportKind } from '../transport/app-server-process.js';
import {
  appServerRemoteAddress,
  connectAppServerEndpoint,
  createWebSocketTapProxy,
  type WebSocketTapProxy,
  type WebSocketTapServerReader,
} from '../transport/ws-transport.js';

export interface CreateCodexTuiSessionOptions extends AgentTuiSessionOptions, AgentRunBriefing {
  /** Codex executable (default `codex`). */
  executable?: string | undefined;
  /** Extra environment for the user-visible TUI process. */
  env?: Record<string, string> | undefined;
  /**
   * Extra environment for the PRIVATE app-server, merged over this process's, or over
   * the host's helper environment when the host composes one (`AgentHost.helperEnvironment`).
   *
   * This remains separate from `env` because tests and advanced hosts may need
   * to configure only the backing service. Native-invocation normalization
   * supplies both when the complete recipe must share a profile or persona.
   */
  appServerEnv?: Record<string, string> | undefined;
  /** Override the private app-server endpoint kind (normally selected by platform). */
  appServerTransport?: AppServerTransportKind | undefined;
  /** Choose which thread to attach to when several appear (passive observer only). */
  selectThread?: ((threadId: string) => boolean) | undefined;
  /** Model id applied when starting a fresh thread or resuming one by id. */
  model?: string | undefined;
  /** Model-specific reasoning effort; native configuration remains authoritative when omitted. */
  effort?: string | undefined;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
  approvalPolicy?: 'never' | 'on-request' | 'untrusted' | undefined;
  /**
   * Who decides the sandbox and approval policy `sandbox`/`approvalPolicy` leave unset on
   * a fresh thread: `'adapter'` (the default) starts it with workspace-write and on-request;
   * `'configuration'` lets the private app-server take them from its configuration, as a
   * typed `codex` does. A typed launch passes `'configuration'`; a host's own spawn keeps
   * the default unless it names its permissions.
   */
  permissionDefaults?: 'adapter' | 'configuration' | undefined;
  /**
   * Decide approval requests from the controller-owned connection, racing the
   * person in the TUI. Without it, the TUI asks the person and the session
   * reports the wait as a pending permission.
   */
  onApproval?: ((req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>) | undefined;
  /** A typed resume: `thread/resume` names no directory, so the thread goes on where it ran. A host's resume moves it. */
  keepThreadCwd?: boolean | undefined;
  /** Preserve a native `codex resume ...` selection flow on the private app-server. */
  resumeInvocation?: string[] | undefined;
  /** Settings for the private app-server's own command line (`--config=…`, `--enable=…`, `--disable=…`). */
  appServerArguments?: string[] | undefined;
  /**
   * Typed arguments for the TUI's own command line. They follow the adapter's
   * `--remote <addr>`, so nothing typed can take the address as its value.
   */
  tuiArguments?: string[] | undefined;
  /**
   * A typed prompt, which the TUI submits once it joins the owned thread. It goes
   * last, after `--`, so clap reads it as the prompt whatever it starts with.
   */
  prompt?: string | undefined;
}

/** The TUI's requests that name the thread it goes to, and the move each is. */
const THREAD_MOVES: ReadonlyMap<string, CodexThreadMove> = new Map<string, CodexThreadMove>([
  ['thread/start', 'new'],
  ['thread/resume', 'resume'],
  ['thread/fork', 'fork'],
]);
/** Requests awaiting their answer, at most; past it the oldest is forgotten. */
const MAX_PENDING_MOVES = 32;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A JSON-RPC id as a map key: a number and a string of the same digits are two ids. */
function requestKey(id: unknown): string | undefined {
  return typeof id === 'number' || typeof id === 'string' ? `${typeof id}:${String(id)}` : undefined;
}

/**
 * What the tap hears of the thread a managed TUI goes to. A thread the TUI starts, resumes or forks is named in the
 * app-server's ANSWER (a `thread/start` or `thread/fork` request carries no new id), so the tap keeps each such
 * request's id, reads the server's frames only while one waits, and hands the answer's `thread` to the observer
 * (`followThread`). An error answer drops the request. A picker's first `thread/resume` is its binding, attached from
 * the request itself as before; its answer then names the thread already observed and moves nothing.
 */
export function codexThreadMoves(observer: () => Pick<CodexObserver, 'sessionId' | 'attachThread' | 'followThread'>): {
  clientMessage(message: unknown): void;
  serverReader: WebSocketTapServerReader;
} {
  const pending = new Map<string, CodexThreadMove>();
  return {
    clientMessage(message) {
      const request = record(message);
      const method = typeof request?.method === 'string' ? request.method : undefined;
      const move = method === undefined ? undefined : THREAD_MOVES.get(method);
      if (move === undefined) return;
      const params = record(request?.params);
      if (move === 'resume' && observer().sessionId === undefined && typeof params?.threadId === 'string') {
        // The observer publishes a provider refusal as a diagnostic, and the TUI's own request receives
        // Codex's error; nothing awaits this attach, so its rejection must not go unhandled.
        observer()
          .attachThread(params.threadId)
          .catch(() => undefined);
      }
      const key = requestKey(request?.id);
      if (key === undefined) return;
      pending.delete(key);
      pending.set(key, move);
      if (pending.size > MAX_PENDING_MOVES) pending.delete(pending.keys().next().value as string);
    },
    serverReader: {
      waiting: () => pending.size > 0,
      message(message) {
        const answer = record(message);
        // A server request or a notification has a method; an answer has none.
        if (answer === undefined || answer.method !== undefined) return;
        const key = requestKey(answer.id);
        const move = key === undefined ? undefined : pending.get(key);
        if (key === undefined || move === undefined) return;
        pending.delete(key);
        const thread = record(record(answer.result)?.thread);
        if (thread === undefined || typeof thread.id !== 'string') return;
        observer()
          .followThread(thread as CodexFollowedThread, move)
          .catch(() => undefined);
      },
    },
  };
}

const OWNED_TUI_ARGUMENTS = ['--remote', '--remote-auth-token-env', '--'];
const OWNED_APP_SERVER_ARGUMENTS = ['--listen', '--stdio'];

function owns(argument: string, owned: readonly string[]): boolean {
  return owned.some((name) => argument === name || argument.startsWith(`${name}=`));
}

/** A Codex native-TUI session — {@link AgentAdapterBinding} plus the rollout path. */
export interface CodexTuiSession extends AgentAdapterBinding {
  /** Absolute path to the observed thread's rollout JSONL, once attached. */
  threadPath(): string | undefined;
}

export interface PreparedCodexTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  /** What of the briefing this launch goes ahead without, under `briefingRefusal: 'withhold'`. */
  readonly briefingWithheld?: readonly AgentBriefingWithheld[] | undefined;
  adopt(runtimeSessionId: string): Promise<CodexTuiSession>;
  dispose(): Promise<void>;
}

/** Prepare the private app-server, owned thread, and native TUI recipe without spawning the TUI. */
export async function prepareCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<PreparedCodexTuiSession> {
  const refusal = opts.briefingRefusal;
  let settled = settleAgentBriefing(opts, CODEX_BRIEFING_CAPABILITIES, 'Codex', refusal);
  // A picker loads its thread before the controller can apply thread overrides.
  if (opts.resumeInvocation)
    settled = settleAgentBriefing(settled.briefing, undefined, 'Codex resume picker', refusal, settled.withheld);
  if (opts.appServerEnv?.AI_PERSONA === 'codex' || opts.appServerEnv?.PUPPETEER_IMPOSTER_HOME)
    settled = settleAgentBriefing(settled.briefing, undefined, 'Codex imposter', refusal, settled.withheld);
  const briefing = settled.briefing;
  opts = withAgentBriefing(opts, briefing);
  if (opts.resume && opts.resumeInvocation) {
    throw new Error('Codex preparation accepts resume or resumeInvocation, not both');
  }
  // After a picker selector the prompt would be read as the session to resume.
  if (opts.prompt !== undefined && opts.resumeInvocation) {
    throw new Error('Codex preparation carries a prompt only into a thread it owns, not into resumeInvocation');
  }
  if (opts.tuiArguments?.some((argument) => owns(argument, OWNED_TUI_ARGUMENTS))) {
    throw new Error('Codex tuiArguments must not carry the remote transport or an end of options');
  }
  if (opts.appServerArguments?.some((argument) => owns(argument, OWNED_APP_SERVER_ARGUMENTS))) {
    throw new Error('Codex appServerArguments must not carry the listener');
  }
  const executable = resolveCodexExecutable(opts.executable);
  const host: AgentHost = opts.host;

  // The app-server runs the agent's turns and tools: under a host that composes a helper
  // environment it gets the agent's, never this process's own.
  const helperEnvironment = host.helperEnvironment?.(opts.appServerEnv ?? {});
  const startedAtMs = Date.now();
  const server = spawnAppServer({
    executable,
    ...(opts.appServerTransport ? { transport: opts.appServerTransport } : {}),
    ...(helperEnvironment
      ? { env: helperEnvironment, inheritEnvironment: false }
      : opts.appServerEnv
        ? { env: opts.appServerEnv }
        : {}),
    ...(opts.appServerArguments?.length ? { args: opts.appServerArguments } : {}),
  });
  try {
    await server.ready();
    // MCP servers start inside thread/start and thread/resume, below (briefing.live.test.ts). A host that names callers
    // by process ancestry must hold this pid first, so every path (fresh, resume, picker, imposter) waits for its answer.
    await announceRunHelper(opts.ingress, { pid: server.process.pid, startedAtMs }, 'Codex');
  } catch (err) {
    await server.dispose();
    throw err;
  }

  // Observer first: own or resume the thread so sessionId + ready state exist
  // before the TUI process is even spawned.
  let observer: Awaited<ReturnType<typeof createCodexObserver>>;
  const serverEndpoint = server.endpoint();
  let tap: WebSocketTapProxy;
  const moves = codexThreadMoves(() => observer);
  try {
    observer = await createCodexObserver({
      transport: connectAppServerEndpoint(serverEndpoint),
      selectThread: opts.selectThread,
      onApproval: opts.onApproval,
      ...(refusal === undefined ? {} : { briefingRefusal: refusal }),
      ...(opts.resumeInvocation
        ? {}
        : opts.resume
          ? {
              threadId: opts.resume,
              // The preflight reads the effective configuration of the directory the launch came from.
              ...(Object.keys(briefing).length ? { configCwd: opts.cwd } : {}),
              // The TUI's own `resume --remote` cannot set them on a held thread (C7).
              ...(opts.model || opts.effort || Object.keys(briefing).length
                ? {
                    resumeOverrides: {
                      model: opts.model,
                      effort: opts.effort,
                      ...briefing,
                      ...(Object.keys(briefing).length && !opts.keepThreadCwd ? { cwd: opts.cwd } : {}),
                    },
                  }
                : {}),
            }
          : {
              start: {
                ...pickAgentBriefing(opts),
                cwd: opts.cwd,
                model: opts.model,
                effort: opts.effort,
                sandbox: opts.sandbox,
                approvalPolicy: opts.approvalPolicy,
                permissionDefaults: opts.permissionDefaults,
              },
            }),
    });
  } catch (err) {
    await server.dispose();
    throw err;
  }

  const provisionalSessionId = `codex-pending-${randomUUID()}`;
  const threadId = observer.sessionId ?? (opts.resumeInvocation ? provisionalSessionId : undefined);
  if (!threadId) {
    await observer.dispose().catch(() => undefined);
    await server.dispose();
    throw new Error('codex TUI session: observer returned no thread id');
  }

  // Always join the owned/resumed thread — never bare `--remote` (that creates
  // a second, unmaterialized thread on first keystroke). The TUI joins through a
  // tap, which hears the thread it moves to (`codexThreadMoves`).
  tap = createWebSocketTapProxy(serverEndpoint, moves.clientMessage, moves.serverReader);
  try {
    await tap.ready();
  } catch (error) {
    await tap.dispose();
    await observer.dispose().catch(() => undefined);
    await server.dispose();
    throw error;
  }
  const remoteAddr = appServerRemoteAddress(tap.endpoint());
  // `resume <thread>` first (clap's SESSION_ID), then the adapter's `--remote <addr>`,
  // then what was typed, and the prompt last behind `--` (clap's PROMPT) — a variadic
  // like `--image` can take neither the address nor the prompt.
  const carried = [...(opts.tuiArguments ?? []), ...(opts.prompt === undefined ? [] : ['--', opts.prompt])];
  const args = opts.resumeInvocation
    ? [...opts.resumeInvocation, '--remote', remoteAddr, ...carried]
    : ['resume', threadId, '--remote', remoteAddr, ...carried];

  const launch: TerminalSpec = {
    command: executable,
    args,
    cwd: opts.cwd,
    ...(opts.env ? { env: { ...opts.env } } : {}),
  };
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: CodexTuiSession | undefined;
  let disposed = false;
  const echoes = new CodexPromptEchoes(observer.events);
  // Its own connection to the app-server itself, never through the picker's tap: the tap reads the TUI's requests.
  const modelSwitch = createCodexModelSwitch({
    connect: () => connectAppServerEndpoint(serverEndpoint),
    threadId: () => observer.sessionId,
    isDisposed: () => disposed,
    onSettings: (params) => observer.settingsUpdated(params),
  });
  // Listening from the start is what lets a change made in the TUI's own picker be observed. It is not awaited and
  // a failure is not kept: the session is whole without it, and a switch asked for later opens the connection again.
  // A thread the TUI moves to is the one the rail then listens to.
  const listenForSettings = (): void => void modelSwitch.listen().catch(() => undefined);
  const unsubscribeThread = observer.onThread(({ threadId: observed }) => {
    modelSwitch.follow(observed);
    listenForSettings();
  });
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    unsubscribeThread();
    echoes.dispose();
    await modelSwitch.dispose();
    await observer.dispose().catch(() => undefined);
    await tap.dispose();
    await server.dispose();
  }

  // Settled before the launch recipe exists, on the one connection and app-server this run has.
  const briefingWithheld = [...settled.withheld, ...(observer.briefingWithheld ?? [])];
  return {
    sessionId: threadId,
    launch,
    ...(briefingWithheld.length > 0 ? { briefingWithheld } : {}),
    async adopt(runtimeSessionId): Promise<CodexTuiSession> {
      if (disposed) throw new Error('prepared Codex session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Codex session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      // A thread this recipe owns or resumed is attached already; a picker's attaches later (`onThread`, above).
      if (observer.sessionId !== undefined) listenForSettings();
      adoptedSession = {
        get sessionId(): string {
          return observer.sessionId ?? threadId;
        },
        // A picker launch runs under the id minted here until the TUI resumes the thread the person chose: the
        // observer attaches it from that request, before its `session:started`. What the picker sends to list or show
        // threads names no choice, so it leaves the run provisional.
        nativeSessionProvisional: () => observer.sessionId === undefined,
        runtimeSessionId,
        observationLevel: () => observer.observationLevel(),
        threadPath: () => observer.threadPath(),
        events: observer.events,
        services: {
          prompt: {
            async submit(submission: PromptSubmission): Promise<PromptReceipt> {
              const submitted = submission.mode !== 'paste-only';
              // Listening first: the thread can record the input before the paste call returns.
              const echo = submitted ? echoes.expect(submission.text) : undefined;
              let result: TerminalAutomationResult;
              try {
                result = await host.automateTerminal(runtimeSessionId, {
                  kind: 'paste',
                  text: submission.text,
                  submit: submitted,
                });
              } catch (error) {
                echo?.withdraw({ status: 'rejected', reason: error instanceof Error ? error.message : String(error) });
                throw error;
              }
              if (!result.accepted) {
                const refused: PromptReceipt = { status: 'rejected', reason: result.reason };
                if (!echo) return refused;
                echo.withdraw(refused);
                return echo.receipt;
              }
              // A paste left staged is all a paste-only submission asks for.
              if (!echo) return { status: 'confirmed' };
              echo.arm(submission.confirmationTimeoutMs ?? 5000);
              return echo.receipt;
            },
          },
          modelSwitch,
        },
        dispose,
      };
      return adoptedSession;
    },
    dispose,
  };
}

export async function createCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<CodexTuiSession> {
  const prepared = await prepareCodexTuiSession(opts);
  try {
    const { runtimeSessionId } = await opts.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (err) {
    await prepared.dispose();
    throw err;
  }
}
