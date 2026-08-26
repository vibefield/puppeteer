import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate } from './types.js';
import { grokTextContent } from './types.js';

/** Grok message deltas/finalization → conversation events. */
export class GrokConversationNormalizer {
  private readonly assistantByPrompt = new Map<string, string>();
  private readonly messageIdByPrompt = new Map<string, string>();

  append(update: GrokUpdate, promptId: string, observed: GrokObservedFactory): GrokObservedEvent {
    const text = (this.assistantByPrompt.get(promptId) ?? '') + grokTextContent(update);
    this.assistantByPrompt.set(promptId, text);
    const messageId = update.messageId ?? this.messageIdByPrompt.get(promptId) ?? `grok-assistant:${promptId}`;
    this.messageIdByPrompt.set(promptId, messageId);
    return observed(
      { type: 'assistant.message', messageId, turnId: promptId, text, final: false, displayOnly: false },
      promptId,
    );
  }

  complete(promptId: string, observed: GrokObservedFactory): { events: GrokObservedEvent[]; text?: string } {
    const text = this.assistantByPrompt.get(promptId);
    if (text === undefined) return { events: [] };
    return {
      text,
      events: [
        observed(
          {
            type: 'assistant.message',
            messageId: this.messageIdByPrompt.get(promptId) ?? `grok-assistant:${promptId}`,
            turnId: promptId,
            text,
            final: true,
            displayOnly: false,
          },
          promptId,
        ),
      ],
    };
  }
}
