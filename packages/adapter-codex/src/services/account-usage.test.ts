import { describe, expect, it } from 'vitest';
import {
  createCodexAccountUsageService,
  fetchCodexAccountUsage,
  fetchCodexAccountUsageForProfile,
  normalizeCodexAccountUsage,
} from './account-usage.js';
import type { AgentProfile } from '@vibefield/puppeteer-core';
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
          label: 'SPARK 7D',
          description: 'Codex Spark 7D usage',
          kind: 'window',
          usedPercent: 7,
          durationMinutes: 10_080,
          resetsAt: '2027-01-22T08:00:00.000Z',
          group: { id: 'codex_spark', label: 'Codex Spark' },
        },
      ],
    });
  });

  it('keeps both Spark windows distinct from a weekly-only base account limit', () => {
    // Shape observed from Codex 0.154.0 account/rateLimits/read, 2026-09-11.
    const base = {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 96, windowDurationMins: 10_080, resetsAt: 1_789_435_505 },
      secondary: null,
    };
    const snapshot = normalizeCodexAccountUsage({
      rateLimits: base,
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_789_185_722 },
          secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_789_772_522 },
        },
        codex: base,
      },
    });
    expect(
      snapshot.metrics.map(({ label, usedPercent, durationMinutes }) => ({ label, usedPercent, durationMinutes })),
    ).toEqual([
      { label: '7D', usedPercent: 96, durationMinutes: 10_080 },
      { label: 'SPARK 5H', usedPercent: 0, durationMinutes: 300 },
      { label: 'SPARK 7D', usedPercent: 0, durationMinutes: 10_080 },
    ]);
    expect(snapshot.metrics[1]?.description).toBe('GPT-5.3-Codex-Spark 5H usage');
    expect(snapshot.metrics[2]?.description).toBe('GPT-5.3-Codex-Spark 7D usage');
    // both Spark windows are one part of the plan, named as the backend names it; the base limit is the plan
    expect(snapshot.metrics.map((metric) => metric.group)).toEqual([
      undefined,
      { id: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark' },
      { id: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark' },
    ]);
  });

  it('names the reserve Luna Reserve and holds it in standby: it is spent only after the plan runs out', () => {
    // The shape James's Pro account reads (2026-09-24): a weekly base limit and a weekly `gpt-reserve`.
    const snapshot = normalizeCodexAccountUsage({
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 10_080 } },
        'gpt-reserve': {
          limitId: 'gpt-reserve',
          limitName: null,
          primary: { usedPercent: 0, windowDurationMins: 10_080 },
        },
      },
    });
    expect(snapshot.metrics.map(({ label, group }) => ({ label, group }))).toEqual([
      { label: '7D', group: undefined },
      { label: 'GPT RESERVE 7D', group: { id: 'gpt-reserve', label: 'Luna Reserve', standby: true } },
    ]);
    // a backend name that only respells the id says no more than it; a real one is kept
    const respelled = normalizeCodexAccountUsage({
      rateLimitsByLimitId: {
        'gpt-reserve': {
          limitId: 'gpt-reserve',
          limitName: 'GPT Reserve',
          primary: { usedPercent: 3, windowDurationMins: 10_080 },
        },
      },
    });
    expect(respelled.metrics[0]?.group).toEqual({ id: 'gpt-reserve', label: 'Luna Reserve', standby: true });
    const renamed = normalizeCodexAccountUsage({
      rateLimitsByLimitId: {
        'gpt-reserve': {
          limitId: 'gpt-reserve',
          limitName: 'Luna Reserve (GPT-5.6 Luna)',
          primary: { usedPercent: 3, windowDurationMins: 10_080 },
        },
      },
    });
    expect(renamed.metrics[0]?.group).toEqual({
      id: 'gpt-reserve',
      label: 'Luna Reserve (GPT-5.6 Luna)',
      standby: true,
    });
  });

  it.each([
    ['codex_spark', undefined, 'SPARK'],
    ['codex_mini', undefined, 'MINI'],
    ['codex_other', 'Code review', 'CODE REVIEW'],
    ['codex_other', undefined, 'OTHER'],
  ])('retains the bucket identity for %s even without a known model name', (limitId, limitName, label) => {
    const snapshot = normalizeCodexAccountUsage({
      rateLimitsByLimitId: {
        [limitId!]: {
          limitId,
          limitName,
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
        },
      },
    });
    expect(snapshot.metrics.map((metric) => metric.label)).toEqual([`${label} 5H`, `${label} 7D`]);
    // a bucket the plan does not name is still one part of it, never in standby
    expect(new Set(snapshot.metrics.map((metric) => JSON.stringify(metric.group))).size).toBe(1);
    expect(snapshot.metrics[0]?.group?.id).toBe(limitId);
    expect(snapshot.metrics[0]?.group?.standby).toBeUndefined();
  });

  it.each([
    [15, '15M'],
    [60, '1H'],
    [1440, '1D'],
  ])('names a %s-minute window by its actual duration', (duration, label) => {
    const snapshot = normalizeCodexAccountUsage({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: duration } },
    });
    expect(snapshot.metrics[0]?.label).toBe(label);
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
