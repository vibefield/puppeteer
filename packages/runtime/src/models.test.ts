import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineModelService,
  type AgentModelCatalog,
  type AgentModelDiscoveryContext,
  type AgentAdapterBinding,
  type ProfileService,
} from '@vibecook/puppeteer-core';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider, AgentRuntime, ProfileRegistrySnapshot } from './types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function catalog(context: AgentModelDiscoveryContext): AgentModelCatalog {
  return {
    provider: 'example',
    cwd: context.cwd,
    ...(context.profile ? { profileId: context.profile.id } : {}),
    observedAt: new Date().toISOString(),
    source: { kind: 'native-protocol', freshness: 'unknown' },
    completeness: 'complete',
    customModels: false,
    models: [
      {
        id: 'native-choice',
        label: 'A choice',
        controls: [{ id: 'effort', label: 'Effort', role: 'effort', values: [{ id: 'high', label: 'High' }] }],
      },
    ],
  };
}
async function setup() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'runtime-models-')));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  let count = 0,
    snapshot: ProfileRegistrySnapshot | undefined;
  const binding = (): AgentAdapterBinding => ({
    sessionId: `native-${++count}`,
    runtimeSessionId: `terminal-${count}`,
    observationLevel: () => 'structured',
    events: { onCandidate: () => () => {} },
    services: {
      prompt: {
        async submit() {
          return { status: 'confirmed', turnId: 'turn' };
        },
      },
    },
    async dispose() {},
  });
  const discover = vi.fn(async (context: AgentModelDiscoveryContext) => ({
    status: 'available' as const,
    catalog: catalog(context),
  }));
  const create = vi.fn(async (_options: Parameters<AgentProvider['createSession']>[0]) => binding());
  const prepare = vi.fn(async (options: { cwd: string }) => ({
    sessionId: 'prepared-native',
    launch: { command: 'example', args: [], cwd: options.cwd },
    async adopt() {
      return binding();
    },
    async dispose() {},
  }));
  const profiles: ProfileService = {
    provider: {
      id: 'example',
      label: 'Example',
      support: {
        supported: true,
        identity: 'native-status',
        sharedSurfaces: [],
        nativeDefaultRoot: join(cwd, 'native'),
      },
    },
    bindingEnvironment: (profile) => (profile.kind === 'native-default' ? {} : { EXAMPLE_HOME: profile.dataRoot }),
    observationRoot: (profile) => profile.dataRoot,
    loginInvocation: (_profile, options) => ({ command: 'example', args: ['login'], cwd: options.cwd }),
    async verify() {
      return {
        loggedIn: true,
        verifiedAt: new Date().toISOString(),
        source: { kind: 'native-status', stability: 'documented' },
      };
    },
  };
  const provider: AgentProvider = {
    descriptor: { id: 'example', label: 'Example' },
    profiles,
    createSession: create,
    prepareSession: prepare,
    models: defineModelService({
      provider: { id: 'example', label: 'Example', discovery: 'prelaunch' },
      discover,
      toAgentOptions: (selection) => ({ privateModel: selection.modelId, privateEffort: selection.controls?.effort }),
    }),
  };
  const runtime = createAgentRuntime({
    defaultCwd: cwd,
    providers: [provider, { descriptor: { id: 'bare', label: 'Bare' }, createSession: create }],
    profiles: {
      rootsDirectory: join(cwd, 'profiles'),
      store: {
        async load() {
          return snapshot;
        },
        async save(value) {
          snapshot = value;
        },
      },
    },
    host: {
      async spawnTerminal() {
        throw new Error('unexpected terminal');
      },
      async automateTerminal() {
        return { accepted: true };
      },
    },
  });
  cleanups.push(async () => {
    await runtime.dispose();
  });
  return { runtime, provider, cwd, discover, create, prepare };
}
async function workProfile(runtime: AgentRuntime) {
  const set = await runtime.createProfileSet({ label: 'Work', glyph: 'briefcase' });
  if ('status' in set) throw new Error(set.message);
  const profile = await runtime.createProfile({ providerId: 'example', set: set.set.id });
  if ('status' in profile) throw new Error(profile.message);
  await runtime.setDefaultProfileSet(set.set.id);
  return profile;
}

