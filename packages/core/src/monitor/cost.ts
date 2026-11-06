import type { MonitorStoredEntry, MonitorUsageFamilyValue } from './internal-types.js';
import type { MonitorCostBucket, MonitorUsageAggregate } from './types.js';

export const MONITOR_COST_STEP_MS = 30_000;
export const MONITOR_COST_STEP_COUNT = 20;

/** The clock-free half of a stream's cost: its counts and total, and the observations a window can hold. */
export interface UsageCostLedger {
  priced: number;
  unpriced: number;
  total: number;
  /** Priced, rate-eligible observations with a time, in ledger order. */
  timed: Array<{ value: MonitorUsageFamilyValue; at: number; amount: number }>;
  times: number[];
}

/**
 * Folds a stream's observations, in ledger order (ascending time), into what the clock never changes. `time` is
 * the observation's `Date.parse(rateAt ?? effectiveAt ?? observedAt)`, NEGATIVE_INFINITY when it is none.
 */
export function buildUsageCostLedger(
  entries: ReadonlyArray<{ entry: MonitorStoredEntry; time: number }>,
): UsageCostLedger {
  let priced = 0;
  let unpriced = 0;
  let total = 0;
  const timed: UsageCostLedger['timed'] = [];
  for (const { entry, time } of entries) {
    const value = entry.value as MonitorUsageFamilyValue;
    const amount = value.costUsd;
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
      if (value.canonical || value.pricing || value.cost) unpriced += 1;
      continue;
    }
    priced += 1;
    total += amount;
    if (!entry.rateEligible || !Number.isFinite(time)) continue;
    timed.push({ value, at: time, amount });
  }
  return { priced, unpriced, total, timed, times: timed.map(({ at }) => at) };
}

/** The first index whose time is at or above `bound`, in ascending times. */
function firstAtOrAbove(times: readonly number[], bound: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! >= bound) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The cost ledger uses observation identity/time, never differences of UI totals. Only an observation inside the
 * rate window or the bucket history can move a clock-dependent figure, so only those are walked, in ledger order.
 */
export function projectUsageCost(
  ledger: UsageCostLedger,
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
  let recent = 0;
  const unsplitBuckets = new Set<number>();
  const earliest = Math.min(asOfMs - windowMs, boundary - (MONITOR_COST_STEP_COUNT - 1) * MONITOR_COST_STEP_MS);
  for (let position = firstAtOrAbove(ledger.times, earliest); position < ledger.timed.length; position++) {
    const { value, at, amount } = ledger.timed[position]!;
    if (at > asOfMs) break;
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
    ...(ledger.priced > 0 ? { costUsd: ledger.total, costRatePerMin: (recent * 60_000) / windowMs } : {}),
    costCoverage: ledger.priced === 0 ? 'unavailable' : ledger.unpriced > 0 ? 'partial' : 'complete',
    pricedObservations: ledger.priced,
    unpricedObservations: ledger.unpriced,
    costHistory: ledger.priced > 0 ? buckets : [],
  };
}
