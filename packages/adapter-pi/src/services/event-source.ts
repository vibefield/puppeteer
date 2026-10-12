import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
} from '@vibefield/puppeteer-core';
import type { PiObservedEvent } from '../observation/session-observer.js';

export class PiEventSource {
  private readonly source = new BufferedAdapterEventSource();
  constructor(private readonly options: { sessionId(): string }) {}
  publish(
    event: AgentEvent,
    meta: Partial<Omit<PiObservedEvent, 'event'>> & Pick<PiObservedEvent, 'source' | 'confidence'>,
  ): void {
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.options.sessionId(),
        nativeSessionId: this.options.sessionId(),
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
