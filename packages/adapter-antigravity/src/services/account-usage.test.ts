import {
  AccountUsageFetchResultSchema,
  AccountUsageSnapshotSchema,
  type AgentProfile,
} from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  antigravityAccountUsageFromStatusLine,
  createAntigravityAccountUsageService,
  fetchAntigravityAccountUsage,
  fetchAntigravityAccountUsageForProfile,
  normalizeAntigravityAccountUsage,
  type AntigravityAccountUsageExec,
} from './account-usage.js';
import { ANTIGRAVITY_PROFILE_ROOT_VARIABLE } from './profiles.js';

// Shape observed from Antigravity 1.1.21 `agy -p /usage --output-format json`, 2026-09-11.
const usageFixture = {
  conversation_id: '',
  status: 'SUCCESS',
  response:
    'Gemini Models\tWeekly Limit Remaining\t93.78%\t2026-07-06T07:50:32Z\nGemini Models\tFive Hour Limit Remaining\t74%\t2026-07-01T12:00:00Z\n',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.9378,
              reset_time: '2026-07-06T07:50:32Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.74,
              reset_time: '2026-07-01T12:00:00Z',
            },
            { id: 'gemini-disabled', name: 'Disabled', window: 'weekly', enabled: false, remaining_fraction: 1 },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-09-18T23:11:22Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.5,
              reset_time: '2026-09-12T04:11:22Z',
            },
          ],
        },
      ],
    },
  },
};

const creditsFixture = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Remaining credits\t12\nUpgrade\thttps://antigravity.google/g1-upgrade\n',
  command: { name: 'credits', data: { remaining_credits: 12, upgrade_uri: 'https://antigravity.google/g1-upgrade' } },
};

function scriptedExec(handlers: {
  usage?: unknown;
  credits?: unknown;
  usageStderr?: string;
  fail?: (command: string) => Error;
}): {
  exec: AntigravityAccountUsageExec;
  calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      const command = args.includes('/credits') ? 'credits' : 'usage';
      if (handlers.fail) throw handlers.fail(command);
      if (command === 'credits') {
        return { stdout: JSON.stringify(handlers.credits ?? creditsFixture), stderr: '' };
      }
      return { stdout: JSON.stringify(handlers.usage ?? usageFixture), stderr: handlers.usageStderr ?? '' };
    },
  };
}

