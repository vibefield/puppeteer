import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { COPILOT_PROFILE_ROOT_VARIABLE, createCopilotProfileService } from './profiles.js';

const service = createCopilotProfileService({ home: '/home/tester', executable: 'copilot' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'copilot:4f21b0c9',
    provider: 'copilot',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/copilot/4f21b0c9',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Copilot profiles', () => {
  it('advertises the native root and the shared personal skills directory', () => {
    expect(service.provider).toEqual({
      id: 'copilot',
      label: 'GitHub Copilot',
      support: {
        supported: true,
        identity: 'none',
        sharedSurfaces: ['/home/tester/.agents/skills'],
        nativeDefaultRoot: '/home/tester/.copilot',
      },
    });
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [COPILOT_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/copilot/4f21b0c9',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.copilot' }))).toEqual(
      {},
    );
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'copilot',
      args: ['login'],
      cwd: '/work/repo',
      env: { [COPILOT_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/copilot/4f21b0c9' },
    });
  });

  it('reports verification as unsupported instead of scraping the terminal', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'copilot',
      retryable: false,
    });
  });
});
