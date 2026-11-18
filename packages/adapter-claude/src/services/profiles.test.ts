import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
} from '@vibefield/puppeteer-core';
import {
  CLAUDE_PROFILE_ROOT_VARIABLE,
  claudeProfileIdentityFrom,
  createClaudeProfileService,
  type ClaudeProfileOptions,
} from './profiles.js';

const HOME = resolve('/Users/test');
const NOW = new Date('2026-09-06T12:00:00.000Z');

const managed: AgentProfile = AgentProfileSchema.parse({
  id: 'claude:9f2b',
  provider: 'claude',
  label: 'Work',
  kind: 'managed',
  dataRoot: resolve('/Users/test/.puppeteer/profiles/claude/9f2b'),
  createdAt: '2026-09-06T00:00:00.000Z',
});

const nativeDefault: AgentProfile = AgentProfileSchema.parse({
  id: 'claude:native-default',
  provider: 'claude',
  label: 'Default',
  kind: 'native-default',
  dataRoot: resolve('/Users/test/.claude'),
  createdAt: '2026-09-06T00:00:00.000Z',
});

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** `respond` returns the status document, or throws to stand in for a failed spawn. */
function service(
  respond: string | (() => string),
  calls: Call[] = [],
  root: Pick<ClaudeProfileOptions, 'writeConfig' | 'configExists'> = {},
): ReturnType<typeof createClaudeProfileService> {
  return createClaudeProfileService({
    ...root,
    executable: resolve('/Users/test/.local/bin/claude'),
    home: HOME,
    env: { PATH: '/usr/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: resolve('/Users/test/.claude') },
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
      nativeDefaultRoot: resolve('/Users/test/.claude'),
    });
    expect(provider.support.sharedSurfaces).toContain('project .claude/ settings and .mcp.json');
  });

  it('binds a managed profile to its root and leaves the native default alone', () => {
    const profiles = service(LOGGED_IN);
    expect(profiles.bindingEnvironment(managed)).toEqual({
      [CLAUDE_PROFILE_ROOT_VARIABLE]: resolve('/Users/test/.puppeteer/profiles/claude/9f2b'),
    });
    expect(profiles.bindingEnvironment(nativeDefault)).toEqual({});
  });

  it('names the bound root as the history layout root for an indexer', () => {
    const profiles = service(LOGGED_IN);
    expect(profiles.observationRoot(managed)).toBe(resolve('/Users/test/.puppeteer/profiles/claude/9f2b'));
    expect(profiles.observationRoot(nativeDefault)).toBe(resolve('/Users/test/.claude'));
  });

  it('describes the native interactive login as a terminal spec', () => {
    const spec = service(LOGGED_IN).loginInvocation(managed, { cwd: resolve('/work/repo') });
    expect(spec).toEqual({
      command: resolve('/Users/test/.local/bin/claude'),
      args: ['auth', 'login'],
      cwd: resolve('/work/repo'),
      env: { [CLAUDE_PROFILE_ROOT_VARIABLE]: resolve('/Users/test/.puppeteer/profiles/claude/9f2b') },
    });
  });

  it("marks a new root's first run done, with one credential-free key", async () => {
    const checked: string[] = [];
    const written: Array<{ path: string; contents: string }> = [];
    const profiles = service(LOGGED_IN, [], {
      configExists: async (path) => {
        checked.push(path);
        return false;
      },
      writeConfig: async (path, contents) => {
        written.push({ path, contents });
      },
    });
    await profiles.initializeRoot?.(managed);
    const expected = resolve('/Users/test/.puppeteer/profiles/claude/9f2b/.claude.json');
    expect(checked).toEqual([expected]);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(expected);
    expect(JSON.parse(written[0]?.contents ?? '')).toEqual({ hasCompletedOnboarding: true });
  });

  it("never overwrites a root's app state that is already there", async () => {
    const written: string[] = [];
    const profiles = service(LOGGED_IN, [], {
      configExists: async () => true,
      writeConfig: async (path) => {
        written.push(path);
      },
    });
    await profiles.initializeRoot?.(managed);
    expect(written).toEqual([]);
  });

  it("leaves the native default's own root alone", async () => {
    const checked: string[] = [];
    const written: string[] = [];
    const profiles = service(LOGGED_IN, [], {
      configExists: async (path) => {
        checked.push(path);
        return false;
      },
      writeConfig: async (path) => {
        written.push(path);
      },
    });
    await profiles.initializeRoot?.(nativeDefault);
    expect(checked).toEqual([]);
    expect(written).toEqual([]);
  });

  it('writes nothing that could hold a sign-in', async () => {
    let contents = '';
    const profiles = service(LOGGED_IN, [], {
      configExists: async () => false,
      writeConfig: async (_path, written) => {
        contents = written;
      },
    });
    await profiles.initializeRoot?.(managed);
    expect(Object.keys(JSON.parse(contents) as Record<string, unknown>)).toHaveLength(1);
    for (const word of ['token', 'oauth', 'email', 'account', 'key"']) {
      expect(contents.toLowerCase()).not.toContain(word);
    }
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
    expect(calls[0]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBe(resolve('/Users/test/.puppeteer/profiles/claude/9f2b'));
  });

  it('reads the tier from the status document of a Claude Code that reports one', async () => {
    const reporting = (planTier: string): string => JSON.stringify({ ...JSON.parse(LOGGED_IN), planTier });
    // The one document read so far: the family at the 20x tier, shown as the Ultra plan with no tier beside it.
    const ultra = await service(reporting('max_20x')).verify(managed);
    expect(ultra).toStrictEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'dev@example.com',
      organization: 'Example Org',
      plan: 'ultra',
      planTier: {},
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-status', stability: 'documented' },
    });
    // Any other tier of the family keeps the family's name and wears its tier.
    const tiered = await service(reporting('max_5x')).verify(managed);
    expect(tiered).toMatchObject({ plan: 'max', planTier: { label: '5x' } });
    // Both fit the contract a host reads them through.
    expect(() => ProfileIdentitySchema.parse(ultra)).not.toThrow();
    expect(() => ProfileIdentitySchema.parse(tiered)).not.toThrow();
  });

  it('never forwards the undocumented secure-storage override', async () => {
    const calls: Call[] = [];
    await service(LOGGED_IN, calls).verify(managed);
    expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it('reads the native default from its own root even when the host inherited a root variable', async () => {
    const calls: Call[] = [];
    const inherited = createClaudeProfileService({
      executable: resolve('/Users/test/.local/bin/claude'),
      home: HOME,
      env: { PATH: '/usr/bin', [CLAUDE_PROFILE_ROOT_VARIABLE]: resolve('/Users/test/elsewhere') },
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
    const calls: Array<Call & { strict?: boolean }> = [];
    const claude = createClaudeProfileService({
      executable: resolve('/Users/test/.local/bin/claude'),
      home: HOME,
      env: { PATH: '/usr/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: resolve('/Users/test/.claude') },
      now: () => NOW,
      exec: async (file, args, options) => {
        calls.push({ file, args, env: options.env, ...(options.strict ? { strict: true } : {}) });
        return { stdout: args[1] === 'status' ? JSON.stringify({ loggedIn: false }) : '' };
      },
    });
    expect(claude.provider.support.credential).toBe('external');
    await expect(claude.signOut?.(managed)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      file: resolve('/Users/test/.local/bin/claude'),
      args: ['auth', 'logout'],
      strict: true,
    });
    expect(calls[0]?.env[CLAUDE_PROFILE_ROOT_VARIABLE]).toBe(managed.dataRoot);
    expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    // and it is only a sign-out when the root reads signed out afterwards
    expect(calls[1]).toMatchObject({ args: ['auth', 'status', '--json'] });

    const failing = service(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(failing.signOut?.(managed)).resolves.toMatchObject({ status: 'unavailable', retryable: true });
  });

  it('never reports a sign-out the vendor did not complete or the root does not show', async () => {
    // a logout that failed but printed something is still a failure
    const printedAndFailed = createClaudeProfileService({
      executable: resolve('/Users/test/.local/bin/claude'),
      home: HOME,
      env: { PATH: '/usr/bin' },
      now: () => NOW,
      exec: async (_file, args, options) => {
        if (args[1] === 'logout' && options.strict)
          throw Object.assign(new Error('exit 1'), { stdout: 'Keychain locked' });
        return { stdout: LOGGED_IN };
      },
    });
    await expect(printedAndFailed.signOut?.(managed)).resolves.toMatchObject({ status: 'unavailable' });
    // a logout that exited cleanly while the root still reads signed in is not one either
    const stillIn = service((() => LOGGED_IN) as () => string);
    await expect(stillIn.signOut?.(managed)).resolves.toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('still reads signed in'),
    });
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

/** The plan and tier a signed-in status document decodes to; a key is present only when the identity carries it. */
function planOf(fields: Record<string, unknown>) {
  const identity = claudeProfileIdentityFrom({ loggedIn: true, ...fields }, NOW.toISOString());
  if ('status' in identity) throw new Error(identity.message);
  return {
    ...('plan' in identity ? { plan: identity.plan } : {}),
    ...('planTier' in identity ? { planTier: identity.planTier } : {}),
  };
}

describe('Claude status decoding', () => {
  it('drops blank optional fields instead of emitting empty strings', () => {
    expect(claudeProfileIdentityFrom({ loggedIn: true, email: '   ', orgName: '' }, NOW.toISOString())).toEqual({
      loggedIn: true,
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-status', stability: 'documented' },
    });
  });

  it('reads the tier beside the family as the short label a view draws', () => {
    expect(planOf({ subscriptionType: 'max', planTier: 'max_5x' })).toStrictEqual({
      plan: 'max',
      planTier: { label: '5x' },
    });
    // The plan word does not carry the tier, and both tokens are trimmed first.
    expect(planOf({ subscriptionType: ' max ', planTier: ' max_5x ' })).toStrictEqual({
      plan: 'max',
      planTier: { label: '5x' },
    });
    // A tier nobody has read yet follows the same rule, with no table.
    expect(planOf({ subscriptionType: 'pro', planTier: 'pro_2x' })).toStrictEqual({
      plan: 'pro',
      planTier: { label: '2x' },
    });
  });

  it("says a plan has no tier when the tool's tier is the family itself", () => {
    // The rule's one case of `{}`; the Ultra row below is the naming table's.
    expect(planOf({ subscriptionType: 'max', planTier: 'max' })).toStrictEqual({ plan: 'max', planTier: {} });
    expect(planOf({ subscriptionType: 'pro', planTier: ' pro ' })).toStrictEqual({ plan: 'pro', planTier: {} });
  });

  it('leaves the tier unread when the tool tells none, or tells it in a shape it has not been seen in', () => {
    // Beside a tier it can read,
    expect(planOf({ subscriptionType: 'max', planTier: 'max_5x' }).planTier).toEqual({ label: '5x' });
    // no field, an empty or blank one, and anything but a string are all "not read", never "none".
    expect(planOf({ subscriptionType: 'max' })).toStrictEqual({ plan: 'max' });
    for (const planTier of ['', '   ', null, 20, ['max_20x'], { label: '20x' }]) {
      expect(planOf({ subscriptionType: 'max', planTier }), JSON.stringify(planTier)).toStrictEqual({ plan: 'max' });
    }
  });

  it('gives a one-word tier with no family in front as the tool wrote it', () => {
    expect(planOf({ subscriptionType: 'max', planTier: 'ultra' })).toStrictEqual({
      plan: 'max',
      planTier: { label: 'ultra' },
    });
    expect(planOf({ subscriptionType: 'pro', planTier: '200' })).toStrictEqual({
      plan: 'pro',
      planTier: { label: '200' },
    });
  });

  it('gives no label rather than a compound or a long one', () => {
    expect(planOf({ subscriptionType: 'max', planTier: 'max_5x' }).planTier).toEqual({ label: '5x' });
    // A raw token never reaches a badge: an underscore left, over eight characters, nothing left, or punctuation first.
    for (const planTier of ['team_premium', 'max_20x_promo', 'max_enterprise', 'max_', 'max_-', 'max_+']) {
      expect(planOf({ subscriptionType: 'max', planTier }), planTier).toStrictEqual({ plan: 'max' });
    }
  });

  it('compares the family exactly', () => {
    expect(planOf({ subscriptionType: 'max', planTier: 'max_5x' }).planTier).toEqual({ label: '5x' });
    // No family to take off, or a family the tool has not been seen to case so.
    expect(planOf({ planTier: 'max_5x' })).toStrictEqual({});
    // With no family, even a one-word tier is not read: a label never sits beside no name.
    for (const planTier of ['5x', 'max', 'ultra']) {
      expect(planOf({ planTier }), planTier).toStrictEqual({});
      expect(planOf({ subscriptionType: '  ', planTier }), planTier).toStrictEqual({});
    }
    expect(planOf({ subscriptionType: 'Max', planTier: 'max_5x' })).toStrictEqual({ plan: 'Max' });
    expect(planOf({ subscriptionType: 'Max', planTier: 'max_20x' })).toStrictEqual({ plan: 'Max' });
  });

  it('shows the family at the 20x tier as the Ultra plan, with no tier beside it', () => {
    expect(planOf({ subscriptionType: 'max', planTier: 'max_20x' })).toStrictEqual({ plan: 'ultra', planTier: {} });
    // Both tokens are trimmed before the row is matched.
    expect(planOf({ subscriptionType: ' max ', planTier: 'max_20x  ' })).toStrictEqual({
      plan: 'ultra',
      planTier: {},
    });
  });

  it('holds the Ultra row to both tokens exactly, and leaves every other tier to the rule', () => {
    // A tier of the family the row does not name keeps the family's name and wears its tier.
    expect(planOf({ subscriptionType: 'max', planTier: 'max_5x' })).toStrictEqual({
      plan: 'max',
      planTier: { label: '5x' },
    });
    expect(planOf({ subscriptionType: 'max', planTier: 'max_40x' })).toStrictEqual({
      plan: 'max',
      planTier: { label: '40x' },
    });
    expect(planOf({ subscriptionType: 'max', planTier: 'max' })).toStrictEqual({ plan: 'max', planTier: {} });
    // A case, a family or a token the row does not name exactly is not the row.
    expect(planOf({ subscriptionType: 'max', planTier: 'MAX_20X' })).toStrictEqual({ plan: 'max' });
    expect(planOf({ subscriptionType: 'max', planTier: 'max_20x_promo' })).toStrictEqual({ plan: 'max' });
    expect(planOf({ subscriptionType: 'pro', planTier: 'max_20x' })).toStrictEqual({ plan: 'pro' });
    expect(planOf({ planTier: 'max_20x' })).toStrictEqual({});
    expect(planOf({ subscriptionType: 'max' })).toStrictEqual({ plan: 'max' });
  });
});
