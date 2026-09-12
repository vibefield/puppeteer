import type { DelegationEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeSubagentStarted(subagentId: string, agentType?: string): DelegationEvent {
  return { type: 'delegation:subagent-started', subagentId, agentType };
}

export function normalizeClaudeSubagentStopped(subagentId: string): DelegationEvent {
  return { type: 'delegation:subagent-stopped', subagentId };
}

export function normalizeClaudeTeammateIdle(body: ClaudeHookPayload): DelegationEvent {
  return {
    type: 'delegation:teammate-idle',
    ...(claudeString(body.team_name) !== undefined ? { teamName: claudeString(body.team_name) } : {}),
    teammateName: claudeString(body.teammate_name) ?? 'unknown-teammate',
  };
}
