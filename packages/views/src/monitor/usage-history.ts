/*
 * The UI's usage ledger for one conversation, as a host persists it so a
 * resumed session opens with the total and the burn it had. Keyed by the
 * provider and its native session id, the identity a resume continues. This
 * is cache, not state: the ledger (`usage-ledger.ts`) owns the numbers, the
 * host only keeps them, and losing a record costs a resumed bubble nothing but
 * its first ten minutes of history.
 */

/** One series of the UI's usage ledger as persisted: the held number and its step snapshots. */
export interface UsageSeriesRecord {
  held?: number;
  snapshots: number[];
}

export interface UsageLedgerRecord {
  providerId: string;
  nativeSessionId: string;
  /** ISO time of the save. */
  savedAt: string;
  /** The last step boundary snapshotted, in steps since the epoch. */
  boundary: number;
  total: UsageSeriesRecord;
  output?: UsageSeriesRecord;
  input?: UsageSeriesRecord;
}

export interface UsageHistoryKey {
  providerId: string;
  nativeSessionId: string;
}

/** Where a host keeps the ledgers between sessions; absent means nothing is kept. */
export interface UsageHistoryStore {
  /** The persisted ledger for a conversation, or null when none was saved. */
  load(key: UsageHistoryKey): Promise<UsageLedgerRecord | null>;
  /** Persist the live agents' ledgers; the host merges them into its cache. */
  save(records: readonly UsageLedgerRecord[]): Promise<void>;
}
