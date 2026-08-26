import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeTurnStarted(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  return { type: 'turn:started', turnId, prompt: claudeString(body.prompt) };
}

export function normalizeClaudeTurnCompleted(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  return { type: 'turn:completed', turnId, lastAssistantMessage: claudeString(body.last_assistant_message) };
}

export function normalizeClaudeTurnFailed(body: ClaudeHookPayload, turnId?: string): AgentEvent {
  return {
    type: 'turn:failed',
    turnId,
    error: claudeString(body.error_type) ?? claudeString(body.error),
  };
}
