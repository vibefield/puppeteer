import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ProfileProvider, ProfileService } from '@vibecook/puppeteer-core';
import {
  createFileProfileStore,
  createProfileRegistry,
  defaultProfileStorePath,
  nativeDefaultProfileId,
  parseProfileRegistrySnapshot,
  type ProfileRegistryProvider,
} from './registry.js';
import { createProfileRootAllocator, defaultProfileRootsDirectory } from './roots.js';

function descriptor(id: string, overrides: Partial<ProfileProvider['support']> = {}): ProfileProvider {
  return {
    id,
    label: id,
    support: {
      supported: true,
      identity: 'native-status',
      sharedSurfaces: [],
      nativeDefaultRoot: `/home/user/.${id}`,
      ...overrides,
    },
  };
}

function registryProvider(provider: ProfileProvider): ProfileRegistryProvider {
  const service: ProfileService = {
    provider,
    bindingEnvironment: (profile): Record<string, string> =>
      profile.kind === 'native-default' ? {} : { EXAMPLE_HOME: profile.dataRoot },
    observationRoot: (profile): string => profile.dataRoot,
    loginInvocation: (_profile, options) => ({ command: provider.id, args: ['login'], cwd: options.cwd }),
    async verify() {
      return {
        loggedIn: true,
        verifiedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'native-status', stability: 'documented' },
      };
    },
  };
  return { provider, service };
}

function managedProfile(provider: string, id: string, label = 'Work'): AgentProfile {
  return {
    id,
    provider,
    label,
    kind: 'managed',
    dataRoot: `/home/user/.puppeteer/profiles/${provider}/${id}`,
    createdAt: '2026-09-06T12:00:00.000Z',
  };
}

function memoryStore(initial?: AgentProfile[]) {
  const state = { snapshot: initial ? { version: 1 as const, profiles: initial } : undefined };
  return {
    state,
    store: {
      async load() {
        return state.snapshot;
      },
      async save(snapshot: { version: 1; profiles: AgentProfile[] }) {
        state.snapshot = snapshot;
      },
    },
  };
}

describe('default host locations', () => {
  it('roots the store and the profile roots under the puppeteer home', () => {
    expect(defaultProfileStorePath('/home/user')).toBe(join('/home/user', '.puppeteer', 'profiles.json'));
    expect(defaultProfileRootsDirectory('/home/user')).toBe(join('/home/user', '.puppeteer', 'profiles'));
  });
});

describe('parseProfileRegistrySnapshot', () => {
  it('accepts a versioned document and rejects anything it cannot vouch for', () => {
    const profile = managedProfile('example', 'p1');
    expect(parseProfileRegistrySnapshot({ version: 1, profiles: [profile] }).profiles).toEqual([profile]);
    expect(() => parseProfileRegistrySnapshot({ version: 2, profiles: [] })).toThrow('unsupported');
    expect(() => parseProfileRegistrySnapshot({ version: 1 })).toThrow('profiles array');
    expect(() => parseProfileRegistrySnapshot({ version: 1, profiles: [{ ...profile, kind: 'other' }] })).toThrow(
      'schema validation',
    );
  });
});

describe('createFileProfileStore', () => {
  it('treats a missing file as an empty registry and writes 0600 atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-profiles-'));
    const path = join(directory, 'nested', 'profiles.json');
    const store = createFileProfileStore({ path });

    await expect(store.load()).resolves.toBeUndefined();
    const profile = managedProfile('example', 'p1');
    await store.save({ version: 1, profiles: [profile] });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, profiles: [profile] });
    await expect(store.load()).resolves.toEqual({ version: 1, profiles: [profile] });

    // A rewrite replaces the document rather than appending to it.
    await store.save({ version: 1, profiles: [] });
    await expect(store.load()).resolves.toEqual({ version: 1, profiles: [] });
  });

  it('refuses to silently forget a corrupt registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-profiles-'));
    const path = join(directory, 'profiles.json');
    await writeFile(path, '{"version":1,"profiles":[{"id":"p1"}]}');
    await expect(createFileProfileStore({ path }).load()).rejects.toThrow('schema validation');
  });
});

