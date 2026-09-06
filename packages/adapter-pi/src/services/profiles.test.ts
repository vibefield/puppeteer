import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { createPiProfileService, PI_PROFILE_ROOT_VARIABLE } from './profiles.js';

const service = createPiProfileService({ home: '/home/tester', executable: 'pi' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'pi:9a3d21ff',
    provider: 'pi',
    label: 'Personal',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/pi/9a3d21ff',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Pi profiles', () => {
  it('advertises the native agent root without reading the real home directory', () => {
    expect(service.provider.support.nativeDefaultRoot).toBe('/home/tester/.pi/agent');
    expect(service.provider.support.supported).toBe(true);
    expect(service.provider.support.identity).toBe('none');
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.pi/agent' }))).toEqual(
      {},
    );
  });

  it('opens the agent itself in the profile root because Pi has no login command', () => {
    const spec = service.loginInvocation(profile(), { cwd: '/work/repo' });
    expect(spec).toEqual({
      command: 'pi',
      args: [],
      cwd: '/work/repo',
      env: { [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff' },
    });
    // `pi auth print-api-key` and `print-bearer-token` emit credentials and are
    // never invoked by the host.
    expect(spec.args.join(' ')).not.toContain('auth');
  });

  it('reports verification as unsupported instead of printing credentials', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'pi',
      retryable: false,
    });
  });
});
