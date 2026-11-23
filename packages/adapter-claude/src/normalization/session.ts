import type { AgentEvent } from '@vibefield/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString, nonEmptyClaudeString } from './wire.js';

export function normalizeClaudeSessionStarted(body: ClaudeHookPayload, rebind: boolean): AgentEvent {
  return {
    type: 'session:started',
    nativeSessionId: claudeString(body.session_id),
    title: nonEmptyClaudeString(body.session_title),
    startSource: claudeString(body.source),
    ...(rebind ? { rebind: true } : {}),
  };
}

/** The session's title as a later hook says it (`UserPromptSubmit.session_title`): the name it goes by now. */
export function normalizeClaudeSessionTitle(title: string): AgentEvent {
  return { type: 'session:title-updated', title };
}

export function normalizeClaudeSessionReady(): AgentEvent {
  return { type: 'session:ready' };
}

export function normalizeClaudeSessionExited(body: ClaudeHookPayload): AgentEvent {
  return { type: 'session:exited', reason: claudeString(body.reason) };
}
