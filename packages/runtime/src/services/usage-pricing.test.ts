import { describe, expect, it } from 'vitest';
import type { MonitorUsageFamilyValue } from '@vibefield/puppeteer-core/monitor-spi';
import { priceUsage } from './usage-pricing.js';
import { USAGE_PRICE_SNAPSHOT } from './usage-prices.js';

const value = (overrides: Partial<MonitorUsageFamilyValue> = {}): MonitorUsageFamilyValue => ({
  kind: 'usage',
  usageId: 'request',
  origin: 'protocol',
  boundary: 'response',
  canonical: true,
  pricing: {
    providerId: 'openai',
    modelId: 'gpt-5.4',
    inputTokens: 100,
    cacheReadTokens: 900,
    cacheCreationTokens: 0,
    outputTokens: 50,
    contextTokens: 1000,
  },
  ...overrides,
});
describe('pinned USD pricing', () => {
  it('uses disjoint fresh input, cached input, and output at their own prices', () => {
    const result = priceUsage(value({ reasoningTokens: 30 }));
    expect(result.costUsd).toBeCloseTo((100 * 2.5 + 900 * 0.25 + 50 * 15) / 1_000_000);
    expect(result.cost).toMatchObject({
      basis: 'api-equivalent',
      source: 'catalog',
      catalogVersion: USAGE_PRICE_SNAPSHOT.sha256,
    });
  });
  it('prefers a provider estimate, including zero and cost-only reports', () => {
    expect(priceUsage(value({ costUsd: 0 })).cost).toMatchObject({ source: 'provider-reported' });
    expect(priceUsage(value({ costUsd: 0.8, pricing: undefined })).costUsd).toBe(0.8);
  });
  it('leaves unknown routes, models, buckets, and paid tiers explicitly unpriced', () => {
    for (const pricing of [
      { providerId: 'custom', modelId: 'gpt-5.4' },
      { providerId: 'openai', modelId: 'future-model' },
      { providerId: 'openai', modelId: 'gpt-5.4' },
      { ...value().pricing!, serviceTier: 'priority' },
      { ...value().pricing!, gap: 'baseline' as const },
      { ...value().pricing!, cacheCreationTokens: 100 },
    ]) {
      expect(priceUsage(value({ pricing }))).toMatchObject({ cost: { source: 'unavailable' } });
      expect(priceUsage(value({ pricing })).costUsd).toBeUndefined();
    }
  });
  it('selects the context tier from request size and refuses to guess from aggregate counters', () => {
    const high = priceUsage(value({ pricing: { ...value().pricing!, contextTokens: 300_000 } }));
    expect(high.costUsd).toBeCloseTo((100 * 5 + 900 * 0.5 + 50 * 22.5) / 1_000_000);
    const { contextTokens: _, ...unknownContext } = value().pricing!;
    expect(priceUsage(value({ pricing: unknownContext })).costUsd).toBeUndefined();
  });
});
