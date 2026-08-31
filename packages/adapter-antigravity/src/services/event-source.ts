import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
} from '@vibecook/puppeteer-core';
import type { AntigravityObservedEvent } from '../observation/session-observer.js';
export class AntigravityEventSource {
  private readonly source = new BufferedAdapterEventSource();
  constructor(private readonly options: { sessionId(): string; nativeSessionId(): string | undefined }) {}
  publish(
    event: AgentEvent,
    meta: Partial<Omit<AntigravityObservedEvent, 'event'>> & Pick<AntigravityObservedEvent, 'source' | 'confidence'>,
  ) {
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.options.sessionId(),
        ...(this.options.nativeSessionId() ? { nativeSessionId: this.options.nativeSessionId() } : {}),
        timestamp: meta.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: meta.source,
        confidence: meta.confidence,
        event,
        ...(meta.promptId ? { promptId: meta.promptId } : {}),
        ...(meta.turnId ? { turnId: meta.turnId } : {}),
        ...(meta.replay !== undefined ? { replay: meta.replay } : {}),
        ...(meta.eventId ? { eventId: meta.eventId } : {}),
        ...(meta.sourceEventRef ? { sourceEventRef: meta.sourceEventRef } : {}),
        ...(meta.nativeEvent !== undefined ? { nativeEvent: meta.nativeEvent } : {}),
      }),
    );
  }
  onCandidate(listener: (candidate: AdapterEventCandidate) => void) {
    return this.source.onCandidate(listener);
  }
  close() {
    this.source.close();
  }
}
