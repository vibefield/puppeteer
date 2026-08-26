import type { AgentEvent } from '@vibecook/puppeteer-core';
import { hermesRecord, hermesString } from './types.js';

/** Hermes session.info usage → context-window event. */
export function normalizeHermesContextWindow(payload: Record<string, unknown>): AgentEvent[] {
  const usage = hermesRecord(payload.usage);
  const usedTokens = typeof usage?.context_used === 'number' ? usage.context_used : undefined;
  const capacityTokens = typeof usage?.context_max === 'number' ? usage.context_max : undefined;
  if (
    typeof usedTokens !== 'number' ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0 ||
    typeof capacityTokens !== 'number' ||
    !Number.isFinite(capacityTokens) ||
    capacityTokens <= 0
  ) {
    return [];
  }
  const percentage =
    typeof usage?.context_percent === 'number' &&
    Number.isFinite(usage.context_percent) &&
    usage.context_percent >= 0 &&
    usage.context_percent <= 100
      ? usage.context_percent
      : undefined;
  const modelId = hermesString(payload.model);
  return [
    {
      type: 'context-window.updated',
      usedTokens,
      capacityTokens,
      ...(percentage !== undefined
        ? { usedPercentage: percentage, percentageSource: 'provider' as const }
        : { percentageSource: 'derived' as const }),
      ...(modelId ? { modelId } : {}),
    },
  ];
}
