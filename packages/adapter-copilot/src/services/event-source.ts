import { performance } from 'node:perf_hooks';
import {
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
  type AdapterEventCandidate,
  type AgentEvent,
} from '@vibefield/puppeteer-core';
import type { CopilotObservedEvent } from '../observation/session-observer.js';
export class CopilotEventSource {
  private readonly source = new BufferedAdapterEventSource();
  constructor(private readonly sessionId: string) {}
  publish(
    event: AgentEvent,
    meta: Partial<Omit<CopilotObservedEvent, 'event'>> & Pick<CopilotObservedEvent, 'source' | 'confidence'>,
  ) {
    this.source.emit(
      createAdapterEventCandidate({
        sessionId: this.sessionId,
        nativeSessionId: this.sessionId,
        timestamp: meta.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: meta.source,
        confidence: meta.confidence,
        event,
        ...(meta.promptId ? { promptId: meta.promptId } : {}),
        ...(meta.turnId ? { turnId: meta.turnId } : {}),
        ...(meta.agentId ? { agentId: meta.agentId } : {}),
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
