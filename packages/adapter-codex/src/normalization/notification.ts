import type { NotificationEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/**
 * Codex user-facing error notification normalization. `ErrorNotification` carries its text in
 * `error.message` (a `TurnError`, beside `threadId`, `turnId` and `willRetry`; generated schema,
 * 0.150.0 and 0.164.0). A top-level `message` is not part of it and is read only as a fallback.
 */
export class CodexNotificationEventNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<NotificationEvent> {
    if (input.method !== 'error') return { handled: false, events: [] };
    const message = str(rec(input.params.error)?.message) ?? str(input.params.message);
    return {
      handled: true,
      events: [{ type: 'notification:received', message, notificationType: 'error' }],
    };
  }
}
