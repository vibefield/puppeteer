/**
 * Adapter-local semantic observation boundary.
 *
 * Implementations own provider files and polling. Only normalized events,
 * optional correction-aware monitor batches and capabilities cross this boundary.
 */

import type { AgentEvent } from '@vibefield/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';

export interface SemanticObservationPollHint {
  hookEventName?: string | undefined;
  nativeSessionId?: string | undefined;
  promptId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
}

export interface SemanticObservationEvent {
  event: AgentEvent;
  timestamp: string;
  promptId?: string | undefined;
  turnId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  replay?: boolean | undefined;
  /**
   * What an attach's first read found still open (a turn, a tool, a question): the live rail's own end for it (a
   * PostToolUse, the turn's Stop) closes it, as it would close one the rail had announced.
   */
  openAtAttach?: boolean | undefined;
  /** Retained as candidate evidence and later on the runtime envelope; never monitor state. */
  nativeEvent?: unknown;
}

export interface SemanticObservationAttachRequest {
  nativeSessionId: string;
  transcriptPath: string;
  /** Zero disables polling; an omitted value lets the provider choose its fallback cadence. */
  pollIntervalMs?: number | undefined;
  /**
   * The session was running before this observer, which a restarted host attached to it. The first read publishes
   * what the durable record shows still open, so the agent shows the state it is in rather than waiting for its next
   * hook: the open work as replay, and a question it waits on live, once. Never set for a launch, a resume or a
   * rebind, whose process is not in the middle of what the record last shows.
   */
  attached?: boolean | undefined;
}

export interface SemanticObservationHandle {
  onEvent(listener: (event: SemanticObservationEvent) => void): () => void;
  onBatch(listener: (batch: AdapterMonitorObservationBatch) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  poll(hint?: SemanticObservationPollHint): Promise<void>;
  dispose(): Promise<void>;
}

/** Stable seam for session-scoped durable observation; no external SDK contract leaks through it. */
export interface SemanticObservationProvider {
  capabilities(): Promise<readonly ObservationCapability[]>;
  attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle>;
}
