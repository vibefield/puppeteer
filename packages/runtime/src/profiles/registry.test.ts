import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ProfileProvider, ProfileService } from '@vibecook/puppeteer-core';
import type { ProfileRegistrySnapshot } from '../types.js';
import {
  createFileProfileStore,
  createProfileRegistry,
  defaultProfileStorePath,
  NATIVE_PROFILE_SET_LABEL,
  nativeDefaultProfileId,
  parseProfileRegistrySnapshot,
  type ProfileRegistryProvider,
} from './registry.js';
import {
  createProfileRootAllocator,
  defaultProfileRootsDirectory,
  profileSetSlug,
  uniqueProfileSetId,
} from './roots.js';

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

const WORK_SET = {
  id: 'work',
  kind: 'managed' as const,
  label: 'Work',
  glyph: 'briefcase',
  directory: '/home/user/.puppeteer/profiles/work',
  createdAt: '2026-09-23T09:00:00.000Z',
};

/** A store holding what a pre-set host wrote (version 1), adopted on the registry's first read. */
function memoryStore(initial?: AgentProfile[]) {
  const state: { snapshot: ProfileRegistrySnapshot | undefined } = {
    snapshot: initial ? parseProfileRegistrySnapshot({ version: 1, profiles: initial }) : undefined,
  };
  return {
    state,
    store: {
      async load() {
        return state.snapshot;
      },
      async save(snapshot: ProfileRegistrySnapshot) {
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
    const profile = { ...managedProfile('example', 'p1'), set: 'work' };
    const document = { version: 2, defaultSet: 'work', sets: [WORK_SET], profiles: [profile] };
    expect(parseProfileRegistrySnapshot(document)).toEqual(document);
    expect(() => parseProfileRegistrySnapshot({ version: 3, sets: [], profiles: [] })).toThrow('unsupported');
    expect(() => parseProfileRegistrySnapshot({ version: 2, profiles: [] })).toThrow('sets array');
    expect(() => parseProfileRegistrySnapshot({ version: 1 })).toThrow('profiles array');
    expect(() => parseProfileRegistrySnapshot({ version: 1, profiles: [{ ...profile, kind: 'other' }] })).toThrow(
      'schema validation',
    );
    expect(() => parseProfileRegistrySnapshot({ ...document, sets: [{ ...WORK_SET, id: '../escape' }] })).toThrow(
      'schema validation',
    );
  });

  it('adopts a version 1 registry into sets by name, keeping every root where it is', () => {
    const adopted = parseProfileRegistrySnapshot({
      version: 1,
      profiles: [
        managedProfile('alpha', 'a1', 'Work'),
        managedProfile('beta', 'b1', ' work '),
        // A second account of one provider under one name cannot share the set.
        managedProfile('alpha', 'a2', 'Work'),
        managedProfile('alpha', 'a3', 'Personal'),
        // Synthetic entries a careless host wrote are not stored state.
        { ...managedProfile('alpha', 'alpha:native-default', 'Default'), kind: 'native-default' },
      ],
    });
    expect(adopted.version).toBe(2);
    expect(adopted.defaultSet).toBeUndefined();
    expect(adopted.sets.map((set) => [set.id, set.label, set.directory])).toEqual([
      ['work', 'Work', undefined],
      ['work-2', 'Work', undefined],
      ['personal', 'Personal', undefined],
    ]);
    expect(adopted.profiles.map((profile) => [profile.id, profile.set, profile.label, profile.dataRoot])).toEqual([
      ['a1', 'work', 'Work', '/home/user/.puppeteer/profiles/alpha/a1'],
      ['b1', 'work', 'Work', '/home/user/.puppeteer/profiles/beta/b1'],
      ['a2', 'work-2', 'Work', '/home/user/.puppeteer/profiles/alpha/a2'],
      ['a3', 'personal', 'Personal', '/home/user/.puppeteer/profiles/alpha/a3'],
    ]);
    // Adoption is a fixed point: reading the result again changes nothing.
    expect(parseProfileRegistrySnapshot(adopted)).toEqual(adopted);
  });

  it('adopts accounts named "Profiles" into a set that is not called profiles, and keeps one that already is', () => {
    const adopted = parseProfileRegistrySnapshot({ version: 1, profiles: [managedProfile('alpha', 'a1', 'Profiles')] });
    expect(adopted.sets.map((set) => [set.id, set.label])).toEqual([['profiles-2', 'Profiles']]);
    // A registry an earlier build wrote with the id is read as it is, folder and all.
    const earlier = {
      version: 2,
      defaultSet: 'profiles',
      sets: [
        {
          ...WORK_SET,
          id: 'profiles',
          label: 'Profiles',
          directory: '/home/user/.puppeteer/profiles/profiles',
        },
      ],
      profiles: [{ ...managedProfile('alpha', 'a1', 'Profiles'), set: 'profiles' }],
    };
    expect(parseProfileRegistrySnapshot(earlier)).toEqual(earlier);
  });

  it('repairs a document whose references do not hold, without dropping a root', () => {
    const repaired = parseProfileRegistrySnapshot({
      version: 2,
      defaultSet: 'gone',
      sets: [WORK_SET],
      profiles: [
        { ...managedProfile('alpha', 'a1'), set: 'work' },
        { ...managedProfile('alpha', 'a2', 'Orphan'), set: 'missing' },
        // A retired account may sit beside its successor.
        { ...managedProfile('alpha', 'a0'), set: 'work', retiredAt: '2026-09-23T10:00:00.000Z' },
      ],
    });
    expect(repaired.defaultSet).toBeUndefined();
    expect(repaired.sets.map((set) => set.id)).toEqual(['work', 'orphan']);
    expect(repaired.profiles.map((profile) => [profile.id, profile.set])).toEqual([
      ['a1', 'work'],
      ['a2', 'orphan'],
      ['a0', 'work'],
    ]);
  });

  it('refuses a document that names one set or one account twice, rather than dropping either', () => {
    // Keeping one would let the next write forget the other's folder or root.
    expect(() =>
      parseProfileRegistrySnapshot({ version: 2, sets: [WORK_SET, { ...WORK_SET, label: 'Again' }], profiles: [] }),
    ).toThrow('duplicate profile set id: work');
    expect(() =>
      parseProfileRegistrySnapshot({
        version: 2,
        sets: [WORK_SET],
        profiles: [
          { ...managedProfile('alpha', 'a1'), set: 'work' },
          { ...managedProfile('beta', 'a1'), set: 'work' },
        ],
      }),
    ).toThrow('duplicate agent profile id: a1');
  });
});

