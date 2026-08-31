import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotReasoning(
  data: Record<string, unknown>,
  started: boolean,
): { events: AgentEvent[]; reasoningId?: string } {
  const reasoningId = copilotString(data.reasoningId);
  const content = typeof data.content === 'string' ? data.content : undefined;
  return {
    events: [
      ...(!started ? ([{ type: 'reasoning:started', ...(reasoningId ? { reasoningId } : {}) }] as AgentEvent[]) : []),
      ...(content !== undefined
        ? ([
            { type: 'reasoning:summary', ...(reasoningId ? { reasoningId } : {}), text: content, final: false },
          ] as AgentEvent[])
        : [{ type: 'reasoning:progress', ...(reasoningId ? { reasoningId } : {}) } as AgentEvent]),
    ],
    ...(reasoningId ? { reasoningId } : {}),
  };
}
