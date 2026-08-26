import type { AgentEvent } from '@vibecook/puppeteer-core';
import { hermesString } from './types.js';

/** Hermes session.info → environment event. */
export function normalizeHermesEnvironment(payload: Record<string, unknown>): AgentEvent[] {
  const model = hermesString(payload.model);
  const currentCwd = hermesString(payload.cwd);
  if (!model && !currentCwd) return [];
  const provider = hermesString(payload.provider);
  return [
    {
      type: 'session.environment.updated',
      ...(currentCwd ? { currentCwd } : {}),
      ...(model ? { model: { id: model, ...(provider ? { provider } : {}) } } : {}),
    },
  ];
}
