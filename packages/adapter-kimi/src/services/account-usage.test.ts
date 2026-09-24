import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountUsageFetchResultSchema, AccountUsageSnapshotSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  KIMI_USAGE_ENDPOINT,
  createKimiAccountUsageService,
  fetchKimiAccountUsage,
  fetchKimiAccountUsageForProfile,
  normalizeKimiAccountUsage,
} from './account-usage.js';

// The current document, as kimi-code packages/oauth/src/managed-usage.ts parses
// it: ratios may arrive as strings, wallet amounts are fixed-point strings.
const usageFixture = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-09-23T17:00:00Z' },
    limit_7d: { used_ratio: '0.4', reset_time: '2026-09-28T00:00:00Z' },
    limit_month_total: { used_ratio: 0.55, reset_time: '2026-10-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0.3, reset_time: '2026-10-01T00:00:00Z' },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: '20000000000', amountLeft: '10000000000' },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: 'CNY', priceInCents: '20000' },
    monthlyUsed: { currency: 'CNY', priceInCents: '5000' },
  },
};

// The older document: a weekly summary and `limits[]` rows with native windows.
const legacyUsageFixture = {
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

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ACCESS = 'kimi-access-7f3a9c';
const REFRESH = 'kimi-refresh-91bd4e';

const credential = (expiresAt = NOW.valueOf() / 1_000 + 900) => ({
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_at: expiresAt,
  expires_in: 900,
  scope: 'kimi-code',
  token_type: 'Bearer',
});

const tempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'puppeteer-kimi-usage-'));

async function writeCredential(root: string, document: unknown): Promise<void> {
  await mkdir(join(root, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'credentials', 'kimi-code.json'), JSON.stringify(document), { mode: 0o600 });
}

