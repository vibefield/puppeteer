import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';

/** Runtime-only contract shared by Agent-owned read-model services. */
export interface AgentProjectionService<Snapshot, Envelope extends AgentEventEnvelope = AgentEventEnvelope> {
  readonly name: string;
  accepts(envelope: Envelope): boolean;
  consume(envelope: Envelope): void;
  snapshot(): Snapshot;
}
