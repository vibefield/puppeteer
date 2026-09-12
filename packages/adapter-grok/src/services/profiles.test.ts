import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { createGrokProfileService, GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';

const service = createGrokProfileService({ home: '/home/tester', executable: 'grok' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'grok:8c8c0a1e',
    provider: 'grok',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Grok profiles', () => {
  it('advertises the native root without reading the real home directory', () => {
    expect(service.provider).toEqual({
      id: 'grok',
      label: 'Grok',
      support: { supported: true, identity: 'none', sharedSurfaces: [], nativeDefaultRoot: '/home/tester/.grok' },
    });
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [GROK_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.grok' }))).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/grok/8c8c0a1e');
    expect(service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.grok' }))).toBe(
      '/home/tester/.grok',
    );
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'grok',
      args: ['login'],
      cwd: '/work/repo',
      env: { [GROK_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e' },
    });
  });

  it('reports verification as unsupported instead of scraping the terminal', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'grok',
      retryable: false,
    });
  });
});
