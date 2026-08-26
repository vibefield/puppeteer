import { z } from 'zod';
import {
  AgentEventConfidenceSchema,
  AgentEventSourceRefSchema,
  AgentEventSourceSchema,
  type AgentEventConfidence,
  type AgentEventSource,
  type AgentEventSourceRef,
} from '../events/contract.js';
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
  actorKey?: string;
  actorRole?: 'child' | 'auxiliary' | 'unknown';
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

const NonEmptyStringSchema = z.string().trim().min(1);

/** Runtime schema for candidate correlation/evidence metadata; event payload validation is route-specific. */
export const AdapterEventCandidateSchema = z
  .strictObject({
    type: NonEmptyStringSchema,
    eventId: NonEmptyStringSchema.optional(),
    sourceEventRef: AgentEventSourceRefSchema.optional(),
    sessionId: NonEmptyStringSchema,
    nativeSessionId: NonEmptyStringSchema.optional(),
    promptId: NonEmptyStringSchema.optional(),
    turnId: NonEmptyStringSchema.optional(),
    agentId: NonEmptyStringSchema.optional(),
    agentType: NonEmptyStringSchema.optional(),
    actorKey: NonEmptyStringSchema.optional(),
    actorRole: z.enum(['child', 'auxiliary', 'unknown']).optional(),
    providerVersion: NonEmptyStringSchema.optional(),
    timestamp: z.iso.datetime({ offset: true }),
    monotonicTime: z.number().finite().nonnegative(),
    source: AgentEventSourceSchema,
    confidence: AgentEventConfidenceSchema,
    replay: z.boolean().optional(),
    event: z.unknown(),
    nativeEvent: z.unknown().optional(),
  })
  .superRefine((candidate, context) => {
    if (candidate.agentId && candidate.actorKey) {
      context.addIssue({ code: 'custom', message: 'candidate cannot carry both exact agentId and derived actorKey' });
    }
    if (candidate.actorRole && !candidate.agentId && !candidate.actorKey) {
      context.addIssue({ code: 'custom', message: 'actorRole requires agentId or actorKey' });
    }
    if (candidate.eventId && candidate.sourceEventRef && candidate.eventId !== candidate.sourceEventRef.eventId) {
      context.addIssue({ code: 'custom', message: 'eventId must match sourceEventRef.eventId' });
    }
  });

export function createAdapterEventCandidate<T extends AgentEvent>(
  fields: AdapterEventCandidateFields<T>,
): AdapterEventCandidate<T> {
  return { ...fields, type: agentServiceEventType(fields.event) } as AdapterEventCandidate<T>;
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
  readonly #pendingCapacity: number;
  #candidatePending: AdapterEventCandidate[] = [];
  #legacyPending: AdapterEventCandidate[] = [];
  #candidateAttached = false;
  #legacyAttached = false;
  #closed = false;

  constructor(options: { pendingCapacity?: number } = {}) {
    this.#pendingCapacity = options.pendingCapacity ?? 256;
    if (!Number.isSafeInteger(this.#pendingCapacity) || this.#pendingCapacity < 1) {
      throw new RangeError('adapter event pendingCapacity must be a positive safe integer');
    }
  }

  emit(candidate: AdapterEventCandidate): void {
    if (this.#closed) return;
    Object.freeze(candidate.event);
    Object.freeze(candidate);
    if (this.#candidateAttached) this.deliverCandidate(candidate);
    else this.buffer(this.#candidatePending, candidate);
    if (this.#legacyAttached) this.deliverLegacy(candidate);
    else this.buffer(this.#legacyPending, candidate);
  }

  onCandidate(listener: AdapterEventCandidateListener): () => void {
    if (this.#closed) return () => undefined;
    this.#candidateListeners.add(listener);
    if (!this.#candidateAttached) {
      this.#candidateAttached = true;
      const pending = this.#candidatePending;
      this.#candidatePending = [];
      for (const candidate of pending) this.deliverCandidate(candidate);
    }
    return () => this.#candidateListeners.delete(listener);
  }

  /** @deprecated Direct adapter consumers should move to runtime Agent events. */
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#legacyListeners.add(listener);
    if (!this.#legacyAttached) {
      this.#legacyAttached = true;
      const pending = this.#legacyPending;
      this.#legacyPending = [];
      for (const candidate of pending) this.deliverLegacy(candidate);
    }
    return () => this.#legacyListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#candidatePending = [];
    this.#legacyPending = [];
    this.#candidateListeners.clear();
    this.#legacyListeners.clear();
  }

  private buffer(buffer: AdapterEventCandidate[], candidate: AdapterEventCandidate): void {
    buffer.push(candidate);
    if (buffer.length > this.#pendingCapacity) buffer.splice(0, buffer.length - this.#pendingCapacity);
  }

  private deliverCandidate(candidate: AdapterEventCandidate): void {
    for (const listener of [...this.#candidateListeners]) {
      try {
        listener(candidate);
      } catch {
        // Adapter ingestion cannot be affected by a consumer fault.
      }
    }
  }

  private deliverLegacy(candidate: AdapterEventCandidate): void {
    const envelope = this.#legacyStamper.next<AgentEvent>(candidate);
    Object.freeze(envelope);
    for (const listener of [...this.#legacyListeners]) {
      try {
        listener(envelope);
      } catch {
        // Compatibility listeners are isolated from ingestion and each other.
      }
    }
  }
}
