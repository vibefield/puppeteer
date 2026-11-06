import type { MonitorStoredEntry } from './internal-types.js';
import { buildUsageIndex, queryUsageIndex, type MonitorUsageLedgerProjection } from './usage-index.js';

export type { MonitorUsageLedgerProjection };

export const DEFAULT_MONITOR_BURN_RATE_WINDOW_MS = 60_000;

/**
 * Projects corrected usage entries without adding low-latency cumulative
 * samples to canonical response contributions. `asOfMs` is injected by the
 * caller; this helper never reads the wall clock. It is the usage index's
 * query over an index of `entries`: the rule a monitor projection answers
 * from the index it memoizes per ledger.
 */
export function projectMonitorUsageLedger(
  entries: readonly MonitorStoredEntry[],
  asOfMs: number,
  windowMs = DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
): MonitorUsageLedgerProjection {
  return queryUsageIndex(buildUsageIndex(entries), asOfMs, windowMs);
}
