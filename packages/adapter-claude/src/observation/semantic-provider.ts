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
  /** Retained as candidate evidence and later on the runtime envelope; never monitor state. */
  nativeEvent?: unknown;
}

export interface SemanticObservationAttachRequest {
  nativeSessionId: string;
  transcriptPath: string;
  /** Zero disables polling; an omitted value lets the provider choose its fallback cadence. */
  pollIntervalMs?: number | undefined;
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
