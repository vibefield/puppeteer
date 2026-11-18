import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '@vibefield/puppeteer-core';
import { CLAUDE_RENEWAL_ARGS, createClaudeTokenRenewer, type ClaudeRenewalInvocation } from './account-renewal.js';

const EXECUTABLE = resolve('/Users/test/.local/bin/claude');
const EMPTY = resolve('/var/empty-for-renewal');
const START = new Date('2026-11-17T06:00:00.000Z');

const managed: AgentProfile = {
  id: 'p1',
  provider: 'claude',
  label: 'Work',
  kind: 'managed',
  dataRoot: resolve('/Users/test/.puppeteer/profiles/work/claude-9f2b'),
  createdAt: '2026-09-06T12:00:00.000Z',
};

const other: AgentProfile = {
  ...managed,
  id: 'p2',
  dataRoot: resolve('/Users/test/.puppeteer/profiles/home/claude-1c3d'),
};

const nativeDefault: AgentProfile = {
  id: 'claude:default',
  provider: 'claude',
  label: 'Default',
  kind: 'native-default',
  dataRoot: resolve('/Users/test/.claude'),
  createdAt: '2026-09-06T12:00:00.000Z',
};

/** What a host's own environment may hold beside the few variables a renewal is given. */
const AMBIENT: NodeJS.ProcessEnv = {
  HOME: '/Users/test',
  USER: 'test',
  LOGNAME: 'test',
  PATH: '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  ANTHROPIC_API_KEY: 'made-up-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'made-up-token',
  CLAUDE_CONFIG_DIR: '/elsewhere',
  HOST_SECRET: 'made-up-secret',
};

const PASSED = { HOME: '/Users/test', USER: 'test', LOGNAME: 'test', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };

function renewer(run: (invocation: ClaudeRenewalInvocation) => Promise<void>, now: () => Date = () => START) {
  return createClaudeTokenRenewer({ executable: EXECUTABLE, env: AMBIENT, workingDirectory: EMPTY, run, now });
}

describe('Claude token renewal', () => {
  it('starts Claude Code once, sending no message, under the root and an allow-list environment', async () => {
    const seen: ClaudeRenewalInvocation[] = [];
    const renewal = renewer(async (invocation) => {
      seen.push(invocation);
    });

    await expect(renewal.renew(managed, async () => true)).resolves.toBe(true);
    expect(seen).toEqual([
      {
        command: EXECUTABLE,
        args: ['--safe-mode', '--strict-mcp-config', '--print', '/cost', '--no-session-persistence'],
        cwd: EMPTY,
        env: { ...PASSED, TERM: 'dumb', CLAUDE_CONFIG_DIR: managed.dataRoot },
        timeoutMs: 30_000,
      },
    ]);
    expect(seen[0]?.args).toEqual([...CLAUDE_RENEWAL_ARGS]);
    // Nothing of the host's own: no key, no token override, no secret.
    expect(JSON.stringify(seen[0])).not.toContain('made-up');
  });

  it("binds no root for the native default, whatever the host's environment names", async () => {
    const seen: ClaudeRenewalInvocation[] = [];
    const renewal = renewer(async (invocation) => {
      seen.push(invocation);
    });

    await expect(renewal.renew(nativeDefault, async () => true)).resolves.toBe(true);
    await expect(renewal.renew(undefined, async () => true)).resolves.toBe(true);
    expect(seen.map((invocation) => invocation.env)).toEqual([
      { ...PASSED, TERM: 'dumb' },
      { ...PASSED, TERM: 'dumb' },
    ]);
  });

  it('answers by what the credential then reads, not by how the start ended', async () => {
    const run = vi.fn(async () => undefined);
    const renewal = renewer(run);

    await expect(renewal.renew(managed, async () => false)).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers false, and never rejects, when the start cannot be run', async () => {
    const confirm = vi.fn(async () => true);
    const renewal = renewer(async () => {
      throw new Error('spawn ENOENT');
    });

    await expect(renewal.renew(managed, confirm)).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('runs one renewal at a time for one root', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(async (): Promise<void> => {
      await new Promise<void>((done) => {
        finish = done;
      });
    });
    const confirm = vi.fn(async () => true);
    const renewal = renewer(run);

    const first = renewal.renew(managed, confirm);
    const second = renewal.renew(managed, confirm);
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);

    // Once it has ended, a later call is a start of its own.
    const third = renewal.renew(managed, confirm);
    finish();
    await expect(third).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('renews two roots side by side', async () => {
    const roots: Array<string | undefined> = [];
    const renewal = renewer(async (invocation) => {
      roots.push(invocation.env.CLAUDE_CONFIG_DIR);
    });

    const both = Promise.all([renewal.renew(managed, async () => true), renewal.renew(other, async () => true)]);
    await expect(both).resolves.toEqual([true, true]);
    expect(roots).toEqual([managed.dataRoot, other.dataRoot]);
  });

  it('does not try a renewal that did not work again inside its wait', async () => {
    let clock = START.valueOf();
    let works = false;
    const run = vi.fn(async () => undefined);
    const renewal = renewer(run, () => new Date(clock));
    const confirm = async (): Promise<boolean> => works;

    await expect(renewal.renew(managed, confirm)).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    // Twenty-nine minutes on: nothing is started, for this root alone.
    clock += 29 * 60_000;
    works = true;
    await expect(renewal.renew(managed, confirm)).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(renewal.renew(other, confirm)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);

    // Thirty minutes on: it is tried again, and one that works leaves no wait behind.
    clock += 60_000;
    await expect(renewal.renew(managed, confirm)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    await expect(renewal.renew(managed, confirm)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
