import type { MonitorCostBucket, MonitorUsageAggregate } from '@vibecook/puppeteer-core';

/** A cache of independently observed USD runs. Never reconstructed from transcripts. */
export interface UsageRunRecord {
  runId: string;
  /** Core monitor revision; a delayed snapshot cannot undo a correction. */
  revision?: number;
  costUsd?: number;
  coverage: NonNullable<MonitorUsageAggregate['costCoverage']>;
  buckets: MonitorCostBucket[];
}

export interface UsageLedgerRecord {
  currency: 'USD';
  providerId: string;
  nativeSessionId: string;
  savedAt: string;
  runs: UsageRunRecord[];
}

export interface UsageHistoryKey {
  providerId: string;
  nativeSessionId: string;
}

/** Optional display-history persistence, not a provider billing record. */
export interface UsageHistoryStore {
  load(key: UsageHistoryKey): Promise<UsageLedgerRecord | null>;
  save(records: readonly UsageLedgerRecord[]): Promise<void>;
}
