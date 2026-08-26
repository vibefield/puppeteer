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

export interface GrokEventPublication {
  promptId?: string;
  turnId?: string;
  timestamp?: string;
  source?: AgentEventSource;
  confidence?: AgentEventConfidence;
  replay?: boolean;
  nativeEvent?: unknown;
}

/** Publishes merged Grok log/ACP events as unstamped runtime candidates. */
export class GrokEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly sessionId: string) {}

  publish(event: AgentEvent, publication: GrokEventPublication = {}): void {
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.sessionId,
        nativeSessionId: this.sessionId,
        promptId: publication.promptId,
        turnId: publication.turnId,
        timestamp: publication.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: publication.source ?? 'native-transcript',
        confidence: publication.confidence ?? 'authoritative',
        replay: publication.replay,
        event,
        nativeEvent: publication.nativeEvent,
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
