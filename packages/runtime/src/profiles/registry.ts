import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentProfileSchema,
  NATIVE_PROFILE_SET_ID,
  ProfileIdentitySchema,
  ProfileSetSchema,
  type AgentProfile,
  type ProfileIdentity,
  type ProfileProvider,
  type ProfileService,
  type ProfileSet,
} from '@vibefield/puppeteer-core';
import type { ProfileRegistrySnapshot, ProfileSetInfo, ProfileStore } from '../types.js';
import { profileSetSlug, uniqueProfileSetId } from './roots.js';

/**
 * The account-profile registry.
 *
 * Managed profiles are persisted host state, grouped into profile sets — the
 * places a person works in, at most one account per provider each. Every
 * provider that supports profiles also contributes one synthetic
 * `native-default` profile pointing at the vendor's own root; together they
 * are the synthetic native set, so the accounts the user already has appear
 * without being moved, copied, or re-authenticated.
 *
 * Nothing here reads or writes a credential: a profile records a label, a
 * directory, and the last identity the adapter read back from native evidence.
 */

export const NATIVE_DEFAULT_PROFILE_LABEL = 'Default';
/** What the native set is called: the machine the providers' own roots are on. */
export const NATIVE_PROFILE_SET_LABEL = process.platform === 'darwin' ? 'This Mac' : 'This computer';
const NATIVE_DEFAULT_SUFFIX = 'native-default';
/**
 * Synthetic profiles have no creation event. A fixed timestamp keeps them
 * stable across reloads instead of drifting on every process start.
 */
const NATIVE_DEFAULT_CREATED_AT = new Date(0).toISOString();
const STORE_FILE_MODE = 0o600;
const STORE_DIRECTORY_MODE = 0o700;
const MAX_PERSISTED_PROFILES = 512;
const MAX_PERSISTED_SETS = 256;

export function nativeDefaultProfileId(providerId: string): string {
  return `${providerId}:${NATIVE_DEFAULT_SUFFIX}`;
}

export function defaultProfileStorePath(home = homedir()): string {
  return join(home, '.puppeteer', 'profiles.json');
}

function nativeProfileSet(): ProfileSet {
  return {
    id: NATIVE_PROFILE_SET_ID,
    kind: 'native',
    label: NATIVE_PROFILE_SET_LABEL,
    createdAt: NATIVE_DEFAULT_CREATED_AT,
  };
}

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const active = (profile: AgentProfile): boolean => profile.retiredAt === undefined;

/**
 * Bring a parsed document to the registry's invariants, keeping every root:
 * only managed entries are stored; every account names an existing managed
 * set, which is found (same name, no account of that provider yet) or made
 * from its label when it does not; a set holds at most one active account per
 * provider, the later one re-homed the same way; an account's label is its
 * set's name; the default names a known set or is dropped. A version 1
 * document — per-provider profiles and no sets — is adopted by exactly this
 * rule, which groups the accounts one person named alike.
 */
function normalize(sets: readonly ProfileSet[], profiles: readonly AgentProfile[], defaultSet: string | undefined) {
  const keptSets: ProfileSet[] = [];
  const ids = new Set<string>([NATIVE_PROFILE_SET_ID]);
  for (const set of sets) {
    if (set.kind !== 'managed') continue;
    // Two sets under one id is a corrupt document, not a choice between them:
    // dropping either would let the next write forget its folder.
    if (set.id !== NATIVE_PROFILE_SET_ID && ids.has(set.id)) throw new Error(`duplicate profile set id: ${set.id}`);
    if (ids.has(set.id)) continue;
    ids.add(set.id);
    keptSets.push({ ...set });
  }
  const byId = new Map(keptSets.map((set) => [set.id, set]));
  const keptProfiles: AgentProfile[] = [];
  const seenProfiles = new Set<string>();
  const holds = (setId: string, provider: string): boolean =>
    keptProfiles.some((profile) => profile.set === setId && profile.provider === provider && active(profile));

  for (const entry of profiles) {
    if (entry.kind !== 'managed') continue;
    // The same for accounts: each names a root, and a dropped one is a root
    // (and a credential) nothing would ever sign out.
    if (seenProfiles.has(entry.id)) throw new Error(`duplicate agent profile id: ${entry.id}`);
    seenProfiles.add(entry.id);
    let home = entry.set === undefined ? undefined : byId.get(entry.set);
    if (home !== undefined && active(entry) && holds(home.id, entry.provider)) home = undefined;
    if (home === undefined) {
      home = keptSets.find(
        (set) => sameLabel(set.label, entry.label) && (!active(entry) || !holds(set.id, entry.provider)),
      );
    }
    if (home === undefined) {
      const id = uniqueProfileSetId(profileSetSlug(entry.label), ids);
      ids.add(id);
      home = { id, kind: 'managed', label: entry.label.trim(), createdAt: entry.createdAt };
      keptSets.push(home);
      byId.set(id, home);
    }
    keptProfiles.push({ ...entry, set: home.id, label: home.label });
  }
  const keptDefault = defaultSet !== undefined && byId.has(defaultSet) ? defaultSet : undefined;
  return { sets: keptSets, profiles: keptProfiles, defaultSet: keptDefault };
}

