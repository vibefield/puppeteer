import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedKimiMapSet } from './types.js';

/** Kimi text parts/finalization → conversation events. */
export class KimiConversationNormalizer {
  private readonly assistantByTurn = new Map<string, string>();

  append(turnId: string, textDelta: string): AgentEvent {
    const text = (this.assistantByTurn.get(turnId) ?? '') + textDelta;
    boundedKimiMapSet(this.assistantByTurn, turnId, text);
    return {
      type: 'conversation:assistant-message',
      messageId: `kimi-assistant:${turnId}`,
      turnId,
      text,
      final: false,
      displayOnly: false,
    };
  }

  complete(turnId: string): { text?: string; events: AgentEvent[] } {
    const text = this.assistantByTurn.get(turnId);
    return text === undefined
      ? { events: [] }
      : {
          text,
          events: [
            {
              type: 'conversation:assistant-message',
              messageId: `kimi-assistant:${turnId}`,
              turnId,
              text,
              final: true,
              displayOnly: false,
            },
          ],
        };
  }

  reset(turnId: string): void {
    this.assistantByTurn.delete(turnId);
  }
}
