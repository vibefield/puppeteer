import {
  createInitialSessionState,
  reduceSessionState,
  type AgentEventEnvelope,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import type { AgentProjectionService } from './projection-service.js';

/** Agent-owned projection of normalized events into deterministic session state. */
export class AgentStateService implements AgentProjectionService<SessionRuntimeState> {
  readonly name = 'state';
  private current = createInitialSessionState();

  accepts(envelope: AgentEventEnvelope): boolean {
    return envelope.service !== 'monitor';
  }

  consume(envelope: AgentEventEnvelope): void {
    if (!this.accepts(envelope)) return;
    this.current = reduceSessionState(this.current, envelope);
  }

  snapshot(): SessionRuntimeState {
    return this.current;
  }
}