describe('runtime model discovery and launch selection', () => {
  it('uses the same default, named, and native account choice as spawn without starting a session', async () => {
    const { runtime, cwd, discover, create } = await setup();
    const profile = await workProfile(runtime);
    expect(runtime.modelProviders()).toEqual([{ id: 'example', label: 'Example', discovery: 'prelaunch' }]);
    expect(await runtime.discoverModels({ agent: 'example' })).toMatchObject({
      status: 'available',
      catalog: { cwd, profileId: profile.id },
    });
    expect(discover.mock.calls.at(-1)?.[0].profile).toEqual(profile);
    expect(
      await runtime.discoverModels({ agent: 'example', profile: profile.id, cwd: join(cwd, 'nested', '..') }),
    ).toMatchObject({ catalog: { cwd, profileId: profile.id } });
    await runtime.discoverModels({ agent: 'example', profileSet: 'native' });
    expect(discover.mock.calls.at(-1)?.[0].profile).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(await runtime.discoverModels({ agent: 'example', profile: 'missing' })).toMatchObject({
      status: 'error',
      code: 'invalid-context',
    });
    expect(await runtime.discoverModels({ agent: 'bare' })).toMatchObject({ status: 'unsupported' });
    expect(await runtime.discoverModels({ agent: 'missing' })).toMatchObject({ status: 'unsupported' });
  });

  it('revalidates at launch in the selected account and passes only translated private options', async () => {
    const { runtime, cwd, discover, create, prepare } = await setup();
    const profile = await workProfile(runtime);
    await runtime.discoverModels({ agent: 'example' });
    const modelSelection = { modelId: 'native-choice', controls: { effort: 'high' } };
    const spawned = await runtime.spawn({ agent: 'example', modelSelection });
    expect(spawned).not.toHaveProperty('error');
    expect(discover).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, profile, agentOptions: { privateModel: 'native-choice', privateEffort: 'high' } }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('modelSelection');
    const prepared = await runtime.prepareSession({ agent: 'example', profile: profile.id, modelSelection });
    expect(prepared).not.toHaveProperty('error');
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ profile, agentOptions: { privateModel: 'native-choice', privateEffort: 'high' } }),
    );
    expect(JSON.stringify(spawned)).not.toContain('privateModel');
  });

  it('rejects stale choices, invalid controls, ambiguous native options, and resume overrides before provider launch', async () => {
    const { runtime, discover, create, prepare } = await setup();
    for (const modelSelection of [{ modelId: 'removed' }, { modelId: 'native-choice', controls: { effort: 'max' } }]) {
      expect(await runtime.spawn({ agent: 'example', modelSelection })).toMatchObject({
        error: { code: 'AGENT_LAUNCH_REFUSED', refusal: { code: 'INVALID_MODEL_SELECTION' } },
      });
    }
    expect(
      await runtime.prepareSession({
        agent: 'example',
        modelSelection: { modelId: 'native-choice' },
        agentOptions: {},
      }),
    ).toHaveProperty('error.refusal.code', 'INVALID_MODEL_SELECTION');
    expect(
      await runtime.createSession({
        agent: 'example',
        resume: 'old-session',
        modelSelection: { modelId: 'native-choice' },
      }),
    ).toHaveProperty('error.refusal.code', 'INVALID_MODEL_SELECTION');
    discover.mockImplementationOnce(async (context) => ({
      status: 'available',
      catalog: { ...catalog(context), models: [] },
    }));
    expect(await runtime.spawn({ agent: 'example', modelSelection: { modelId: 'native-choice' } })).toHaveProperty(
      'error.refusal.code',
      'INVALID_MODEL_SELECTION',
    );
    expect(create).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('inherits defaults without discovery and preserves the existing native options path', async () => {
    const { runtime, discover, create } = await setup();
    expect(await runtime.spawn({ agent: 'example' })).not.toHaveProperty('error');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ agentOptions: undefined }));
    await runtime.spawn({ agent: 'example', agentOptions: { privateOption: true } });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ agentOptions: { privateOption: true } }));
    expect(discover).not.toHaveBeenCalled();
  });

  it('rejects a catalog from a different workspace or account', async () => {
    const { runtime, discover } = await setup();
    discover.mockImplementationOnce(async (context) => ({
      status: 'available',
      catalog: { ...catalog(context), cwd: '/other' },
    }));
    expect(await runtime.discoverModels({ agent: 'example' })).toMatchObject({
      status: 'error',
      code: 'invalid-response',
    });
    discover.mockImplementationOnce(async (context) => ({
      status: 'available',
      catalog: { ...catalog(context), profileId: 'example:other' },
    }));
    expect(await runtime.spawn({ agent: 'example', modelSelection: { modelId: 'native-choice' } })).toHaveProperty(
      'error.refusal.code',
      'MODEL_DISCOVERY_UNAVAILABLE',
    );
  });

  it('cancels pending discovery on disposal and waits for provider cleanup', async () => {
    const { runtime, provider } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cleaned = false;
    vi.spyOn(provider.models!, 'discover').mockImplementation(
      (context) =>
        new Promise((resolve) => {
          context.signal!.addEventListener(
            'abort',
            () => {
              cleaned = true;
              resolve({ status: 'cancelled', provider: 'example', code: 'cancelled', message: 'Cancelled.' });
            },
            { once: true },
          );
          started();
        }),
    );
    const pending = runtime.discoverModels({ agent: 'example' });
    await ready;
    await runtime.dispose();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(cleaned).toBe(true);
  });
});
