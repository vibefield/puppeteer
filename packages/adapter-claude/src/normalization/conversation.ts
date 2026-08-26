import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeClaudeAssistantMessage(
  messageId: string,
  turnId: string | undefined,
  text: string,
  final: boolean,
): AgentEvent {
  return { type: 'assistant.message', messageId, turnId, text, final, displayOnly: true };
}
