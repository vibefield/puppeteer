import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpEventOfType } from './types.js';

type AcpReasoningEvent = AcpEventOfType<'reasoning:started' | 'reasoning:progress'>;

/** Presence-only ACP thought stream → reasoning lifecycle adapter. */
export class AcpReasoningNormalizer {
  private active = false;
  private reasoningId: string | undefined;

  normalize(update: SessionUpdate): AcpReasoningEvent[] {
    if (update.sessionUpdate !== 'agent_thought_chunk') return [];
    this.reasoningId = update.messageId ?? this.reasoningId;
    const event: AcpReasoningEvent = {
      type: this.active ? 'reasoning:progress' : 'reasoning:started',
      reasoningId: update.messageId ?? undefined,
    };
    this.active = true;
    return [event];
  }

  complete(): { active: boolean; reasoningId?: string } {
    const result = {
      active: this.active,
      ...(this.reasoningId ? { reasoningId: this.reasoningId } : {}),
    };
    this.active = false;
    this.reasoningId = undefined;
    return result;
  }
}
