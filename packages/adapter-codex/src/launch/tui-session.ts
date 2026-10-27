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
 * Injection is still bracketed-paste into the native TUI; confirmation is
 * best-effort `confirmed` (the structured driver has deterministic receipts).
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentHost,
  AgentAdapterBinding,
  AgentTuiSessionOptions,
  PromptReceipt,
  PromptSubmission,
  TerminalSpec,
} from '@vibefield/puppeteer-core';
import { resolveCodexExecutable } from '../detection.js';
import { createCodexObserver } from '../observation/observer.js';
import type { CodexApprovalDecision, CodexApprovalRequest } from '../driver.js';
import { spawnAppServer, type AppServerTransportKind } from '../transport/app-server-process.js';
import {
  appServerRemoteAddress,
  connectAppServerEndpoint,
  createWebSocketTapProxy,
  type WebSocketTapProxy,
} from '../transport/ws-transport.js';

export interface CreateCodexTuiSessionOptions extends AgentTuiSessionOptions {
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
  /** Decide structured approval requests from the controller-owned app-server connection. Default: deny. */
  onApproval?: ((req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>) | undefined;
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
  adopt(runtimeSessionId: string): Promise<CodexTuiSession>;
  dispose(): Promise<void>;
}

/** Prepare the private app-server, owned thread, and native TUI recipe without spawning the TUI. */
export async function prepareCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<PreparedCodexTuiSession> {
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
  } catch (err) {
    await server.dispose();
    throw err;
  }

  // Observer first: own or resume the thread so sessionId + ready state exist
  // before the TUI process is even spawned.
  let observer: Awaited<ReturnType<typeof createCodexObserver>>;
  const serverEndpoint = server.endpoint();
  let resumeTap: WebSocketTapProxy | undefined;
  try {
    observer = await createCodexObserver({
      transport: connectAppServerEndpoint(serverEndpoint),
      selectThread: opts.selectThread,
      onApproval: opts.onApproval,
      ...(opts.resumeInvocation
        ? {}
        : opts.resume
          ? {
              threadId: opts.resume,
              // The TUI's own `resume --remote` cannot set them on a held thread (C7).
              ...(opts.model || opts.effort ? { resumeOverrides: { model: opts.model, effort: opts.effort } } : {}),
            }
          : {
              start: {
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
  // a second, unmaterialized thread on first keystroke).
  if (opts.resumeInvocation) {
    resumeTap = createWebSocketTapProxy(serverEndpoint, (message) => {
      const request = message as { method?: unknown; params?: { threadId?: unknown } };
      if (request.method === 'thread/resume' && typeof request.params?.threadId === 'string') {
        void observer.attachThread(request.params.threadId);
      }
    });
    try {
      await resumeTap.ready();
    } catch (error) {
      await resumeTap.dispose();
      await observer.dispose().catch(() => undefined);
      await server.dispose();
      throw error;
    }
  }
  const remoteAddr = appServerRemoteAddress(resumeTap?.endpoint() ?? serverEndpoint);
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
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await observer.dispose().catch(() => undefined);
    await resumeTap?.dispose();
    await server.dispose();
  }

  return {
    sessionId: threadId,
    launch,
    async adopt(runtimeSessionId): Promise<CodexTuiSession> {
      if (disposed) throw new Error('prepared Codex session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Codex session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = {
        get sessionId(): string {
          return observer.sessionId ?? threadId;
        },
        runtimeSessionId,
        observationLevel: () => observer.observationLevel(),
        threadPath: () => observer.threadPath(),
        events: observer.events,
        services: {
          prompt: {
            async submit(submission: PromptSubmission): Promise<PromptReceipt> {
              const result = await host.automateTerminal(runtimeSessionId, {
                kind: 'paste',
                text: submission.text,
                submit: submission.mode !== 'paste-only',
              });
              return result.accepted ? { status: 'confirmed' } : { status: 'rejected', reason: result.reason };
            },
          },
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
