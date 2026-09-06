import { describe, expect, it } from 'vitest';
import {
  createCodexAccountUsageService,
  fetchCodexAccountUsage,
  fetchCodexAccountUsageForProfile,
  normalizeCodexAccountUsage,
} from './account-usage.js';
import type { AgentProfile } from '@vibecook/puppeteer-core';
import type { Transport } from '../transport/app-server-client.js';

const fixture = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    },
    codex_spark: {
      limitId: 'codex_spark',
      limitName: 'Codex Spark',
      primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
      secondary: null,
    },
  },
  rateLimitResetCredits: { availableCount: 2, credits: null },
};

function scriptedTransport(respond: (message: Record<string, unknown>) => unknown): {
  transport: Transport;
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

describe('Codex account usage', () => {
  it('advertises its provider identity and polling cadence', () => {
    expect(createCodexAccountUsageService().provider).toEqual({
      id: 'codex',
      label: 'Codex',
      refresh: { pollIntervalMs: 60_000 },
    });
  });
  it('normalizes every metered bucket and labels windows by reported duration', () => {
    const snapshot = normalizeCodexAccountUsage(fixture, '2026-07-23T00:00:00.000Z');

    expect(snapshot).toEqual({
      provider: 'codex',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'documented' },
      credits: { balance: '12.50', hasCredits: true, unlimited: false, resetCreditsAvailable: 2 },
      metrics: [
        {
          id: 'codex:primary:window',
          label: '5H',
          description: 'codex 5H usage',
          kind: 'window',
          usedPercent: 25,
          durationMinutes: 300,
          resetsAt: '2027-01-15T08:00:00.000Z',
        },
        {
          id: 'codex:secondary:window',
          label: '7D',
          description: 'codex 7D usage',
          kind: 'window',
          usedPercent: 40,
          durationMinutes: 10_080,
          resetsAt: '2027-01-22T08:00:00.000Z',
        },
        {
          id: 'codex_spark:primary:window',
          label: 'SPARK',
          description: 'Codex Spark SPARK usage',
          kind: 'window',
          usedPercent: 7,
          durationMinutes: 10_080,
          resetsAt: '2027-01-22T08:00:00.000Z',
        },
      ],
    });
  });

  it('falls back to the backward-compatible single bucket and tolerates missing metadata', () => {
    const snapshot = normalizeCodexAccountUsage({
      rateLimits: {
        limitId: null,
        primary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: null },
        secondary: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    });

    expect(snapshot.metrics).toEqual([
      {
        id: 'codex:primary:window',
        label: '7D',
        description: 'codex 7D usage',
        kind: 'window',
        usedPercent: 6,
        durationMinutes: 10_080,
      },
    ]);
  });

  it('preserves workspace spend-control limits even when rolling windows are absent', () => {
    const snapshot = normalizeCodexAccountUsage(
      {
        rateLimits: {
          limitId: 'workspace',
          limitName: 'Workspace allocation',
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: {
            limit: '100.00',
            used: '80.00',
            remainingPercent: 20,
            resetsAt: 1_800_604_800,
          },
          spendControlReached: true,
          planType: 'team',
          rateLimitReachedType: 'workspace_member_usage_limit_reached',
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot.scope).toBe('workspace');
    expect(snapshot.metrics).toEqual([
      {
        id: 'workspace:budget',
        label: 'BUDGET',
        description: 'Workspace allocation',
        kind: 'budget',
        usedPercent: 80,
        resetsAt: '2027-01-22T08:00:00.000Z',
      },
    ]);
  });

  it('does not treat bucket metadata without quota data as usable account usage', () => {
    expect(
      normalizeCodexAccountUsage({
        rateLimits: { limitId: 'codex', planType: 'plus', primary: null, secondary: null },
      }).metrics,
    ).toEqual([]);
  });

  it('performs initialize then the documented read and closes its one-shot transport', async () => {
    const scripted = scriptedTransport((message) => {
      if (message.method === 'initialize') return { id: message.id, result: {} };
      if (message.method === 'account/rateLimits/read') return { id: message.id, result: fixture };
      throw new Error(`unexpected method: ${String(message.method)}`);
    });

    const result = await fetchCodexAccountUsage({
      transport: scripted.transport,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('available');
    expect(scripted.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(scripted.closed()).toBe(true);
  });

  it('returns a typed unauthenticated result without exposing the native error body', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      ...(message.method === 'initialize'
        ? { result: {} }
        : { error: { code: -32_000, message: 'Login required: secret native detail' } }),
    }));

    await expect(fetchCodexAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'codex',
      message: 'Codex is not authenticated with a supported account',
      retryable: false,
    });
  });

  it('returns a typed configuration failure and closes the transport when client construction fails', async () => {
    const scripted = scriptedTransport(() => {
      throw new Error('request should not be sent');
    });

    await expect(
      fetchCodexAccountUsage({
        transport: scripted.transport,
        requestTimeoutMs: 0,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'codex',
      message: 'Codex account usage timeout must be positive',
      retryable: false,
    });
    expect(scripted.sent).toEqual([]);
    expect(scripted.closed()).toBe(true);
  });
});

describe('Codex account usage per profile', () => {
  const managed: AgentProfile = {
    id: 'codex:7a10',
    provider: 'codex',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/Users/test/.puppeteer/profiles/codex/7a10',
    createdAt: '2026-09-06T00:00:00.000Z',
  };
  const nativeDefault: AgentProfile = { ...managed, id: 'codex:native-default', kind: 'native-default' };

  function recordingSpawn(): {
    spawnTransport: (options: { executable?: string; env?: Record<string, string> }) => Transport;
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
          result: request.method === 'account/rateLimits/read' ? fixture : {},
        })).transport;
      },
    };
  }

  it('binds the app-server to the profile root and stamps the profile id', async () => {
    const spawn = recordingSpawn();
    const result = await fetchCodexAccountUsageForProfile(managed, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('codex:7a10');
    expect(spawn.spawns).toEqual([{ env: { CODEX_HOME: '/Users/test/.puppeteer/profiles/codex/7a10' } }]);
  });

  it('reads the native default account without a binding', async () => {
    const spawn = recordingSpawn();
    const result = await fetchCodexAccountUsageForProfile(nativeDefault, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('codex:native-default');
    expect(spawn.spawns).toEqual([{}]);
  });

  it('leaves a snapshot unstamped when no profile was selected', async () => {
    const spawn = recordingSpawn();
    const result = await fetchCodexAccountUsageForProfile(undefined, { spawnTransport: spawn.spawnTransport });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBeUndefined();
    expect(spawn.spawns).toEqual([{}]);
  });

  it('routes the service fetch through the selected profile', async () => {
    const spawn = recordingSpawn();
    const service = createCodexAccountUsageService({ spawnTransport: spawn.spawnTransport });
    const result = await service.fetch({ profile: managed });

    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('codex:7a10');
    expect(spawn.spawns).toEqual([{ env: { CODEX_HOME: '/Users/test/.puppeteer/profiles/codex/7a10' } }]);
  });
});
