import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibecook/puppeteer-core';

export interface OpenCodeNormalizedEvent {
  event: AgentEvent;
  promptId?: string;
  turnId?: string;
  timestamp: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  nativeEvent: unknown;
}

export interface NormalizeOpenCodeOptions {
  replay?: boolean;
  /** Durable HTTP projections retain their source response here. */
  nativeEvent?: unknown;
}

export interface OpenCodeNormalizerOptions {
  sessionID: string;
  contextWindowCapacityTokens?: number | undefined;
  maxSeenEventIds?: number | undefined;
  maxCorrelationEntries?: number | undefined;
}

export interface OpenCodeTextPartState {
  kind: 'text' | 'reasoning';
  text: string;
  final: boolean;
}
