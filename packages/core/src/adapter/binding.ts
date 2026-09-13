/**
 * Provider-neutral low-level adapter binding. Runtime wraps exactly one of
 * these handles in its application-facing `Agent`.
 *
 * Zero I/O by design (like the rest of core): interfaces only. Concrete drivers
 * (`createClaudeSession`, `createCodexSession`, and peers) implement these.
 */

import type { ObservationLevel } from '../events/index.js';
import type { AgentAdapterEventSource, AgentPromptService } from '../services/index.js';

/**
 * The low-level handle every adapter returns for one live agent process/thread.
 * It produces only normalized events plus explicit control operations. Derived
 * state, context, and monitor projections belong to the runtime's
 * per-spawn Agent instance, never to an adapter.
 *
 * Process lifecycle (spawn/terminate) belongs to the host, not this handle;
 * `dispose()` tears down observation/control only. Adapters MAY extend the
 * handle with native diagnostics, but applications consume runtime Agent.
 */
export interface AgentAdapterBinding {
  /** Provider-native correlation id shared by its live and durable observation planes. */
  readonly sessionId: string;
  /** The host's id for the terminal session (attach/write/kill routing). */
  readonly runtimeSessionId: string;
  /** Honest, current observation level — never overstated (DESIGN §19.2). */
  observationLevel(): ObservationLevel;
  /** Unstamped normalized facts. Runtime is the only owner of validation and envelopes. */
  readonly events: AgentAdapterEventSource;
  /** Explicit upper-level capabilities; commands never travel inside event payloads. */
  readonly services: {
    readonly prompt: AgentPromptService;
  };
  /**
   * Tear down observation/control. Process lifecycle stays with the host.
   * With `release` (stable ingress) the HOST is leaving and the process is
   * not: the binding closes what the host holds — listeners, tails — and
   * keeps everything the running process depends on (the staged launch files
   * it execs on every hook) exactly where the process reads them.
   */
  dispose(options?: AdapterDisposeOptions): Promise<void>;
}

/** How a binding is being torn down (stable ingress). */
export interface AdapterDisposeOptions {
  /** The host leaves; the process stays. Nothing the process depends on is removed. */
  readonly release?: boolean | undefined;
}
