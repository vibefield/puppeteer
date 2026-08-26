import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeOpenCodeReasoningStarted(reasoningId: string): AgentEvent {
  return { type: 'reasoning.started', reasoningId };
}

export function normalizeOpenCodeReasoningSummary(reasoningId: string, text: string, final: boolean): AgentEvent {
  return { type: 'reasoning.summary', reasoningId, text, final };
}

export function normalizeOpenCodeReasoningCompleted(reasoningId: string): AgentEvent {
  return { type: 'reasoning.completed', reasoningId };
}
