import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
} from '@vibecook/puppeteer-core';
import type { KimiObservedEvent } from '../session-observer.js';

export interface KimiEventSourceOptions {
  sessionId(): string;
  nativeSessionId(): string | undefined;
}

/** Publishes normalized Kimi journal events as unstamped runtime candidates. */
export class KimiEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly options: KimiEventSourceOptions) {}

  publish(
    event: AgentEvent,
    meta: Pick<KimiObservedEvent, 'promptId' | 'turnId' | 'timestamp' | 'source' | 'confidence' | 'replay'> & {
      nativeEvent?: unknown;
    },
  ): void {
    const nativeSessionId = this.options.nativeSessionId();
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.options.sessionId(),
        nativeSessionId,
        promptId: meta.promptId,
        turnId: meta.turnId,
        timestamp: meta.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: meta.source,
        confidence: meta.confidence,
        replay: meta.replay,
        event,
        nativeEvent: meta.nativeEvent,
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
