import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentHost,
  AgentProfile,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  ProfileSupport,
  TerminalSpec,
} from '@vibefield/puppeteer-core';
import type { ProfileRegistrySnapshot, ProfileSetInfo } from '../types.js';
import { createProfileOnboarding } from './onboarding.js';
import {
  createProfileRegistry,
  nativeDefaultProfileId,
  parseProfileRegistrySnapshot,
  type ProfileRegistryProvider,
} from './registry.js';
import { createProfileRootAllocator } from './roots.js';

const identity: ProfileIdentity = {
  loggedIn: true,
  email: 'user@example.com',
  plan: 'max',
  verifiedAt: '2026-09-06T12:00:00.000Z',
  source: { kind: 'native-status', stability: 'documented' },
};

interface FakeProvider extends ProfileRegistryProvider {
  spawnedSpecs: TerminalSpec[];
  initialized: AgentProfile[];
  /** The options every loginInvocation call received, as received. */
  logins: Array<{ cwd: string; route?: string }>;
}

function fakeProvider(
  id: string,
  options: {
    variable?: string;
    supported?: boolean;
    verify?: ProfileService['verify'];
    initializeRoot?: ProfileService['initializeRoot'];
    signOut?: ProfileService['signOut'];
    credential?: 'root' | 'external';
    signInRoutes?: ProfileSupport['signInRoutes'];
  } = {},
): FakeProvider {
  const variable = options.variable ?? `${id.toUpperCase()}_HOME`;
  const provider: ProfileProvider = {
    id,
    label: id,
    support: {
      supported: options.supported ?? true,
      identity: 'native-status',
      sharedSurfaces: [],
      nativeDefaultRoot: `/home/user/.${id}`,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
      ...(options.signInRoutes === undefined ? {} : { signInRoutes: options.signInRoutes }),
    },
  };
  const initialized: AgentProfile[] = [];
  const logins: FakeProvider['logins'] = [];
  const service: ProfileService = {
    provider,
    bindingEnvironment: (profile) => (profile.kind === 'native-default' ? {} : { [variable]: profile.dataRoot }),
    observationRoot: (profile) => profile.dataRoot,
    loginInvocation: (_profile, invocation) => {
      logins.push(invocation);
      return {
        command: id,
        args: invocation.route === undefined ? ['login'] : ['login', invocation.route],
        cwd: invocation.cwd,
        env: { NO_COLOR: '1' },
      };
    },
    verify: options.verify ?? (async () => identity),
    ...(options.signOut === undefined ? {} : { signOut: options.signOut }),
    ...(options.initializeRoot === undefined
      ? {
          async initializeRoot(profile) {
            initialized.push(profile);
          },
        }
      : { initializeRoot: options.initializeRoot }),
  };
  return { provider, service, spawnedSpecs: [], initialized, logins };
}

function harness(entries: FakeProvider[], overrides: { host?: AgentHost } = {}) {
  const providers = new Map(entries.map((entry) => [entry.provider.id, entry as ProfileRegistryProvider]));
  const stored: { snapshot?: ProfileRegistrySnapshot } = {};
  const registry = createProfileRegistry({
    providers: entries,
    store: {
      async load() {
        return stored.snapshot;
      },
      async save(snapshot) {
        stored.snapshot = snapshot;
      },
    },
  });
  const spawned: TerminalSpec[] = [];
  const host: AgentHost = overrides.host ?? {
    async spawnTerminal(spec) {
      spawned.push(spec);
      return { runtimeSessionId: `terminal-${spawned.length}` };
    },
    async automateTerminal() {
      return { accepted: true };
    },
  };
  return { providers, registry, stored, spawned, host };
}

async function onboarding(entries: FakeProvider[], overrides: { host?: AgentHost } = {}) {
  const box = harness(entries, overrides);
  const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles');
  return {
    ...box,
    rootsDirectory,
    onboarding: createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({ rootsDirectory }),
      host: box.host,
      defaultCwd: '/workspace',
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    }),
  };
}

