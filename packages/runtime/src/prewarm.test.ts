import { describe, expect, it, vi } from 'vitest';
import type { AgentHost, AgentProfile, ProfileService } from '@vibecook/puppeteer-core';
import { parseProfileRegistrySnapshot } from './profiles/registry.js';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider } from './types.js';

const host = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as AgentHost;

function runtimeWith(prewarm?: AgentProvider['prewarm']) {
  const createSession = vi.fn();
  const runtime = createAgentRuntime({
    host,
    defaultCwd: '/unused',
    providers: [{ descriptor: { id: 'example', label: 'Example' }, createSession, ...(prewarm ? { prewarm } : {}) }],
  });
  return { runtime, createSession };
}

describe('runtime cache prewarming', () => {
  it('resolves registered accounts separately and rejects a foreign or missing profile', async () => {
    const profile: AgentProfile = {
      id: 'work',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/profiles/work',
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    const prewarm = vi.fn(async () => undefined);
    const profiles: ProfileService = {
      provider: { id: 'example', label: 'Example', support: { supported: true, identity: 'none', sharedSurfaces: [] } },
      bindingEnvironment: () => ({}),
      observationRoot: (target) => target.dataRoot,
      loginInvocation: () => ({ command: 'example', args: ['login'], cwd: '/unused' }),
      verify: vi.fn(),
    };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: '/unused',
      providers: [{ descriptor: { id: 'example', label: 'Example' }, profiles, prewarm, createSession: vi.fn() }],
      profiles: {
        store: {
          load: async () =>
            parseProfileRegistrySnapshot({
              version: 1,
              profiles: [profile, { ...profile, id: 'foreign', provider: 'other' }],
            }),
          save: vi.fn(),
        },
      },
    });
    try {
      await runtime.prewarm('example', 'work');
      await runtime.prewarm('example');
      // Read through the registry, the account carries the set it was adopted into.
      expect(prewarm).toHaveBeenCalledWith({ profile: { ...profile, set: 'work' }, signal: expect.any(AbortSignal) });
      expect(prewarm).toHaveBeenCalledTimes(2);
      await expect(runtime.prewarm('example', 'foreign')).rejects.toThrow('belongs to other');
      await expect(runtime.prewarm('example', 'missing')).rejects.toThrow('unknown account profile');
      expect(prewarm).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('coalesces in-flight requests and throttles successful warming without allocating a session', async () => {
    let finish!: () => void;
    const prewarm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { runtime, createSession } = runtimeWith(prewarm);
    const first = runtime.prewarm('example');
    const second = runtime.prewarm('example');
    await Promise.resolve();
    expect(prewarm).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    await runtime.prewarm('example');
    expect(prewarm).toHaveBeenCalledOnce();
    expect(createSession).not.toHaveBeenCalled();
    expect(host.spawnTerminal).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('allows a retry after failure and treats unsupported providers as a no-op', async () => {
    const prewarm = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { runtime } = runtimeWith(prewarm);
    await expect(runtime.prewarm('example')).rejects.toThrow('offline');
    await runtime.prewarm('example');
    expect(prewarm).toHaveBeenCalledTimes(2);
    await runtime.prewarm('missing');
    await runtime.dispose();
    const unsupported = runtimeWith();
    await unsupported.runtime.prewarm('example');
    expect(unsupported.createSession).not.toHaveBeenCalled();
    await unsupported.runtime.dispose();
  });

  it('aborts in-flight warming and refuses new work on disposal', async () => {
    const prewarm = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { runtime } = runtimeWith(prewarm);
    const rejected = expect(runtime.prewarm('example')).rejects.toThrow();
    await Promise.resolve();
    await runtime.dispose();
    await rejected;
    expect(prewarm.mock.calls[0]![0].signal.aborted).toBe(true);
    await expect(runtime.prewarm('example')).rejects.toThrow('disposed');
  });
});
