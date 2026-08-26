import type { AdapterEventCandidate, AdapterEventCandidateListener } from '../adapter/event-candidate.js';

/** The sole adapter-to-runtime event ingress. Candidates carry no runtime identity or sequence. */
export interface AgentAdapterEventSource {
  onCandidate(listener: AdapterEventCandidateListener): () => void;
}

export type { AdapterEventCandidate, AdapterEventCandidateListener };
