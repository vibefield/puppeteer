import type { AgentEvent } from '@vibefield/puppeteer-core';
import { piString, piTextContent } from './types.js';

export function normalizePiAssistantMessage(
  entryId: string,
  message: Record<string, unknown>,
  turnId?: string,
): AgentEvent[] {
  const text = piTextContent(message.content);
  if (text === undefined) return [];
  return [
    {
      type: 'conversation:assistant-message',
      messageId: piString(message.responseId) ?? entryId,
      ...(turnId ? { turnId } : {}),
      text,
      final: true,
    },
  ];
}
