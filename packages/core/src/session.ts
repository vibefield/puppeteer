/**
 * The agent-agnostic session contract (DESIGN §9), lifted into core once a
 * second driver existed to test it against (M5: Claude's hook+PTY driver and
 * Codex's structured app-server driver). Before that, the adapter session lived as a
 * concrete `ClaudeSession` in the Claude adapter — lifting off one example
 * would have baked in Claude's shape.
 *
 * Zero I/O by design (like the rest of core): interfaces only. Concrete drivers
 * (`createClaudeSession`, `createCodexSession`, and peers) implement these.
 */

import type { AgentEventEnvelope, ObservationLevel } from './events.js';
import type { MonitorArtifactReadResult } from './monitor/types.js';

/**
 * A programmatic prompt submission (generalized from the Claude guarded
 * injector, DESIGN §17).
 */
export interface PromptSubmission {
  text: string;
  /**
   * Paste-and-submit (default) appends Enter; paste-only leaves it staged.
   * Meaningful only to guarded-paste (native-TUI) injectors; structured drivers
   * submit atomically and ignore it.
   */
  mode?: 'paste-and-submit' | 'paste-only';
  confirmationTimeoutMs?: number;
}

/**
 * Outcome of a prompt submission. `uncertain` is first-class: a guarded-paste
 * injector cannot always prove the agent accepted exactly our text (DESIGN
 * §17). Structured drivers normally confirm through protocol correlation, but
 * still emit `uncertain` if that proof channel disappears after submission.
 */
export type PromptReceipt =
  | { status: 'confirmed'; turnId?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

/**
 * The low-level handle every adapter returns for one live agent process/thread.
 * It produces only normalized events plus explicit control operations. Derived
 * state, context, conversation, and monitor projections belong to the runtime's
 * per-spawn Agent instance, never to an adapter.
 *
 * Process lifecycle (spawn/terminate) belongs to the host, not this handle;
 * `dispose()` tears down observation/control only. Adapters MAY extend the
 * handle with native diagnostics, but applications consume runtime Agent.
 */
export interface AgentAdapterSession {
  /** Native/join id — the chopsticks ↔ spaghetti correlation key. */
  readonly sessionId: string;
  /** The host's id for the terminal session (attach/write/kill routing). */
  readonly runtimeSessionId: string;
  /** Honest, current observation level — never overstated (DESIGN §19.2). */
  observationLevel(): ObservationLevel;
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  /** Optional resolution of adapter-issued opaque artifact references. */
  readMonitorArtifact?(artifactId: string, options: { maxBytes: number }): Promise<MonitorArtifactReadResult>;
  submitPrompt(submission: PromptSubmission): Promise<PromptReceipt>;
  /** Tear down observation/control. Process lifecycle stays with the host. */
  dispose(): Promise<void>;
}

/** @deprecated Low-level compatibility name. Prefer AgentAdapterSession. */
export type AgentSession = AgentAdapterSession;
