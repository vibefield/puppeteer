import { createHash } from 'node:crypto';
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
      catalogVersion: USAGE_PRICE_SNAPSHOT.version,
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
  it('prices Codex’s newer models at the vendor’s own rates, in both context tiers', () => {
    // Standard rates per million tokens, [input, cached input, output], short (≤ 272K input tokens) then long:
    // https://developers.openai.com/api/docs/pricing, read 2026-10-27.
    const rates = [
      ['gpt-6-luna', [0.1, 0.01, 0.5], [0.2, 0.02, 0.75]],
      ['gpt-6-sol', [2, 0.2, 10], [4, 0.4, 15]],
      ['gpt-6.1-sol', [2, 0.1, 10], [4, 0.2, 15]],
      ['gpt-6.1-terra', [1, 0.05, 5], [2, 0.1, 7.5]],
    ] as const;
    const usd = ([input, cached, output]: readonly [number, number, number]) =>
      (100 * input + 900 * cached + 50 * output) / 1_000_000;
    for (const [modelId, short, long] of rates) {
      for (const [contextTokens, expected] of [
        [1000, short],
        [300_000, long],
      ] as const) {
        const result = priceUsage(value({ pricing: { ...value().pricing!, modelId, contextTokens } }));
        expect(result.costUsd, `${modelId} at ${contextTokens}`).toBeCloseTo(usd(expected), 12);
        expect(result.cost).toMatchObject({ source: 'catalog', catalogVersion: USAGE_PRICE_SNAPSHOT.version });
      }
    }
  });
  it('versions the card by both its inputs: the models.dev snapshot and the vendor’s rows it lacks', () => {
    const { sha256, supplement, version } = USAGE_PRICE_SNAPSHOT;
    expect(supplement.source).toBe('https://developers.openai.com/api/docs/pricing');
    expect(version).toBe(createHash('sha256').update(`${sha256}\n${supplement.sha256}`).digest('hex'));
  });
});
