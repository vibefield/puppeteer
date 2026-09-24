import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_USAGE_ENDPOINT,
  claudeAccountUsageFromStatusLine,
  claudeKeychainService,
  createClaudeAccountUsageService,
  fetchClaudeAccountUsageForProfileWithDependencies,
  fetchClaudeAccountUsageWithDependencies,
  findClaudeAccessToken,
  getClaudeStatusLineAccountUsage,
  normalizeClaudeAccountUsage,
  observeClaudeStatusLineAccountUsage,
  onClaudeAccountUsage,
  resetClaudeAccountUsageObserversForTests,
  resolveClaudeAccessToken,
} from './account-usage.js';
import * as publicApi from '../index.js';

describe('Claude account usage', () => {
  afterEach(() => {
    resetClaudeAccountUsageObserversForTests();
  });
  it('advertises its provider identity, safe polling cadence, and push channel', () => {
    const service = createClaudeAccountUsageService();
    expect(service.provider).toEqual({
      id: 'claude',
      label: 'Claude',
      refresh: { pollIntervalMs: 30 * 60_000, pushUpdatePollIntervalMs: 30 * 60_000 },
    });
    expect(service.subscribe).toEqual(expect.any(Function));
  });
  it('finds tokens in current and fallback credential layouts', () => {
    expect(findClaudeAccessToken({ claudeAiOauth: { accessToken: ' current-token ' } })).toBe('current-token');
    expect(findClaudeAccessToken({ nested: { access_token: 'fallback-token' } })).toBe('fallback-token');
    expect(findClaudeAccessToken({ apiKey: 'not-an-oauth-token' })).toBeUndefined();
  });

  it('prefers an environment token without consulting Keychain', async () => {
    const readKeychainPayload = vi.fn(async () => JSON.stringify({ accessToken: 'keychain-token' }));
    await expect(
      resolveClaudeAccessToken({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
        readKeychainPayload,
      }),
    ).resolves.toBe('env-token');
    expect(readKeychainPayload).not.toHaveBeenCalled();
  });

  it('reads file credentials and falls back to an injected Keychain reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-credentials-'));
    const credentialsPath = join(directory, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }), 'utf8');

    await expect(
      resolveClaudeAccessToken({
        env: {},
        credentialsPath,
        useKeychain: false,
      }),
    ).resolves.toBe('file-token');

    await expect(
      resolveClaudeAccessToken({
        env: {},
        credentialsPath: join(directory, 'missing.json'),
        useKeychain: true,
        readKeychainPayload: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }),
      }),
    ).resolves.toBe('keychain-token');
  });

  it('normalizes five-hour, weekly, and model-specific weekly windows', () => {
    const snapshot = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 12.5, resets_at: 1_800_000_000 },
        rate_limits: {
          seven_day: { used_percentage: 34, resets_at: '2027-01-22T08:00:00Z' },
          seven_day_opus: { utilization: 56, resets_at: 1_800_604_800 },
          unrelated: { note: 'not a quota window' },
        },
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot).toEqual({
      provider: 'claude',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'oauth-endpoint', stability: 'experimental' },
      metrics: [
        {
          id: 'subscription:five_hour:window',
          label: '5H',
          description: '5-hour usage',
          kind: 'window',
          durationMinutes: 300,
          usedPercent: 12.5,
          resetsAt: '2027-01-15T08:00:00.000Z',
        },
        {
          id: 'subscription:seven_day:window',
          label: '7D',
          description: '7-day usage',
          kind: 'window',
          durationMinutes: 10_080,
          usedPercent: 34,
          resetsAt: '2027-01-22T08:00:00.000Z',
        },
        {
          id: 'subscription:seven_day_opus:window',
          label: 'OPUS',
          description: '7-day opus usage',
          kind: 'window',
          durationMinutes: 10_080,
          usedPercent: 56,
          resetsAt: '2027-01-22T08:00:00.000Z',
          group: { id: 'scope:opus', label: 'Opus only' },
        },
      ],
    });
  });

  it('names optional credits correctly and emits one budget per credit limit', () => {
    const snapshot = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 12, resets_at: 1_800_000_000 },
        cinder_cove: { utilization: 22, resets_at: 1_800_604_800 },
        extra_usage: {
          is_enabled: true,
          state: 'enabled',
          monthly_limit: '100.00',
          used_credits: '25.00',
          utilization: 25,
          resets_at: 1_800_604_800,
        },
        limits: [
          {
            id: 'cowork_credit',
            name: 'Claude Code and Cowork credit',
            limit: '50.00',
            used: '10.00',
            remaining_percent: 80,
            expires_at: 1_800_604_800,
          },
        ],
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot.metrics).toEqual([
      {
        id: 'subscription:five_hour:window',
        label: '5H',
        description: '5-hour usage',
        kind: 'window',
        durationMinutes: 300,
        usedPercent: 12,
        resetsAt: '2027-01-15T08:00:00.000Z',
      },
      {
        id: 'cinder_cove:budget',
        label: 'CREDIT',
        description: 'Claude Code and Cowork credit',
        kind: 'budget',
        usedPercent: 22,
        resetsAt: '2027-01-22T08:00:00.000Z',
      },
      {
        id: 'cowork_credit:budget',
        label: 'CREDIT',
        description: 'Claude Code and Cowork credit',
        kind: 'budget',
        usedPercent: 20,
        resetsAt: '2027-01-22T08:00:00.000Z',
      },
      {
        id: 'extra_usage:budget',
        label: 'CREDIT',
        description: 'Usage credits',
        kind: 'budget',
        usedPercent: 25,
        resetsAt: '2027-01-22T08:00:00.000Z',
      },
    ]);
  });

  it('coalesces the live OAuth legacy and structured limits and uses the supplied model name', () => {
    // Shape observed from /api/oauth/usage with Claude Code 2.1.269, 2026-09-11.
    const reset = '2026-09-16T16:00:00.477157+00:00';
    const snapshot = normalizeClaudeAccountUsage({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 12, resets_at: reset },
      seven_day_sonnet: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      limits: [
        { kind: 'session', group: 'session', percent: 0, resets_at: null, scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: reset, scope: null },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 24,
          resets_at: reset,
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
      ],
      spend: { used: { currency: 'USD' }, limit: null, percent: 0, disabled_reason: null },
    });
    expect(snapshot.metrics.map(({ id, label, kind, usedPercent }) => ({ id, label, kind, usedPercent }))).toEqual([
      { id: 'subscription:five_hour:window', label: '5H', kind: 'window', usedPercent: 0 },
      { id: 'subscription:seven_day:window', label: '7D', kind: 'window', usedPercent: 12 },
      { id: 'subscription:seven_day_fable:window', label: 'FABLE', kind: 'window', usedPercent: 24 },
    ]);
    expect(snapshot.metrics[2]).toMatchObject({
      description: 'Current week (Fable) usage',
      durationMinutes: 10_080,
      resetsAt: '2026-09-16T16:00:00.477Z',
      // the part of the plan it meters, headed the way the usage page says it
      group: { id: 'scope:fable', label: 'Fable only' },
    });
    // the plan's own windows belong to no group
    expect(snapshot.metrics[0]!.group).toBeUndefined();
    expect(snapshot.metrics[1]!.group).toBeUndefined();
  });

  it('supports structured-only limits with stable identities independent of array order', () => {
    const limits = [
      { kind: 'session', percent: 9 },
      { kind: 'weekly_all', percent: 18 },
      { kind: 'weekly_scoped', percent: 36, scope: { model: { display_name: 'Fable 5.1' } } },
      {
        kind: 'weekly_scoped',
        percent: 50,
        scope: { model: { display_name: 'Fable 5.1' }, surface: { display_name: 'Claude Code' } },
      },
    ];
    const metrics = normalizeClaudeAccountUsage({ limits }).metrics;
    expect(metrics.map(({ label }) => label)).toEqual(['5H', '7D', 'FABLE 5.1 / CLAUDE CODE', 'FABLE 5.1']);
    expect(metrics.map(({ group }) => group?.label)).toEqual([
      undefined,
      undefined,
      'Fable 5.1 in Claude Code',
      'Fable 5.1 only',
    ]);
    expect(new Set(metrics.map(({ id }) => id)).size).toBe(4);
    expect(normalizeClaudeAccountUsage({ limits: [...limits].reverse() }).metrics).toEqual(metrics);
  });

  it('uses structured values for matching legacy model limits without conflating different models', () => {
    const snapshot = normalizeClaudeAccountUsage({
      seven_day_sonnet: { utilization: 10 },
      limits: [
        { kind: 'weekly_scoped', percent: 20, scope: { model: { display_name: 'Sonnet' } } },
        { kind: 'weekly_scoped', percent: 20, scope: { model: { display_name: 'Fable' } } },
      ],
    });
    expect(snapshot.metrics.map(({ label, usedPercent }) => ({ label, usedPercent }))).toEqual([
      { label: 'FABLE', usedPercent: 20 },
      { label: 'SONNET', usedPercent: 20 },
    ]);
    // the legacy field and the structured limit name the same part of the plan
    expect(snapshot.metrics[1]!.group).toEqual({ id: 'scope:sonnet', label: 'Sonnet only' });
  });

  it('omits disabled budgets, unknown backend counters, and unnamed structured limits', () => {
    expect(
      normalizeClaudeAccountUsage({
        extra_usage: { is_enabled: false, monthly_limit: 100, used_credits: 0, utilization: 0 },
        internal_counter: { percent: 80 },
        limits: [
          { percent: 25 },
          { id: 'disabled_credit', is_enabled: false, utilization: 0, limit: 100, used: 0 },
          { kind: 'weekly_scoped', percent: 25, scope: { model: { id: 'opaque-model-id' } } },
          { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } } },
        ],
      }).metrics,
    ).toEqual([]);
  });

  it('labels documented gateway spend limits as budgets', () => {
    expect(
      claudeAccountUsageFromStatusLine({
        rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 1_800_000_000 } },
      })?.snapshot.metrics,
    ).toEqual([
      {
        id: 'spend_limit:budget',
        label: 'SPEND',
        description: 'Spend limit',
        kind: 'budget',
        usedPercent: 62.8,
        resetsAt: '2027-01-15T08:00:00.000Z',
      },
    ]);
  });

  it('does not publish credential resolvers or dependency-injection hooks', () => {
    expect(publicApi).not.toHaveProperty('findClaudeAccessToken');
    expect(publicApi).not.toHaveProperty('resolveClaudeAccessToken');
    expect(publicApi).not.toHaveProperty('fetchClaudeAccountUsageWithDependencies');
    expect(publicApi).not.toHaveProperty('fetchClaudeAccountUsageForProfileWithDependencies');
  });

  it('sends the required OAuth headers and never returns the credential', async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = url;
      requestInit = init;
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: 1_800_000_000 },
          seven_day: { utilization: 20, resets_at: 1_800_604_800 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await fetchClaudeAccountUsageWithDependencies({
      resolveAccessToken: async () => 'super-secret-token',
      fetchImpl,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(requestUrl).toBe(CLAUDE_USAGE_ENDPOINT);
    expect(new Headers(requestInit?.headers).get('authorization')).toBe('Bearer super-secret-token');
    expect(new Headers(requestInit?.headers).get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(result.status).toBe('available');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('returns typed auth and transient failures', async () => {
    await expect(
      fetchClaudeAccountUsageWithDependencies({ resolveAccessToken: async () => undefined }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were not found',
      retryable: false,
    });

    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'expired',
        fetchImpl: vi.fn(async () => new Response('', { status: 401 })) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were rejected',
      retryable: false,
    });

    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'valid',
        fetchImpl: vi.fn(
          async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
        ) as typeof fetch,
        now: () => new Date('2026-07-23T20:00:00.000Z'),
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage request failed with HTTP 429',
      retryable: true,
      code: 'rate-limited',
      retryAt: '2026-07-23T20:02:00.000Z',
    });
  });

  it('returns unavailable for a successful but unrecognized payload', async () => {
    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'valid',
        fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude returned no recognized account usage limits',
      retryable: true,
    });
  });

  it('parses official status-line rate_limits without OAuth', () => {
    const result = claudeAccountUsageFromStatusLine(
      {
        model: { id: 'claude-opus-4-8' },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 41.2, resets_at: '2027-01-22T08:00:00Z' },
        },
      },
      '2026-07-23T18:00:00.000Z',
    );

    expect(result).toMatchObject({
      status: 'available',
      snapshot: {
        provider: 'claude',
        fetchedAt: '2026-07-23T18:00:00.000Z',
        scope: 'subscription',
        source: { kind: 'native-statusline', stability: 'documented' },
        metrics: [
          {
            id: 'subscription:five_hour:window',
            label: '5H',
            description: '5-hour usage',
            kind: 'window',
            durationMinutes: 300,
            usedPercent: 23.5,
            resetsAt: '2027-01-15T08:00:00.000Z',
          },
          {
            id: 'subscription:seven_day:window',
            label: '7D',
            description: '7-day usage',
            kind: 'window',
            durationMinutes: 10_080,
            usedPercent: 41.2,
            resetsAt: '2027-01-22T08:00:00.000Z',
          },
        ],
      },
    });
    expect(claudeAccountUsageFromStatusLine({ context_window: { used_percentage: 10 } })).toBeUndefined();
  });

  it('notifies process-global status-line usage observers', () => {
    const listener = vi.fn();
    const unsubscribe = onClaudeAccountUsage(listener);

    const first = observeClaudeStatusLineAccountUsage(
      {
        rate_limits: {
          five_hour: { used_percentage: 10, resets_at: 1_800_000_000 },
        },
      },
      '2026-07-23T18:00:00.000Z',
    );
    expect(first?.status).toBe('available');
    expect(listener).toHaveBeenCalledOnce();
    expect(getClaudeStatusLineAccountUsage()).toBe(first);

    unsubscribe();
    observeClaudeStatusLineAccountUsage(
      {
        rate_limits: {
          five_hour: { used_percentage: 20, resets_at: 1_800_000_000 },
        },
      },
      '2026-07-23T18:01:00.000Z',
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(getClaudeStatusLineAccountUsage()?.snapshot.metrics[0]?.usedPercent).toBe(20);
  });

  it('does not refresh or rewrite expired OAuth credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-read-only-'));
    const credentialsPath = join(directory, '.credentials.json');
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh-token-owned-by-claude',
        expiresAt: Date.parse('2026-07-01T00:00:00.000Z'),
      },
    });
    await writeFile(credentialsPath, original, 'utf8');
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;

    const result = await fetchClaudeAccountUsageWithDependencies({
      credentialsPath,
      useKeychain: false,
      fetchImpl,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'unauthenticated', provider: 'claude' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(credentialsPath, 'utf8')).resolves.toBe(original);
  });

  it('does not rotate fresh credentials after the usage endpoint rejects them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-rejected-read-only-'));
    const credentialsPath = join(directory, '.credentials.json');
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fresh-but-rejected',
        refreshToken: 'refresh-token-owned-by-claude',
        expiresAt: Date.parse('2026-07-24T00:00:00.000Z'),
      },
    });
    await writeFile(credentialsPath, original, 'utf8');
    let requestUrl: string | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestUrl = String(input);
      return new Response('', { status: 401 });
    }) as typeof fetch;

    const result = await fetchClaudeAccountUsageWithDependencies({
      credentialsPath,
      useKeychain: false,
      fetchImpl,
      now: () => new Date('2026-07-23T20:00:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'unauthenticated', provider: 'claude' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requestUrl).toBe(CLAUDE_USAGE_ENDPOINT);
    await expect(readFile(credentialsPath, 'utf8')).resolves.toBe(original);
  });
});

