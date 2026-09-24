import { describe, expect, it } from 'vitest';
import {
  AgentProfileIdSchema,
  AgentProfileSchema,
  NATIVE_PROFILE_SET_ID,
  ProfileFailureSchema,
  ProfileGlyphSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  ProfileSetIdSchema,
  ProfileSetSchema,
  ProfileSignInRouteSchema,
  ProfileSignInSchema,
  ProfileSupportSchema,
  SignInServiceIdSchema,
  SignInServiceSchema,
} from './profiles.js';

describe('account profile contracts', () => {
  it('accepts a managed profile and the synthetic native default beside it', () => {
    expect(
      AgentProfileSchema.parse({
        id: '9a3bf3d4-0e3b-4d0e-b9b1-9a1d7f2b6c40',
        provider: 'example',
        label: 'Work',
        kind: 'managed',
        dataRoot: '/home/user/.puppeteer/profiles/example/9a3bf3d4-0e3b-4d0e-b9b1-9a1d7f2b6c40',
        createdAt: '2026-09-06T12:00:00.000Z',
      }).kind,
    ).toBe('managed');

    expect(AgentProfileIdSchema.safeParse('example:native-default').success).toBe(true);
    expect(
      AgentProfileSchema.parse({
        id: 'example:native-default',
        provider: 'example',
        label: 'Default',
        kind: 'native-default',
        dataRoot: '/home/user/.example',
        createdAt: '1970-01-01T00:00:00.000Z',
      }).kind,
    ).toBe('native-default');
  });

  it('rejects empty labels, unknown kinds, and unknown profile fields', () => {
    const base = {
      id: 'profile-1',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/home/user/.puppeteer/profiles/example/profile-1',
      createdAt: '2026-09-06T12:00:00.000Z',
    };
    expect(AgentProfileSchema.safeParse({ ...base, label: '   ' }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...base, kind: 'shared' }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...base, token: 'sk-secret' }).success).toBe(false);
  });

  it('carries native identity without a credential and records when it was read', () => {
    const identity = ProfileIdentitySchema.parse({
      loggedIn: true,
      method: 'subscription',
      email: 'user@example.com',
      organization: 'Example Org',
      plan: 'max',
      verifiedAt: '2026-09-06T12:00:00.000Z',
      source: { kind: 'native-status', stability: 'documented' },
    });
    expect(identity.loggedIn).toBe(true);
    // A token has no field to live in: the shape is strict.
    expect(ProfileIdentitySchema.safeParse({ ...identity, accessToken: 'sk-secret' }).success).toBe(false);
    expect(ProfileIdentitySchema.safeParse({ loggedIn: false }).success).toBe(false);

    expect(
      AgentProfileSchema.safeParse({
        id: 'profile-1',
        provider: 'example',
        label: 'Work',
        kind: 'managed',
        dataRoot: '/home/user/.puppeteer/profiles/example/profile-1',
        createdAt: '2026-09-06T12:00:00.000Z',
        identity,
      }).success,
    ).toBe(true);
  });

  it('validates provider support declarations and typed failures', () => {
    expect(
      ProfileSupportSchema.parse({
        supported: true,
        identity: 'native-protocol',
        sharedSurfaces: ['~/.agents/skills'],
        nativeDefaultRoot: '/home/user/.example',
      }).identity,
    ).toBe('native-protocol');
    expect(
      ProfileProviderSchema.safeParse({
        id: 'example',
        label: 'Example',
        support: { supported: false, identity: 'none', sharedSurfaces: [] },
      }).success,
    ).toBe(true);
    expect(ProfileSupportSchema.safeParse({ supported: true, identity: 'guessed', sharedSurfaces: [] }).success).toBe(
      false,
    );

    for (const status of ['unsupported', 'unavailable', 'not-found', 'invalid'] as const) {
      expect(
        ProfileFailureSchema.safeParse({ status, provider: 'example', message: 'nope', retryable: false }).success,
      ).toBe(true);
    }
    expect(ProfileFailureSchema.safeParse({ status: 'broken', message: 'nope', retryable: false }).success).toBe(false);
  });

  it('names a profile set by a directory-safe id and keeps its glyph an open token', () => {
    const set = ProfileSetSchema.parse({
      id: 'client-demo',
      kind: 'managed',
      label: 'Client demo',
      glyph: 'flask',
      directory: '/home/user/.puppeteer/profiles/client-demo',
      createdAt: '2026-09-23T09:00:00.000Z',
    });
    expect(set.id).toBe('client-demo');
    expect(ProfileSetIdSchema.safeParse(NATIVE_PROFILE_SET_ID).success).toBe(true);
    // A set id is a directory name: no separators, no dots, no case, no edges.
    for (const id of ['../work', 'work/claude', '.work', 'Work', '-work', 'work-', '', 'a'.repeat(49)]) {
      expect(ProfileSetIdSchema.safeParse(id).success, id).toBe(false);
    }
    // A glyph a newer build adds still parses here.
    expect(ProfileGlyphSchema.safeParse('telescope').success).toBe(true);
    expect(ProfileGlyphSchema.safeParse('<svg>').success).toBe(false);
    expect(ProfileSetSchema.safeParse({ ...set, members: [] }).success).toBe(false);
    expect(ProfileSetSchema.safeParse({ ...set, label: ' ' }).success).toBe(false);
  });

  it('records the set an account belongs to and when it was signed out', () => {
    const profile = AgentProfileSchema.parse({
      id: '9a3bf3d4-0e3b-4d0e-b9b1-9a1d7f2b6c40',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/home/user/.puppeteer/profiles/work/example-9a3bf3d4',
      createdAt: '2026-09-23T09:00:00.000Z',
      set: 'work',
      retiredAt: '2026-09-23T10:00:00.000Z',
    });
    expect(profile.set).toBe('work');
    expect(AgentProfileSchema.safeParse({ ...profile, set: 'Work' }).success).toBe(false);
  });
});

