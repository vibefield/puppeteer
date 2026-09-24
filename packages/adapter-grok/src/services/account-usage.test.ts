import { AccountUsageSnapshotSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  createGrokAccountUsageService,
  fetchGrokAccountUsage,
  fetchGrokAccountUsageForProfile,
  normalizeGrokAccountUsage,
} from './account-usage.js';
import { GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';
import { GROK_BILLING_ACP_METHOD, type GrokAgentTransport } from '../transport/agent-client.js';

const creditsFixture = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
    },
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 300 },
    prepaidBalance: { val: 1250 },
    isUnifiedBillingUser: true,
  },
  subscription_tier: 'SuperGrok',
};

const legacyFixture = {
  config: {
    monthlyLimit: { val: 2000 },
    used: { val: 500 },
    billingPeriodStart: '2026-05-01T00:00:00Z',
    billingPeriodEnd: '2026-06-01T00:00:00Z',
    prepaidBalance: {},
  },
};

function scriptedTransport(respond: (message: Record<string, unknown>) => unknown): {
  transport: GrokAgentTransport;
  sent: Array<Record<string, unknown>>;
  closed: () => boolean;
} {
  let onMessage: ((message: unknown) => void) | undefined;
  let isClosed = false;
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: () => isClosed,
    transport: {
      send(message) {
        const request = message as Record<string, unknown>;
        sent.push(request);
        if (request.id === undefined) return;
        const reply = respond(request);
        queueMicrotask(() => onMessage?.(reply));
      },
      onMessage(handler) {
        onMessage = handler;
      },
      onClose() {},
      close() {
        isClosed = true;
      },
    },
  };
}

describe('Grok account usage', () => {
  it('advertises its provider identity and polling cadence', () => {
    expect(createGrokAccountUsageService().provider).toEqual({
      id: 'grok',
      label: 'Grok',
      refresh: { pollIntervalMs: 15 * 60_000 },
    });
  });

  it('normalizes the credits-config weekly pool and prepaid balance', () => {
    const snapshot = normalizeGrokAccountUsage(creditsFixture, '2026-06-03T00:00:00.000Z');
    expect(AccountUsageSnapshotSchema.parse(snapshot)).toEqual({
      provider: 'grok',
      fetchedAt: '2026-06-03T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'experimental' },
      credits: { balance: '12.50', hasCredits: true },
      metrics: [
        {
          id: 'grok:included:window',
          label: '7D',
          description: 'Grok weekly included usage',
          kind: 'window',
          usedPercent: 42.5,
          durationMinutes: 10_080,
          startsAt: '2026-06-01T00:00:00.000Z',
          resetsAt: '2026-06-08T00:00:00.000Z',
        },
        {
          id: 'grok:on-demand:budget',
          label: 'ON-DEMAND',
          description: 'Grok on-demand credit usage',
          kind: 'budget',
          usedPercent: 6,
          resetsAt: '2026-06-08T00:00:00.000Z',
        },
      ],
    });
  });

  it('derives a monthly window from the legacy billing-config cents', () => {
    const snapshot = normalizeGrokAccountUsage(legacyFixture, '2026-05-15T00:00:00.000Z');
    expect(snapshot.metrics).toEqual([
      {
        id: 'grok:included:window',
        label: '30D',
        description: 'Grok included usage',
        kind: 'window',
        usedPercent: 25,
        durationMinutes: 44_640,
        startsAt: '2026-05-01T00:00:00.000Z',
        resetsAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    expect(snapshot.credits).toEqual({ balance: '0.00', hasCredits: false });
  });

  it('does not treat a payload without quota data as usable account usage', () => {
    expect(normalizeGrokAccountUsage({ config: { isUnifiedBillingUser: true } }).metrics).toEqual([]);
    expect(normalizeGrokAccountUsage({ config: { isUnifiedBillingUser: true } }).credits).toBeUndefined();
  });

  it('ignores a zero on-demand cap and still returns the included window', () => {
    const snapshot = normalizeGrokAccountUsage({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-06-08T00:00:00Z' },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
    });
    expect(snapshot.metrics.map((metric) => metric.label)).toEqual(['7D']);
  });

  it('performs initialize, cached-token auth, then the underscored billing method and closes', async () => {
    const scripted = scriptedTransport((message) => {
      if (message.method === 'initialize') {
        return { id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } };
      }
      if (message.method === 'authenticate') return { id: message.id, result: {} };
      if (message.method === GROK_BILLING_ACP_METHOD) return { id: message.id, result: creditsFixture };
      throw new Error(`unexpected method: ${String(message.method)}`);
    });

    const result = await fetchGrokAccountUsage({
      transport: scripted.transport,
      now: () => new Date('2026-06-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('available');
    expect(scripted.sent.map((message) => message.method)).toEqual([
      'initialize',
      'authenticate',
      GROK_BILLING_ACP_METHOD,
    ]);
    expect(scripted.sent[2]?.method).toBe('_x.ai/billing');
    expect(scripted.sent.some((message) => message.method === 'x.ai/billing')).toBe(false);
    expect(scripted.closed()).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Bearer|access[_-]?token|auth\.json/i);
  });

  it('skips authenticate when the agent does not advertise cached_token', async () => {
    const scripted = scriptedTransport((message) => {
      if (message.method === 'initialize') return { id: message.id, result: { authMethods: [{ id: 'grok.com' }] } };
      if (message.method === GROK_BILLING_ACP_METHOD) return { id: message.id, result: creditsFixture };
      throw new Error(`unexpected method: ${String(message.method)}`);
    });

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toMatchObject({
      status: 'available',
    });
    expect(scripted.sent.map((message) => message.method)).toEqual(['initialize', GROK_BILLING_ACP_METHOD]);
  });

  it('reports unsupported when the agent does not register the billing method', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      ...(message.method === 'initialize'
        ? { result: { authMethods: [] } }
        : { error: { code: -32_601, message: 'Method not found' } }),
    }));

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unsupported',
      provider: 'grok',
      message: 'Grok account usage is not exposed through its ACP protocol',
      retryable: false,
    });
    expect(scripted.closed()).toBe(true);
  });

  it('returns a typed unauthenticated result without exposing the native error body', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      ...(message.method === 'initialize'
        ? { result: { authMethods: [] } }
        : {
            error: {
              code: -32_000,
              message: 'Authentication required to fetch billing data. Run `grok login`. token=secret',
            },
          }),
    }));

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'grok',
      message: 'Grok is not authenticated with a grok.com account',
      retryable: false,
    });
  });

  it('continues to billing when cached-token authenticate is refused', async () => {
    const scripted = scriptedTransport((message) => {
      if (message.method === 'initialize') {
        return { id: message.id, result: { authMethods: [{ id: 'cached_token' }] } };
      }
      if (message.method === 'authenticate') {
        return { id: message.id, error: { code: -32_000, message: 'No cached auth token found' } };
      }
      if (message.method === GROK_BILLING_ACP_METHOD) return { id: message.id, result: creditsFixture };
      throw new Error(`unexpected method: ${String(message.method)}`);
    });

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toMatchObject({
      status: 'available',
    });
  });

  it('treats a billing payload with no meters as unavailable', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      result:
        message.method === GROK_BILLING_ACP_METHOD ? { config: { isUnifiedBillingUser: true } } : { authMethods: [] },
    }));

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unavailable',
      provider: 'grok',
      message: 'Grok returned no recognized account usage limits',
      retryable: true,
    });
  });

  it('marks a 429 billing read as rate-limited without leaking the native body', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      ...(message.method === 'initialize'
        ? { result: { authMethods: [] } }
        : { error: { code: 429, message: 'private rate-limit detail' } }),
    }));

    await expect(fetchGrokAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unavailable',
      provider: 'grok',
      message: 'Grok account usage is unavailable',
      retryable: true,
      code: 'rate-limited',
    });
  });

  it('returns a typed configuration failure and closes the transport when the timeout is invalid', async () => {
    const scripted = scriptedTransport(() => {
      throw new Error('request should not be sent');
    });

    await expect(
      fetchGrokAccountUsage({
        transport: scripted.transport,
        requestTimeoutMs: 0,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'grok',
      message: 'Grok account usage timeout must be positive',
      retryable: false,
    });
    expect(scripted.sent).toEqual([]);
    expect(scripted.closed()).toBe(true);
  });
});

