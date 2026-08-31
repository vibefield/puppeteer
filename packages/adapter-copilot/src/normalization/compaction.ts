import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotNumber, copilotString } from './types.js';

export function normalizeCopilotCompaction(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'session.compaction_start') {
    const usedTokens = copilotNumber(data.currentTokens);
    const capacityTokens = copilotNumber(data.tokenLimit);
    return [
      {
        type: 'compaction:started',
        ...(copilotString(data.trigger) ? { trigger: copilotString(data.trigger) } : {}),
      },
      ...(usedTokens !== undefined && capacityTokens !== undefined && capacityTokens > 0
        ? ([
            {
              type: 'context-window:updated',
              usedTokens,
              capacityTokens,
              usedPercentage: Math.min(100, (usedTokens / capacityTokens) * 100),
              percentageSource: 'derived',
              ...(copilotString(data.model) ? { modelId: copilotString(data.model) } : {}),
            },
          ] as AgentEvent[])
        : []),
    ];
  }
  if (type === 'session.compaction_complete') {
    const completed: AgentEvent = {
      type: 'compaction:completed',
      ...(copilotString(data.trigger) ? { trigger: copilotString(data.trigger) } : {}),
      outcome: data.success === true ? 'completed' : data.success === false ? 'failed' : 'unknown',
    };
    return [
      ...(data.success === true ? ([{ type: 'context-window:invalidated', reason: 'compacted' }] as AgentEvent[]) : []),
      completed,
    ];
  }
  if (type === 'session.truncation' || type === 'session.context_cleared')
    return [{ type: 'context-window:invalidated', reason: 'history-changed' }];
  return undefined;
}
