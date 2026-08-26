import type { AgentEventConfidence, AgentEventSource, AgentEventSourceRef } from './contract.js';
import {
  agentEventService,
  agentServiceEventType,
  type AgentEvent,
  type AgentEventServiceOf,
  type AgentServiceEventType,
} from './catalog.js';

export interface AgentEventEnvelope<T extends AgentEvent = AgentEvent> {
  /** Namespaced event-bus route. Consumers subscribe to this field, never native event names. */
  readonly type: AgentServiceEventType<T>;
  /** Top-level category on the public event rail. */
  readonly service: AgentEventServiceOf<T>;
  /** Stable source identity when the producer has one; sequence remains delivery order only. */
  readonly eventId?: string;
  /** Complete upstream identity/revision reference, when supplied by the producer. */
  readonly sourceEventRef?: AgentEventSourceRef;
  /** Monotonic per session, assigned by the runtime at ingestion, before fan-out. */
  readonly sequence: number;
  readonly sessionId: string;
  readonly nativeSessionId?: string;
  /** User-turn correlation (Claude Code `prompt_id`). */
  readonly promptId?: string;
  /** Assistant response-cycle correlation (Claude Code `turn_id`). */
  readonly turnId?: string;
  /** Provider-native actor attribution. Absence means the root actor. */
  readonly agentId?: string;
  readonly agentType?: string;
  /** Stable derived lane when evidence identifies a non-root actor without an exact native id. */
  readonly actorKey?: string;
  /** Classification for a non-root actor lane. */
  readonly actorRole?: 'child' | 'auxiliary' | 'unknown';
  /** Provider binary/protocol version associated with this evidence, when known. */
  readonly providerVersion?: string;
  readonly timestamp: string;
  readonly monotonicTime: number;
  readonly source: AgentEventSource;
  readonly confidence: AgentEventConfidence;
  /** True when this envelope reconstructs durable history rather than reporting a new live event. */
  readonly replay?: boolean;
  readonly event: T;
  /** DESIGN ADR-008 — the raw native event is always retained. */
  readonly nativeEvent?: unknown;
}

export interface EnvelopeStamper {
  next<T extends AgentEvent>(
    fields: Omit<AgentEventEnvelope<T>, 'sequence' | 'type' | 'service'>,
  ): AgentEventEnvelope<T>;
}

/**
 * Sequence numbers are assigned at ingestion, before fan-out, so every
 * consumer observes the same order. One stamper per session.
 *
 * @deprecated Runtime owns production stamping through `AdapterEventCandidate`
 * ingestion. This helper remains for compatibility consumers and tests.
 */
export function createEnvelopeStamper(initialSequence = 0): EnvelopeStamper {
  let sequence = initialSequence;
  return {
    next(fields) {
      sequence += 1;
      return {
        ...fields,
        sequence,
        type: agentServiceEventType(fields.event),
        service: agentEventService(fields.event),
      };
    },
  };
}
