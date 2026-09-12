import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { createKimiProfileService, KIMI_PROFILE_ROOT_VARIABLE } from './profiles.js';

const service = createKimiProfileService({ home: '/home/tester', executable: 'kimi' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'kimi:1d0f77aa',
    provider: 'kimi',
    label: 'Personal',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/kimi/1d0f77aa',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Kimi profiles', () => {
  it('advertises the native root without reading the real home directory', () => {
    expect(service.provider).toEqual({
      id: 'kimi',
      label: 'Kimi',
      support: {
        supported: true,
        identity: 'none',
        sharedSurfaces: [],
        nativeDefaultRoot: '/home/tester/.kimi-code',
      },
    });
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [KIMI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/kimi/1d0f77aa',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.kimi-code' })),
    ).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/kimi/1d0f77aa');
    expect(service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.kimi-code' }))).toBe(
      '/home/tester/.kimi-code',
    );
  });

  it('runs the native device-code login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'kimi',
      args: ['login'],
      cwd: '/work/repo',
      env: { [KIMI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/kimi/1d0f77aa' },
    });
  });

  it('reports verification as unsupported instead of scraping the terminal', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'kimi',
      retryable: false,
    });
  });
});
