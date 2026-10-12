import type { AgentEvent } from '@vibefield/puppeteer-core';

/** OpenCode text-part accumulation → canonical assistant-message event. */
export function normalizeOpenCodeAssistantMessage(
  messageId: string,
  turnId: string,
  text: string,
  final: boolean,
): AgentEvent {
  return { type: 'conversation:assistant-message', messageId, turnId, text, final };
}
