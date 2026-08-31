import type { AgentEvent } from '@vibecook/puppeteer-core';
import { piNumber, piRecord } from './types.js';

export function normalizePiUsage(usageId: string, value: unknown): AgentEvent[] {
  const usage = piRecord(value);
  if (!usage) return [];
  const inputTokens = piNumber(usage.input);
  const outputTokens = piNumber(usage.output);
  const cacheReadTokens = piNumber(usage.cacheRead);
  const cacheCreationTokens = piNumber(usage.cacheWrite);
  const reasoningTokens = piNumber(usage.reasoning);
  const totalTokens = piNumber(usage.totalTokens);
  const meterTokens =
    inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
  const costUsd = piNumber(piRecord(usage.cost)?.total);
  const breakdown = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
  if (totalTokens === undefined && costUsd === undefined && Object.keys(breakdown).length === 0) return [];
  return [
    {
      type: 'usage:tokens-used',
      usageId,
      boundary: 'response',
      canonical: true,
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(meterTokens !== undefined ? { meterTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(Object.keys(breakdown).length > 0 ? { breakdown } : {}),
    },
  ];
}

export function normalizePiSummaryUsage(body: Record<string, unknown>): AgentEvent[] | undefined {
  if (body.type !== 'branch_summary') return undefined;
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : 'unknown';
  const events = normalizePiUsage(`pi:branch-summary:${id}`, body.usage);
  return events.length > 0 ? events : undefined;
}
