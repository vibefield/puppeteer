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

export interface AcpEventSourceOptions {
  sessionId(): string;
  turnId(): string | undefined;
}

/** Converts category-normalized ACP events into unstamped runtime candidates. */
export class AcpEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly options: AcpEventSourceOptions) {}

  publish(
    event: AgentEvent,
    source: AgentEventSource,
    nativeEvent?: unknown,
    confidence: AgentEventConfidence = 'authoritative',
  ): void {
    const sessionId = this.options.sessionId();
    this.source.emit(
      createAdapterEventCandidate({
        sessionId,
        nativeSessionId: sessionId,
        turnId: this.options.turnId(),
        timestamp: new Date().toISOString(),
        monotonicTime: performance.now(),
        source,
        confidence,
        event,
        nativeEvent,
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
