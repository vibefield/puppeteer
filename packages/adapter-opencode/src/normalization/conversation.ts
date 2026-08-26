import type { AgentEvent } from '@vibecook/puppeteer-core';

/** OpenCode text-part accumulation → canonical assistant-message event. */
export function normalizeOpenCodeAssistantMessage(
  messageId: string,
  turnId: string,
  text: string,
  final: boolean,
): AgentEvent {
  return { type: 'assistant.message', messageId, turnId, text, final };
}
