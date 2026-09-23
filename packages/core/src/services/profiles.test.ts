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
  ProfileSupportSchema,
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
