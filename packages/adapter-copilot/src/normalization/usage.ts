import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotNumber, copilotRecord } from './types.js';

function usageBreakdown(value: unknown) {
  const usage = copilotRecord(value);
  if (!usage) return undefined;
  const result = {
    ...(copilotNumber(usage.inputTokens) !== undefined ? { inputTokens: copilotNumber(usage.inputTokens) } : {}),
    ...(copilotNumber(usage.outputTokens) !== undefined ? { outputTokens: copilotNumber(usage.outputTokens) } : {}),
    ...(copilotNumber(usage.cacheReadTokens) !== undefined
      ? { cacheReadTokens: copilotNumber(usage.cacheReadTokens) }
      : {}),
    ...(copilotNumber(usage.cacheWriteTokens) !== undefined
      ? { cacheCreationTokens: copilotNumber(usage.cacheWriteTokens) }
      : {}),
    ...(copilotNumber(usage.reasoningTokens) !== undefined
      ? { reasoningTokens: copilotNumber(usage.reasoningTokens) }
      : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
export function normalizeCopilotMessageUsage(entryId: string, data: Record<string, unknown>): AgentEvent[] {
  const outputTokens = copilotNumber(data.outputTokens);
  return outputTokens === undefined
    ? []
    : [
        {
          type: 'usage:tokens-used',
          usageId: `copilot:${entryId}`,
          boundary: 'response',
          canonical: true,
          meterTokens: outputTokens,
          breakdown: { outputTokens },
        },
      ];
}
export function normalizeCopilotShutdownUsage(entryId: string, data: Record<string, unknown>): AgentEvent[] {
  const metrics = copilotRecord(data.modelMetrics);
  if (!metrics) return [];
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
    reasoningTokens = 0,
    samples = 0;
  for (const metric of Object.values(metrics)) {
    const usage = copilotRecord(copilotRecord(metric)?.usage);
    const breakdown = usageBreakdown(usage);
    if (!breakdown) continue;
    inputTokens += breakdown.inputTokens ?? 0;
    outputTokens += breakdown.outputTokens ?? 0;
    cacheReadTokens += breakdown.cacheReadTokens ?? 0;
    cacheCreationTokens += breakdown.cacheCreationTokens ?? 0;
    reasoningTokens += breakdown.reasoningTokens ?? 0;
    samples += 1;
  }
  if (!samples) return [];
  const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens + reasoningTokens;
  return [
    {
      type: 'usage:tokens-used',
      usageId: `copilot:${entryId}:shutdown`,
      boundary: 'sample',
      canonical: false,
      cumulativeTokens: total,
      meterTokens: inputTokens + outputTokens,
      breakdown: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens },
    },
  ];
}
