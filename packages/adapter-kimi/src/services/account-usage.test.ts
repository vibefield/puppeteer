import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountUsageFetchResultSchema, AccountUsageSnapshotSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  KIMI_USAGE_ENDPOINT,
  createKimiAccountUsageService,
  fetchKimiAccountUsage,
  fetchKimiAccountUsageForProfile,
  findKimiAccessToken,
  kimiUsageUrl,
  normalizeKimiAccountUsage,
} from './account-usage.js';

// Shape documented by kimi-code packages/oauth/src/managed-usage.ts.
const usageFixture = {
  usage: { used: '40', limit: '1000', resetTime: '2026-08-03T05:20:51Z' },
  limits: [
    {
      name: 'session',
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { used: '25', limit: '100', resetTime: '2026-08-01T12:00:00Z' },
    },
  ],
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: 500_000_000, amountLeft: 250_000_000 },
    monthlyChargeLimit: { currency: 'USD' },
  },
};

describe('Kimi account usage', () => {
  it('advertises its provider identity and polling cadence', () => {
    expect(createKimiAccountUsageService().provider).toEqual({
      id: 'kimi',
      label: 'Kimi',
      refresh: { pollIntervalMs: 5 * 60_000 },
    });
  });

  it('uses the documented managed usages endpoint', () => {
    expect(KIMI_USAGE_ENDPOINT).toBe('https://api.kimi.com/coding/v1/usages');
    expect(kimiUsageUrl({ KIMI_CODE_BASE_URL: 'https://api.kimi.ai/coding/v1/' })).toBe(
      'https://api.kimi.ai/coding/v1/usages',
    );
  });

  it('normalizes weekly summary, folded 5-hour windows, and booster credits', () => {
    const snapshot = normalizeKimiAccountUsage(usageFixture, '2026-07-23T00:00:00.000Z');
    expect(AccountUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toEqual({
      provider: 'kimi',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'oauth-endpoint', stability: 'documented' },
      credits: { balance: '2.50 USD', hasCredits: true },
      metrics: [
        {
          id: 'subscription:session:window',
          label: '5H',
          description: 'session',
          kind: 'window',
          usedPercent: 25,
          durationMinutes: 300,
          resetsAt: '2026-08-01T12:00:00.000Z',
        },
        {
          id: 'subscription:weekly:window',
          label: '7D',
          description: 'Weekly plan limit',
          kind: 'window',
          usedPercent: 4,
          durationMinutes: 10_080,
          resetsAt: '2026-08-03T05:20:51.000Z',
        },
      ],
    });
  });

  it('ignores an expired access token so Kimi Code remains the refresh owner', () => {
    expect(
      findKimiAccessToken({ access_token: 'stale', expires_at: 1_700_000_000 }, Date.parse('2026-09-11T00:00:00.000Z')),
    ).toBeUndefined();
    expect(
      findKimiAccessToken({ access_token: 'fresh', expires_at: 1_800_000_000 }, Date.parse('2026-07-23T00:00:00.000Z')),
    ).toBe('fresh');
  });

  it('fetches the usages endpoint with a bearer token and does not log it', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const result = await fetchKimiAccountUsage({
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      resolveAccessToken: async () => 'secret-token',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(AccountUsageFetchResultSchema.parse(result).status).toBe('available');
    expect(calls).toEqual([{ url: KIMI_USAGE_ENDPOINT, headers: expect.any(Headers) }]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(JSON.stringify(result)).not.toMatch(/secret-token|Bearer/i);
  });

  it('reads file credentials and reports unauthenticated when they are missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-credentials-'));
    const credentialsPath = join(directory, 'kimi-code.json');
    await writeFile(credentialsPath, JSON.stringify({ access_token: 'file-token', expires_at: 1_800_000_000 }), 'utf8');
    const result = await fetchKimiAccountUsage({
      credentialsPath,
      env: {},
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer file-token');
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(result.status).toBe('available');

    await expect(
      fetchKimiAccountUsage({
        credentialsPath: join(directory, 'missing.json'),
        env: {},
        fetchImpl: async () => new Response('{}', { status: 200 }),
      }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'kimi',
      message: 'Kimi Code OAuth credentials were not found',
      retryable: false,
    });
  });

  it('maps HTTP 401 to unauthenticated without exposing the native body', async () => {
    await expect(
      fetchKimiAccountUsage({
        resolveAccessToken: async () => 'secret-token',
        fetchImpl: async () => new Response('secret native detail', { status: 401 }),
      }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'kimi',
      message: 'Kimi Code OAuth credentials were rejected',
      retryable: false,
    });
  });
});

describe('Kimi account usage per profile', () => {
  const managed: AgentProfile = {
    id: 'kimi:7a10',
    provider: 'kimi',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/Users/test/.puppeteer/profiles/kimi/7a10',
    createdAt: '2026-09-06T00:00:00.000Z',
  };

  it('reads the profile credential file and stamps the profile id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-profile-'));
    await mkdir(join(directory, 'credentials'), { mode: 0o700 });
    await writeFile(
      join(directory, 'credentials', 'kimi-code.json'),
      JSON.stringify({ access_token: 'profile-token', expires_at: 1_800_000_000 }),
      'utf8',
    );
    const profile = { ...managed, dataRoot: directory };
    const result = await fetchKimiAccountUsageForProfile(profile, {
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer profile-token');
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('kimi:7a10');
  });
});
