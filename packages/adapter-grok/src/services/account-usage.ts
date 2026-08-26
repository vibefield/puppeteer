import type { AccountUsageFetchResult, AccountUsageProvider, AccountUsageService } from '@vibecook/puppeteer-core';

export const GROK_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'grok',
  label: 'Grok',
  refresh: { pollIntervalMs: 15 * 60_000 },
};

/**
 * Grok Build fetches its weekly quota through an in-process
 * `x.ai/billing` TUI extension. The same method is not registered on direct or
 * shared-leader ACP connections, so the adapter must not claim a structured
 * capability or scrape the terminal/credential cache.
 */
export async function fetchGrokAccountUsage(): Promise<AccountUsageFetchResult> {
  return {
    status: 'unsupported',
    provider: 'grok',
    message: 'Grok account usage is not exposed through its ACP/headless protocol',
    retryable: false,
  };
}

/** Explicit unsupported capability so generic consumers can report its state. */
export function createGrokAccountUsageService(): AccountUsageService {
  return {
    provider: GROK_ACCOUNT_USAGE_PROVIDER,
    fetch: fetchGrokAccountUsage,
  };
}