describe('Antigravity account usage', () => {
  it('advertises its provider identity and polling cadence', () => {
    expect(createAntigravityAccountUsageService().provider).toEqual({
      id: 'antigravity',
      label: 'Antigravity',
      refresh: { pollIntervalMs: 5 * 60_000 },
    });
  });

  it('normalizes print-mode groups into Gemini base rings and prefixed third-party windows', () => {
    const snapshot = normalizeAntigravityAccountUsage(usageFixture, '2026-07-23T00:00:00.000Z');
    expect(AccountUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toEqual({
      provider: 'antigravity',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'documented' },
      metrics: [
        {
          id: 'gemini-5h:window',
          label: '5H',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          kind: 'window',
          usedPercent: 26,
          durationMinutes: 300,
          resetsAt: '2026-07-01T12:00:00.000Z',
          group: { id: 'gemini-models', label: 'Gemini models' },
        },
        {
          id: 'gemini-weekly:window',
          label: '7D',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          kind: 'window',
          usedPercent: 6.22,
          durationMinutes: 10_080,
          resetsAt: '2026-07-06T07:50:32.000Z',
          group: { id: 'gemini-models', label: 'Gemini models' },
        },
        {
          id: '3p-5h:window',
          label: '3P 5H',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          kind: 'window',
          usedPercent: 50,
          durationMinutes: 300,
          resetsAt: '2026-09-12T04:11:22.000Z',
          group: { id: 'claude-and-gpt-models', label: 'Claude and GPT models' },
        },
        {
          id: '3p-weekly:window',
          label: '3P 7D',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          kind: 'window',
          usedPercent: 0,
          durationMinutes: 10_080,
          resetsAt: '2026-09-18T23:11:22.000Z',
          group: { id: 'claude-and-gpt-models', label: 'Claude and GPT models' },
        },
      ],
    });
  });

  it('does not parse the tab-separated response field as quota', () => {
    expect(
      normalizeAntigravityAccountUsage({
        conversation_id: '',
        status: 'SUCCESS',
        response: 'Gemini Models\tWeekly Limit Remaining\t0%\t2026-07-06T07:50:32Z\n',
        command: { name: 'usage', data: { description: 'empty', groups: [] } },
      }).metrics,
    ).toEqual([]);
  });

  it('normalizes the documented status-line quota map', () => {
    const snapshot = antigravityAccountUsageFromStatusLine(
      {
        quota: {
          'gemini-weekly': {
            remaining_fraction: 0.9378,
            reset_time: '2026-07-06T07:50:32Z',
            reset_in_seconds: 560_580,
          },
          'gemini-5h': { remaining_fraction: 0.741, reset_time: '2026-07-01T12:00:00Z' },
        },
      },
      '2026-07-23T00:00:00.000Z',
    );
    expect(snapshot?.source).toEqual({ kind: 'native-statusline', stability: 'documented' });
    expect(snapshot?.metrics.map(({ label, usedPercent }) => ({ label, usedPercent }))).toEqual([
      { label: '5H', usedPercent: 25.9 },
      { label: '7D', usedPercent: 6.22 },
    ]);
    // the map has bucket ids only: the documented family is still named
    expect(snapshot?.metrics.map(({ group }) => group)).toEqual([
      { id: 'gemini-models', label: 'Gemini models' },
      { id: 'gemini-models', label: 'Gemini models' },
    ]);
  });

  it('reads print-mode usage and credits through one-shot json commands', async () => {
    const scripted = scriptedExec({});
    const result = await fetchAntigravityAccountUsage({
      executable: '/opt/agy',
      env: {},
      cwd: '/tmp',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      exec: scripted.exec,
    });

    expect(AccountUsageFetchResultSchema.parse(result).status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.snapshot.metrics.map((metric) => metric.label)).toEqual(['5H', '7D', '3P 5H', '3P 7D']);
    expect(result.snapshot.credits).toEqual({ balance: '12', hasCredits: true });
    expect(scripted.calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['-p', '/usage', '--output-format', 'json'],
      ['-p', '/credits', '--output-format', 'json'],
    ]);
    expect(scripted.calls[0]?.file).toBe('/opt/agy');
    expect(scripted.calls[0]?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
    expect(scripted.calls[0]?.env.AGY_CLI_HIDE_ACCOUNT_INFO).toBeUndefined();
  });

  it('returns a typed unauthenticated result without exposing native detail', async () => {
    const scripted = scriptedExec({
      usage: { status: 'ERROR' },
      usageStderr: 'Please sign in to view available models: secret native detail',
    });
    await expect(
      fetchAntigravityAccountUsage({ executable: '/opt/agy', env: {}, cwd: '/tmp', exec: scripted.exec }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'antigravity',
      message: 'Antigravity is not authenticated with a supported account',
      retryable: false,
    });
  });

  it('returns unavailable when print-mode yields no buckets', async () => {
    const scripted = scriptedExec({
      usage: { command: { name: 'usage', data: { groups: [] } } },
      credits: { command: { name: 'credits', data: {} } },
    });
    await expect(
      fetchAntigravityAccountUsage({ executable: '/opt/agy', env: {}, cwd: '/tmp', exec: scripted.exec }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'antigravity',
      message: 'Antigravity returned no account usage limits',
      retryable: true,
    });
  });

  it('maps a missing executable to a typed failure', async () => {
    await expect(
      fetchAntigravityAccountUsage({
        executable: '/missing/agy',
        env: {},
        cwd: '/tmp',
        exec: async () => {
          const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'antigravity',
      message: 'Antigravity executable was not found',
      retryable: true,
    });
  });
});

describe('Antigravity account usage per profile', () => {
  const managed: AgentProfile = {
    id: 'antigravity:7a10',
    provider: 'antigravity',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/Users/test/.puppeteer/profiles/antigravity/7a10',
    createdAt: '2026-09-06T00:00:00.000Z',
  };

  it('binds HOME to the profile root and stamps the profile id', async () => {
    const scripted = scriptedExec({});
    const result = await fetchAntigravityAccountUsageForProfile(managed, {
      executable: '/opt/agy',
      env: {},
      cwd: '/tmp',
      exec: scripted.exec,
    });
    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('antigravity:7a10');
    expect(scripted.calls[0]?.env.HOME).toBe(managed.dataRoot);
    expect(scripted.calls[0]?.env[ANTIGRAVITY_PROFILE_ROOT_VARIABLE]).toBe(managed.dataRoot);
  });

  it('reads the native default account without a home binding', async () => {
    const scripted = scriptedExec({});
    const result = await fetchAntigravityAccountUsageForProfile(
      { ...managed, id: 'antigravity:native-default', kind: 'native-default' },
      { executable: '/opt/agy', env: {}, cwd: '/tmp', exec: scripted.exec },
    );
    expect(result).toMatchObject({ status: 'available' });
    if (result.status !== 'available') return;
    expect(result.snapshot.profileId).toBe('antigravity:native-default');
    expect(scripted.calls[0]?.env.HOME).toBeUndefined();
    expect(scripted.calls[0]?.env[ANTIGRAVITY_PROFILE_ROOT_VARIABLE]).toBeUndefined();
  });
});
