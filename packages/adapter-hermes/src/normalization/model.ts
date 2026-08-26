import type { ModelEvent } from '@vibecook/puppeteer-core';
import { hermesString } from './types.js';

/** Hermes session.info -> model event. */
export function normalizeHermesModel(payload: Record<string, unknown>): ModelEvent[] {
  const model = hermesString(payload.model);
  if (!model) return [];
  const provider = hermesString(payload.provider);
  return [{ type: 'model:updated', model: { id: model, ...(provider ? { provider } : {}) } }];
}
