import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventSource,
} from '@vibecook/puppeteer-core';

export interface HermesEventPublication {
  nativeSessionId?: string | undefined;
  turnId?: string | undefined;
  timestamp: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  nativeEvent?: unknown;
}

/** Publishes normalized Hermes gateway events as unstamped runtime candidates. */
export class HermesEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly sessionId: string) {}

  publish(event: AgentEvent, publication: HermesEventPublication): void {
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.sessionId,
        nativeSessionId: publication.nativeSessionId ?? this.sessionId,
        turnId: publication.turnId,
        timestamp: publication.timestamp,
        monotonicTime: performance.now(),
        source: publication.source,
        confidence: publication.confidence,
        replay: publication.replay,
        event,
        nativeEvent: publication.nativeEvent,
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