describe('Claude credential lookup per profile root', () => {
  // Probed 2026-09-06 on Claude Code 2.1.263 (RFC 006 "Resolved questions" §1).
  // The digests are sha256(root, NFC).hex[0:8] and are asserted as literals so a
  // change to the derivation cannot pass silently.
  it('uses the unsuffixed Keychain service for the native default root', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
    expect(claudeKeychainService('')).toBe('Claude Code-credentials');
    expect(claudeKeychainService('   ')).toBe('Claude Code-credentials');
  });

  it('suffixes the Keychain service with the config-dir digest for a managed root', () => {
    expect(claudeKeychainService('/Users/test/.puppeteer/profiles/claude/9f2b')).toBe(
      'Claude Code-credentials-bfe77fcf',
    );
    expect(claudeKeychainService('/Users/test/.claude')).toBe('Claude Code-credentials-462977e4');
  });

  it('normalizes the root to NFC before hashing so both Unicode forms agree', () => {
    const composed = '/Users/test/profiles/caf\u00e9';
    const decomposed = '/Users/test/profiles/cafe\u0301';
    expect(claudeKeychainService(composed)).toBe('Claude Code-credentials-8d81606d');
    expect(claudeKeychainService(decomposed)).toBe(claudeKeychainService(composed));
  });

  it('stamps the profile id on a snapshot read for one profile', async () => {
    const profile = {
      id: 'claude:9f2b',
      provider: 'claude' as const,
      label: 'Work',
      kind: 'managed' as const,
      dataRoot: '/Users/test/.puppeteer/profiles/claude/9f2b',
      createdAt: '2026-09-06T00:00:00.000Z',
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    const result = await fetchClaudeAccountUsageForProfileWithDependencies(profile, {
      resolveAccessToken: async () => 'token-from-the-profile-root',
      fetchImpl,
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('claude:9f2b');
  });

  it('leaves a snapshot unstamped when no profile was selected', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 12 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    const result = await fetchClaudeAccountUsageForProfileWithDependencies(undefined, {
      resolveAccessToken: async () => 'ambient-token',
      fetchImpl,
    });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBeUndefined();
  });
});
