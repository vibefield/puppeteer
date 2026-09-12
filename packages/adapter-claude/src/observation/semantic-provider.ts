/**
 * Adapter-local semantic observation boundary.
 *
 * Implementations own provider files and polling. Only normalized events,
 * optional correction-aware monitor batches, capabilities, and opaque artifact
 * reads cross this boundary.
 */

import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { MonitorArtifactReadResult } from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export interface SemanticObservationPollHint {
  hookEventName?: string;
  nativeSessionId?: string;
  promptId?: string;
  agentId?: string;
  agentType?: string;
}

export interface SemanticObservationEvent {
  event: AgentEvent;
  timestamp: string;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  replay?: boolean;
  /** Retained as candidate evidence and later on the runtime envelope; never monitor state. */
  nativeEvent?: unknown;
}

export interface SemanticObservationAttachRequest {
  nativeSessionId: string;
  transcriptPath: string;
  /** Zero disables polling; an omitted value lets the provider choose its fallback cadence. */
  pollIntervalMs?: number;
}

export interface SemanticObservationHandle {
  onEvent(listener: (event: SemanticObservationEvent) => void): () => void;
  onBatch(listener: (batch: AdapterMonitorObservationBatch) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  poll(hint?: SemanticObservationPollHint): Promise<void>;
  readArtifact(artifactId: string, options: { maxBytes: number }): Promise<MonitorArtifactReadResult>;
  dispose(): Promise<void>;
}

/** Stable seam for session-scoped durable observation; no external SDK contract leaks through it. */
export interface SemanticObservationProvider {
  capabilities(): Promise<readonly ObservationCapability[]>;
  attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle>;
}
