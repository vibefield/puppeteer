import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeSubagentStarted(subagentId: string, agentType?: string): AgentEvent {
  return { type: 'subagent.started', subagentId, agentType };
}

export function normalizeClaudeSubagentStopped(subagentId: string): AgentEvent {
  return { type: 'subagent.stopped', subagentId };
}

export function normalizeClaudeTeammateIdle(body: ClaudeHookPayload): AgentEvent {
  return {
    type: 'teammate.idle',
    ...(claudeString(body.team_name) !== undefined ? { teamName: claudeString(body.team_name) } : {}),
    teammateName: claudeString(body.teammate_name) ?? 'unknown-teammate',
  };
}
