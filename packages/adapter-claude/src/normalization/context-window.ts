import type { AgentEvent } from '@vibefield/puppeteer-core';

export function normalizeClaudeContextInvalidated(
  reason: 'compacted' | 'history-changed' | 'model-changed' | 'provider-reset',
): AgentEvent {
  return { type: 'context-window:invalidated', reason };
}
