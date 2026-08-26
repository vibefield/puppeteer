import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeOpenCodeTurnStarted(turnID: string): AgentEvent {
  return { type: 'turn.started', turnId: turnID };
}

export function normalizeOpenCodeTurnCompleted(
  turnID: string,
  stopReason: string,
  lastAssistantMessage?: string,
): AgentEvent {
  return {
    type: 'turn.completed',
    turnId: turnID,
    stopReason,
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
  };
}

export function normalizeOpenCodeTurnFailed(turnID: string, error?: string): AgentEvent {
  return { type: 'turn.failed', turnId: turnID, error };
}