describe('createProfileRegistry', () => {
  it('adds one synthetic native-default profile per supporting provider', async () => {
    const { store } = memoryStore([managedProfile('alpha', 'p1', 'Work')]);
    const registry = createProfileRegistry({
      providers: [
        registryProvider(descriptor('alpha')),
        registryProvider(descriptor('beta')),
        // Declared but unsupported, and supported without a known root: neither
        // can produce a default profile.
        registryProvider(descriptor('gamma', { supported: false })),
        registryProvider(descriptor('delta', { nativeDefaultRoot: undefined })),
      ],
      store,
    });

    const profiles = await registry.list();
    expect(profiles.map((profile) => profile.id)).toEqual([
      nativeDefaultProfileId('alpha'),
      'p1',
      nativeDefaultProfileId('beta'),
    ]);
    expect(profiles[0]).toMatchObject({
      label: 'Default',
      kind: 'native-default',
      dataRoot: '/home/user/.alpha',
      createdAt: '1970-01-01T00:00:00.000Z',
    });
    await expect(registry.list('beta')).resolves.toHaveLength(1);
    await expect(registry.managed()).resolves.toHaveLength(1);
    await expect(registry.get('p1')).resolves.toMatchObject({ label: 'Work' });
    await expect(registry.get('nope')).resolves.toBeUndefined();
  });

  it('persists additions and removals and announces every change', async () => {
    const { state, store } = memoryStore();
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    const changes = vi.fn();
    registry.onChange(changes);

    await registry.add(managedProfile('alpha', 'p1'));
    expect(state.snapshot?.profiles.map((profile) => profile.id)).toEqual(['p1']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]?.[0].map((profile: AgentProfile) => profile.id)).toEqual([
      nativeDefaultProfileId('alpha'),
      'p1',
    ]);

    await expect(registry.add(managedProfile('alpha', 'p1'))).rejects.toThrow('already registered');
    await expect(registry.remove('p1')).resolves.toBe(true);
    await expect(registry.remove('p1')).resolves.toBe(false);
    expect(state.snapshot?.profiles).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('persists a managed identity and keeps a native-default identity in memory only', async () => {
    const { state, store } = memoryStore([managedProfile('alpha', 'p1')]);
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    const identity = {
      loggedIn: true,
      email: 'user@example.com',
      plan: 'max',
      verifiedAt: '2026-09-06T12:00:00.000Z',
      source: { kind: 'native-status' as const, stability: 'documented' as const },
    };

    await expect(registry.recordIdentity('p1', identity)).resolves.toMatchObject({ identity });
    expect(state.snapshot?.profiles[0]?.identity).toEqual(identity);

    await expect(registry.recordIdentity(nativeDefaultProfileId('alpha'), identity)).resolves.toMatchObject({
      identity,
    });
    // The synthetic profile is derived from the adapter, so it is never written.
    expect(state.snapshot?.profiles).toHaveLength(1);
    await expect(registry.list('alpha')).resolves.toMatchObject([{ identity }, { identity }]);
    await expect(registry.recordIdentity('missing', identity)).resolves.toBeUndefined();
  });

  it('keeps registered profiles whose provider no longer exposes profiles', async () => {
    const { store } = memoryStore([managedProfile('alpha', 'p1'), managedProfile('retired', 'p2')]);
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });

    await expect(registry.list()).resolves.toMatchObject([
      { id: nativeDefaultProfileId('alpha') },
      { id: 'p1' },
      { id: 'p2' },
    ]);
    await expect(registry.remove('p2')).resolves.toBe(true);
  });

  it('stops announcing after dispose', async () => {
    const { store } = memoryStore();
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    const changes = vi.fn();
    registry.onChange(changes);
    registry.dispose();

    await registry.add(managedProfile('alpha', 'p1'));
    expect(changes).not.toHaveBeenCalled();
    expect(registry.onChange(changes)()).toBeUndefined();
  });
});

describe('createProfileRootAllocator', () => {
  it('allocates one immutable 0700 root per profile under the provider directory', async () => {
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-roots-')), 'profiles');
    const allocator = createProfileRootAllocator({ rootsDirectory, newId: () => 'fixed-id' });

    const allocated = await allocator.allocate('alpha');
    expect(allocated).toEqual({ id: 'fixed-id', dataRoot: join(rootsDirectory, 'alpha', 'fixed-id') });
    expect((await stat(allocated.dataRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(rootsDirectory, 'alpha'))).mode & 0o777).toBe(0o700);
  });
});
