/** ACP `session/update` → category-normalized Core event pipeline. */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { normalizeAcpFallback } from './adapter.js';
import { AcpConversationNormalizer } from './conversation.js';
import { normalizeAcpContextWindow } from './context-window.js';
import { normalizeAcpEnvironment } from './environment.js';
import { AcpReasoningNormalizer } from './reasoning.js';
import { normalizeAcpTool } from './tool.js';
import type { NormalizedUpdate } from './types.js';

/** One session-scoped composition of category-focused ACP normalizers. */
export class AcpNotificationNormalizer {
  private readonly conversation = new AcpConversationNormalizer();
  private readonly reasoning = new AcpReasoningNormalizer();

  normalize(notification: SessionNotification): NormalizedUpdate {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        return { events: this.conversation.normalize(update) };
      case 'agent_thought_chunk':
        return { events: this.reasoning.normalize(update) };
      case 'tool_call':
      case 'tool_call_update':
        return { events: normalizeAcpTool(update) };
      case 'usage_update':
        return { events: normalizeAcpContextWindow(update) };
      case 'config_option_update':
        return { events: normalizeAcpEnvironment(update) };
      default:
        return { events: normalizeAcpFallback(update) };
    }
  }

  assistantText(messageId?: string): string {
    return this.conversation.assistantText(messageId);
  }

  completeReasoning(): { active: boolean; reasoningId?: string } {
    return this.reasoning.complete();
  }
}
