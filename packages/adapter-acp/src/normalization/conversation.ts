import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpEventOfType } from './types.js';

type AcpConversationEvent = AcpEventOfType<'conversation:assistant-message'>;

/** Text of an ACP content block. Only `text` blocks carry conversation prose. */
function contentText(update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>): string {
  return update.content.type === 'text' ? (update.content.text ?? '') : '';
}

/** Session-scoped ACP message-delta → conversation event adapter. */
export class AcpConversationNormalizer {
  private readonly messageBuffers = new Map<string, string>();

  normalize(update: SessionUpdate): AcpConversationEvent[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      // The driver already represented this prompt echo as turn:started.
      return [];
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return [];

    const messageId = update.messageId ?? 'acp-msg';
    const text = (this.messageBuffers.get(messageId) ?? '') + contentText(update);
    this.messageBuffers.set(messageId, text);
    return [{ type: 'conversation:assistant-message', messageId, text, final: false, displayOnly: false }];
  }

  /** Full accumulated text; without an id, returns the latest message buffer. */
  assistantText(messageId?: string): string {
    if (messageId) return this.messageBuffers.get(messageId) ?? '';
    let last = '';
    for (const value of this.messageBuffers.values()) last = value;
    return last;
  }
}
