import type { EffortEvent } from '@vibefield/puppeteer-core';
import { kimiString } from './types.js';

/** Kimi profile/request effort facts -> Core effort events. */
export function normalizeKimiEffort(type: string, body: Record<string, unknown>): EffortEvent[] | undefined {
  const intent = type === 'profile.bind' ? 'configured' : type === 'llm.request' ? 'observed' : undefined;
  if (!intent) return undefined;
  const effort = kimiString(body.thinkingEffort);
  return effort ? [{ type: 'effort:updated', intent, effort }] : [];
}
