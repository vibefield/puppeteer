import type { AgentEvent } from '@vibecook/puppeteer-core';

/** Kimi context mutation records → context invalidation events. */
export function normalizeKimiContextWindow(type: string): AgentEvent[] | undefined {
  if (type === 'full_compaction.complete') {
    return [{ type: 'context-window.invalidated', reason: 'compacted' }];
  }
  if (type === 'context.clear' || type === 'context.undo') {
    return [{ type: 'context-window.invalidated', reason: 'history-changed' }];
  }
  return undefined;
}
