import { describe, expect, it } from 'vitest';
import { codexUsageCounter, codexUsagePricing } from './usage.js';
const model = { providerId: 'openai', modelId: 'gpt-5.4' };
describe('Codex native usage pricing', () => {
  it('subtracts cached input once and never adds reasoning on top of output', () => {
    const previous = { total: 100, input: 80, cached: 40, output: 20, reasoning: 10 };
    const current = { total: 180, input: 140, cached: 90, output: 40, reasoning: 25 };
    const last = { total: 80, input: 60, cached: 50, output: 20, reasoning: 15 };
    expect(codexUsagePricing(current, previous, model, true, last)).toEqual({
      ...model,
      inputTokens: 10,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      outputTokens: 20,
      contextTokens: 60,
    });
  });
  it('does not price an initial counter, a reset, or an ambiguous model change', () => {
    const current = { total: 100, input: 80, cached: 40, output: 20 };
    expect(codexUsagePricing(current, undefined, model, true, current).gap).toBe('baseline');
    expect(codexUsagePricing(current, { ...current, total: 200 }, model, true, current).gap).toBe('counter-reset');
    expect(codexUsagePricing(current, { total: 0 }, model, false, current).gap).toBe('model-change');
  });
  it('rejects invalid counters and incomplete or overlapping buckets', () => {
    expect(codexUsageCounter({ totalTokens: -1 })).toBeUndefined();
    expect(codexUsageCounter({ totalTokens: 1.5 })).toBeUndefined();
    const zero = { total: 0, input: 0, cached: 0, output: 0 };
    expect(codexUsagePricing({ total: 10 }, zero, model, true, undefined).gap).toBe('incomplete-buckets');
    expect(codexUsagePricing({ total: 10, input: 5, cached: 6, output: 5 }, zero, model, true, undefined).gap).toBe(
      'incomplete-buckets',
    );
  });
});
