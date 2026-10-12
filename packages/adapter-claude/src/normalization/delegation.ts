import type { DelegationEvent } from '@vibefield/puppeteer-core';

export function normalizeClaudeSubagentStarted(subagentId: string, agentType?: string): DelegationEvent {
  return { type: 'delegation:subagent-started', subagentId, agentType };
}

export function normalizeClaudeSubagentStopped(subagentId: string): DelegationEvent {
  return { type: 'delegation:subagent-stopped', subagentId };
}
