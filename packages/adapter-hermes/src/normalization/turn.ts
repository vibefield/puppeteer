import type { TurnEvent } from '@vibecook/puppeteer-core';
import { hermesString } from './types.js';

/** Owns Hermes turn identity and lifecycle independently from message text. */
export class HermesTurnNormalizer {
  private turnCount = 0;
  private turnId: string | undefined;

  currentTurnId(): string | undefined {
    return this.turnId;
  }

  start(): { turnId: string; events: TurnEvent[] } {
    const turnId = `hermes-turn-${++this.turnCount}`;
    this.turnId = turnId;
    return { turnId, events: [{ type: 'turn:started', turnId }] };
  }

  complete(payload: Record<string, unknown>, lastAssistantMessage?: string): { turnId?: string; events: TurnEvent[] } {
    const status = hermesString(payload.status) ?? 'complete';
    const turnId = this.turnId;
    this.turnId = undefined;
    if (status === 'interrupted' || status === 'error') {
      return { turnId, events: [{ type: 'turn:failed', turnId, error: status }] };
    }
    return {
      turnId,
      events: [
        {
          type: 'turn:completed',
          turnId,
          stopReason: status,
          ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
        },
      ],
    };
  }
}
