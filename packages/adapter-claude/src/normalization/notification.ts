import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeNotification(body: ClaudeHookPayload): AgentEvent {
  return {
    type: 'notification:received',
    message: claudeString(body.message),
    notificationType: claudeString(body.notification_type),
  };
}
