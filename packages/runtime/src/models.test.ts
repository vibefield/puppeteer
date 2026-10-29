import { createFileCreationRequestRegistry } from './identity/creation-registry.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineModelService,
  type AgentModelCatalog,
  type AgentModelDiscoveryContext,
  type AgentModelDiscoveryResult,
  type AgentAdapterBinding,
  type ProfileService,
} from '@vibefield/puppeteer-core';
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
async function setup(options: { resumeSelection?: boolean; creationRegistry?: boolean } = {}) {
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
  const discover = vi.fn(async (context: AgentModelDiscoveryContext): Promise<AgentModelDiscoveryResult> => ({
    status: 'available',
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
    descriptor: {
      id: 'example',
      label: 'Example',
      briefing: { mcpServers: true, allowTools: true, instructions: true, mcpServerProcess: 'terminal' },
    },
    profiles,
    createSession: create,
    prepareSession: prepare,
    // A continuation that carries an account root of the provider's own, as the builtin codecs do.
    launch: {
      provider: { id: 'example', label: 'Example', resume: true },
      continuation: {
        capture: ({ agentOptions }) => {
          const root = (agentOptions as { privateRoot?: string } | undefined)?.privateRoot;
          return root === undefined ? undefined : JSON.stringify({ root });
        },
        restore: (state) =>
          state === undefined ? undefined : { privateRoot: (JSON.parse(state) as { root: string }).root },
      },
    },
    models: defineModelService({
      provider: {
        id: 'example',
        label: 'Example',
        discovery: 'prelaunch',
        ...(options.resumeSelection === undefined ? {} : { resumeSelection: options.resumeSelection }),
      },
      discover,
      toAgentOptions: (selection) => ({ privateModel: selection.modelId, privateEffort: selection.controls?.effort }),
    }),
  };
  const runtime = createAgentRuntime({
    defaultCwd: cwd,
    ...(options.creationRegistry
      ? { creationRegistry: createFileCreationRequestRegistry({ directory: join(cwd, 'creation-registry') }) }
      : {}),
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

  it('rejects stale choices, invalid controls, ambiguous native options, and a resume its provider cannot apply before provider launch', async () => {
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

describe('resume starts at the session’s own launch selection', () => {
  const continuation = (root?: string) => ({
    providerId: 'example',
    nativeSessionId: 'native-old',
    implementation: 'native' as const,
    ...(root === undefined ? {} : { state: JSON.stringify({ root }) }),
  });
  const modelSelection = { modelId: 'native-choice', controls: { effort: 'high' } };

  it('discovers again in the resumed account and folder, and lays the translation over the continuation', async () => {
    const { runtime, cwd, discover, create } = await setup({ resumeSelection: true });
    const profile = await workProfile(runtime);
    const resumed = await runtime.resume({
      continuation: continuation('/roots/work'),
      profile: profile.id,
      modelSelection,
    });
    if ('error' in resumed) throw new Error(resumed.error.message);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]?.[0]).toMatchObject({ cwd, profile });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd,
        resume: 'native-old',
        profile,
        agentOptions: { privateRoot: '/roots/work', privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('modelSelection');
    // The continuation handed back is the session's own root; the selection never enters it.
    expect(resumed.info.continuation).toEqual({
      providerId: 'example',
      nativeSessionId: resumed.info.nativeSession.id,
      implementation: 'native',
      state: JSON.stringify({ root: '/roots/work' }),
    });
    expect(JSON.stringify(resumed)).not.toContain('privateModel');

    // A resume that names no account continues in the provider's own root, never the default set's.
    await runtime.resume({ continuation: continuation(), modelSelection });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1]?.[0].profile).toBeUndefined();
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: 'native-old',
        agentOptions: { privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('profile');
  });

  it('refuses a stale or invalid selection and a failed discovery after discovering again, before the provider launches', async () => {
    const { runtime, discover, create } = await setup({ resumeSelection: true });
    for (const stale of [{ modelId: 'removed' }, { modelId: 'native-choice', controls: { effort: 'max' } }]) {
      expect(await runtime.resume({ continuation: continuation('/roots/work'), modelSelection: stale })).toMatchObject({
        error: { code: 'AGENT_LAUNCH_REFUSED', refusal: { code: 'INVALID_MODEL_SELECTION' } },
      });
    }
    expect(discover).toHaveBeenCalledTimes(2);
    discover.mockImplementationOnce(async () => ({
      status: 'auth-required',
      provider: 'example',
      code: 'auth-required',
      message: 'Sign in to discover models.',
    }));
    expect(await runtime.resume({ continuation: continuation('/roots/work'), modelSelection })).toMatchObject({
      error: {
        code: 'AGENT_LAUNCH_REFUSED',
        message: 'Sign in to discover models.',
        refusal: { code: 'MODEL_DISCOVERY_UNAVAILABLE' },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps today’s continuation exactly when the resume carries no selection', async () => {
    const { runtime, discover, create } = await setup();
    expect(await runtime.resume({ continuation: continuation('/roots/work') })).not.toHaveProperty('error');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ resume: 'native-old', agentOptions: { privateRoot: '/roots/work' } }),
    );
    expect(await runtime.resume({ continuation: continuation() })).not.toHaveProperty('error');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ resume: 'native-old', agentOptions: undefined }));
    expect(discover).not.toHaveBeenCalled();
  });

  it('applies on the lower-level resume paths too, and refuses a selection beside native options there', async () => {
    const { runtime, cwd, discover, create, prepare } = await setup({ resumeSelection: true });
    const created = await runtime.createSession({ agent: 'example', resume: 'native-old', modelSelection });
    expect(created).not.toHaveProperty('error');
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: 'native-old',
        agentOptions: { privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    const prepared = await runtime.prepareSession({ agent: 'example', resume: 'native-old', modelSelection });
    expect(prepared).not.toHaveProperty('error');
    expect(prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd,
        resume: 'native-old',
        agentOptions: { privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    expect(discover).toHaveBeenCalledTimes(2);
    const typed = { agent: 'example', resume: 'native-old', modelSelection, agentOptions: { privateRoot: '/typed' } };
    expect(await runtime.createSession(typed)).toMatchObject({
      error: {
        code: 'AGENT_LAUNCH_REFUSED',
        message: 'Choose either a model selection or provider-native launch options.',
        refusal: { code: 'INVALID_MODEL_SELECTION' },
      },
    });
    expect(await runtime.prepareSession(typed)).toMatchObject({
      error: {
        message: 'Choose either a model selection or provider-native launch options.',
        refusal: { code: 'INVALID_MODEL_SELECTION' },
      },
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('refuses before discovery where the provider’s resume cannot take a selection', async () => {
    for (const resumeSelection of [undefined, false]) {
      const { runtime, discover, create } = await setup(resumeSelection === undefined ? {} : { resumeSelection });
      expect(runtime.modelProviders()[0]?.resumeSelection).toBe(resumeSelection);
      expect(await runtime.resume({ continuation: continuation('/roots/work'), modelSelection })).toMatchObject({
        error: {
          code: 'AGENT_LAUNCH_REFUSED',
          message: 'Example cannot start a resumed session at a model selection; resume without one.',
          refusal: { code: 'INVALID_MODEL_SELECTION' },
        },
      });
      expect(discover).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });
});

describe('run briefings alongside model selection', () => {
  const briefing = () => ({
    mcpServers: { field: { command: 'door', args: ['--stdio'], env: { TOKEN: 'run-secret' } } },
    allowTools: ['field/*'],
    instructions: 'role briefing',
  });
  const modelSelection = { modelId: 'native-choice', controls: { effort: 'high' } };
  it('carries an immutable snapshot through spawn and preparation without capturing secrets', async () => {
    const { runtime, create, prepare, provider } = await setup();
    const capture = vi.spyOn(provider.launch!.continuation!, 'capture');
    const input = briefing();
    const spawning = runtime.spawn({ agent: 'example', modelSelection, ...input });
    input.mcpServers.field.env.TOKEN = 'changed';
    const agent = await spawning;
    expect(agent).not.toHaveProperty('error');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...briefing(),
        agentOptions: { privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    for (const field of ['mcpServers', 'allowTools', 'instructions'])
      expect(capture.mock.calls[0]![0]).not.toHaveProperty(field);
    expect(JSON.stringify(agent)).not.toContain('run-secret');
    expect(JSON.stringify(agent)).not.toContain('role briefing');
    await runtime.prepareSession({ agent: 'example', modelSelection, ...briefing() });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining(briefing()));
  });

  it('accepts fresh briefing data on resume beside a new model and opaque continuation state', async () => {
    const { runtime, create } = await setup({ resumeSelection: true });
    const continuation = {
      providerId: 'example',
      nativeSessionId: 'old',
      implementation: 'native' as const,
      state: JSON.stringify({ root: '/work/profile' }),
    };
    const resumed = await runtime.resume({ continuation, modelSelection, ...briefing() });
    if ('error' in resumed) throw new Error(resumed.error.message);
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...briefing(),
        resume: 'old',
        agentOptions: { privateRoot: '/work/profile', privateModel: 'native-choice', privateEffort: 'high' },
      }),
    );
    expect(resumed.info.continuation!.state).toBe(continuation.state);
    await runtime.resume({ continuation });
    expect(create.mock.calls.at(-1)![0]).not.toHaveProperty('mcpServers');
  });

  it('rejects unsupported fields before provider launch or model discovery', async () => {
    const { runtime, create, discover } = await setup();
    for (const field of ['mcpServers', 'allowTools', 'instructions'] as const) {
      const result = await runtime.spawn({ agent: 'bare', [field]: briefing()[field] });
      expect(result).toMatchObject({
        error: {
          code: 'AGENT_LAUNCH_REFUSED',
          refusal: { code: 'UNSUPPORTED_LAUNCH_FIELD' },
          message: expect.stringContaining(field),
        },
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('includes all briefing fields in creation identity and protects advertised capabilities from mutation', async () => {
    const { runtime, create } = await setup({ creationRegistry: true });
    const input = { agent: 'example', creationRequestId: 'briefing-retry', ...briefing() };
    expect(await runtime.spawn(input)).not.toHaveProperty('error');
    expect(await runtime.spawn(input)).not.toHaveProperty('error');
    expect(create).toHaveBeenCalledTimes(1);
    for (const change of [
      { instructions: 'different' },
      { allowTools: [] },
      { mcpServers: { field: { command: 'other' } } },
    ]) {
      expect(await runtime.spawn({ ...input, ...change })).toHaveProperty('error.code', 'CREATION_REQUEST_CONFLICT');
    }
    const catalog = runtime.providers();
    catalog.find((provider) => provider.id === 'example')!.briefing!.instructions = false;
    expect(runtime.providers().find((provider) => provider.id === 'example')!.briefing!.instructions).toBe(true);
    const launches = runtime.launchProviders();
    expect(launches[0]!.briefing!.mcpServerProcess).toBe('terminal');
    launches[0]!.briefing!.instructions = false;
    expect(runtime.launchProviders()[0]!.briefing!.instructions).toBe(true);
  });
});
