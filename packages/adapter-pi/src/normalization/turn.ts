import type { AgentEvent } from '@vibecook/puppeteer-core';
import { piErrorText, piString, piTextContent } from './types.js';

export function piTurnStarted(entryId: string, message: Record<string, unknown>): AgentEvent {
  return {
    type: 'turn:started',
    turnId: entryId,
    ...(piTextContent(message.content) !== undefined ? { prompt: piTextContent(message.content) } : {}),
  };
}

export function piTurnTerminal(
  turnId: string,
  message: Record<string, unknown>,
  lastAssistantMessage?: string,
): AgentEvent | undefined {
  const reason = piString(message.stopReason);
  if (reason === 'toolUse') return undefined;
  if (reason === 'error' || piString(message.errorMessage)) {
    return {
      type: 'turn:failed',
      turnId,
      ...(piErrorText(message.errorMessage ?? reason) ? { error: piErrorText(message.errorMessage ?? reason) } : {}),
    };
  }
  return {
    type: 'turn:completed',
    turnId,
    ...(reason ? { stopReason: reason } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
  };
}
