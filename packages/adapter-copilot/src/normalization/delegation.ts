import type { AgentEvent } from '@vibefield/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotDelegation(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (!['subagent.started', 'subagent.completed', 'subagent.failed'].includes(type)) return undefined;
  const id = copilotString(data.toolCallId);
  if (!id) return [];
  if (type === 'subagent.started')
    return [
      {
        type: 'delegation:subagent-started',
        subagentId: id,
        ...(copilotString(data.agentName) ? { agentType: copilotString(data.agentName) } : {}),
      },
    ];
  return [{ type: 'delegation:subagent-stopped', subagentId: id }];
}