describe('createFileProfileStore', () => {
  it('treats a missing file as an empty registry and writes 0600 atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-profiles-'));
    const path = join(directory, 'nested', 'profiles.json');
    const store = createFileProfileStore({ path });

    await expect(store.load()).resolves.toBeUndefined();
    const profile = { ...managedProfile('example', 'p1'), set: 'work' };
    const document: ProfileRegistrySnapshot = { version: 2, sets: [WORK_SET], profiles: [profile] };
    await store.save(document);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(document);
    await expect(store.load()).resolves.toEqual(document);

    // A rewrite replaces the document rather than appending to it.
    await store.save({ version: 2, sets: [], profiles: [] });
    await expect(store.load()).resolves.toEqual({ version: 2, sets: [], profiles: [] });
  });

  it('reads a version 1 file as the adopted version 2 document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-profiles-'));
    const path = join(directory, 'profiles.json');
    await writeFile(path, JSON.stringify({ version: 1, profiles: [managedProfile('example', 'p1', 'Work')] }));
    await expect(createFileProfileStore({ path }).load()).resolves.toMatchObject({
      version: 2,
      sets: [{ id: 'work', label: 'Work' }],
      profiles: [{ id: 'p1', set: 'work' }],
    });
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
      set: 'native',
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

    await registry.addSet(WORK_SET);
    await registry.add({ ...managedProfile('alpha', 'p1', 'Anything'), set: 'work' });
    expect(state.snapshot?.profiles.map((profile) => [profile.id, profile.label])).toEqual([['p1', 'Work']]);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes.mock.calls[1]?.[0].map((profile: AgentProfile) => profile.id)).toEqual([
      nativeDefaultProfileId('alpha'),
      'p1',
    ]);

    await expect(registry.add({ ...managedProfile('alpha', 'p1'), set: 'work' })).rejects.toThrow('already registered');
    await expect(registry.add(managedProfile('alpha', 'p9'))).rejects.toThrow('names no registered profile set');
    await expect(registry.add({ ...managedProfile('alpha', 'p2'), set: 'work' })).rejects.toThrow(
      'already has a alpha account',
    );
    await expect(registry.remove('p1')).resolves.toBe(true);
    await expect(registry.remove('p1')).resolves.toBe(false);
    expect(state.snapshot?.profiles).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('lists the native set first and each managed set with its active accounts', async () => {
    const { state, store } = memoryStore();
    const registry = createProfileRegistry({
      providers: [registryProvider(descriptor('alpha')), registryProvider(descriptor('beta'))],
      store,
    });
    await registry.addSet(WORK_SET);
    await registry.add({ ...managedProfile('beta', 'b1'), set: 'work' });
    await registry.add({ ...managedProfile('alpha', 'a1'), set: 'work' });

    const sets = await registry.sets();
    expect(sets.map((info) => [info.set.id, info.set.kind, info.isDefault])).toEqual([
      ['native', 'native', true],
      ['work', 'managed', false],
    ]);
    expect(sets[0]?.set.label).toBe(NATIVE_PROFILE_SET_LABEL);
    expect(sets[0]?.profiles.map((profile) => profile.id)).toEqual([
      nativeDefaultProfileId('alpha'),
      nativeDefaultProfileId('beta'),
    ]);
    // Provider order, whatever order the accounts were added in.
    expect(sets[1]?.profiles.map((profile) => profile.id)).toEqual(['a1', 'b1']);

    // Retiring takes an account out of its set and lets another take its place.
    await expect(registry.retire('a1', '2026-09-23T10:00:00.000Z')).resolves.toMatchObject({
      retiredAt: '2026-09-23T10:00:00.000Z',
    });
    expect((await registry.getSet('work'))?.profiles.map((profile) => profile.id)).toEqual(['b1']);
    await registry.add({ ...managedProfile('alpha', 'a2'), set: 'work' });
    expect((await registry.getSet('work'))?.profiles.map((profile) => profile.id)).toEqual(['a2', 'b1']);
    // Still registered, so a host can find it to finish it.
    await expect(registry.get('a1')).resolves.toMatchObject({ retiredAt: '2026-09-23T10:00:00.000Z' });
    expect(state.snapshot?.profiles.map((profile) => profile.id)).toEqual(['b1', 'a1', 'a2']);
  });

  it('renames a set through to its accounts and keeps its directory', async () => {
    const { state, store } = memoryStore();
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    await registry.addSet(WORK_SET);
    await registry.add({ ...managedProfile('alpha', 'a1'), set: 'work' });

    const renamed = await registry.updateSet('work', { label: '  Acme  ', glyph: 'rocket' });
    expect(renamed?.set).toMatchObject({ id: 'work', label: 'Acme', glyph: 'rocket', directory: WORK_SET.directory });
    expect(renamed?.profiles[0]?.label).toBe('Acme');
    expect(state.snapshot?.profiles[0]?.label).toBe('Acme');
    // A directory is recorded once and never moved.
    await registry.updateSet('work', { directory: '/elsewhere' });
    expect((await registry.getSet('work'))?.set.directory).toBe(WORK_SET.directory);
    await expect(registry.updateSet('work', { glyph: null })).resolves.toMatchObject({
      set: { id: 'work', label: 'Acme' },
    });
    expect((await registry.getSet('work'))?.set.glyph).toBeUndefined();
    await expect(registry.updateSet('work', { label: ' ' })).rejects.toThrow('schema validation');
    await expect(registry.updateSet('native', { label: 'Mine' })).resolves.toBeUndefined();
  });

  it('records one default and forgets it with its set', async () => {
    const { state, store } = memoryStore();
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    await registry.addSet(WORK_SET);
    await registry.add({ ...managedProfile('alpha', 'a1'), set: 'work' });
    await expect(registry.defaultSetId()).resolves.toBe('native');

    await expect(registry.setDefault('work')).resolves.toBe(true);
    await expect(registry.setDefault('ghost')).resolves.toBe(false);
    expect(state.snapshot?.defaultSet).toBe('work');
    expect((await registry.sets()).map((info) => info.isDefault)).toEqual([false, true]);

    const removed = await registry.removeSet('work');
    expect(removed?.set.id).toBe('work');
    expect(removed?.profiles.map((profile) => profile.id)).toEqual(['a1']);
    expect(state.snapshot).toEqual({ version: 2, sets: [], profiles: [] });
    await expect(registry.defaultSetId()).resolves.toBe('native');
    await expect(registry.removeSet('work')).resolves.toBeUndefined();

    await registry.addSet(WORK_SET);
    await registry.setDefault('work');
    await expect(registry.setDefault('native')).resolves.toBe(true);
    expect(state.snapshot?.defaultSet).toBeUndefined();
    await expect(registry.addSet({ ...WORK_SET })).rejects.toThrow('already registered');
    await expect(registry.addSet({ ...WORK_SET, id: 'native' })).rejects.toThrow('already registered');
    await expect(registry.addSet({ ...WORK_SET, id: 'other', kind: 'native' })).rejects.toThrow('schema validation');
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

  it('hands out copies of an identity, its sign-ins included, never the one it keeps', async () => {
    const { state, store } = memoryStore([managedProfile('alpha', 'p1')]);
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    const identity = {
      loggedIn: true,
      method: 'oauth',
      signIns: [{ service: { id: 'example', label: 'Example' }, method: 'oauth', inUse: true }],
      verifiedAt: '2026-09-23T12:00:00.000Z',
      source: { kind: 'native-protocol' as const, stability: 'experimental' as const },
    };
    const copy = structuredClone(identity);

    for (const profileId of ['p1', nativeDefaultProfileId('alpha')]) {
      const recorded = await registry.recordIdentity(profileId, identity);
      const read = await registry.get(profileId);
      for (const handed of [recorded, read]) {
        handed!.identity!.signIns!.push({ service: { id: 'injected', label: 'Injected' }, method: 'oauth' });
        handed!.identity!.signIns![0]!.service.label = 'Changed';
        handed!.identity!.source.stability = 'documented';
      }
      await expect(registry.get(profileId)).resolves.toMatchObject({ identity: copy });
      expect((await registry.get(profileId))?.identity?.signIns).toHaveLength(1);
    }
    expect(state.snapshot?.profiles[0]?.identity).toEqual(copy);
  });

  it('keeps registered profiles whose provider no longer exposes profiles', async () => {
    const { store } = memoryStore([managedProfile('alpha', 'p1'), managedProfile('retired', 'p2', 'Other')]);
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });

    await expect(registry.list()).resolves.toMatchObject([
      { id: nativeDefaultProfileId('alpha') },
      { id: 'p1' },
      { id: 'p2' },
    ]);
    await expect(registry.remove('p2')).resolves.toBe(true);
  });

  it('writes one change at a time, so the file ends where memory does however the saves are timed', async () => {
    const saved: ProfileRegistrySnapshot[] = [];
    // A slow disk: the first save lands long after the rest were asked for.
    let delay = 40;
    const registry = createProfileRegistry({
      providers: [registryProvider(descriptor('alpha'))],
      store: {
        async load() {
          return undefined;
        },
        async save(snapshot) {
          const wait = delay;
          delay = Math.max(0, delay - 10);
          await new Promise((resolve) => setTimeout(resolve, wait));
          saved.push(snapshot);
        },
      },
    });
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) =>
        registry.addSet({ ...WORK_SET, id, label: id.toUpperCase(), directory: `/profiles/${id}` }),
      ),
    );
    const memory = (await registry.sets()).map((info) => info.set.id);
    expect(memory).toEqual(['native', 'a', 'b', 'c', 'd', 'e']);
    // every save carried everything before it, and the last one is the whole
    expect(saved.map((snapshot) => snapshot.sets.length)).toEqual([1, 2, 3, 4, 5]);
    expect(saved.at(-1)?.sets.map((set) => set.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('changes nothing when a write fails, so a retry finds the state it started from', async () => {
    const { store, state } = memoryStore([managedProfile('alpha', 'p1')]);
    let failNext = false;
    const registry = createProfileRegistry({
      providers: [registryProvider(descriptor('alpha'))],
      store: {
        load: store.load,
        async save(snapshot) {
          if (failNext) {
            failNext = false;
            throw new Error('disk full');
          }
          await store.save(snapshot);
        },
      },
    });
    const setId = (await registry.get('p1'))!.set!;
    failNext = true;
    await expect(registry.removeSet(setId)).rejects.toThrow('disk full');
    // the set is still there, in memory and on disk
    expect((await registry.sets()).map((info) => info.set.id)).toContain(setId);
    expect(state.snapshot?.sets.map((set) => set.id)).toContain(setId);

    // a retire that failed is not half-done: the retry writes it
    failNext = true;
    await expect(registry.retire('p1', '2026-09-23T10:00:00.000Z')).rejects.toThrow('disk full');
    expect((await registry.get('p1'))?.retiredAt).toBeUndefined();
    await expect(registry.retire('p1', '2026-09-23T10:00:00.000Z')).resolves.toMatchObject({
      retiredAt: '2026-09-23T10:00:00.000Z',
    });
    expect(state.snapshot?.profiles[0]?.retiredAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('stops announcing after dispose', async () => {
    const { store } = memoryStore();
    const registry = createProfileRegistry({ providers: [registryProvider(descriptor('alpha'))], store });
    const changes = vi.fn();
    registry.onChange(changes);
    registry.dispose();

    await registry.addSet(WORK_SET);
    await registry.add({ ...managedProfile('alpha', 'p1'), set: 'work' });
    expect(changes).not.toHaveBeenCalled();
    expect(registry.onChange(changes)()).toBeUndefined();
  });
});

describe('profile set slugs', () => {
  it('folds a name to a directory-safe id and never lands on a reserved one', () => {
    expect(profileSetSlug('Work')).toBe('work');
    expect(profileSetSlug('  Client Demo!  ')).toBe('client-demo');
    expect(profileSetSlug('Café Déjà-vu')).toBe('cafe-deja-vu');
    expect(profileSetSlug('../../etc')).toBe('etc');
    expect(profileSetSlug('🚀')).toBe('profile');
    expect(profileSetSlug('a'.repeat(80))).toHaveLength(40);
    expect(uniqueProfileSetId('work', new Set(['work', 'work-2']))).toBe('work-3');
    expect(uniqueProfileSetId('native', new Set())).toBe('native-2');
    // An agent reads a folder named `profiles` as its own profiles directory.
    expect(uniqueProfileSetId(profileSetSlug(' Profiles '), new Set())).toBe('profiles-2');
    expect(uniqueProfileSetId('profiles', new Set(['profiles-2']))).toBe('profiles-3');
    // Only the whole name is reserved.
    expect(uniqueProfileSetId('profile', new Set())).toBe('profile');
    expect(uniqueProfileSetId('work-profiles', new Set())).toBe('work-profiles');
  });
});

describe('createProfileRootAllocator', () => {
  it('makes a set directory from its name, skipping ids and folders already there', async () => {
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-roots-')), 'profiles');
    const allocator = createProfileRootAllocator({ rootsDirectory });

    await expect(allocator.allocateSet('Work', new Set())).resolves.toEqual({
      id: 'work',
      directory: join(rootsDirectory, 'work'),
    });
    expect((await stat(join(rootsDirectory, 'work'))).mode & 0o777).toBe(0o700);
    // Registered elsewhere, or a folder nobody registered: neither is reused.
    await mkdir(join(rootsDirectory, 'work-3'));
    await expect(allocator.allocateSet('Work', new Set(['work-2']))).resolves.toMatchObject({ id: 'work-4' });
    await expect(allocator.allocateSet('Profiles', new Set())).resolves.toEqual({
      id: 'profiles-2',
      directory: join(rootsDirectory, 'profiles-2'),
    });
  });

  it('allocates each account a fresh 0700 root inside its set directory', async () => {
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-roots-')), 'profiles');
    const ids = ['aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-2222-4222-8222-222222222222', 'bbbbbbbb-3333'];
    const allocator = createProfileRootAllocator({ rootsDirectory, newId: () => ids.shift()! });
    const { directory } = await allocator.allocateSet('Work', new Set());

    const first = await allocator.allocateAccount(directory, 'alpha');
    expect(first).toEqual({ id: 'aaaaaaaa-1111-4111-8111-111111111111', dataRoot: join(directory, 'alpha-aaaaaaaa') });
    expect((await stat(first.dataRoot)).mode & 0o777).toBe(0o700);
    // The same short name is taken, so the next id is tried: a root is never shared.
    const second = await allocator.allocateAccount(directory, 'alpha');
    expect(second).toEqual({ id: 'bbbbbbbb-3333', dataRoot: join(directory, 'alpha-bbbbbbbb') });
    expect(await readdir(directory)).toEqual(['alpha-aaaaaaaa', 'alpha-bbbbbbbb']);
  });
});