/**
 * Validate one persisted document. The envelope is checked structurally and
 * every entry through Core's Zod schemas; a corrupt file is an error rather
 * than an empty registry, because silently forgetting profiles would let the
 * next write erase them. Version 1 (per-provider profiles, no sets) is read
 * and adopted into sets; what comes back is always version 2.
 */
export function parseProfileRegistrySnapshot(value: unknown): ProfileRegistrySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile registry document must be an object');
  }
  const document = value as { version?: unknown; profiles?: unknown; sets?: unknown; defaultSet?: unknown };
  if (document.version !== 1 && document.version !== 2) throw new Error('unsupported profile registry version');
  if (!Array.isArray(document.profiles)) throw new Error('profile registry document has no profiles array');
  const profiles = document.profiles.map((entry, index) => {
    const parsed = AgentProfileSchema.safeParse(entry);
    if (!parsed.success) throw new Error(`profile registry entry ${index} failed schema validation`);
    return parsed.data;
  });
  let sets: ProfileSet[] = [];
  let defaultSet: string | undefined;
  if (document.version === 2) {
    if (!Array.isArray(document.sets)) throw new Error('profile registry document has no sets array');
    sets = document.sets.map((entry, index) => {
      const parsed = ProfileSetSchema.safeParse(entry);
      if (!parsed.success) throw new Error(`profile registry set ${index} failed schema validation`);
      return parsed.data;
    });
    if (document.defaultSet !== undefined) {
      if (typeof document.defaultSet !== 'string') throw new Error('profile registry default set is not a string');
      defaultSet = document.defaultSet;
    }
  }
  const normalized = normalize(sets, profiles, defaultSet);
  return {
    version: 2,
    ...(normalized.defaultSet === undefined ? {} : { defaultSet: normalized.defaultSet }),
    sets: normalized.sets,
    profiles: normalized.profiles,
  };
}

export interface FileProfileStoreOptions {
  /** Defaults to ~/.puppeteer/profiles.json. */
  path?: string;
}

/** Atomic 0600 file store: write a fresh temp file, then rename over the target. */
export function createFileProfileStore(options: FileProfileStoreOptions = {}): ProfileStore {
  const path = options.path ?? defaultProfileStorePath();
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      return parseProfileRegistrySnapshot(JSON.parse(raw));
    },
    async save(snapshot) {
      await mkdir(dirname(path), { recursive: true, mode: STORE_DIRECTORY_MODE });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: STORE_FILE_MODE });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

export interface ProfileRegistryProvider {
  provider: ProfileProvider;
  service: ProfileService;
}

export interface ProfileRegistryOptions {
  providers: readonly ProfileRegistryProvider[];
  store: ProfileStore;
  onError?: (error: Error) => void;
}

export interface ProfileSetPatch {
  label?: string;
  /** A glyph token, or null to clear it. */
  glyph?: string | null;
  /** Record the directory a set was given after it was made (an adopted set's first account). */
  directory?: string;
}

