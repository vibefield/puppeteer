import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeClaudeContextInvalidated(
  reason: 'compacted' | 'history-changed' | 'model-changed' | 'provider-reset',
): AgentEvent {
  return { type: 'context-window.invalidated', reason };
}
