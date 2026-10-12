import type { ConversationEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, itemText, rec, str } from './types.js';

/** Codex assistant-message stream normalization and delta accumulation. */
export class CodexConversationNormalizer {
  private readonly messageBuffers = new Map<string, string>();

  normalize(input: CodexNormalizationInput): CategoryNormalization<ConversationEvent> {
    const events: ConversationEvent[] = [];
    const { method, params } = input;

    if (method === 'item/started' || method === 'item/completed') {
      const item = rec(params.item);
      if (!item || str(item.type) !== 'agentMessage') return { handled: false, events };
      if (method === 'item/completed') {
        const itemId = str(item.id) ?? 'unknown-item';
        this.messageBuffers.delete(itemId);
        events.push({
          type: 'conversation:assistant-message',
          messageId: itemId,
          turnId: input.turnId,
          text: itemText(item),
          final: true,
          displayOnly: false,
        });
      }
      return { handled: true, events };
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = str(params.itemId) ?? 'unknown-item';
      const text = (this.messageBuffers.get(itemId) ?? '') + (str(params.delta) ?? '');
      this.messageBuffers.set(itemId, text);
      events.push({
        type: 'conversation:assistant-message',
        messageId: itemId,
        turnId: input.turnId,
        text,
        final: false,
        displayOnly: false,
      });
      return { handled: true, events };
    }

    return { handled: false, events };
  }
}