function expectNoTokens(result: unknown): void {
  expect(JSON.stringify(result)).not.toMatch(new RegExp(`${ACCESS}|${REFRESH}|Bearer`, 'i'));
}

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
  });

  it('normalizes the current windows in the CLI order, with the booster wallet and its charge limit', () => {
    const snapshot = normalizeKimiAccountUsage(usageFixture, '2026-09-23T12:00:00.000Z');
    expect(AccountUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toEqual({
      provider: 'kimi',
      fetchedAt: '2026-09-23T12:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'oauth-endpoint', stability: 'documented' },
      credits: { balance: '100.00 CNY', hasCredits: true },
      metrics: [
        {
          id: 'subscription:5h:window',
          label: '5H',
          description: '5-hour limit',
          kind: 'window',
          usedPercent: 25,
          durationMinutes: 300,
          resetsAt: '2026-09-23T17:00:00.000Z',
        },
        {
          id: 'subscription:weekly:window',
          label: '7D',
          description: 'Weekly limit',
          kind: 'window',
          usedPercent: 40,
          durationMinutes: 10_080,
          resetsAt: '2026-09-28T00:00:00.000Z',
        },
        {
          id: 'subscription:monthly:window',
          label: '30D',
          description: 'Monthly limit',
          kind: 'window',
          usedPercent: 55,
          durationMinutes: 43_200,
          resetsAt: '2026-10-01T00:00:00.000Z',
        },
        {
          id: 'subscription:monthly-code:window',
          label: 'CODE',
          description: "Kimi Code's share of the monthly limit",
          kind: 'window',
          usedPercent: 30,
          durationMinutes: 43_200,
          resetsAt: '2026-10-01T00:00:00.000Z',
        },
        {
          id: 'booster:monthly:budget',
          label: 'SPEND',
          description: 'Booster spend against the monthly charge limit',
          kind: 'budget',
          usedPercent: 25,
        },
      ],
    });
  });

  it('keeps only the windows present, past 100% when over, and drops entries without a usable ratio', () => {
    const snapshot = normalizeKimiAccountUsage(
      {
        usages: {
          limit_5h: { used_ratio: 1.2, reset_time: '' },
          limit_7d: { used_ratio: -0.1, reset_time: '2026-09-28T00:00:00Z' },
          limit_month_total: { used_ratio: 'high' },
          limit_month_code: 'not an entry',
        },
      },
      '2026-09-23T12:00:00.000Z',
    );
    expect(snapshot.metrics).toEqual([
      {
        id: 'subscription:5h:window',
        label: '5H',
        description: '5-hour limit',
        kind: 'window',
        usedPercent: 120,
        durationMinutes: 300,
      },
    ]);
    expect(snapshot).not.toHaveProperty('credits');
  });

  it('still normalizes the older document: weekly summary, folded 5-hour windows, and booster credits', () => {
    const snapshot = normalizeKimiAccountUsage(legacyUsageFixture, '2026-07-23T00:00:00.000Z');
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

  it('reads the current windows alone when a document carries both shapes', () => {
    const snapshot = normalizeKimiAccountUsage({ ...legacyUsageFixture, ...usageFixture }, '2026-09-23T12:00:00.000Z');
    expect(snapshot.metrics.map((metric) => metric.id)).toEqual([
      'subscription:5h:window',
      'subscription:weekly:window',
      'subscription:monthly:window',
      'subscription:monthly-code:window',
      'booster:monthly:budget',
    ]);
  });

  it('reads the booster wallet as the CLI does', () => {
    const wallet = (overrides: Record<string, unknown>) =>
      normalizeKimiAccountUsage({ boosterWallet: { ...usageFixture.boosterWallet, ...overrides } });
    // Never funded: no wallet at all.
    expect(wallet({ balance: { type: 'BOOSTER', amount: 0, amountLeft: 0 } })).not.toHaveProperty('credits');
    expect(wallet({ balance: { type: 'GIFT', amount: 1_000_000, amountLeft: 1_000_000 } })).not.toHaveProperty(
      'credits',
    );
    // Spent down: a wallet with nothing left, and under a cent rounds up to one.
    expect(wallet({ balance: { type: 'BOOSTER', amount: 5_000_000 } }).credits).toEqual({
      balance: '0.00 CNY',
      hasCredits: false,
    });
    expect(wallet({ balance: { type: 'BOOSTER', amount: 5_000_000, amountLeft: 400_000 } }).credits).toEqual({
      balance: '0.01 CNY',
      hasCredits: true,
    });
    // The charge limit is a meter only while it is on; the currency falls back to USD.
    const off = wallet({ monthlyChargeLimitEnabled: false });
    expect(off.metrics).toEqual([]);
    expect(off.credits).toEqual({ balance: '100.00 CNY', hasCredits: true });
    const unspent = normalizeKimiAccountUsage({
      boosterWallet: {
        balance: { type: 'BOOSTER', amount: 1_000_000_000, amountLeft: 1_000_000_000 },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { priceInCents: 1_000 },
      },
    });
    expect(unspent.credits).toEqual({ balance: '10.00 USD', hasCredits: true });
    expect(unspent.metrics).toMatchObject([{ id: 'booster:monthly:budget', usedPercent: 0 }]);
  });
});

describe('Kimi account usage fetch', () => {
  it('fetches the usages endpoint with a bearer token and does not log it', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const result = await fetchKimiAccountUsage({
      root: await tempRoot(),
      env: {},
      now: () => NOW,
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

  it("reads the root's credential file and reports unauthenticated when there is none", async () => {
    const root = await tempRoot();
    await writeCredential(root, credential());
    const result = await fetchKimiAccountUsage({
      root,
      env: {},
      now: () => NOW,
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(result.status).toBe('available');
    expectNoTokens(result);

    await expect(
      fetchKimiAccountUsage({
        root: await tempRoot(),
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

  it('leaves a lapsed token to Kimi Code: no request, and not a sign-in prompt', async () => {
    const root = await tempRoot();
    await writeCredential(root, credential(NOW.valueOf() / 1_000 - 35 * 86_400));
    const before = await readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8');
    let requests = 0;
    const result = await fetchKimiAccountUsage({
      root,
      env: {},
      now: () => NOW,
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(result).toMatchObject({ status: 'unavailable', provider: 'kimi', retryable: true });
    expect(requests).toBe(0);
    expect(await readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8')).toBe(before);
    expectNoTokens(result);
  });

  it('maps HTTP 401 to unauthenticated without exposing the native body', async () => {
    await expect(
      fetchKimiAccountUsage({
        root: await tempRoot(),
        env: {},
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

  it('carries a rate limit and its retry time', async () => {
    const result = await fetchKimiAccountUsage({
      root: await tempRoot(),
      env: {},
      now: () => NOW,
      resolveAccessToken: async () => 'secret-token',
      fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    });
    expect(result).toEqual({
      status: 'unavailable',
      provider: 'kimi',
      message: 'Kimi account usage request failed with HTTP 429',
      retryable: true,
      code: 'rate-limited',
      retryAt: '2026-09-23T12:02:00.000Z',
    });
  });

  it('asks the platform the root signed in to, unless KIMI_CODE_BASE_URL says otherwise', async () => {
    const root = await tempRoot();
    await writeCredential(root, credential());
    await writeFile(join(root, 'region'), 'global\n');
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(usageFixture), { status: 200 });
    };
    await fetchKimiAccountUsage({ root, env: {}, now: () => NOW, fetchImpl });
    await fetchKimiAccountUsage({
      root,
      env: { KIMI_CODE_BASE_URL: 'https://proxy.example/coding/v1/' },
      now: () => NOW,
      fetchImpl,
    });
    expect(urls).toEqual(['https://api.kimi.ai/coding/v1/usages', 'https://proxy.example/coding/v1/usages']);
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
    const directory = await tempRoot();
    await writeCredential(directory, credential());
    const profile = { ...managed, dataRoot: directory };
    const result = await fetchKimiAccountUsageForProfile(profile, {
      env: {},
      now: () => NOW,
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
        return new Response(JSON.stringify(usageFixture), { status: 200 });
      },
    });
    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('kimi:7a10');
    expectNoTokens(result);
  });

  it("keeps a managed profile on its own root, and follows that root's platform", async () => {
    const directory = await tempRoot();
    await writeCredential(directory, credential());
    await writeFile(
      join(directory, 'config.toml'),
      '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n',
    );
    const elsewhere = await tempRoot();
    const urls: string[] = [];
    const result = await fetchKimiAccountUsageForProfile(
      { ...managed, dataRoot: directory },
      {
        root: elsewhere,
        env: { KIMI_CODE_HOME: elsewhere },
        now: () => NOW,
        fetchImpl: async (url) => {
          urls.push(String(url));
          return new Response(JSON.stringify(usageFixture), { status: 200 });
        },
      },
    );
    expect(result.status).toBe('available');
    expect(urls).toEqual(['https://api.kimi.ai/coding/v1/usages']);
  });

  it('reads the native default where Kimi Code resolves it', async () => {
    const home = await tempRoot();
    await writeCredential(home, credential());
    const result = await createKimiAccountUsageService({
      env: { KIMI_CODE_HOME: home },
      now: () => NOW,
      fetchImpl: async () => new Response(JSON.stringify(usageFixture), { status: 200 }),
    }).fetch({
      profile: { ...managed, id: 'kimi:native-default', kind: 'native-default', dataRoot: home },
    });
    expect(result).toMatchObject({ status: 'available', snapshot: { profileId: 'kimi:native-default' } });
  });
});
