import type { ConversationEvent } from '@vibecook/puppeteer-core';
import { hermesString } from './types.js';

/** Owns only Hermes streamed assistant conversation text. */
export class HermesConversationNormalizer {
  private assistantText = '';

  start(): void {
    this.assistantText = '';
  }

  delta(payload: Record<string, unknown>, turnId?: string): ConversationEvent[] {
    const chunk = hermesString(payload.text);
    if (chunk) this.assistantText += chunk;
    if (!chunk && !this.assistantText) return [];
    return [{ type: 'conversation:assistant-message', turnId, text: this.assistantText, final: false }];
  }

  complete(
    payload: Record<string, unknown>,
    turnId?: string,
  ): { text?: string | undefined; events: ConversationEvent[] } {
    const finalText = hermesString(payload.text) ?? this.assistantText;
    this.assistantText = '';
    const events: ConversationEvent[] = [];
    if (finalText) events.push({ type: 'conversation:assistant-message', turnId, text: finalText, final: true });
    return { text: finalText || undefined, events };
  }
}
