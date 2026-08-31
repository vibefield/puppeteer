import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotEffort(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (!['session.start', 'session.resume', 'session.model_change'].includes(type)) return undefined;
  const effort = copilotString(data.reasoningEffort);
  return effort ? [{ type: 'effort:updated', intent: 'observed', effort }] : [];
}
