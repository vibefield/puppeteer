import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotAssistantMessage(
  entryId: string,
  data: Record<string, unknown>,
  turnId?: string,
): AgentEvent[] {
  const text = typeof data.content === 'string' ? data.content : undefined;
  if (text === undefined || text.length === 0) return [];
  return [
    {
      type: 'conversation:assistant-message',
      messageId: copilotString(data.messageId) ?? entryId,
      ...(turnId ? { turnId } : {}),
      text,
      final: true,
    },
  ];
}
