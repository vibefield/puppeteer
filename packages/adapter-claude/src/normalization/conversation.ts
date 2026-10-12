import type { AgentEvent } from '@vibefield/puppeteer-core';

export function normalizeClaudeAssistantMessage(
  messageId: string,
  turnId: string | undefined,
  text: string,
  final: boolean,
): AgentEvent {
  return { type: 'conversation:assistant-message', messageId, turnId, text, final, displayOnly: true };
}
