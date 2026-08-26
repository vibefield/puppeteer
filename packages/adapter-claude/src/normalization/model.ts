import type { ModelEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

/** Claude session model evidence -> Core model service. */
export function normalizeClaudeSessionModel(body: ClaudeHookPayload): ModelEvent | undefined {
  const model = claudeString(body.model);
  return model ? { type: 'model:updated', model: { id: model, provider: 'anthropic' } } : undefined;
}