export interface ProfileRegistry {
  /** Managed profiles plus one synthetic native-default profile per supporting provider. */
  list(providerId?: string): Promise<AgentProfile[]>;
  get(profileId: string): Promise<AgentProfile | undefined>;
  /** Registered managed profiles only, retired ones included; native defaults are excluded. */
  managed(providerId?: string): Promise<AgentProfile[]>;
  /** Register a managed profile in the set it names, which must not already hold an active account of its provider. */
  add(profile: AgentProfile): Promise<void>;
  remove(profileId: string): Promise<boolean>;
  /** Take an account out of its set and out of new spawns, keeping it registered until it is removed. */
  retire(profileId: string, at: string): Promise<AgentProfile | undefined>;
  /** Persist the identity a verification read back from native evidence. */
  recordIdentity(profileId: string, identity: ProfileIdentity): Promise<AgentProfile | undefined>;
  /** The native set first, then the managed sets in the order they were made. */
  sets(): Promise<ProfileSetInfo[]>;
  getSet(setId: string): Promise<ProfileSetInfo | undefined>;
  addSet(set: ProfileSet): Promise<void>;
  /** A managed set's name, glyph, or first directory; a new name is its accounts' label too. */
  updateSet(setId: string, patch: ProfileSetPatch): Promise<ProfileSetInfo | undefined>;
  /** Unregister a managed set and every account in it; answers what was removed. */
  removeSet(setId: string): Promise<{ set: ProfileSet; profiles: AgentProfile[] } | undefined>;
  /** The set spawns use when they name none. */
  defaultSetId(): Promise<string>;
  setDefault(setId: string): Promise<boolean>;
  onChange(listener: (profiles: AgentProfile[]) => void): () => void;
  dispose(): void;
}

function cloneIdentity(identity: ProfileIdentity): ProfileIdentity {
  return {
    ...identity,
    source: { ...identity.source },
    ...(identity.signIns === undefined
      ? {}
      : { signIns: identity.signIns.map((signIn) => ({ ...signIn, service: { ...signIn.service } })) }),
  };
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, ...(profile.identity ? { identity: cloneIdentity(profile.identity) } : {}) };
}

interface RegistryState {
  sets: ProfileSet[];
  profiles: AgentProfile[];
  defaultSet: string | undefined;
}

