import type { ModelEvent } from '@vibecook/puppeteer-core';
import { kimiString } from './types.js';

/** Kimi profile/request model facts -> Core model events. */
export function normalizeKimiModel(type: string, body: Record<string, unknown>): ModelEvent[] | undefined {
  const intent = type === 'profile.bind' ? 'configured' : type === 'llm.request' ? 'observed' : undefined;
  if (!intent) return undefined;
  const model = kimiString(type === 'profile.bind' ? body.modelAlias : body.model);
  return model ? [{ type: 'model:updated', intent, model: { id: model, provider: 'moonshot-ai' } }] : [];
}
