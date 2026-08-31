import { createAppendOnlyJsonlTail } from '@vibecook/puppeteer-native-observation';
import type { AgentEvent, AgentEventConfidence, AgentEventSource, AgentEventSourceRef } from '@vibecook/puppeteer-core';
import { CopilotSessionNormalizer } from '../normalization/pipeline.js';
import { copilotRecord, copilotSourceRef } from '../normalization/types.js';
import type { CopilotSessionLocation } from './session-store.js';

export interface CopilotObservedEvent {
  event: AgentEvent;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  timestamp?: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  eventId?: string;
  sourceEventRef?: AgentEventSourceRef;
  nativeEvent: unknown;
}
export type CopilotPromptEchoResult = { matched: true } | { matched: false; reason: string };
export interface CopilotPromptExpectation {
  promise: Promise<CopilotPromptEchoResult>;
  cancel(): void;
}
export interface CopilotSessionObserver {
  sessionId(): string;
  sessionDirectory(): string;
  onEvent(listener: (event: CopilotObservedEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  expectPrompt(text: string, timeoutMs: number): CopilotPromptExpectation;
  poll(): Promise<void>;
  stop(): Promise<void>;
}
export function createCopilotSessionObserver(options: {
  location: CopilotSessionLocation;
  replayBoundary?: number;
  pollIntervalMs?: number;
  maxReplayBytes?: number;
}): CopilotSessionObserver {
  const normalizer = new CopilotSessionNormalizer();
  const tail = createAppendOnlyJsonlTail(options.location.eventsPath, {
    replayBoundary: options.replayBoundary,
    maxReplayBytes: options.maxReplayBytes,
  });
  const events = new Set<(event: CopilotObservedEvent) => void>();
  const errors = new Set<(error: Error) => void>();
  const waiters = new Map<
    number,
    { text: string; resolve(result: CopilotPromptEchoResult): void; timeout: ReturnType<typeof setTimeout> }
  >();
  let waiterId = 0,
    stopped = false,
    polling: Promise<void> | undefined;
  const report = (value: unknown) => {
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of errors) {
      try {
        listener(error);
      } catch {}
    }
  };
  const observePrompt = (value: unknown) => {
    const body = copilotRecord(value),
      data = copilotRecord(body?.data);
    if (body?.type !== 'user.message' || typeof data?.content !== 'string') return;
    for (const [id, waiter] of waiters)
      if (waiter.text === data.content) {
        waiters.delete(id);
        clearTimeout(waiter.timeout);
        waiter.resolve({ matched: true });
      }
  };
  const doPoll = async () => {
    if (stopped) return;
    const result = await tail.poll();
    for (const diagnostic of result.diagnostics) report(new Error(diagnostic.message));
    for (const record of result.records) {
      observePrompt(record.value);
      const normalized = normalizer.normalize(record.value);
      for (const [index, event] of normalized.events.entries()) {
        const sourceEventRef = copilotSourceRef(options.location.sessionId, record, `${index}:${event.type}`);
        const observed: CopilotObservedEvent = {
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
          ...(normalized.agentId ? { agentId: normalized.agentId } : {}),
        };
        for (const listener of events) {
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
    sessionId: () => options.location.sessionId,
    sessionDirectory: () => options.location.sessionDir,
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    onError(listener) {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    expectPrompt(text, timeoutMs) {
      const id = ++waiterId;
      let resolve!: (result: CopilotPromptEchoResult) => void;
      const promise = new Promise<CopilotPromptEchoResult>((done) => {
        resolve = done;
      });
      const timeout = setTimeout(() => {
        if (waiters.delete(id))
          resolve({ matched: false, reason: 'durable Copilot user.message confirmation timed out' });
      }, timeoutMs);
      waiters.set(id, { text, resolve, timeout });
      return {
        promise,
        cancel() {
          const waiter = waiters.get(id);
          if (!waiter) return;
          waiters.delete(id);
          clearTimeout(waiter.timeout);
          waiter.resolve({ matched: false, reason: 'prompt confirmation cancelled' });
        },
      };
    },
    poll,
    async stop() {
      if (stopped) return;
      clearInterval(timer);
      await poll();
      stopped = true;
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.resolve({ matched: false, reason: 'Copilot observer stopped' });
      }
      waiters.clear();
      events.clear();
      errors.clear();
    },
  };
}