export function createProfileRegistry(options: ProfileRegistryOptions): ProfileRegistry {
  const providers = new Map(options.providers.map((entry) => [entry.provider.id, entry]));
  const listeners = new Set<(profiles: AgentProfile[]) => void>();
  /**
   * Identities verified for a synthetic native-default profile. They are not
   * persisted: the profile itself is derived from the adapter's declared root,
   * which can change with HOME, so a stale stored identity would outlive it.
   */
  const nativeDefaultIdentities = new Map<string, ProfileIdentity>();
  let state: RegistryState | undefined;
  let loading: Promise<RegistryState> | undefined;
  let disposed = false;

  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  function load(): Promise<RegistryState> {
    if (state) return Promise.resolve(state);
    loading ??= (async () => {
      const snapshot = await options.store.load();
      // Re-read through the parser whatever the store handed back: a host
      // store may predate sets, and the invariants are the registry's.
      const parsed = snapshot === undefined ? undefined : parseProfileRegistrySnapshot(snapshot);
      state = {
        sets: parsed?.sets ?? [],
        profiles: parsed?.profiles ?? [],
        defaultSet: parsed?.defaultSet,
      };
      return state;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  function nativeDefaults(): AgentProfile[] {
    const profiles: AgentProfile[] = [];
    for (const { provider } of providers.values()) {
      const root = provider.support.nativeDefaultRoot;
      if (!provider.support.supported || !root) continue;
      const id = nativeDefaultProfileId(provider.id);
      const identity = nativeDefaultIdentities.get(id);
      profiles.push({
        id,
        provider: provider.id,
        label: NATIVE_DEFAULT_PROFILE_LABEL,
        kind: 'native-default',
        dataRoot: root,
        createdAt: NATIVE_DEFAULT_CREATED_AT,
        set: NATIVE_PROFILE_SET_ID,
        ...(identity ? { identity } : {}),
      });
    }
    return profiles;
  }

  /** Provider registration order, then any provider no longer composed: a stable list for a UI. */
  function inProviderOrder(profiles: readonly AgentProfile[]): AgentProfile[] {
    const ordered: AgentProfile[] = [];
    for (const providerId of providers.keys()) {
      for (const profile of profiles) if (profile.provider === providerId) ordered.push(profile);
    }
    for (const profile of profiles) if (!providers.has(profile.provider)) ordered.push(profile);
    return ordered;
  }

  async function snapshot(): Promise<AgentProfile[]> {
    const { profiles: managed } = await load();
    const synthetic = nativeDefaults();
    const combined: AgentProfile[] = [];
    // Provider registration order, native default first: a stable list for a UI.
    for (const providerId of providers.keys()) {
      for (const profile of synthetic) if (profile.provider === providerId) combined.push(profile);
      for (const profile of managed) if (profile.provider === providerId) combined.push(profile);
    }
    // Managed profiles whose provider no longer exposes profiles are still
    // registered state; hiding them would make removal impossible.
    for (const profile of managed) if (!providers.has(profile.provider)) combined.push(profile);
    return combined.map(cloneProfile);
  }

  function info(loaded: RegistryState, set: ProfileSet): ProfileSetInfo {
    const defaultSet = loaded.defaultSet ?? NATIVE_PROFILE_SET_ID;
    const members =
      set.kind === 'native'
        ? nativeDefaults()
        : inProviderOrder(loaded.profiles.filter((profile) => profile.set === set.id && active(profile)));
    return { set: { ...set }, isDefault: defaultSet === set.id, profiles: members.map(cloneProfile) };
  }

  /**
   * Every write goes through here, one at a time: the change is made to a
   * copy of the committed state, the copy is saved, and only a save that
   * succeeded makes it the state. So the file never lags what readers see
   * (two overlapping saves could otherwise land out of order), and a failed
   * write changes nothing — a retry finds the state it started from.
   */
  let writes: Promise<unknown> = Promise.resolve();
  function mutate<T>(change: (draft: RegistryState) => { result: T; changed: boolean }): Promise<T> {
    const run = writes.then(async () => {
      const current = await load();
      const draft: RegistryState = {
        sets: current.sets.map((set) => ({ ...set })),
        profiles: current.profiles.map(cloneProfile),
        defaultSet: current.defaultSet,
      };
      const { result, changed } = change(draft);
      if (changed) {
        await options.store.save({
          version: 2,
          ...(draft.defaultSet === undefined ? {} : { defaultSet: draft.defaultSet }),
          sets: draft.sets.map((set) => ({ ...set })),
          profiles: draft.profiles.map(cloneProfile),
        });
        state = draft;
        await announce();
      }
      return result;
    });
    writes = run.catch(() => undefined);
    return run;
  }

  function emit(profiles: AgentProfile[]): void {
    for (const listener of listeners) {
      try {
        listener(profiles.map(cloneProfile));
      } catch (error) {
        report(error);
      }
    }
  }

  async function announce(): Promise<void> {
    emit(await snapshot());
  }

  function managedSet(loaded: RegistryState, setId: string): ProfileSet | undefined {
    return loaded.sets.find((set) => set.id === setId);
  }

  return {
    list: async (providerId) =>
      (await snapshot()).filter((profile) => providerId === undefined || profile.provider === providerId),

    get: async (profileId) => (await snapshot()).find((profile) => profile.id === profileId),

    managed: async (providerId) =>
      (await load()).profiles
        .filter((profile) => providerId === undefined || profile.provider === providerId)
        .map(cloneProfile),

    add(profile) {
      if (profile.kind !== 'managed') {
        return Promise.reject(new Error(`only managed profiles are registered: ${profile.id}`));
      }
      return mutate((draft) => {
        if (draft.profiles.some((existing) => existing.id === profile.id)) {
          throw new Error(`agent profile already registered: ${profile.id}`);
        }
        const set = profile.set === undefined ? undefined : managedSet(draft, profile.set);
        if (!set) throw new Error(`agent profile names no registered profile set: ${profile.id}`);
        if (
          active(profile) &&
          draft.profiles.some(
            (existing) => existing.set === set.id && existing.provider === profile.provider && active(existing),
          )
        ) {
          throw new Error(`profile set ${set.id} already has a ${profile.provider} account`);
        }
        if (draft.profiles.length >= MAX_PERSISTED_PROFILES) {
          throw new Error(`profile registry is full (${MAX_PERSISTED_PROFILES} profiles)`);
        }
        draft.profiles.push({ ...cloneProfile(profile), label: set.label });
        return { result: undefined, changed: true };
      });
    },

    remove(profileId) {
      return mutate((draft) => {
        const index = draft.profiles.findIndex((profile) => profile.id === profileId);
        if (index < 0) return { result: false, changed: false };
        draft.profiles.splice(index, 1);
        return { result: true, changed: true };
      });
    },

    retire(profileId, at) {
      return mutate((draft) => {
        const profile = draft.profiles.find((entry) => entry.id === profileId);
        if (!profile) return { result: undefined, changed: false };
        const changed = profile.retiredAt === undefined;
        if (changed) profile.retiredAt = at;
        return { result: cloneProfile(profile), changed };
      });
    },

    async recordIdentity(profileId, identity) {
      const parsed = ProfileIdentitySchema.safeParse(identity);
      if (!parsed.success) throw new Error(`profile identity for ${profileId} failed schema validation`);
      const recorded = await mutate((draft) => {
        const profile = draft.profiles.find((entry) => entry.id === profileId);
        if (!profile) return { result: undefined, changed: false };
        profile.identity = parsed.data;
        return { result: cloneProfile(profile), changed: true };
      });
      if (recorded) return recorded;
      const existing = (await snapshot()).find((entry) => entry.id === profileId);
      if (existing?.kind !== 'native-default') return undefined;
      nativeDefaultIdentities.set(profileId, parsed.data);
      await announce();
      return cloneProfile({ ...existing, identity: parsed.data });
    },

    async sets() {
      const loaded = await load();
      return [info(loaded, nativeProfileSet()), ...loaded.sets.map((set) => info(loaded, set))];
    },

    async getSet(setId) {
      const loaded = await load();
      if (setId === NATIVE_PROFILE_SET_ID) return info(loaded, nativeProfileSet());
      const set = managedSet(loaded, setId);
      return set ? info(loaded, set) : undefined;
    },

    addSet(set) {
      const parsed = ProfileSetSchema.safeParse(set);
      if (!parsed.success || parsed.data.kind !== 'managed') {
        return Promise.reject(new Error(`profile set ${JSON.stringify(set.id)} failed schema validation`));
      }
      return mutate((draft) => {
        if (parsed.data.id === NATIVE_PROFILE_SET_ID || managedSet(draft, parsed.data.id)) {
          throw new Error(`profile set already registered: ${parsed.data.id}`);
        }
        if (draft.sets.length >= MAX_PERSISTED_SETS) {
          throw new Error(`profile registry is full (${MAX_PERSISTED_SETS} profile sets)`);
        }
        draft.sets.push(parsed.data);
        return { result: undefined, changed: true };
      });
    },

    updateSet(setId, patch) {
      return mutate((draft) => {
        const set = managedSet(draft, setId);
        if (!set) return { result: undefined, changed: false };
        const next: ProfileSet = {
          ...set,
          ...(patch.label === undefined ? {} : { label: patch.label.trim() }),
          ...(patch.directory === undefined || set.directory !== undefined ? {} : { directory: patch.directory }),
        };
        if (patch.glyph === null) delete next.glyph;
        else if (patch.glyph !== undefined) next.glyph = patch.glyph;
        const parsed = ProfileSetSchema.safeParse(next);
        if (!parsed.success) throw new Error(`profile set ${JSON.stringify(setId)} failed schema validation`);
        Object.assign(set, parsed.data);
        if (parsed.data.glyph === undefined) delete set.glyph;
        if (patch.label !== undefined) {
          for (const profile of draft.profiles) if (profile.set === setId) profile.label = set.label;
        }
        return { result: info(draft, set), changed: true };
      });
    },

    removeSet(setId) {
      return mutate((draft) => {
        const index = draft.sets.findIndex((set) => set.id === setId);
        if (index < 0) return { result: undefined, changed: false };
        const [set] = draft.sets.splice(index, 1);
        const removed = draft.profiles.filter((profile) => profile.set === setId);
        draft.profiles = draft.profiles.filter((profile) => profile.set !== setId);
        if (draft.defaultSet === setId) draft.defaultSet = undefined;
        return { result: { set: { ...set! }, profiles: removed.map(cloneProfile) }, changed: true };
      });
    },

    async defaultSetId() {
      return (await load()).defaultSet ?? NATIVE_PROFILE_SET_ID;
    },

    setDefault(setId) {
      return mutate((draft) => {
        if (setId !== NATIVE_PROFILE_SET_ID && !managedSet(draft, setId)) return { result: false, changed: false };
        const next = setId === NATIVE_PROFILE_SET_ID ? undefined : setId;
        const changed = draft.defaultSet !== next;
        draft.defaultSet = next;
        return { result: true, changed };
      });
    },

    onChange(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      disposed = true;
      listeners.clear();
      nativeDefaultIdentities.clear();
    },
  };
}
