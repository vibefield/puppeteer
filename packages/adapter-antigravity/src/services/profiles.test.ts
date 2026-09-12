import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_PROFILE_ROOT_VARIABLE, createAntigravityProfileService } from './profiles.js';

const service = createAntigravityProfileService({ home: '/home/tester', executable: 'agy' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'antigravity:0b12ce77',
    provider: 'antigravity',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Antigravity profiles', () => {
  it('declares profiles unsupported because the CLI has no login surface', () => {
    expect(service.provider.support).toEqual({
      supported: false,
      identity: 'none',
      sharedSurfaces: [],
      nativeDefaultRoot: '/home/tester/.gemini/antigravity-cli',
    });
  });

  it('still binds correctly through the adapter-owned home redirection', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.gemini/antigravity-cli' })),
    ).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/antigravity/0b12ce77');
    expect(
      service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.gemini/antigravity-cli' })),
    ).toBe('/home/tester/.gemini/antigravity-cli');
  });

  it('opens the agent itself because no login subcommand exists on 1.1.21', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'agy',
      args: [],
      cwd: '/work/repo',
      env: { [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77' },
    });
  });

  it('reports verification as unsupported', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'antigravity',
      retryable: false,
    });
  });
});
