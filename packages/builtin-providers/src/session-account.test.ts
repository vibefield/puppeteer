import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, ProfileService } from '@vibefield/puppeteer-core';
import { sessionAccount } from './session-account.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'builtin-session-account-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A provider's profile service as the account rule reads it: each profile's root, and the provider's own. */
function profilesWith(nativeDefaultRoot: string): ProfileService {
  return {
    provider: {
      id: 'claude',
      label: 'Claude',
      support: { supported: true, identity: 'none', sharedSurfaces: [], nativeDefaultRoot },
    },
    bindingEnvironment: () => ({}),
    observationRoot: (profile) => (profile.kind === 'managed' ? profile.dataRoot : nativeDefaultRoot),
    loginInvocation: () => ({ command: 'claude', args: ['login'], cwd: '/' }),
    verify: async () => ({ status: 'unsupported', provider: 'claude', message: 'no identity', retryable: false }),
  };
}

const managed = (dataRoot: string): AgentProfile => ({
  id: 'p1',
  provider: 'claude',
  label: 'Work',
  kind: 'managed',
  dataRoot,
  createdAt: '2026-09-06T00:00:00.000Z',
});

describe('sessionAccount: the registered account a session’s pushed usage belongs to', () => {
  it('names the bound account whose root the session runs under, read through a link to it as well', async () => {
    const base = await scratch();
    const root = join(base, 'work');
    const link = join(base, 'link');
    await mkdir(root);
    await symlink(root, link, 'junction');
    const profiles = profilesWith(join(base, 'native'));

    expect(sessionAccount({ root, profile: managed(root), profiles, env: undefined })).toEqual({ profileId: 'p1' });
    expect(sessionAccount({ root: link, profile: managed(root), profiles, env: {} })).toEqual({ profileId: 'p1' });
    expect(sessionAccount({ root, profile: managed(link), profiles, env: {} })).toEqual({ profileId: 'p1' });
  });

  it('names the native default account for the provider’s own root', () => {
    const profiles = profilesWith('/home/person/.claude');
    expect(sessionAccount({ root: '/home/person/.claude', profile: undefined, profiles, env: {} })).toEqual({
      profileId: 'claude:native-default',
    });
    expect(sessionAccount({ root: '/home/person/.claude/', profile: undefined, profiles, env: {} })).toEqual({
      profileId: 'claude:native-default',
    });
  });

  it('names no account for a root no registered account names, nor for an imposter on any root', () => {
    const profiles = profilesWith('/home/person/.claude');
    expect(sessionAccount({ root: '/elsewhere', profile: undefined, profiles, env: {} })).toBeUndefined();
    // a profile is bound, and the launch names another root: the profile does not own it
    expect(sessionAccount({ root: '/elsewhere', profile: managed('/roots/p1'), profiles, env: {} })).toBeUndefined();
    const imposters: Record<string, string>[] = [
      { PUPPETEER_IMPOSTER_HOME: '/home/person/.claude' },
      { AI_PERSONA: 'claude' },
    ];
    for (const env of imposters) {
      expect(sessionAccount({ root: '/home/person/.claude', profile: undefined, profiles, env })).toBeUndefined();
    }
  });
});
