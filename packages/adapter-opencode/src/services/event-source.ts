import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
} from '@vibecook/puppeteer-core';
import type { OpenCodeNormalizedEvent } from '../normalization/pipeline.js';

export interface OpenCodeEventSourceOptions {
  sessionId(): string;
  nativeSessionId(): string | undefined;
}

/** Publishes normalized OpenCode REST/SSE output as runtime candidates. */
export class OpenCodeEventSource {
  private readonly source = new BufferedAdapterEventSource();

  constructor(private readonly options: OpenCodeEventSourceOptions) {}

  publish(normalized: OpenCodeNormalizedEvent): void {
    const nativeSessionId = this.options.nativeSessionId();
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.options.sessionId(),
        nativeSessionId,
        promptId: normalized.promptId,
        turnId: normalized.turnId,
        timestamp: normalized.timestamp,
        monotonicTime: performance.now(),
        source: normalized.source,
        confidence: normalized.confidence,
        replay: normalized.replay,
        event: normalized.event,
        nativeEvent: normalized.nativeEvent,
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

export function runtimeOpenCodeEvent(event: AgentEvent, nativeEvent: unknown): OpenCodeNormalizedEvent {
  return {
    event,
    timestamp: new Date().toISOString(),
    source: 'runtime',
    confidence: 'derived',
    nativeEvent,
  };
}
