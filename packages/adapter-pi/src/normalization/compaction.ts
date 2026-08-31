import type { AgentEvent } from '@vibecook/puppeteer-core';
import { piString } from './types.js';
import { normalizePiUsage } from './usage.js';

export function normalizePiCompaction(body: Record<string, unknown>): AgentEvent[] | undefined {
  if (body.type !== 'compaction') return undefined;
  const id = piString(body.id);
  return [
    ...normalizePiUsage(`pi:compaction:${id ?? 'unknown'}`, body.usage),
    { type: 'context-window:invalidated', reason: 'compacted' },
    { type: 'compaction:completed', ...(id ? { compactionId: id } : {}), outcome: 'completed' },
  ];
}
