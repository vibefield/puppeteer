import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fetchClaudeAccountUsageWithDependencies } from './account-usage.js';

const NOW = new Date('2026-11-17T06:00:00.000Z');
const HOUR_MS = 3_600_000;

/** A stored credential document, as Claude Code keeps it; every value is made up. */
function credential(expiresAt: number, withRefreshToken = true): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `made-up-access-${expiresAt}`,
      ...(withRefreshToken ? { refreshToken: 'made-up-refresh' } : {}),
      expiresAt,
    },
  });
}

const AGED = credential(NOW.valueOf() - 3 * HOUR_MS);
const FRESH = credential(NOW.valueOf() + 8 * HOUR_MS);

/** The store is read through the Keychain seam alone: no file, and nothing of the ambient environment. */
function reading(read: () => string) {
  return {
    env: {},
    credentialsPath: resolve('/nonexistent/claude/.credentials.json'),
    useKeychain: true,
    readKeychainPayload: async () => read(),
    now: () => NOW,
  };
}

function usageEndpoint() {
  const body = JSON.stringify({ five_hour: { utilization: 12, resets_at: '2026-11-17T09:00:00.000Z' } });
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status: 200 }));
}

describe('Claude account usage, renewing an aged access token', () => {
  it('renews an aged access token through Claude Code, then reads the limits', async () => {
    let stored = AGED;
    const renew = vi.fn(async (confirm: () => Promise<boolean>) => {
      // Claude Code's own start stores the new token; this observer only reads again.
      stored = FRESH;
      return confirm();
    });
    const endpoint = usageEndpoint();

    const result = await fetchClaudeAccountUsageWithDependencies({
      ...reading(() => stored),
      fetchImpl: endpoint as unknown as typeof fetch,
      renewAccessToken: renew,
    });

    expect(renew).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('available');
    expect(endpoint).toHaveBeenCalledTimes(1);
    // The token sent is the renewed one, never the aged one.
    const sent = new Headers(endpoint.mock.calls[0]?.[1]?.headers).get('authorization');
    expect(sent).toBe(`Bearer made-up-access-${NOW.valueOf() + 8 * HOUR_MS}`);
  });

  it('reports a reading that failed when the renewal leaves the token aged', async () => {
    const renew = vi.fn(async (confirm: () => Promise<boolean>) => confirm());
    const endpoint = usageEndpoint();

    const result = await fetchClaudeAccountUsageWithDependencies({
      ...reading(() => AGED),
      fetchImpl: endpoint as unknown as typeof fetch,
      renewAccessToken: renew,
    });

    expect(renew).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'unavailable', provider: 'claude', retryable: true });
    expect(endpoint).not.toHaveBeenCalled();
  });

  it('never asks for a renewal with nothing to renew from', async () => {
    const renew = vi.fn(async () => true);
    const endpoint = usageEndpoint();

    const result = await fetchClaudeAccountUsageWithDependencies({
      ...reading(() => credential(NOW.valueOf() - 3 * HOUR_MS, false)),
      fetchImpl: endpoint as unknown as typeof fetch,
      renewAccessToken: renew,
    });

    expect(renew).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'unauthenticated', retryable: false });
    expect(endpoint).not.toHaveBeenCalled();
  });

  it('never asks for a renewal while the access token is inside its lifetime', async () => {
    const renew = vi.fn(async () => true);
    const endpoint = usageEndpoint();

    const result = await fetchClaudeAccountUsageWithDependencies({
      ...reading(() => FRESH),
      fetchImpl: endpoint as unknown as typeof fetch,
      renewAccessToken: renew,
    });

    expect(renew).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
  });
});
