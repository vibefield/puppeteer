import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeSessionStarted(body: ClaudeHookPayload, rebind: boolean): AgentEvent {
  return {
    type: 'session.started',
    nativeSessionId: claudeString(body.session_id),
    title: claudeString(body.session_title),
    startSource: claudeString(body.source),
    ...(rebind ? { rebind: true } : {}),
  };
}

export function normalizeClaudeSessionReady(): AgentEvent {
  return { type: 'session.ready' };
}

export function normalizeClaudeSessionExited(body: ClaudeHookPayload): AgentEvent {
  return { type: 'session.exited', reason: claudeString(body.reason) };
}
