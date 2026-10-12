import type { UsageCostEstimate } from '@vibefield/puppeteer-core';
import {
  permitsLiveUsage,
  type MonitorFamilyUpdate,
  type MonitorUsageFamilyValue,
} from '@vibefield/puppeteer-core/monitor-spi';
import { USAGE_PRICES, USAGE_PRICE_SNAPSHOT } from './usage-prices.js';

interface Rates {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: readonly (Rates & { above: number })[];
}
const catalog: Readonly<Record<string, Rates>> = USAGE_PRICES;

/** Pure calculation against a pinned catalog. No transcript, tokenizer, or network access. */
export function priceUsage(value: MonitorUsageFamilyValue): MonitorUsageFamilyValue {
  const unavailable = (reason: string): MonitorUsageFamilyValue => {
    const { costUsd: _cost, ...rest } = value;
    return { ...rest, cost: { basis: 'api-equivalent', source: 'unavailable', reason } };
  };
  if (value.costUsd !== undefined && Number.isFinite(value.costUsd) && value.costUsd >= 0) {
    return { ...value, cost: { basis: 'api-equivalent', source: 'provider-reported' } };
  }
  const usage = value.pricing;
  if (!usage) return unavailable('No request pricing metadata');
  if (usage.gap) return unavailable(usage.gap);
  if (!usage.modelId) return unavailable('Unknown request model');
  // This catalog deliberately contains standard API reference rates only.
  if (usage.serviceTier && !['default', 'standard', 'auto'].includes(usage.serviceTier)) {
    return unavailable(`Unsupported service tier: ${usage.serviceTier}`);
  }
  let rates = catalog[`${usage.providerId}/${usage.modelId}`];
  if (!rates) return unavailable('Model absent from pinned price catalog');
  if (
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.cacheReadTokens === undefined ||
    usage.cacheCreationTokens === undefined
  ) {
    return unavailable('Incomplete billable token buckets');
  }
  if (rates.tiers?.length) {
    if (usage.contextTokens === undefined) return unavailable('Request context size unavailable for tiered pricing');
    for (const tier of [...rates.tiers].sort((a, b) => a.above - b.above)) {
      if (usage.contextTokens > tier.above) rates = tier;
    }
  }
  const cached = usage.cacheReadTokens;
  const written = usage.cacheCreationTokens ?? 0;
  if (cached > 0 && rates.cache_read === undefined) return unavailable('Cache-read rate unavailable');
  // Cache-write TTLs have different prices. Prefer Claude's reported estimate.
  if (written > 0) return unavailable('Cache-write duration unavailable');
  const inputUsd = (usage.inputTokens * rates.input + cached * (rates.cache_read ?? 0)) / 1_000_000;
  const outputUsd = (usage.outputTokens * rates.output) / 1_000_000;
  const cost: UsageCostEstimate = {
    basis: 'api-equivalent',
    source: 'catalog',
    catalogVersion: USAGE_PRICE_SNAPSHOT.sha256,
    inputUsd,
    outputUsd,
  };
  return { ...value, costUsd: inputUsd + outputUsd, cost };
}

/** Freeze an observation's estimate on ingress, never from the current session model. */
export function priceUsageUpdates(updates: readonly MonitorFamilyUpdate[], phase: string): MonitorFamilyUpdate[] {
  return updates.map((update) =>
    update.family === 'usage' &&
    update.operation === 'upsert' &&
    permitsLiveUsage(phase, update.value.origin) &&
    (update.value.canonical || update.value.pricing || update.value.costUsd !== undefined)
      ? { ...update, value: priceUsage(update.value) }
      : update,
  );
}
