import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpEventOfType } from './types.js';

type AcpConversationEvent = AcpEventOfType<'conversation:assistant-message'>;

/** Text of an ACP content block. Only `text` blocks carry conversation prose. */
function contentText(update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>): string {
  return update.content.type === 'text' ? (update.content.text ?? '') : '';
}

/**
 * Session-scoped ACP message-delta → conversation event adapter. An assistant message never spans a
 * prompt: the buffers start empty at every prompt of the session (`beginTurn`).
 */
export class AcpConversationNormalizer {
  private readonly messageBuffers = new Map<string, string>();

  normalize(update: SessionUpdate): AcpConversationEvent[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      // A prompt echo opens a turn: this client's (the driver already represented it as turn:started),
      // another client's, or one that session/load replays.
      this.beginTurn();
      return [];
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return [];

    const messageId = update.messageId ?? 'acp-msg';
    const text = (this.messageBuffers.get(messageId) ?? '') + contentText(update);
    this.messageBuffers.set(messageId, text);
    return [{ type: 'conversation:assistant-message', messageId, text, final: false, displayOnly: false }];
  }

  /** A new prompt: no assistant message, id'd or id-less, carries over from the turn before. */
  beginTurn(): void {
    this.messageBuffers.clear();
  }

  /** Full accumulated text; without an id, returns the latest message buffer. */
  assistantText(messageId?: string): string {
    if (messageId) return this.messageBuffers.get(messageId) ?? '';
    let last = '';
    for (const value of this.messageBuffers.values()) last = value;
    return last;
  }
}
