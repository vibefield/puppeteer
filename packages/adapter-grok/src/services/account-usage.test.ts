import { describe, expect, it } from 'vitest';
import { createGrokAccountUsageService, fetchGrokAccountUsage } from './account-usage.js';

describe('Grok account usage', () => {
  it('advertises its provider identity without asking a product to special-case it', () => {
    expect(createGrokAccountUsageService().provider).toEqual({
      id: 'grok',
      label: 'Grok',
      refresh: { pollIntervalMs: 15 * 60_000 },
    });
  });
  it('reports the missing public protocol capability explicitly', async () => {
    await expect(fetchGrokAccountUsage()).resolves.toEqual({
      status: 'unsupported',
      provider: 'grok',
      message: 'Grok account usage is not exposed through its ACP/headless protocol',
      retryable: false,
    });
  });
});
