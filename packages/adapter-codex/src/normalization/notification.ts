import type { NotificationEvent } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, str } from './types.js';

/** Codex user-facing error notification normalization. */
export class CodexNotificationEventNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<NotificationEvent> {
    if (input.method !== 'error') return { handled: false, events: [] };
    return {
      handled: true,
      events: [{ type: 'notification:received', message: str(input.params.message), notificationType: 'error' }],
    };
  }
}
