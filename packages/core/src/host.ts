/**
 * AgentHost — the terminal/process capability an application host (desktop
 * app, CLI, …) lends to an adapter so the adapter can own its FULL native-TUI
 * launch recipe without owning PTY infrastructure. The normal path asks the
 * host to spawn it; split-phase preparation can instead bind the recipe to an
 * existing caller-owned terminal before an external shim execs it. This lifts
 * the Claude adapter's `ports` shape (DESIGN §16) into core so every adapter
 * shares ONE injection point. It is what lets the Codex app-server +
 * `codex --remote` and Grok leader + `grok --leader` recipes move out of the
 * app and into their adapters (ADR-007: process lifecycle belongs to the host;
 * the adapter only asks the host to spawn/automate, or binds an existing
 * terminal, and observes/controls the result).
 */

/** An authoritative native terminal recipe for a host spawn or caller-owned exec. */
export interface TerminalSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment for the spawned process (merged over the host's base). */
  env?: Record<string, string> | undefined;
  /** Initial geometry; the host may substitute its own default when omitted. */
  cols?: number | undefined;
  rows?: number | undefined;
}

/**
 * The capability surface an adapter needs from its host. Deliberately tiny:
 * spawn a terminal and write raw bytes to one. Everything else (transcripts,
 * app-servers, leaders, sockets) the adapter builds itself.
 */
export type TerminalAutomationOperation =
  { kind: 'paste'; text: string; submit: boolean } | { kind: 'text'; text: string } | { kind: 'interrupt' };

export type TerminalAutomationResult =
  { accepted: true } | { accepted: false; reason: 'human-input-conflict' | string };

export interface AgentHost {
  /** Spawn a native terminal for the agent; returns the host's routing id. */
  spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }>;
  /**
   * Submit one semantic automation operation. The terminal service orders it
   * atomically against accepted human input without attaching a view, taking
   * focus, or claiming resize control.
   */
  automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
  /**
   * The complete environment for a helper process the adapter spawns itself (a private app-server, a leader, a
   * `serve` backend): the host's agent-environment policy applied over the adapter's own variables, as
   * {@link spawnTerminal} applies it to {@link TerminalSpec.env}. Such a helper runs the agent's model calls and
   * tools, so it must run under the agent's environment, never the host process's own, which may carry the
   * host's secrets. Absent = the adapter merges its variables over its own process environment.
   */
  helperEnvironment?(env: Record<string, string>): Record<string, string>;
}

/**
 * The options every native-TUI session factory accepts. Each adapter's
 * `createXTuiSession` extends this with its own extras (executable, sandbox, …)
 * and returns an {@link AgentAdapterBinding} whose `runtimeSessionId` is the terminal
 * the host spawned or the caller adopted and whose `dispose()` tears down the
 * adapter's own backing services (observer, app-server, leader client).
 */
export interface AgentTuiSessionOptions {
  cwd: string;
  /** Resume an existing session by its native/join id. */
  resume?: string | undefined;
  /** The host capability the adapter spawns/writes its terminal through. */
  host: AgentHost;
  /** The host's say over the session's loopback ingress (see {@link HostIngress}). */
  ingress?: HostIngress | undefined;
}

/**
 * Stable ingress — the host's say over the loopback endpoint an adapter's
 * process posts to (hooks, status lines, telemetry). An adapter that binds one
 * mints it ephemeral by default; a host that outlives its own process
 * (a daemon that restarts under a running agent) needs that endpoint to be
 * PINNABLE and REPORTED, so it can persist `{port, token}` beside the session
 * and hand them back to `attachSession` after a restart: the running agent keeps
 * posting to the same port with the same bearer, and a rebound listener picks
 * the stream up where the old host left it. Adapters without an ingress ignore
 * this entirely; `onBound` is never called for them.
 */
export interface HostIngress {
  /** Bind this port (a re-attach to a process launched against it). Absent or 0 = ephemeral. */
  port?: number | undefined;
  /** Use this bearer token. Absent = the adapter mints one. */
  token?: string | undefined;
  /** The ingress actually bound, reported once the listener is up and BEFORE the process launches. */
  onBound?: ((bound: BoundIngress) => void) | undefined;
  /**
   * The adapter's {@link AgentAttachRecord}, reported BEFORE the process launches and again whenever what it holds
   * changes (a helper reborn on a new endpoint): the host keeps the latest beside the session and hands it back to
   * `attachSession`. Adapters with nothing to find again beyond the continuation never call it.
   */
  onAttachRecord?: ((record: AgentAttachRecord) => void) | undefined;
}

/**
 * One adapter's attach record for one session (stable ingress, the restart half): what the adapter must find again
 * to bind to its running process once the host is back, beyond the continuation, which is captured before the
 * process exists and holds no secret. A helper's endpoint, pid and start time, or a provisional id's launch anchor.
 *
 * The record is the adapter's alone. The host never reads it: it keeps the latest one owner-only beside the session
 * (as it keeps the ingress bearer), and hands it back to `attachSession` exactly as reported. Neither field is ever
 * logged or put in a launch recipe.
 *
 * - `version` is the adapter's own format. An attach that meets a version it does not know refuses with
 *   {@link AgentAttachRefusedError} and never guesses: a host may restart under a newer adapter than the one that
 *   launched the process.
 * - `secret` holds what must not sit in `state`: a helper's password or bearer, or an endpoint's nonce.
 *
 * An adapter that attaches to an endpoint its process did not just bind in this host (a helper that outlived the
 * host) binds that endpoint to the process before it trusts it. The helper answers a per-run nonce kept in `secret`,
 * or the host's own process service names the endpoint's peer. Any other answer means the backend is gone, which
 * is a refusal with its next step, never an attach: a same-uid process can take a freed socket path or port.
 */
export interface AgentAttachRecord {
  version: number;
  state: string;
  secret?: string | undefined;
}

/** The ingress a session's process was launched against. */
export interface BoundIngress {
  port: number;
  token: string;
}
