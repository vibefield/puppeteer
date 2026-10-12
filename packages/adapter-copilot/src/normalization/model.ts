import type { AgentEvent } from '@vibefield/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotModel(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (!['session.start', 'session.resume', 'session.model_change', 'session.auto_mode_resolved'].includes(type))
    return undefined;
  const id = copilotString(
    type === 'session.model_change'
      ? data.newModel
      : type === 'session.auto_mode_resolved'
        ? data.chosenModel
        : data.selectedModel,
  );
  return id ? [{ type: 'model:updated', intent: 'observed', model: { id } }] : [];
}
