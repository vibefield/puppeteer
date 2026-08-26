import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventEnvelope,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';

export interface TestAgentProjection {
  readonly state: SessionRuntimeState;
  readonly states: SessionRuntimeState[];
  readonly envelopes: AgentEventEnvelope[];
  readonly monitorBatches: AdapterMonitorObservationBatch[];
  dispose(): void;
}

export interface TestAgentEventSource {
  readonly events: {
    onCandidate(listener: (candidate: AdapterEventCandidate) => void): () => void;
  };
}

/**
 * Minimal test consumer for a low-level adapter stream.
 *
 * Product code uses the runtime Agent. Adapter unit tests use this projection
 * to assert reducer outcomes without putting state back onto adapter handles.
 */
export function projectAgentEvents(
  session: TestAgentEventSource,
  onState?: (state: SessionRuntimeState) => void,
): TestAgentProjection {
  let state = createInitialSessionState();
  const states: SessionRuntimeState[] = [];
  const envelopes: AgentEventEnvelope[] = [];
  const monitorBatches: AdapterMonitorObservationBatch[] = [];
  const stamper = createEnvelopeStamper();
  const unsubscribe = session.events.onCandidate((candidate) => {
    const { type: _type, ...fields } = candidate;
    const envelope = stamper.next<AgentEvent>(
      fields as Omit<AgentEventEnvelope<AgentEvent>, 'sequence' | 'type' | 'category'>,
    );
    envelopes.push(envelope);
    if (envelope.event.type === 'monitor:batch') {
      monitorBatches.push(envelope.event.batch);
      return;
    }
    state = reduceSessionState(state, envelope);
    states.push(state);
    onState?.(state);
  });
  return {
    get state() {
      return state;
    },
    states,
    envelopes,
    monitorBatches,
    dispose: unsubscribe,
  };
}

/** Session-oriented alias retained for readability in adapter conformance tests. */
export const projectAgentSession = projectAgentEvents;
