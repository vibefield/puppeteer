import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventEnvelope,
  type AgentEventSource,
} from '@vibecook/puppeteer-core';

export interface ClaudeEventPublication {
  source: AgentEventSource;
  timestamp: string;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  providerVersion?: string;
  confidence?: AgentEventConfidence;
  native?: unknown;
  replay?: boolean;
}

export interface ClaudeEventSourceOptions {
  sessionId(): string;
  providerVersion?: string;
}

/** Publishes normalized Claude hook/transcript/status events as candidates. */
export class ClaudeEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly options: ClaudeEventSourceOptions) {}

  publish(event: AgentEvent, publication: ClaudeEventPublication): void {
    const sessionId = this.options.sessionId();
    this.source.emit(
      createAdapterEventCandidate({
        sessionId,
        nativeSessionId: sessionId,
        promptId: publication.promptId,
        turnId: publication.turnId,
        agentId: publication.agentId,
        agentType: publication.agentType,
        providerVersion: publication.providerVersion ?? this.options.providerVersion,
        timestamp: publication.timestamp,
        monotonicTime: performance.now(),
        source: publication.source,
        confidence: publication.confidence ?? 'authoritative',
        replay: publication.replay,
        event,
        nativeEvent: publication.native,
      }),
    );
  }

  onCandidate(listener: (candidate: AdapterEventCandidate) => void): () => void {
    return this.source.onCandidate(listener);
  }

  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    return this.source.onEvent(listener);
  }

  close(): void {
    this.source.close();
  }
}
