import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '@vibefield/puppeteer-core';
import { createClaudeAccountUsageService, fetchClaudeAccountUsageWithDependencies } from './account-usage.js';

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

describe('the Claude usage service, renewing through its renewer', () => {
  let folder = '';
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'puppeteer-usage-renewal-test-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  /** A root whose stored access token aged three hours ago, its refresh token beside it, in the root's own file. */
  async function agedRoot(name: string): Promise<string> {
    const root = join(folder, name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.credentials.json'), credential(Date.now() - 3 * HOUR_MS));
    return root;
  }

  const managedAt = (dataRoot: string): AgentProfile => ({
    id: 'p1',
    provider: 'claude',
    label: 'Work',
    kind: 'managed',
    dataRoot,
    createdAt: '2026-09-06T12:00:00.000Z',
  });

  /** A renewer that starts nothing: it has the service read again, and the token is still aged. */
  const readingAgain = () => ({
    renew: vi.fn(async (_profile: AgentProfile | undefined, confirm: () => Promise<boolean>) => confirm()),
  });

  /** A script in Claude Code's place: it writes the environment it was started with beside itself, then ends. */
  async function standIn(): Promise<string> {
    const script = join(folder, 'claude-stand-in.mjs');
    const lines = [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('./seen.json', import.meta.url), JSON.stringify(process.env));",
    ];
    await writeFile(script, `${lines.join('\n')}\n`);
    return script;
  }

  it('hands its renewer the profile it read aged, and answers the reading that failed when it stays aged', async () => {
    const profile = managedAt(await agedRoot('work'));
    const renewer = readingAgain();
    const service = createClaudeAccountUsageService({ env: { HOME: folder }, renewer });

    const result = await service.fetch({ profile });
    expect(renewer.renew).toHaveBeenCalledTimes(1);
    expect(renewer.renew.mock.calls[0]?.[0]).toBe(profile);
    expect(result).toMatchObject({ status: 'unavailable', provider: 'claude', retryable: true });
  });

  it('reads the native default through the environment it was given, then asks its renewer', async () => {
    const renewer = readingAgain();
    const env = { HOME: folder, CLAUDE_CONFIG_DIR: await agedRoot('native') };
    const service = createClaudeAccountUsageService({ env, renewer });

    const result = await service.fetch();
    expect(renewer.renew).toHaveBeenCalledTimes(1);
    expect(renewer.renew.mock.calls[0]?.[0]).toBeUndefined();
    expect(result).toMatchObject({ status: 'unavailable', provider: 'claude', retryable: true });
  });

  it('starts the executable it was given, under its environment, for a managed root read aged', async () => {
    const profile = managedAt(await agedRoot('work'));
    const env = { ...process.env, USER: 'usage-stand-in', CLAUDE_CODE_OAUTH_TOKEN: 'made-up-token' };
    const service = createClaudeAccountUsageService({ env, executable: await standIn() });

    const result = await service.fetch({ profile });
    const seen = JSON.parse(await readFile(join(folder, 'seen.json'), 'utf8')) as Record<string, string | undefined>;
    expect(seen.USER).toBe('usage-stand-in');
    expect(seen.CLAUDE_CONFIG_DIR).toBe(profile.dataRoot);
    expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result).toMatchObject({ status: 'unavailable', provider: 'claude', retryable: true });
  });

  it('starts nothing for the native default, and answers the reading that failed', async () => {
    const env = { HOME: folder, CLAUDE_CONFIG_DIR: await agedRoot('native') };
    const service = createClaudeAccountUsageService({ env, executable: await standIn() });

    const result = await service.fetch();
    expect(existsSync(join(folder, 'seen.json'))).toBe(false);
    expect(result).toMatchObject({ status: 'unavailable', provider: 'claude', retryable: true });
  });
});
