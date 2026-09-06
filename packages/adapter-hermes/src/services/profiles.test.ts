import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { createHermesProfileService, HERMES_PROFILE_ROOT_VARIABLE } from './profiles.js';

const service = createHermesProfileService({ home: '/home/tester', executable: 'hermes' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'hermes:5b7c31de',
    provider: 'hermes',
    label: 'Research',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/hermes/5b7c31de',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Hermes profiles', () => {
  it('advertises the native root variable and default root', () => {
    expect(HERMES_PROFILE_ROOT_VARIABLE).toBe('HERMES_HOME');
    expect(service.provider.support).toMatchObject({
      supported: true,
      identity: 'none',
      nativeDefaultRoot: '/home/tester/.hermes',
    });
    expect(service.provider.support.sharedSurfaces).toHaveLength(1);
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      HERMES_HOME: '/home/tester/.puppeteer/profiles/hermes/5b7c31de',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.hermes' }))).toEqual(
      {},
    );
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'hermes',
      args: ['login'],
      cwd: '/work/repo',
      env: { HERMES_HOME: '/home/tester/.puppeteer/profiles/hermes/5b7c31de' },
    });
  });

  it('reports verification as unsupported instead of scraping the terminal', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'hermes',
      retryable: false,
    });
  });
});
