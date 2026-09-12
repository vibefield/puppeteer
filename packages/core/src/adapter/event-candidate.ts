import { z } from 'zod';
import {
  AgentEventConfidenceSchema,
  AgentEventSourceRefSchema,
  AgentEventSourceSchema,
  type AgentEventConfidence,
  type AgentEventSource,
  type AgentEventSourceRef,
} from '../events/contract.js';
import { agentEventType, type AgentEvent, type AgentEventTypeFor } from '../events/catalog.js';

/**
 * Normalized adapter output before runtime identity and delivery order exist.
 * The canonical `category:event-name` route is present so runtime validation
 * never needs to infer a category from provider-native evidence.
 */
export interface AdapterEventCandidateFields<T extends AgentEvent> {
  eventId?: string | undefined;
  sourceEventRef?: AgentEventSourceRef | undefined;
  sessionId: string;
  nativeSessionId?: string | undefined;
  promptId?: string | undefined;
  turnId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  actorKey?: string | undefined;
  actorRole?: 'child' | 'auxiliary' | 'unknown' | undefined;
  providerVersion?: string | undefined;
  timestamp: string;
  monotonicTime: number;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean | undefined;
  event: T;
  nativeEvent?: unknown;
}

/** Distributes over `AgentEvent`, keeping the route and event callback data correlated. */
export type AdapterEventCandidate<T extends AgentEvent = AgentEvent> = T extends AgentEvent
  ? AdapterEventCandidateFields<T> & { type: AgentEventTypeFor<T> }
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
  return { ...fields, type: agentEventType(fields.event) } as AdapterEventCandidate<T>;
}

export type AdapterEventCandidateListener = (candidate: AdapterEventCandidate) => void;

/**
 * Bootstrap-safe adapter event source. Runtime remains the sole envelope owner.
 */
export class BufferedAdapterEventSource {
  readonly #candidateListeners = new Set<AdapterEventCandidateListener>();
  readonly #pendingCapacity: number;
  #candidatePending: AdapterEventCandidate[] = [];
  #candidateAttached = false;
  #closed = false;

  constructor(options: { pendingCapacity?: number | undefined } = {}) {
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

  close(): void {
    this.#closed = true;
    this.#candidatePending = [];
    this.#candidateListeners.clear();
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
}
