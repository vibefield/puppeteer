import type { MonitorStoredEntry, MonitorUsageFamilyValue } from './internal-types.js';
import type { MonitorCostBucket, MonitorUsageAggregate } from './types.js';

export const MONITOR_COST_STEP_MS = 30_000;
export const MONITOR_COST_STEP_COUNT = 20;

/** The cost ledger uses observation identity/time, never differences of UI totals. */
export function projectUsageCost(
  entries: readonly MonitorStoredEntry[],
  asOfMs: number,
  windowMs: number,
): Pick<
  MonitorUsageAggregate,
  'costUsd' | 'costCoverage' | 'costRatePerMin' | 'pricedObservations' | 'unpricedObservations'
> & { costHistory: MonitorCostBucket[] } {
  const boundary = Math.floor(asOfMs / MONITOR_COST_STEP_MS) * MONITOR_COST_STEP_MS;
  const buckets: MonitorCostBucket[] = Array.from({ length: MONITOR_COST_STEP_COUNT }, (_, index) => ({
    at: new Date(boundary - (MONITOR_COST_STEP_COUNT - index - 1) * MONITOR_COST_STEP_MS).toISOString(),
    costUsd: 0,
  }));
  let priced = 0;
  let unpriced = 0;
  let total = 0;
  let recent = 0;
  const unsplitBuckets = new Set<number>();
  for (const entry of entries) {
    const value = entry.value as MonitorUsageFamilyValue;
    const amount = value.costUsd;
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
      if (value.canonical || value.pricing || value.cost) unpriced += 1;
      continue;
    }
    priced += 1;
    total += amount;
    const at = Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt);
    if (!entry.rateEligible || !Number.isFinite(at) || at > asOfMs) continue;
    if (at > asOfMs - windowMs) recent += amount;
    const index =
      MONITOR_COST_STEP_COUNT -
      1 -
      Math.floor((boundary - Math.floor(at / MONITOR_COST_STEP_MS) * MONITOR_COST_STEP_MS) / MONITOR_COST_STEP_MS);
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.costUsd += amount;
    if (amount > 0 && (value.cost?.inputUsd === undefined || value.cost.outputUsd === undefined)) {
      unsplitBuckets.add(index);
      delete bucket.inputUsd;
      delete bucket.outputUsd;
    }
    if (unsplitBuckets.has(index)) continue;
    if (value.cost?.inputUsd !== undefined) bucket.inputUsd = (bucket.inputUsd ?? 0) + value.cost.inputUsd;
    if (value.cost?.outputUsd !== undefined) bucket.outputUsd = (bucket.outputUsd ?? 0) + value.cost.outputUsd;
  }
  return {
    ...(priced > 0 ? { costUsd: total, costRatePerMin: (recent * 60_000) / windowMs } : {}),
    costCoverage: priced === 0 ? 'unavailable' : unpriced > 0 ? 'partial' : 'complete',
    pricedObservations: priced,
    unpricedObservations: unpriced,
    costHistory: priced > 0 ? buckets : [],
  };
}