describe('sign-in contracts', () => {
  const inUse = {
    service: { id: 'example', label: 'Example' },
    method: 'oauth',
    subscription: true,
    inUse: true,
    account: 'person',
    email: 'person@example.com',
    plan: 'Pro',
  };
  const other = { service: { id: 'other-cloud', label: 'Other Cloud' }, method: 'api-key' };
  const read = {
    verifiedAt: '2026-09-23T12:00:00.000Z',
    source: { kind: 'native-protocol', stability: 'experimental' },
  } as const;

  it('lists every sign-in a root holds and repeats the in-use one at the top level', () => {
    const identity = ProfileIdentitySchema.parse({
      loggedIn: true,
      method: 'oauth',
      account: 'person',
      email: 'person@example.com',
      plan: 'Pro',
      signIns: [inUse, other],
      ...read,
    });
    expect(identity.signIns?.map((signIn) => signIn.service.id)).toEqual(['example', 'other-cloud']);
    expect(identity.account).toBe('person');
    // A vendor agent's single sign-in names its account without a list.
    expect(ProfileIdentitySchema.safeParse({ loggedIn: true, account: 'person', ...read }).success).toBe(true);
  });

  it('keeps loggedIn and the list in agreement, with at most one sign-in in use', () => {
    // A harness with nothing signed in says so with an empty list.
    expect(ProfileIdentitySchema.safeParse({ loggedIn: false, signIns: [], ...read }).success).toBe(true);
    expect(ProfileIdentitySchema.safeParse({ loggedIn: true, signIns: [], ...read }).success).toBe(false);
    expect(ProfileIdentitySchema.safeParse({ loggedIn: false, signIns: [other], ...read }).success).toBe(false);
    // Sign-ins with none in use are still signed in.
    expect(ProfileIdentitySchema.safeParse({ loggedIn: true, signIns: [other], ...read }).success).toBe(true);
    const twoInUse = { loggedIn: true, signIns: [inUse, { ...other, inUse: true }], ...read };
    expect(ProfileIdentitySchema.safeParse(twoInUse).success).toBe(false);
    expect(ProfileIdentitySchema.safeParse({ ...twoInUse, signIns: [inUse, { ...other, inUse: false }] }).success).toBe(
      true,
    );
    // The rules hold wherever an identity travels, a stored profile included.
    expect(
      AgentProfileSchema.safeParse({
        id: 'profile-1',
        provider: 'example',
        label: 'Work',
        kind: 'managed',
        dataRoot: '/home/user/.puppeteer/profiles/work/example-profile1',
        createdAt: '2026-09-23T09:00:00.000Z',
        identity: twoInUse,
      }).success,
    ).toBe(false);
  });

  it('gives a token no field to live in, on a sign-in or on its service', () => {
    expect(ProfileSignInSchema.safeParse(other).success).toBe(true);
    for (const field of ['accessToken', 'refreshToken', 'token', 'key', 'apiKey', 'secret']) {
      expect(ProfileSignInSchema.safeParse({ ...other, [field]: 'sk-secret' }).success, field).toBe(false);
    }
    expect(ProfileSignInSchema.safeParse({ ...other, service: { ...other.service, key: 'sk-secret' } }).success).toBe(
      false,
    );
    expect(
      ProfileIdentitySchema.safeParse({ loggedIn: true, signIns: [{ ...other, token: 'sk-secret' }], ...read }).success,
    ).toBe(false);
    // A sign-in says how it signs in, to a service a person can name.
    expect(ProfileSignInSchema.safeParse({ service: other.service }).success).toBe(false);
    expect(ProfileSignInSchema.safeParse({ ...other, method: ' ' }).success).toBe(false);
    expect(SignInServiceSchema.safeParse({ id: 'example', label: ' ' }).success).toBe(false);
    expect(SignInServiceSchema.safeParse({ id: 'example', label: 'x'.repeat(65) }).success).toBe(false);
  });

  it('shares service ids across adapters under one grammar', () => {
    const canonical = [
      'anthropic',
      'openai',
      'xai',
      'kimi',
      'google',
      'github',
      'nous',
      'opencode',
      'openrouter',
      'meta',
    ];
    for (const id of canonical) expect(SignInServiceIdSchema.safeParse(id).success, id).toBe(true);
    // An unlisted native id passes through where it already fits.
    for (const id of ['github-copilot', 'amazon.bedrock', 'custom_llm', 'x', 'a'.repeat(64)]) {
      expect(SignInServiceIdSchema.safeParse(id).success, id).toBe(true);
    }
    for (const id of ['', 'OpenAI', 'open ai', 'open/ai', '-openai', 'openai-', '.openai', '_openai', 'a'.repeat(65)]) {
      expect(SignInServiceIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('declares sign-in routes as menu items the runtime can check, never as commands', () => {
    const support = { supported: true, identity: 'native-protocol', sharedSurfaces: [] } as const;
    const routes = [
      { id: 'portal', label: 'Example Portal', service: { id: 'example', label: 'Example' } },
      { id: 'another-provider', label: 'Another provider…' },
    ];
    expect(
      ProfileProviderSchema.parse({
        id: 'example-harness',
        label: 'Example Harness',
        support: { ...support, service: { id: 'example', label: 'Example' }, signInRoutes: routes },
      }).support.signInRoutes,
    ).toEqual(routes);
    // Absent is one login; an empty list is not a way to say it, and seventeen is not a menu.
    expect(ProfileSupportSchema.safeParse({ ...support, signInRoutes: [] }).success).toBe(false);
    const seventeen = Array.from({ length: 17 }, (_, index) => ({ id: `route-${index}`, label: `Route ${index}` }));
    expect(ProfileSupportSchema.safeParse({ ...support, signInRoutes: seventeen }).success).toBe(false);
    // One id names one route.
    const twice = [routes[0], { ...routes[1], id: 'portal' }];
    expect(ProfileSupportSchema.safeParse({ ...support, signInRoutes: twice }).success).toBe(false);
    // The adapter builds the command from the id; nothing else rides along.
    expect(ProfileSignInRouteSchema.safeParse({ ...routes[1], args: ['auth', 'login'] }).success).toBe(false);
    for (const id of ['', 'Portal', '-portal', 'por tal', 'por_tal', 'a'.repeat(33)]) {
      expect(ProfileSignInRouteSchema.safeParse({ ...routes[1], id }).success, id).toBe(false);
    }
    expect(ProfileSignInRouteSchema.safeParse({ ...routes[1], label: ' ' }).success).toBe(false);
    expect(
      ProfileSignInRouteSchema.safeParse({ ...routes[0], service: { id: 'Example', label: 'Example' } }).success,
    ).toBe(false);
  });
});
