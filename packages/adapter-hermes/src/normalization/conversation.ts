import type { AgentEvent } from '@vibecook/puppeteer-core';
import { hermesString } from './types.js';

/** Owns Hermes turn correlation and streamed assistant conversation text. */
export class HermesConversationNormalizer {
  private turnCount = 0;
  private turnId: string | undefined;
  private assistantText = '';

  currentTurnId(): string | undefined {
    return this.turnId;
  }

  start(): { turnId: string; events: AgentEvent[] } {
    const turnId = `hermes-turn-${++this.turnCount}`;
    this.turnId = turnId;
    this.assistantText = '';
    return { turnId, events: [{ type: 'turn.started', turnId }] };
  }

  delta(payload: Record<string, unknown>): AgentEvent[] {
    const chunk = hermesString(payload.text);
    if (chunk) this.assistantText += chunk;
    if (!chunk && !this.assistantText) return [];
    return [{ type: 'assistant.message', turnId: this.turnId, text: this.assistantText, final: false }];
  }

  complete(payload: Record<string, unknown>): { turnId?: string; events: AgentEvent[] } {
    const finalText = hermesString(payload.text) ?? this.assistantText;
    const status = hermesString(payload.status) ?? 'complete';
    const turnId = this.turnId;
    this.turnId = undefined;
    this.assistantText = '';
    const events: AgentEvent[] = [];
    if (finalText) events.push({ type: 'assistant.message', turnId, text: finalText, final: true });
    if (status === 'interrupted' || status === 'error') {
      events.push({ type: 'turn.failed', turnId, error: status });
    } else {
      events.push({
        type: 'turn.completed',
        turnId,
        stopReason: status,
        ...(finalText ? { lastAssistantMessage: finalText } : {}),
      });
    }
    return { turnId, events };
  }
}
