import { describe, expect, it } from 'vitest';
import { AgentProfileSchema, ProfileProviderSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { CLAUDE_PROFILE_ROOT_VARIABLE, claudeProfileIdentityFrom, createClaudeProfileService } from './profiles.js';

const HOME = '/Users/test';
const NOW = new Date('2026-09-06T12:00:00.000Z');

const managed: AgentProfile = AgentProfileSchema.parse({
  id: 'claude:9f2b',
  provider: 'claude',
  label: 'Work',
  kind: 'managed',
  dataRoot: '/Users/test/.puppeteer/profiles/claude/9f2b',
  createdAt: '2026-09-06T00:00:00.000Z',
});

const nativeDefault: AgentProfile = AgentProfileSchema.parse({
  id: 'claude:native-default',
  provider: 'claude',
  label: 'Default',
  kind: 'native-default',
  dataRoot: '/Users/test/.claude',
  createdAt: '2026-09-06T00:00:00.000Z',
});

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** `respond` returns the status document, or throws to stand in for a failed spawn. */
function service(respond: string | (() => string), calls: Call[] = []): ReturnType<typeof createClaudeProfileService> {
  return createClaudeProfileService({
    executable: '/Users/test/.local/bin/claude',
    home: HOME,
    env: { PATH: '/usr/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/test/.claude' },
    now: () => NOW,
    exec: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return { stdout: typeof respond === 'string' ? respond : respond() };
    },
  });
}

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'dev@example.com',
  orgId: '89070c0f-90f4-486f-b097-4cf87dab7386',
  orgName: 'Example Org',
  subscriptionType: 'max',
});

describe('Claude profile provider', () => {
  it('declares a valid provider with the native default root', () => {
    const { provider } = service(LOGGED_IN);
    expect(() => ProfileProviderSchema.parse(provider)).not.toThrow();
    expect(provider.support).toMatchObject({
      supported: true,
      identity: 'native-status',
      nativeDefaultRoot: '/Users/test/.claude',
    });
    expect(provider.support.sharedSurfaces).toContain('project .claude/ settings and .mcp.json');
  });

  it('binds a managed profile to its root and leaves the native default alone', () => {
    const profiles = service(LOGGED_IN);
    expect(profiles.bindingEnvironment(managed)).toEqual({
      [CLAUDE_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/claude/9f2b',
    });
    expect(profiles.bindingEnvironment(nativeDefault)).toEqual({});
  });

  it('names the bound root as the history layout root for an indexer', () => {
    const profiles = service(LOGGED_IN);
    expect(profiles.observationRoot(managed)).toBe('/Users/test/.puppeteer/profiles/claude/9f2b');
    expect(profiles.observationRoot(nativeDefault)).toBe('/Users/test/.claude');
  });

  it('describes the native interactive login as a terminal spec', () => {
    const spec = service(LOGGED_IN).loginInvocation(managed, { cwd: '/work/repo' });
    expect(spec).toEqual({
      command: '/Users/test/.local/bin/claude',
      args: ['auth', 'login'],
      cwd: '/work/repo',
      env: { [CLAUDE_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/claude/9f2b' },
    });
  });
});

describe('Claude profile verification', () => {
  it('reads identity from the native status document under the profile binding', async () => {
    const calls: Call[] = [];
    const identity = await service(LOGGED_IN, calls).verify(managed);
    expect(identity).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'dev@example.com',
      organization: 'Example Org',
      plan: 'max',
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-status', stability: 'documented' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['auth', 'status', '--json']);
    expect(calls[0]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBe('/Users/test/.puppeteer/profiles/claude/9f2b');
  });

  it('never forwards the undocumented secure-storage override', async () => {
    const calls: Call[] = [];
    await service(LOGGED_IN, calls).verify(managed);
    expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it('reads the native default from its own root even when the host inherited a root variable', async () => {
    const calls: Call[] = [];
    const inherited = createClaudeProfileService({
      executable: '/Users/test/.local/bin/claude',
      home: HOME,
      env: { PATH: '/usr/bin', [CLAUDE_PROFILE_ROOT_VARIABLE]: '/Users/test/elsewhere' },
      now: () => NOW,
      exec: async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return { stdout: LOGGED_IN };
      },
    });
    await inherited.verify(nativeDefault);
    await inherited.verify(managed);
    expect(calls[0]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBeUndefined();
    expect(calls[1]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBe(managed.dataRoot);
  });

  it('signs out with the vendor command under the binding, so the root-keyed Keychain item goes too', async () => {
    const calls: Call[] = [];
    const claude = service('', calls);
    await expect(claude.signOut?.(managed)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ file: '/Users/test/.local/bin/claude', args: ['auth', 'logout'] });
    expect(calls[0]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBe(managed.dataRoot);
    expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();

    const failing = service(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(failing.signOut?.(managed)).resolves.toMatchObject({ status: 'unavailable', retryable: true });
  });

  it('reports a logged-out root without inventing identity fields', async () => {
    const identity = await service(JSON.stringify({ loggedIn: false })).verify(managed);
    expect(identity).toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-status', stability: 'documented' },
    });
  });

  it('fails rather than guessing when the document is unrecognized', async () => {
    expect(await service('{"unexpected":true}').verify(managed)).toMatchObject({
      status: 'unavailable',
      provider: 'claude',
      retryable: true,
    });
    expect(await service('not json at all').verify(managed)).toMatchObject({ status: 'unavailable' });
  });

  it('fails when the status command cannot run', async () => {
    const failing = service(() => {
      throw new Error('spawn ENOENT');
    });
    expect(await failing.verify(managed)).toMatchObject({ status: 'unavailable', retryable: true });
  });
});

describe('Claude status decoding', () => {
  it('drops blank optional fields instead of emitting empty strings', () => {
    expect(claudeProfileIdentityFrom({ loggedIn: true, email: '   ', orgName: '' }, NOW.toISOString())).toEqual({
      loggedIn: true,
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-status', stability: 'documented' },
    });
  });
});
