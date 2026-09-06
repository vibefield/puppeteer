import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { normalizeOpenCodeNativeInvocation } from '../launch/native-invocation.js';
import { createOpenCodeProfileService, openCodeDataHome, OPENCODE_PROFILE_ROOT_VARIABLE } from './profiles.js';

const service = createOpenCodeProfileService({ home: '/home/tester', executable: 'opencode' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'opencode:77c5b0ad',
    provider: 'opencode',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('OpenCode profiles', () => {
  it('advertises the native XDG data root and the surfaces that stay shared', () => {
    expect(service.provider.support).toMatchObject({
      supported: true,
      identity: 'none',
      nativeDefaultRoot: '/home/tester/.local/share/opencode',
    });
    expect(service.provider.support.sharedSurfaces.length).toBeGreaterThan(0);
  });

  it('binds a managed profile through XDG_DATA_HOME one level inside the root', () => {
    expect(openCodeDataHome(profile())).toBe('/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data');
    expect(service.bindingEnvironment(profile())).toEqual({
      [OPENCODE_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.local/share/opencode' })),
    ).toEqual({});
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'opencode',
      args: ['auth', 'login'],
      cwd: '/work/repo',
      env: { [OPENCODE_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data' },
    });
  });

  it('produces a binding the adapter turns into launch options', () => {
    // The composition root normalizes bindingEnvironment through the adapter's
    // own invocation normalizer, so the two must agree.
    const resolution = normalizeOpenCodeNativeInvocation({
      providerId: 'opencode',
      cwd: '/work/repo',
      argv: [],
      environment: service.bindingEnvironment(profile()),
      implementation: { kind: 'native' },
    });
    expect(resolution).toEqual({
      status: 'accepted',
      options: { env: { XDG_DATA_HOME: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data' } },
    });
  });

  it('reports verification as unsupported instead of scraping the terminal', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'opencode',
      retryable: false,
    });
  });
});
