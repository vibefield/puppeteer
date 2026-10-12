import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventSource,
} from '@vibefield/puppeteer-core';

export interface CodexEventSourceOptions {
  sessionId(): string;
  turnId(): string | undefined;
}

/** Converts category-normalized Codex events into unstamped runtime candidates. */
export class CodexEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly options: CodexEventSourceOptions) {}

  publish(
    event: AgentEvent,
    source: AgentEventSource,
    nativeEvent?: unknown,
    confidence: AgentEventConfidence = 'authoritative',
    replay = false,
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
        ...(replay ? { replay: true } : {}),
        event,
        nativeEvent,
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
