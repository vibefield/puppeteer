import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterEventCandidate, AgentAdapterBinding, AgentHost, ProfileService } from '@vibefield/puppeteer-core';

/**
 * Every read the runtime makes of its profile registry, counted, and a switch that makes every read from the Nth on
 * throw, as an unreadable profiles.json would. The recorder has its own file so that runtime.test.ts keeps the real
 * registry.
 */
const reads = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
const UNREADABLE = vi.hoisted(() => 'profiles.json is unreadable');

vi.mock('./profiles/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profiles/registry.js')>();
  const createProfileRegistry: typeof actual.createProfileRegistry = (options) => {
    const registry = actual.createProfileRegistry(options);
    const read = <T>(next: () => Promise<T>): Promise<T> => {
      reads.count += 1;
      return reads.count >= reads.failFrom ? Promise.reject(new Error(UNREADABLE)) : next();
    };
    return {
      ...registry,
      list: (providerId) => read(() => registry.list(providerId)),
      get: (profileId) => read(() => registry.get(profileId)),
      managed: (providerId) => read(() => registry.managed(providerId)),
      sets: () => read(() => registry.sets()),
      getSet: (setId) => read(() => registry.getSet(setId)),
      defaultSetId: () => read(() => registry.defaultSetId()),
    };
  };
  return { ...actual, createProfileRegistry };
});

import { createAgentRuntime } from './runtime.js';
import type { AgentProvider, ProfileRegistrySnapshot, ProfileStore } from './types.js';

type Runtime = ReturnType<typeof createAgentRuntime>;

const host: AgentHost = {
  async spawnTerminal() {
    throw new Error('fake providers do not spawn');
  },
  async automateTerminal() {
    return { accepted: true };
  },
};

function memoryProfileStore(): ProfileStore {
  let snapshot: ProfileRegistrySnapshot | undefined;
  return {
    async load() {
      return snapshot;
    },
    async save(next) {
      snapshot = next;
    },
  };
}

function binding(sessionId: string, runtimeSessionId: string): AgentAdapterBinding {
  const listeners = new Set<(event: AdapterEventCandidate) => void>();
  return {
    sessionId,
    runtimeSessionId,
    observationLevel: () => 'structured',
    events: {
      onCandidate(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    services: {
      prompt: {
        async submit() {
          return { status: 'confirmed' };
        },
      },
    },
    async dispose() {},
  };
}

/**
 * A provider whose binding variable is its own root, as runtime.test.ts's example provider, which records the account
 * each preparation was handed.
 */
function typedProvider(handed: Array<string | undefined>): AgentProvider {
  const profiles: ProfileService = {
    provider: {
      id: 'example',
      label: 'Example',
      support: {
        supported: true,
        identity: 'native-status',
        sharedSurfaces: [],
        nativeDefaultRoot: '/home/user/.example',
      },
    },
    bindingEnvironment: (profile) => (profile.kind === 'native-default' ? {} : { EXAMPLE_HOME: profile.dataRoot }),
    observationRoot: (profile) => (profile.kind === 'native-default' ? '/home/user/.example' : profile.dataRoot),
    loginInvocation: (_profile, options) => ({ command: 'example', args: ['login'], cwd: options.cwd }),
    async verify() {
      return {
        loggedIn: true,
        verifiedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'native-status', stability: 'documented' },
      };
    },
  };
  return {
    descriptor: { id: 'example', label: 'Example' },
    profiles,
    launch: {
      provider: {
        id: 'example',
        label: 'Example',
        resume: true,
        nativeInvocation: {
          commands: [{ name: 'example', executable: '/opt/example' }],
          environmentVariables: ['EXAMPLE_HOME'],
        },
      },
      normalizeInvocation: () => ({ status: 'accepted' as const }),
    },
    async createSession() {
      throw new Error('a typed invocation is prepared, never spawned');
    },
    async prepareSession(options) {
      handed.push(options.profile?.id);
      const sessionId = `example-prepared-${handed.length}`;
      return {
        sessionId,
        launch: { command: '/opt/example', args: ['--session-id', sessionId], cwd: options.cwd, env: {} },
        async adopt(runtimeSessionId) {
          return binding(sessionId, runtimeSessionId);
        },
        async dispose() {},
      };
    },
  };
}

/** The label a prepared run carries once its pane adopts it. */
async function adoptAndExit(runtime: Runtime, preparationId: string): Promise<string | undefined> {
  const adopted = await runtime.adoptPrepared(preparationId, { terminalSessionId: `terminal-${preparationId}` });
  if ('error' in adopted) throw new Error(adopted.error.message);
  await runtime.handleProcessExit(adopted.terminalSessionId, { exitCode: 0, signal: null, reason: 'process-exit' });
  return adopted.profileId;
}

describe('a typed invocation under a registered account', () => {
  it('is prepared under the account from the one registry read that attributed it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-typed-account-'));
    const handed: Array<string | undefined> = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [typedProvider(handed)],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
    });
    try {
      const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
      if ('status' in created) throw new Error(created.message);

      reads.count = 0;
      // A second read fails, as a registry torn or retired under the launch would: attribution already read the
      // account, and a named profile's second read would make it a run that fails.
      reads.failFrom = 2;
      const prepared = await runtime.prepareInvocation({
        providerId: 'example',
        cwd: root,
        argv: [],
        environment: { EXAMPLE_HOME: created.dataRoot },
        implementation: { kind: 'native' },
      });
      const preparedReads = reads.count;
      reads.failFrom = Number.POSITIVE_INFINITY;
      if ('error' in prepared) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);

      const labelled = await adoptAndExit(runtime, prepared.preparationId);
      expect({ handed, reads: preparedReads, labelled }).toEqual({
        handed: [created.id],
        reads: 1,
        labelled: created.id,
      });
    } finally {
      reads.failFrom = Number.POSITIVE_INFINITY;
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is prepared unlabelled when the registry cannot be read, as before, and reported once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-typed-unreadable-'));
    const handed: Array<string | undefined> = [];
    const errors: string[] = [];
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [typedProvider(handed)],
      profiles: { store: memoryProfileStore(), rootsDirectory: join(root, 'profiles') },
      onError: (error) => errors.push(error.message),
    });
    try {
      const created = await runtime.createProfile({ providerId: 'example', label: 'Work' });
      if ('status' in created) throw new Error(created.message);

      // Every read from here on fails.
      reads.failFrom = reads.count + 1;
      const prepared = await runtime.prepareInvocation({
        providerId: 'example',
        cwd: root,
        argv: [],
        environment: { EXAMPLE_HOME: created.dataRoot },
        implementation: { kind: 'native' },
      });
      reads.failFrom = Number.POSITIVE_INFINITY;
      if ('error' in prepared) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);

      const labelled = await adoptAndExit(runtime, prepared.preparationId);
      expect({ handed, labelled, errors }).toEqual({ handed: [undefined], labelled: undefined, errors: [UNREADABLE] });
    } finally {
      reads.failFrom = Number.POSITIVE_INFINITY;
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
