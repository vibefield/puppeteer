import { createAppendOnlyJsonlTail } from '@vibefield/puppeteer-native-observation';
import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  AgentEventSourceRef,
} from '@vibefield/puppeteer-core';
import { PiSessionNormalizer } from '../normalization/pipeline.js';
import { piSourceRef } from '../normalization/types.js';
import { findPiSession, type PiSessionLocation } from './session-store.js';

export interface PiObservedEvent {
  event: AgentEvent;
  promptId?: string;
  turnId?: string;
  timestamp?: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  eventId?: string;
  sourceEventRef?: AgentEventSourceRef;
  nativeEvent: unknown;
}

export interface PiSessionObserver {
  sessionId(): string;
  sessionFile(): string | undefined;
  onEvent(listener: (event: PiObservedEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onBind(listener: (location: PiSessionLocation) => void): () => void;
  poll(): Promise<void>;
  stop(): Promise<void>;
}

export function createPiSessionObserver(options: {
  sessionDir: string;
  sessionId: string;
  location?: PiSessionLocation | undefined;
  replayBoundary?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxReplayBytes?: number | undefined;
}): PiSessionObserver {
  const eventListeners = new Set<(event: PiObservedEvent) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const bindListeners = new Set<(location: PiSessionLocation) => void>();
  const normalizer = new PiSessionNormalizer();
  let location = options.location;
  let tail = location
    ? createAppendOnlyJsonlTail(location.path, {
        replayBoundary: options.replayBoundary,
        maxReplayBytes: options.maxReplayBytes,
      })
    : undefined;
  let stopped = false;
  let polling: Promise<void> | undefined;

  const report = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of errorListeners) {
      try {
        listener(normalized);
      } catch {}
    }
  };
  const bind = (next: PiSessionLocation) => {
    if (location) return;
    location = next;
    tail = createAppendOnlyJsonlTail(next.path, { maxReplayBytes: options.maxReplayBytes });
    for (const listener of bindListeners) {
      try {
        listener(next);
      } catch {}
    }
  };
  const doPoll = async () => {
    if (stopped) return;
    if (!location) {
      const candidate = await findPiSession(options.sessionDir, options.sessionId);
      if (candidate) bind(candidate);
    }
    if (!tail) return;
    const result = await tail.poll();
    for (const diagnostic of result.diagnostics) report(new Error(diagnostic.message));
    for (const record of result.records) {
      const normalized = normalizer.normalize(record.value);
      for (const [index, event] of normalized.events.entries()) {
        const sourceEventRef = piSourceRef(options.sessionId, record, `${index}:${event.type}`);
        const observed: PiObservedEvent = {
          event,
          source: normalized.source,
          confidence: normalized.confidence,
          nativeEvent: record.value,
          replay: record.replay,
          eventId: sourceEventRef.eventId,
          sourceEventRef,
          ...(normalized.timestamp ? { timestamp: normalized.timestamp } : {}),
          ...(normalized.promptId ? { promptId: normalized.promptId } : {}),
          ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
        };
        for (const listener of eventListeners) {
          try {
            listener(observed);
          } catch {}
        }
      }
    }
  };
  const poll = () =>
    (polling ??= doPoll()
      .catch(report)
      .finally(() => {
        polling = undefined;
      }));
  const timer = setInterval(() => void poll(), options.pollIntervalMs ?? 100);
  timer.unref?.();
  return {
    sessionId: () => options.sessionId,
    sessionFile: () => location?.path,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onBind(listener) {
      bindListeners.add(listener);
      if (location) listener(location);
      return () => bindListeners.delete(listener);
    },
    poll,
    async stop() {
      if (stopped) return;
      clearInterval(timer);
      await poll();
      stopped = true;
      eventListeners.clear();
      errorListeners.clear();
      bindListeners.clear();
    },
  };
}
