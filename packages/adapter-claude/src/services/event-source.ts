import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventSource,
} from '@vibefield/puppeteer-core';

export interface ClaudeEventPublication {
  source: AgentEventSource;
  timestamp: string;
  promptId?: string | undefined;
  turnId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  actorKey?: string | undefined;
  actorRole?: 'child' | 'auxiliary' | 'unknown' | undefined;
  providerVersion?: string | undefined;
  confidence?: AgentEventConfidence | undefined;
  native?: unknown;
  replay?: boolean | undefined;
}

export interface ClaudeEventSourceOptions {
  sessionId(): string;
  providerVersion?: string | undefined;
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
        actorKey: publication.actorKey,
        actorRole: publication.actorRole,
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

  close(): void {
    this.source.close();
  }
}
