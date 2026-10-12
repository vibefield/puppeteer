import type { AgentEvent } from '@vibefield/puppeteer-core';
export function antigravityTurnStarted(turnId: string, prompt?: string): AgentEvent {
  return { type: 'turn:started', turnId, ...(prompt !== undefined ? { prompt } : {}) };
}
export function antigravityTurnCompleted(turnId: string, message?: string): AgentEvent {
  return {
    type: 'turn:completed',
    turnId,
    stopReason: 'planner-response',
    ...(message !== undefined ? { lastAssistantMessage: message } : {}),
  };
}
export function antigravityTurnFailed(turnId: string, error?: string): AgentEvent {
  return { type: 'turn:failed', turnId, ...(error ? { error } : {}) };
}
