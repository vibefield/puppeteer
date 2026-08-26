import type { AgentEventConfidence, AgentEventSource, AgentEventSourceRef } from '../events/contract.js';
import { agentServiceEventType, type AgentEvent, type AgentServiceEventType } from '../events/catalog.js';
import { createEnvelopeStamper, type AgentEventEnvelope } from '../events/envelope.js';

/**
 * Normalized adapter output before runtime identity and delivery order exist.
 * The canonical `category:event-name` route is present so runtime validation
 * never needs to infer a category from provider-native evidence.
 */
export interface AdapterEventCandidateFields<T extends AgentEvent> {
  eventId?: string;
  sourceEventRef?: AgentEventSourceRef;
  sessionId: string;
  nativeSessionId?: string;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  providerVersion?: string;
  timestamp: string;
  monotonicTime: number;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  event: T;
  nativeEvent?: unknown;
}

/** Distributes over `AgentEvent`, keeping the route and event callback data correlated. */
export type AdapterEventCandidate<T extends AgentEvent = AgentEvent> = T extends AgentEvent
  ? AdapterEventCandidateFields<T> & { type: AgentServiceEventType<T> }
  : never;

export function createAdapterEventCandidate<T extends AgentEvent>(
  fields: AdapterEventCandidateFields<T>,
): AdapterEventCandidate<T> {
  return { type: agentServiceEventType(fields.event), ...fields } as AdapterEventCandidate<T>;
}

export type AdapterEventCandidateListener = (candidate: AdapterEventCandidate) => void;

/**
 * Bootstrap-safe adapter event source. `onCandidate` is the runtime ingress;
 * `onEvent` is a temporary envelope bridge for direct adapter consumers.
 */
export class BufferedAdapterEventSource {
  readonly #candidateListeners = new Set<AdapterEventCandidateListener>();
  readonly #legacyListeners = new Set<(envelope: AgentEventEnvelope) => void>();
  readonly #legacyStamper = createEnvelopeStamper();
  #pending: AdapterEventCandidate[] = [];
  #attached = false;
  #closed = false;

  emit(candidate: AdapterEventCandidate): void {
    if (this.#closed) return;
    if (!this.#attached) {
      this.#pending.push(candidate);
      return;
    }
    this.deliver(candidate);
  }

  onCandidate(listener: AdapterEventCandidateListener): () => void {
    if (this.#closed) return () => undefined;
    this.#candidateListeners.add(listener);
    this.attach();
    return () => this.#candidateListeners.delete(listener);
  }

  /** @deprecated Direct adapter consumers should move to runtime Agent events. */
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#legacyListeners.add(listener);
    this.attach();
    return () => this.#legacyListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#pending = [];
    this.#candidateListeners.clear();
    this.#legacyListeners.clear();
  }

  private attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const pending = this.#pending;
    this.#pending = [];
    for (const candidate of pending) this.deliver(candidate);
  }

  private deliver(candidate: AdapterEventCandidate): void {
    for (const listener of [...this.#candidateListeners]) {
      try {
        listener(candidate);
      } catch {
        // Adapter ingestion cannot be affected by a consumer fault.
      }
    }

    if (this.#legacyListeners.size === 0) return;
    const envelope = this.#legacyStamper.next<AgentEvent>(candidate);
    for (const listener of [...this.#legacyListeners]) {
      try {
        listener(envelope);
      } catch {
        // Compatibility listeners are isolated from ingestion and each other.
      }
    }
  }
}
