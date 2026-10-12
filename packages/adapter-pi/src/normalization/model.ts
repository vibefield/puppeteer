import type { AgentEvent } from '@vibefield/puppeteer-core';
import { piString } from './types.js';

export function normalizePiModel(body: Record<string, unknown>): AgentEvent[] | undefined {
  if (body.type !== 'model_change') return undefined;
  const id = piString(body.modelId);
  if (!id) return [];
  const provider = piString(body.provider);
  return [{ type: 'model:updated', intent: 'observed', model: { id, ...(provider ? { provider } : {}) } }];
}