describe('createProfileOnboarding', () => {
  it('allocates a root, lets the adapter prepare it, and registers the profile', async () => {
    const alpha = fakeProvider('alpha');
    const box = await onboarding([alpha]);

    const created = await box.onboarding.createProfile({ providerId: 'alpha', label: '  Work  ' });
    expect(created).toMatchObject({ provider: 'alpha', label: 'Work', kind: 'managed', set: 'work' });
    const profile = created as AgentProfile;
    // The account's root is inside the set's folder, named for the provider.
    expect(profile.dataRoot).toBe(join(box.rootsDirectory, 'work', `alpha-${profile.id.slice(0, 8)}`));
    expect((await stat(profile.dataRoot)).mode & 0o777).toBe(0o700);
    expect(alpha.initialized).toEqual([profile]);
    expect(box.stored.snapshot?.profiles).toEqual([profile]);
    expect(box.stored.snapshot?.sets).toMatchObject([
      { id: 'work', kind: 'managed', label: 'Work', directory: join(box.rootsDirectory, 'work') },
    ]);
  });

  it('makes a set with its folder, adds one account per agent, and joins by name for older hosts', async () => {
    const box = await onboarding([fakeProvider('alpha'), fakeProvider('beta')]);

    const work = await box.onboarding.createProfileSet({ label: 'Client demo', glyph: 'flask' });
    if ('status' in work) throw new Error(work.message);
    expect(work).toMatchObject({
      set: { id: 'client-demo', kind: 'managed', label: 'Client demo', glyph: 'flask' },
      isDefault: false,
      profiles: [],
    });
    expect((await stat(join(box.rootsDirectory, 'client-demo'))).mode & 0o777).toBe(0o700);

    const alpha = (await box.onboarding.createProfile({ providerId: 'alpha', set: 'client-demo' })) as AgentProfile;
    expect(alpha).toMatchObject({ set: 'client-demo', label: 'Client demo' });
    await expect(box.onboarding.createProfile({ providerId: 'alpha', set: 'client-demo' })).resolves.toMatchObject({
      status: 'invalid',
      message: 'Client demo already has a alpha account',
    });
    await expect(box.onboarding.createProfile({ providerId: 'alpha', set: 'ghost' })).resolves.toMatchObject({
      status: 'not-found',
    });
    await expect(box.onboarding.createProfile({ providerId: 'alpha', set: 'native' })).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(
      box.onboarding.createProfile({ providerId: 'alpha', set: 'client-demo', label: 'x' }),
    ).resolves.toMatchObject({ status: 'invalid' });

    // A per-provider host naming "client demo" for beta means the same place.
    const beta = (await box.onboarding.createProfile({ providerId: 'beta', label: 'client demo' })) as AgentProfile;
    expect(beta.set).toBe('client-demo');
    // A second alpha under that name cannot share it, so it gets a set of its own.
    const again = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Client demo' })) as AgentProfile;
    expect(again.set).toBe('client-demo-2');

    await expect(box.onboarding.createProfileSet({ label: ' ' })).resolves.toMatchObject({ status: 'invalid' });
    await expect(box.onboarding.createProfileSet({ label: 'X', glyph: 'Not A Glyph' })).resolves.toMatchObject({
      status: 'invalid',
    });
  });

  it('renames, re-marks, and moves the default; never touches the native set', async () => {
    const box = await onboarding([fakeProvider('alpha')]);
    const work = (await box.onboarding.createProfileSet({ label: 'Work' })) as { set: { id: string } };
    await box.onboarding.createProfile({ providerId: 'alpha', set: work.set.id });

    await expect(
      box.onboarding.updateProfileSet({ setId: 'work', label: 'Acme', glyph: 'bolt' }),
    ).resolves.toMatchObject({
      set: { label: 'Acme', glyph: 'bolt', directory: join(box.rootsDirectory, 'work') },
      profiles: [{ label: 'Acme' }],
    });
    await expect(box.onboarding.updateProfileSet({ setId: 'work', label: 'x'.repeat(65) })).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(box.onboarding.updateProfileSet({ setId: 'native', label: 'Mine' })).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(box.onboarding.updateProfileSet({ setId: 'ghost', label: 'Mine' })).resolves.toMatchObject({
      status: 'not-found',
    });

    await expect(box.onboarding.setDefaultProfileSet('work')).resolves.toMatchObject({ isDefault: true });
    await expect(box.onboarding.setDefaultProfileSet('ghost')).resolves.toMatchObject({ status: 'not-found' });
    // The default cannot be removed; neither can the native set.
    await expect(box.onboarding.removeProfileSet('work')).resolves.toMatchObject({
      status: 'invalid',
      message: 'Acme is the default for new sessions; make another set the default first',
    });
    await expect(box.onboarding.removeProfileSet('native')).resolves.toMatchObject({ status: 'invalid' });
    await box.onboarding.setDefaultProfileSet('native');
    const removed = await box.onboarding.removeProfileSet('work');
    expect(removed).toMatchObject({ set: { id: 'work' }, profiles: [{ provider: 'alpha' }] });
    expect(box.stored.snapshot).toMatchObject({ sets: [], profiles: [] });
    // The folder is left for the host to delete.
    await expect(stat(join(box.rootsDirectory, 'work'))).resolves.toBeDefined();
  });

  it('resolves which account a spawn runs under, falling back only when the set was not named', async () => {
    const box = await onboarding([fakeProvider('alpha'), fakeProvider('beta')]);
    await box.onboarding.createProfileSet({ label: 'Work' });
    const alpha = (await box.onboarding.createProfile({ providerId: 'alpha', set: 'work' })) as AgentProfile;

    await expect(box.onboarding.resolveSpawnProfile('alpha', {})).resolves.toEqual({ setId: 'native' });
    await box.onboarding.setDefaultProfileSet('work');
    await expect(box.onboarding.resolveSpawnProfile('alpha', {})).resolves.toEqual({
      profileId: alpha.id,
      setId: 'work',
    });
    // The default set has no beta: beta stays on its own root.
    await expect(box.onboarding.resolveSpawnProfile('beta', {})).resolves.toEqual({ setId: 'native' });
    // Naming the set is a demand, not a preference.
    await expect(box.onboarding.resolveSpawnProfile('beta', { profileSet: 'work' })).resolves.toEqual({
      error: 'Work has no beta account',
    });
    await expect(box.onboarding.resolveSpawnProfile('alpha', { profileSet: 'ghost' })).resolves.toEqual({
      error: 'unknown profile set: ghost',
    });
    await expect(box.onboarding.resolveSpawnProfile('alpha', { profileSet: 'native' })).resolves.toEqual({
      setId: 'native',
    });
    await expect(
      box.onboarding.resolveSpawnProfile('alpha', { profile: nativeDefaultProfileId('alpha') }),
    ).resolves.toEqual({
      profileId: nativeDefaultProfileId('alpha'),
      setId: 'native',
    });
    // A retired account is out of its set: the default falls back past it.
    await box.onboarding.retireProfile(alpha.id);
    await expect(box.onboarding.resolveSpawnProfile('alpha', {})).resolves.toEqual({ setId: 'native' });
  });

  it('retires managed accounts only, and signs out through the adapter where it keeps a credential outside the root', async () => {
    const signedOut: AgentProfile[] = [];
    const alpha = fakeProvider('alpha', {
      async signOut(profile) {
        signedOut.push(profile);
        return undefined;
      },
    });
    const beta = fakeProvider('beta', { credential: 'root' });
    const gamma = fakeProvider('gamma');
    const box = await onboarding([alpha, beta, gamma]);
    const a = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;
    const b = (await box.onboarding.createProfile({ providerId: 'beta', label: 'Work' })) as AgentProfile;
    const c = (await box.onboarding.createProfile({ providerId: 'gamma', label: 'Work' })) as AgentProfile;

    // An account still in its set is not signed out: new work could land in it.
    await expect(box.onboarding.signOutProfile(a.id)).resolves.toMatchObject({ status: 'invalid' });
    expect(signedOut).toEqual([]);

    await expect(box.onboarding.retireProfile(a.id)).resolves.toMatchObject({
      id: a.id,
      retiredAt: expect.any(String),
    });
    await expect(box.onboarding.retireProfile(nativeDefaultProfileId('alpha'))).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(box.onboarding.retireProfile('ghost')).resolves.toMatchObject({ status: 'not-found' });
    // A signed-out account starts no login.
    await expect(box.onboarding.startLogin({ profileId: a.id })).resolves.toMatchObject({ status: 'invalid' });

    await expect(box.onboarding.signOutProfile(a.id)).resolves.toEqual({ ran: true });
    expect(signedOut.map((profile) => profile.id)).toEqual([a.id]);
    // beta keeps its credential in the root: deleting the root is its sign-out.
    await box.onboarding.retireProfile(b.id);
    await expect(box.onboarding.signOutProfile(b.id)).resolves.toEqual({ ran: false, credential: 'root' });
    // gamma never said where it keeps one: the root can go, and nothing more is claimed.
    await box.onboarding.retireProfile(c.id);
    await expect(box.onboarding.signOutProfile(c.id)).resolves.toEqual({ ran: false, credential: 'unknown' });
    await expect(box.onboarding.signOutProfile(nativeDefaultProfileId('beta'))).resolves.toMatchObject({
      status: 'unsupported',
    });
    await expect(box.onboarding.signOutProfile(nativeDefaultProfileId('alpha'))).resolves.toEqual({ ran: true });
    await expect(box.onboarding.signOutProfile('ghost')).resolves.toMatchObject({ status: 'not-found' });
  });

  it('contains an adapter sign-out that throws or answers nonsense', async () => {
    const onError = vi.fn();
    const box = harness([
      fakeProvider('alpha', {
        async signOut() {
          throw new Error('keychain locked, token sk-secret');
        },
      }),
      fakeProvider('beta', {
        async signOut() {
          return { status: 'weird' } as never;
        },
      }),
    ]);
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({
        rootsDirectory: join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles'),
      }),
      host: box.host,
      defaultCwd: '/workspace',
      onError,
    });
    const failure = await flow.signOutProfile(nativeDefaultProfileId('alpha'));
    expect(failure).toMatchObject({ status: 'unavailable', provider: 'alpha', retryable: true });
    expect(JSON.stringify(failure)).not.toContain('sk-secret');
    await expect(flow.signOutProfile(nativeDefaultProfileId('beta'))).resolves.toMatchObject({
      status: 'unavailable',
      message: 'native sign-out returned an unreadable result',
    });
    expect(onError).toHaveBeenCalled();
  });

  it('rejects bad labels and providers that do not support profiles', async () => {
    const box = await onboarding([fakeProvider('alpha'), fakeProvider('beta', { supported: false })]);

    await expect(box.onboarding.createProfile({ providerId: 'alpha', label: '   ' })).resolves.toMatchObject({
      status: 'invalid',
      retryable: false,
    });
    await expect(box.onboarding.createProfile({ providerId: 'alpha', label: 'x'.repeat(65) })).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(box.onboarding.createProfile({ providerId: 'beta', label: 'Work' })).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'beta',
    });
    await expect(box.onboarding.createProfile({ providerId: 'ghost', label: 'Work' })).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'ghost',
    });
    expect(box.stored.snapshot?.profiles ?? []).toEqual([]);
  });

  it('does not register a profile whose root the adapter could not prepare', async () => {
    const onError = vi.fn();
    const failing = fakeProvider('alpha', {
      async initializeRoot() {
        throw new Error('config write failed');
      },
    });
    const box = harness([failing]);
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles');
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({ rootsDirectory }),
      host: box.host,
      defaultCwd: '/workspace',
      onError,
    });

    await expect(flow.createProfile({ providerId: 'alpha', label: 'Work' })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: true,
    });
    expect(box.stored.snapshot?.profiles ?? []).toEqual([]);
    expect(onError).toHaveBeenCalled();
    // The allocated directory is left behind rather than deleted blindly.
    await expect(readdir(join(rootsDirectory, 'work'))).resolves.toHaveLength(1);
  });

  it('merges binding variables and refuses two profiles of one provider', async () => {
    const alpha = fakeProvider('alpha', { variable: 'ALPHA_HOME' });
    const beta = fakeProvider('beta', { variable: 'BETA_HOME' });
    const box = await onboarding([alpha, beta]);
    const first = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;
    const second = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Personal' })) as AgentProfile;
    const other = (await box.onboarding.createProfile({ providerId: 'beta', label: 'Work' })) as AgentProfile;

    await expect(box.onboarding.bindingEnvironment([first.id, other.id])).resolves.toEqual({
      ALPHA_HOME: first.dataRoot,
      BETA_HOME: other.dataRoot,
    });
    // The native default injects nothing: it is the vendor's own root.
    await expect(box.onboarding.bindingEnvironment([nativeDefaultProfileId('beta')])).resolves.toEqual({});
    await expect(box.onboarding.bindingEnvironment([])).resolves.toEqual({});
    await expect(box.onboarding.bindingEnvironment([first.id, second.id])).rejects.toThrow('more than once');
    await expect(box.onboarding.bindingEnvironment(['ghost'])).rejects.toThrow('unknown agent profile');
    // A signed-out account binds nothing; the others still bind.
    await box.onboarding.retireProfile(first.id);
    await expect(box.onboarding.bindingEnvironment([first.id, other.id])).resolves.toEqual({
      BETA_HOME: other.dataRoot,
    });
  });

  it('decides one change at a time: two creates never both pass the check, two names never make two sets', async () => {
    const box = await onboarding([fakeProvider('alpha'), fakeProvider('beta')]);
    const work = (await box.onboarding.createProfileSet({ label: 'Work' })) as ProfileSetInfo;
    const [one, two] = await Promise.all([
      box.onboarding.createProfile({ providerId: 'alpha', set: work.set.id }),
      box.onboarding.createProfile({ providerId: 'alpha', set: work.set.id }),
    ]);
    const outcomes = [one, two].map((result) => ('status' in result ? result.status : 'created')).sort();
    expect(outcomes).toEqual(['created', 'invalid']);
    // the refused one allocated nothing: one root in the folder
    await expect(readdir(work.set.directory!)).resolves.toHaveLength(1);

    const [a, b] = (await Promise.all([
      box.onboarding.createProfile({ providerId: 'alpha', label: 'Client' }),
      box.onboarding.createProfile({ providerId: 'beta', label: 'Client' }),
    ])) as AgentProfile[];
    expect(a!.set).toBe(b!.set);
    expect((await box.registry.sets()).filter((info) => info.set.label === 'Client')).toHaveLength(1);
  });

  it('gives a set adopted from a version 1 registry its folder under its own id, never beside one a set owns', async () => {
    const alpha = fakeProvider('alpha');
    const beta = fakeProvider('beta');
    const box = harness([alpha, beta]);
    // what a pre-set host wrote: one Work account at the old layout
    box.stored.snapshot = parseProfileRegistrySnapshot({
      version: 1,
      profiles: [
        {
          id: 'old-work',
          provider: 'alpha',
          label: 'Work',
          kind: 'managed',
          dataRoot: '/home/user/.puppeteer/profiles/alpha/old-work',
          createdAt: '2026-09-06T12:00:00.000Z',
        },
      ],
    });
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles');
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({ rootsDirectory }),
      host: box.host,
      defaultCwd: '/workspace',
    });
    const added = (await flow.createProfile({ providerId: 'beta', set: 'work' })) as AgentProfile;
    expect(added.dataRoot.startsWith(join(rootsDirectory, 'work') + '/')).toBe(true);
    expect((await box.registry.getSet('work'))?.set.directory).toBe(join(rootsDirectory, 'work'));
    // a new "Work" never lands in that folder, even once it is gone from disk
    await rm(join(rootsDirectory, 'work'), { recursive: true, force: true });
    const other = (await flow.createProfileSet({ label: 'Work' })) as ProfileSetInfo;
    expect(other.set.directory).not.toBe(join(rootsDirectory, 'work'));
  });

  it('never names a set folder profiles, which an agent would read as its own profiles directory', async () => {
    const box = await onboarding([fakeProvider('alpha'), fakeProvider('beta')]);
    const made = (await box.onboarding.createProfileSet({ label: 'Profiles' })) as ProfileSetInfo;
    expect(made.set).toMatchObject({
      id: 'profiles-2',
      label: 'Profiles',
      directory: join(box.rootsDirectory, 'profiles-2'),
    });
    // A host that names per-agent accounts joins it by name, as before.
    const alpha = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'profiles' })) as AgentProfile;
    expect(dirname(alpha.dataRoot)).toBe(join(box.rootsDirectory, 'profiles-2'));
    // A second account of one agent under that name gets a set of its own, still not the reserved one.
    const again = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Profiles' })) as AgentProfile;
    expect(again.set).toBe('profiles-3');
    // Renaming a set to the name moves nothing.
    const work = (await box.onboarding.createProfileSet({ label: 'Work' })) as ProfileSetInfo;
    await expect(box.onboarding.updateProfileSet({ setId: work.set.id, label: 'Profiles' })).resolves.toMatchObject({
      set: { id: 'work', label: 'Profiles', directory: join(box.rootsDirectory, 'work') },
    });
    expect((await readdir(box.rootsDirectory)).sort()).toEqual(['profiles-2', 'profiles-3', 'work']);
  });

  it('reads a registry that already holds a profiles set, and gives it a folder by another name', async () => {
    const box = harness([fakeProvider('alpha'), fakeProvider('beta')]);
    // What an earlier build wrote once it had adopted a version 1 account
    // named "Profiles": a set under that id, still without a folder.
    box.stored.snapshot = parseProfileRegistrySnapshot({
      version: 2,
      sets: [{ id: 'profiles', kind: 'managed', label: 'Profiles', createdAt: '2026-09-06T12:00:00.000Z' }],
      profiles: [
        {
          id: 'old-profiles',
          provider: 'alpha',
          label: 'Profiles',
          kind: 'managed',
          dataRoot: '/home/user/.puppeteer/profiles/alpha/old-profiles',
          createdAt: '2026-09-06T12:00:00.000Z',
          set: 'profiles',
        },
      ],
    });
    const rootsDirectory = join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles');
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({ rootsDirectory }),
      host: box.host,
      defaultCwd: '/workspace',
    });

    await expect(box.registry.getSet('profiles')).resolves.toMatchObject({
      set: { id: 'profiles', label: 'Profiles' },
      profiles: [{ id: 'old-profiles', dataRoot: '/home/user/.puppeteer/profiles/alpha/old-profiles' }],
    });
    const added = (await flow.createProfile({ providerId: 'beta', set: 'profiles' })) as AgentProfile;
    expect(added.set).toBe('profiles');
    expect(dirname(added.dataRoot)).toBe(join(rootsDirectory, 'profiles-2'));
    expect((await box.registry.getSet('profiles'))?.set.directory).toBe(join(rootsDirectory, 'profiles-2'));
  });

  it('spawns the native login with the binding merged over the adapter environment', async () => {
    const alpha = fakeProvider('alpha', { variable: 'ALPHA_HOME' });
    const box = await onboarding([alpha]);
    const profile = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;

    await expect(box.onboarding.startLogin({ profileId: profile.id })).resolves.toEqual({
      runtimeSessionId: 'terminal-1',
      profile,
    });
    expect(box.spawned[0]).toEqual({
      command: 'alpha',
      args: ['login'],
      cwd: '/workspace',
      env: { NO_COLOR: '1', ALPHA_HOME: profile.dataRoot },
    });

    await box.onboarding.startLogin({ profileId: nativeDefaultProfileId('alpha'), cwd: '/elsewhere' });
    expect(box.spawned[1]).toMatchObject({ cwd: '/elsewhere', env: { NO_COLOR: '1' } });
    await expect(box.onboarding.startLogin({ profileId: 'ghost' })).resolves.toMatchObject({ status: 'not-found' });
  });

  it('hands the adapter a sign-in route it declared, and refuses any other before a terminal opens', async () => {
    const harnessProvider = fakeProvider('alpha', {
      variable: 'ALPHA_HOME',
      signInRoutes: [
        { id: 'portal', label: 'Example Portal', service: { id: 'example', label: 'Example' } },
        { id: 'another', label: 'Another provider…' },
      ],
    });
    const single = fakeProvider('beta');
    const box = await onboarding([harnessProvider, single]);
    const profile = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;

    await expect(box.onboarding.startLogin({ profileId: profile.id, route: 'portal' })).resolves.toEqual({
      runtimeSessionId: 'terminal-1',
      profile,
    });
    expect(harnessProvider.logins).toEqual([{ cwd: '/workspace', route: 'portal' }]);
    expect(box.spawned[0]).toEqual({
      command: 'alpha',
      args: ['login', 'portal'],
      cwd: '/workspace',
      env: { NO_COLOR: '1', ALPHA_HOME: profile.dataRoot },
    });

    // An id the adapter never declared is a host bug: refused as invalid,
    // with no terminal and without asking the adapter for a command.
    for (const route of ['elsewhere', 'Portal', '']) {
      await expect(box.onboarding.startLogin({ profileId: profile.id, route })).resolves.toEqual({
        status: 'invalid',
        provider: 'alpha',
        message: `unknown sign-in route for alpha: ${route}`,
        retryable: false,
      });
    }
    // An agent with one login declares no routes, so every route is unknown to it.
    await expect(
      box.onboarding.startLogin({ profileId: nativeDefaultProfileId('beta'), route: 'portal' }),
    ).resolves.toMatchObject({ status: 'invalid', provider: 'beta' });
    expect(box.spawned).toHaveLength(1);
    expect(harnessProvider.logins).toHaveLength(1);
    expect(single.logins).toEqual([]);

    // No route is the default login, asked for without a route key at all.
    await box.onboarding.startLogin({ profileId: profile.id });
    await box.onboarding.startLogin({ profileId: nativeDefaultProfileId('beta'), cwd: '/elsewhere' });
    expect(harnessProvider.logins[1]).toStrictEqual({ cwd: '/workspace' });
    expect(single.logins).toStrictEqual([{ cwd: '/elsewhere' }]);
    expect(box.spawned.map((spec) => spec.args)).toEqual([['login', 'portal'], ['login'], ['login']]);
  });

  it('reports a login the host could not start as retryable', async () => {
    const onError = vi.fn();
    const alpha = fakeProvider('alpha');
    const box = harness([alpha], {
      host: {
        async spawnTerminal() {
          throw new Error('no pty available');
        },
        async automateTerminal() {
          return { accepted: true };
        },
      },
    });
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({
        rootsDirectory: join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles'),
      }),
      host: box.host,
      defaultCwd: '/workspace',
      onError,
    });

    await expect(flow.startLogin({ profileId: nativeDefaultProfileId('alpha') })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: true,
    });
    expect(onError).toHaveBeenCalled();
  });

  it('persists the identity a verification read back and passes adapter failures through', async () => {
    const alpha = fakeProvider('alpha');
    const box = await onboarding([alpha]);
    const profile = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;

    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toEqual(identity);
    expect(box.stored.snapshot?.profiles[0]?.identity).toEqual(identity);
    await expect(box.onboarding.verifyProfile('ghost')).resolves.toMatchObject({ status: 'not-found' });

    const silent = fakeProvider('beta', {
      async verify() {
        return { status: 'unsupported', provider: 'beta', message: 'no native identity surface', retryable: false };
      },
    });
    const other = await onboarding([silent]);
    await expect(other.onboarding.verifyProfile(nativeDefaultProfileId('beta'))).resolves.toEqual({
      status: 'unsupported',
      provider: 'beta',
      message: 'no native identity surface',
      retryable: false,
    });
  });

  it('answers at the top level with the in-use sign-in, whatever the adapter put there', async () => {
    const portal = {
      service: { id: 'example', label: 'Example' },
      method: 'oauth',
      subscription: true,
      inUse: true,
      account: 'person',
      email: 'person@example.com',
      plan: 'Pro',
    };
    const key = { service: { id: 'other-cloud', label: 'Other Cloud' }, method: 'api-key' };
    const read = { verifiedAt: '2026-09-23T12:00:00.000Z', source: identity.source };
    let answer: ProfileIdentity = {
      loggedIn: true,
      // stale or guessed top-level fields the list contradicts
      method: 'subscription',
      organization: 'Somewhere Else',
      signIns: [key, portal],
      ...read,
    };
    const alpha = fakeProvider('alpha', { verify: async () => answer });
    const box = await onboarding([alpha]);
    const profile = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;

    const inUse: ProfileIdentity = {
      loggedIn: true,
      method: 'oauth',
      account: 'person',
      email: 'person@example.com',
      plan: 'Pro',
      signIns: [key, portal],
      ...read,
    };
    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toStrictEqual(inUse);
    expect(box.stored.snapshot?.profiles[0]?.identity).toStrictEqual(inUse);

    // Signed in with none in use: nothing at the top level speaks for the list.
    answer = { loggedIn: true, email: 'person@example.com', signIns: [key, { ...portal, inUse: false }], ...read };
    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toStrictEqual({
      loggedIn: true,
      signIns: [key, { ...portal, inUse: false }],
      ...read,
    });
    // A borrowed sign-in in use says so at the top level too; a stale claim goes.
    const borrowed = {
      service: { id: 'forge', label: 'Forge' },
      method: 'cli',
      borrowedFrom: 'Forge CLI',
      inUse: true,
    };
    answer = { loggedIn: true, borrowedFrom: 'Stale CLI', signIns: [key, borrowed], ...read };
    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toStrictEqual({
      loggedIn: true,
      method: 'cli',
      borrowedFrom: 'Forge CLI',
      signIns: [key, borrowed],
      ...read,
    });
    answer = { loggedIn: true, borrowedFrom: 'Stale CLI', signIns: [key, portal], ...read };
    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toStrictEqual(inUse);
    // A single-sign-in agent reports no list, and its fields pass through untouched.
    answer = { loggedIn: true, method: 'subscription', email: 'person@example.com', ...read };
    await expect(box.onboarding.verifyProfile(profile.id)).resolves.toStrictEqual(answer);
  });

  it('never lets an adapter fault escape verification', async () => {
    const onError = vi.fn();
    const box = harness([
      fakeProvider('alpha', {
        async verify() {
          throw new Error('keychain read failed for token sk-secret');
        },
      }),
    ]);
    const flow = createProfileOnboarding({
      registry: box.registry,
      providers: box.providers,
      allocator: createProfileRootAllocator({
        rootsDirectory: join(await mkdtemp(join(tmpdir(), 'puppeteer-onboarding-')), 'profiles'),
      }),
      host: box.host,
      defaultCwd: '/workspace',
      onError,
    });

    const failure = await flow.verifyProfile(nativeDefaultProfileId('alpha'));
    expect(failure).toMatchObject({ status: 'unavailable', provider: 'alpha', retryable: true });
    expect(JSON.stringify(failure)).not.toContain('sk-secret');
  });

  it('removes managed profiles only and leaves the root on disk', async () => {
    const alpha = fakeProvider('alpha');
    const box = await onboarding([alpha]);
    const profile = (await box.onboarding.createProfile({ providerId: 'alpha', label: 'Work' })) as AgentProfile;

    await expect(box.onboarding.removeProfile(nativeDefaultProfileId('alpha'))).resolves.toBe(false);
    await expect(box.onboarding.removeProfile('ghost')).resolves.toBe(false);
    await expect(box.onboarding.removeProfile(profile.id)).resolves.toBe(true);
    expect(box.stored.snapshot?.profiles).toEqual([]);
    await expect(stat(profile.dataRoot)).resolves.toBeDefined();
  });
});
