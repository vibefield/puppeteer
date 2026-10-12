import type { AgentEvent } from '@vibefield/puppeteer-core';
import { piString } from './types.js';

export function normalizePiEffort(body: Record<string, unknown>): AgentEvent[] | undefined {
  if (body.type !== 'thinking_level_change') return undefined;
  const effort = piString(body.thinkingLevel);
  return effort ? [{ type: 'effort:updated', intent: 'observed', effort }] : [];
}
