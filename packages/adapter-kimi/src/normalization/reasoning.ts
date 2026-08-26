import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedKimiSetAdd } from './types.js';

/** Presence-only Kimi think parts → reasoning lifecycle events. */
export class KimiReasoningNormalizer {
  private readonly activeTurns = new Set<string>();

  progress(turnId: string): AgentEvent {
    const reasoningId = `kimi-reasoning:${turnId}`;
    if (this.activeTurns.has(turnId)) return { type: 'reasoning:progress', reasoningId };
    boundedKimiSetAdd(this.activeTurns, turnId);
    return { type: 'reasoning:started', reasoningId };
  }

  complete(turnId: string): AgentEvent[] {
    return this.activeTurns.delete(turnId)
      ? [{ type: 'reasoning:completed', reasoningId: `kimi-reasoning:${turnId}` }]
      : [];
  }

  reset(turnId: string): void {
    this.activeTurns.delete(turnId);
  }
}
