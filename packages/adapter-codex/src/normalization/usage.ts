import type { UsagePricing } from '@vibecook/puppeteer-core';

export interface CodexUsageCounter {
  total: number;
  input?: number | undefined;
  cached?: number | undefined;
  output?: number | undefined;
  reasoning?: number | undefined;
}

export function codexUsageCounter(value: Record<string, unknown> | undefined): CodexUsageCounter | undefined {
  const count = (key: string): number | undefined => {
    const candidate = value?.[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
  };
  const total = count('totalTokens');
  if (total === undefined) return undefined;
  return {
    total,
    input: count('inputTokens'),
    cached: count('cachedInputTokens'),
    output: count('outputTokens'),
    reasoning: count('reasoningOutputTokens'),
  };
}

/** Cached input and reasoning output are subsets in the native Codex contract. */
export function codexUsagePricing(
  current: CodexUsageCounter,
  previous: CodexUsageCounter | undefined,
  model: Pick<UsagePricing, 'providerId' | 'modelId' | 'serviceTier'>,
  sameModel: boolean,
  last: CodexUsageCounter | undefined,
): UsagePricing {
  if (!previous) return { ...model, gap: 'baseline' };
  if (current.total < previous.total) return { ...model, gap: 'counter-reset' };
  if (!sameModel) return { ...model, gap: 'model-change' };
  const delta = (field: 'input' | 'cached' | 'output') => {
    const a = current[field];
    const b = previous[field];
    return a !== undefined && b !== undefined && a >= b ? a - b : undefined;
  };
  const input = delta('input');
  const cached = delta('cached');
  const output = delta('output');
  if (
    input === undefined ||
    cached === undefined ||
    output === undefined ||
    cached > input ||
    input + output !== current.total - previous.total
  )
    return { ...model, gap: 'incomplete-buckets' };
  // Only a delta equal to the last request proves the prompt size for context tiers.
  const singleRequest = last?.input === input && last.cached === cached && last.output === output;
  return {
    ...model,
    inputTokens: input - cached,
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: output,
    ...(singleRequest ? { contextTokens: input } : {}),
  };
}
