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
  type: AgentServiceEventType<T>;
  /** Top-level category on the public event rail. */
  service: AgentEventServiceOf<T>;
  /** Stable source identity when the producer has one; sequence remains delivery order only. */
  eventId?: string;
  /** Complete upstream identity/revision reference, when supplied by the producer. */
  sourceEventRef?: AgentEventSourceRef;
  /** Monotonic per session, assigned by the runtime at ingestion, before fan-out. */
  sequence: number;
  sessionId: string;
  nativeSessionId?: string;
  /** User-turn correlation (Claude Code `prompt_id`). */
  promptId?: string;
  /** Assistant response-cycle correlation (Claude Code `turn_id`). */
  turnId?: string;
  /** Provider-native actor attribution. Absence means the root actor. */
  agentId?: string;
  agentType?: string;
  /** Provider binary/protocol version associated with this evidence, when known. */
  providerVersion?: string;
  timestamp: string;
  monotonicTime: number;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  /** True when this envelope reconstructs durable history rather than reporting a new live event. */
  replay?: boolean;
  event: T;
  /** DESIGN ADR-008 — the raw native event is always retained. */
  nativeEvent?: unknown;
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
        sequence,
        type: agentServiceEventType(fields.event),
        service: agentEventService(fields.event),
        ...fields,
      };
    },
  };
}
