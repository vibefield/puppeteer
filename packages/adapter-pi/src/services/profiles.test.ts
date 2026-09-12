import { join } from 'node:path';
import { AgentProfileSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { normalizePiNativeInvocation } from '../launch/native-invocation.js';
import { resolvePiAgentDir } from '../observation/session-store.js';
import { createPiProfileService, piAgentDir, PI_PROFILE_ROOT_VARIABLE } from './profiles.js';

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

  it('binds a managed profile one agent level inside the profile root', () => {
    expect(piAgentDir(profile())).toBe('/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent');
    expect(service.bindingEnvironment(profile())).toEqual({
      [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.pi/agent' }))).toEqual(
      {},
    );
  });

  it('names the profile root as the history layout root, the parent of the bound agent directory', () => {
    // Pi's transcripts are <root>/agent/sessions/<cwd>/<id>.jsonl, so an
    // indexer applies the layout to the profile root, and to ~/.pi natively.
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/pi/9a3d21ff');
    expect(service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.pi/agent' }))).toBe(
      '/home/tester/.pi',
    );
  });

  it('opens the agent itself bound to the profile because Pi has no login command', () => {
    const spec = service.loginInvocation(profile(), { cwd: '/work/repo' });
    expect(spec).toEqual({
      command: 'pi',
      args: [],
      cwd: '/work/repo',
      env: { [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent' },
    });
    // `pi auth print-api-key` and `print-bearer-token` emit credentials and are
    // never invoked by the host.
    expect(spec.args.join(' ')).not.toContain('auth');
  });

  it('produces a binding the adapter turns into the agent directory its observation reads', () => {
    // The composition root normalizes bindingEnvironment through the adapter's
    // own invocation normalizer, and the session store resolves the same
    // variable, so the bound agent directory must stay one level inside the
    // observation root.
    const binding = service.bindingEnvironment(profile());
    const resolution = normalizePiNativeInvocation({
      providerId: 'pi',
      cwd: '/work/repo',
      argv: [],
      environment: binding,
      implementation: { kind: 'native' },
    });
    expect(resolution).toEqual({
      status: 'accepted',
      options: { piAgentDir: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent' },
    });
    expect(resolvePiAgentDir(binding[PI_PROFILE_ROOT_VARIABLE])).toBe(
      join(service.observationRoot(profile()), 'agent'),
    );
  });

  it('reports verification as unsupported instead of printing credentials', async () => {
    await expect(service.verify(profile())).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'pi',
      retryable: false,
    });
  });
});
