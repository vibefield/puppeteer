import type { AccountUsageBatch } from '@vibefield/puppeteer-core';

/**
 * The usage column's feed: the latest batch and its changes, from whichever
 * process runs the account-usage monitor (`createAccountUsageMonitor` in the
 * runtime). Godview's port is its main process over IPC; VibeField's is its
 * daemon's usage door and subscription. The column dials nothing itself.
 */
export interface AccountUsagePort {
  snapshot(): Promise<AccountUsageBatch>;
  subscribe(listener: (batch: AccountUsageBatch) => void): () => void;
}
