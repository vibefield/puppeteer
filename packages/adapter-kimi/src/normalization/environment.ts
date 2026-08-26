import type { AgentEvent } from '@vibecook/puppeteer-core';
import { kimiRecord, kimiString } from './types.js';

/** Kimi profile/request model facts → normalized environment events. */
export function normalizeKimiEnvironment(type: string, body: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'profile.bind') {
    const model = kimiString(body.modelAlias);
    const effort = kimiString(body.thinkingEffort);
    const currentCwd = kimiString(kimiRecord(body.environmentDisclosure)?.cwd);
    if (!model && !effort && !currentCwd) return [];
    return [
      {
        type: 'session.environment.updated',
        intent: 'configured',
        ...(currentCwd ? { currentCwd } : {}),
        ...(model ? { model: { id: model, provider: 'moonshot-ai' } } : {}),
        ...(effort ? { effort } : {}),
      },
    ];
  }
  if (type === 'llm.request') {
    const model = kimiString(body.model);
    const effort = kimiString(body.thinkingEffort);
    if (!model && !effort) return [];
    return [
      {
        type: 'session.environment.updated',
        intent: 'observed',
        ...(model ? { model: { id: model, provider: 'moonshot-ai' } } : {}),
        ...(effort ? { effort } : {}),
      },
    ];
  }
  return undefined;
}
