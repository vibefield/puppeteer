import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotNumber, copilotString } from './types.js';

export function normalizeCopilotWorkflow(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'session.autopilot_objective_changed') {
    const id = copilotNumber(data.id);
    if (id === undefined) return [];
    const status = copilotString(data.status)?.toLowerCase();
    return [
      {
        type: 'workflow:updated',
        workflowId: `autopilot:${id}`,
        active: !['completed', 'failed', 'cancelled'].includes(status ?? ''),
      },
    ];
  }
  if (type === 'session.task_complete') {
    const id =
      copilotString(data.objectiveId) ??
      (copilotNumber(data.objectiveId) !== undefined ? String(copilotNumber(data.objectiveId)) : undefined);
    return id ? [{ type: 'workflow:updated', workflowId: `autopilot:${id}`, active: false }] : [];
  }
  return undefined;
}