describe('Grok account usage per profile', () => {
  const managed: AgentProfile = {
    id: 'grok:7a10',
    provider: 'grok',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/Users/test/.puppeteer/profiles/grok/7a10',
    createdAt: '2026-09-06T00:00:00.000Z',
  };
  const nativeDefault: AgentProfile = { ...managed, id: 'grok:native-default', kind: 'native-default' };

  function recordingSpawn(): {
    spawnTransport: (options: { executable?: string; env?: Record<string, string> }) => GrokAgentTransport;
    spawns: Array<{ executable?: string; env?: Record<string, string> }>;
  } {
    const spawns: Array<{ executable?: string; env?: Record<string, string> }> = [];
    return {
      spawns,
      spawnTransport(options) {
        spawns.push(options);
        return scriptedTransport((request) => ({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === GROK_BILLING_ACP_METHOD ? creditsFixture : { authMethods: [] },
        })).transport;
      },
    };
  }

  it('binds the agent to the profile root and stamps the profile id', async () => {
    const spawn = recordingSpawn();
    const result = await fetchGrokAccountUsageForProfile(managed, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('grok:7a10');
    expect(spawn.spawns).toEqual([
      { env: { [GROK_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/grok/7a10' } },
    ]);
  });

  it('reads the native default account without a binding', async () => {
    const spawn = recordingSpawn();
    const result = await fetchGrokAccountUsageForProfile(nativeDefault, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('grok:native-default');
    expect(spawn.spawns).toEqual([{}]);
  });

  it('leaves a snapshot unstamped when no profile was selected', async () => {
    const spawn = recordingSpawn();
    const result = await fetchGrokAccountUsageForProfile(undefined, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBeUndefined();
    expect(spawn.spawns).toEqual([{}]);
  });

  it('routes the service fetch through the selected profile', async () => {
    const spawn = recordingSpawn();
    const service = createGrokAccountUsageService({ spawnTransport: spawn.spawnTransport });
    const result = await service.fetch({ profile: managed });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('grok:7a10');
    expect(spawn.spawns).toEqual([
      { env: { [GROK_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/grok/7a10' } },
    ]);
  });
});
