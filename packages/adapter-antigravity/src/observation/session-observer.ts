import { resolve } from 'node:path';
import { createAppendOnlyJsonlTail } from '@vibefield/puppeteer-native-observation';
import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  AgentEventSourceRef,
} from '@vibefield/puppeteer-core';
import { AntigravityTranscriptNormalizer } from '../normalization/pipeline.js';
import { antigravityPrompt, antigravityRecord, antigravitySourceRef } from '../normalization/types.js';
import { listAntigravitySessions, transcriptContainsPrompt, type AntigravitySessionLocation } from './session-store.js';

export interface AntigravityObservedEvent {
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
export type AntigravityPromptEchoResult = { matched: true; sessionId: string } | { matched: false; reason: string };
export interface AntigravityPromptExpectation {
  promise: Promise<AntigravityPromptEchoResult>;
  cancel(): void;
}
export interface AntigravitySessionObserver {
  sessionId(): string | undefined;
  sessionDirectory(): string | undefined;
  onEvent(listener: (event: AntigravityObservedEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onBind(listener: (location: AntigravitySessionLocation) => void): () => void;
  expectPrompt(text: string, timeoutMs: number): AntigravityPromptExpectation;
  poll(): Promise<void>;
  stop(): Promise<void>;
}

interface PromptWaiter {
  text: string;
  correlatable: boolean;
  resolve(result: AntigravityPromptEchoResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SessionDiscovery {
  baseline: Set<string>;
  waiters: Map<number, PromptWaiter>;
  boundSessionId?: string | undefined;
}

// Observers sharing a native store must not claim each other's conversations.
// Each observer remembers claims made during its lifetime, even after the
// claiming observer stops, so a delayed launch cannot adopt an older peer.
const discoveriesByRoot = new Map<string, Set<SessionDiscovery>>();

export function createAntigravitySessionObserver(options: {
  root: string;
  location?: AntigravitySessionLocation | undefined;
  replayBoundary?: number | undefined;
  baselineSessionIds?: ReadonlySet<string> | undefined;
  pollIntervalMs?: number | undefined;
  maxReplayBytes?: number | undefined;
}): AntigravitySessionObserver {
  const normalizer = new AntigravityTranscriptNormalizer();
  const events = new Set<(event: AntigravityObservedEvent) => void>();
  const errors = new Set<(error: Error) => void>();
  const binds = new Set<(location: AntigravitySessionLocation) => void>();
  const waiters = new Map<number, PromptWaiter>();
  const baseline = new Set(options.baselineSessionIds ?? []);
  let location = options.location;
  let tail = location
    ? createAppendOnlyJsonlTail(location.transcriptPath, {
        replayBoundary: options.replayBoundary,
        maxReplayBytes: options.maxReplayBytes,
      })
    : undefined;
  let waiterId = 0,
    stopped = false,
    polling: Promise<void> | undefined;
  const root = resolve(options.root);
  const discoveries = discoveriesByRoot.get(root) ?? new Set<SessionDiscovery>();
  const discovery: SessionDiscovery = { baseline, waiters, boundSessionId: options.location?.sessionId };
  for (const peer of discoveries) {
    if (peer.boundSessionId) baseline.add(peer.boundSessionId);
    if (discovery.boundSessionId) peer.baseline.add(discovery.boundSessionId);
  }
  discoveries.add(discovery);
  discoveriesByRoot.set(root, discoveries);
  const report = (value: unknown) => {
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of errors) {
      try {
        listener(error);
      } catch {}
    }
  };
  const bind = (next: AntigravitySessionLocation) => {
    if (location || stopped || baseline.has(next.sessionId)) return;
    tail = createAppendOnlyJsonlTail(next.transcriptPath, { maxReplayBytes: options.maxReplayBytes });
    location = next;
    discovery.boundSessionId = next.sessionId;
    for (const peer of discoveries) {
      if (peer !== discovery) peer.baseline.add(next.sessionId);
    }
    for (const listener of binds) {
      try {
        listener(next);
      } catch {}
    }
  };
  const discover = async () => {
    if (location) return;
    const candidates = (await listAntigravitySessions(options.root)).filter((item) => !baseline.has(item.sessionId));
    if (!candidates.length) return;
    // A newly created file proves only that some process started. Even one
    // candidate needs a prompt echo before it can identify this terminal.
    for (const [id, waiter] of waiters) {
      if (!waiter.correlatable) continue;
      const matches = [];
      for (const candidate of candidates)
        if (await transcriptContainsPrompt(candidate.transcriptPath, waiter.text)) matches.push(candidate);
      if (matches.length === 1 && waiter.correlatable && waiters.get(id) === waiter) {
        bind(matches[0]!);
        return;
      }
    }
  };
  const observePrompt = (value: unknown) => {
    if (!location) return;
    const body = antigravityRecord(value);
    if (body?.type !== 'USER_INPUT') return;
    const text = antigravityPrompt(body.content);
    for (const [id, waiter] of waiters)
      if (waiter.text === text) {
        waiters.delete(id);
        clearTimeout(waiter.timeout);
        waiter.resolve({ matched: true, sessionId: location.sessionId });
      }
  };
  const doPoll = async () => {
    if (stopped) return;
    await discover();
    if (!tail || !location) return;
    const result = await tail.poll();
    for (const diagnostic of result.diagnostics) report(new Error(diagnostic.message));
    for (const record of result.records) {
      observePrompt(record.value);
      const normalized = normalizer.normalize(record.value);
      for (const [index, event] of normalized.events.entries()) {
        const sourceEventRef = antigravitySourceRef(location.sessionId, record, `${index}:${event.type}`);
        const observed: AntigravityObservedEvent = {
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
    sessionId: () => location?.sessionId,
    sessionDirectory: () => location?.sessionDir,
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    onError(listener) {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onBind(listener) {
      binds.add(listener);
      if (location) listener(location);
      return () => binds.delete(listener);
    },
    expectPrompt(text, timeoutMs) {
      const id = ++waiterId;
      let resolve!: (result: AntigravityPromptEchoResult) => void;
      const promise = new Promise<AntigravityPromptEchoResult>((done) => {
        resolve = done;
      });
      const timeout = setTimeout(() => {
        if (waiters.delete(id))
          resolve({ matched: false, reason: 'durable Antigravity USER_INPUT confirmation timed out' });
      }, timeoutMs);
      const waiter: PromptWaiter = { text, resolve, timeout, correlatable: true };
      if (!location) {
        for (const peer of discoveries) {
          if (peer.boundSessionId) continue;
          for (const pending of peer.waiters.values()) {
            if (pending.text !== text) continue;
            // Identical concurrent submissions cannot identify either launch,
            // even if one transcript becomes visible before the other.
            pending.correlatable = false;
            waiter.correlatable = false;
          }
        }
      }
      waiters.set(id, waiter);
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
        waiter.resolve({ matched: false, reason: 'Antigravity observer stopped' });
      }
      waiters.clear();
      events.clear();
      errors.clear();
      binds.clear();
      discoveries.delete(discovery);
      if (discoveries.size === 0) discoveriesByRoot.delete(root);
    },
  };
}
