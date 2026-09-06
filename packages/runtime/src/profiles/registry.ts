import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  type AgentProfile,
  type ProfileIdentity,
  type ProfileProvider,
  type ProfileService,
} from '@vibecook/puppeteer-core';
import type { ProfileRegistrySnapshot, ProfileStore } from '../types.js';

/**
 * The account-profile registry.
 *
 * Managed profiles are persisted host state. Every provider that supports
 * profiles also contributes one synthetic `native-default` profile pointing at
 * the vendor's own root, so the account the user already has appears in the
 * list without being moved, copied, or re-authenticated.
 *
 * Nothing here reads or writes a credential: a profile records a label, a
 * directory, and the last identity the adapter read back from native evidence.
 */

export const NATIVE_DEFAULT_PROFILE_LABEL = 'Default';
const NATIVE_DEFAULT_SUFFIX = 'native-default';
/**
 * Synthetic profiles have no creation event. A fixed timestamp keeps them
 * stable across reloads instead of drifting on every process start.
 */
const NATIVE_DEFAULT_CREATED_AT = new Date(0).toISOString();
const STORE_FILE_MODE = 0o600;
const STORE_DIRECTORY_MODE = 0o700;
const MAX_PERSISTED_PROFILES = 512;

export function nativeDefaultProfileId(providerId: string): string {
  return `${providerId}:${NATIVE_DEFAULT_SUFFIX}`;
}

export function defaultProfileStorePath(home = homedir()): string {
  return join(home, '.puppeteer', 'profiles.json');
}

/**
 * Validate one persisted snapshot. The envelope is checked structurally and
 * every entry through Core's Zod schema; a corrupt file is an error rather
 * than an empty registry, because silently forgetting profiles would let the
 * next write erase them.
 */
export function parseProfileRegistrySnapshot(value: unknown): ProfileRegistrySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile registry document must be an object');
  }
  const document = value as { version?: unknown; profiles?: unknown };
  if (document.version !== 1) throw new Error('unsupported profile registry version');
  if (!Array.isArray(document.profiles)) throw new Error('profile registry document has no profiles array');
  const profiles = document.profiles.map((entry, index) => {
    const parsed = AgentProfileSchema.safeParse(entry);
    if (!parsed.success) throw new Error(`profile registry entry ${index} failed schema validation`);
    return parsed.data;
  });
  return { version: 1, profiles };
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

export interface ProfileRegistry {
  /** Managed profiles plus one synthetic native-default profile per supporting provider. */
  list(providerId?: string): Promise<AgentProfile[]>;
  get(profileId: string): Promise<AgentProfile | undefined>;
  /** Registered managed profiles only; native defaults are excluded. */
  managed(providerId?: string): Promise<AgentProfile[]>;
  add(profile: AgentProfile): Promise<void>;
  remove(profileId: string): Promise<boolean>;
  /** Persist the identity a verification read back from native evidence. */
  recordIdentity(profileId: string, identity: ProfileIdentity): Promise<AgentProfile | undefined>;
  onChange(listener: (profiles: AgentProfile[]) => void): () => void;
  dispose(): void;
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, ...(profile.identity ? { identity: { ...profile.identity } } : {}) };
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
  let managedProfiles: AgentProfile[] | undefined;
  let loading: Promise<AgentProfile[]> | undefined;
  let disposed = false;

  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  function load(): Promise<AgentProfile[]> {
    if (managedProfiles) return Promise.resolve(managedProfiles);
    loading ??= (async () => {
      const snapshot = await options.store.load();
      managedProfiles = (snapshot?.profiles ?? []).filter((profile) => profile.kind === 'managed');
      return managedProfiles;
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
        ...(identity ? { identity } : {}),
      });
    }
    return profiles;
  }

  async function snapshot(): Promise<AgentProfile[]> {
    const managed = await load();
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

  async function persist(): Promise<void> {
    await options.store.save({ version: 1, profiles: (managedProfiles ?? []).map(cloneProfile) });
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

  return {
    list: async (providerId) =>
      (await snapshot()).filter((profile) => providerId === undefined || profile.provider === providerId),

    get: async (profileId) => (await snapshot()).find((profile) => profile.id === profileId),

    managed: async (providerId) =>
      (await load()).filter((profile) => providerId === undefined || profile.provider === providerId).map(cloneProfile),

    async add(profile) {
      const managed = await load();
      if (managed.some((existing) => existing.id === profile.id)) {
        throw new Error(`agent profile already registered: ${profile.id}`);
      }
      if (managed.length >= MAX_PERSISTED_PROFILES) {
        throw new Error(`profile registry is full (${MAX_PERSISTED_PROFILES} profiles)`);
      }
      managed.push(cloneProfile(profile));
      await persist();
      await announce();
    },

    async remove(profileId) {
      const managed = await load();
      const index = managed.findIndex((profile) => profile.id === profileId);
      if (index < 0) return false;
      managed.splice(index, 1);
      await persist();
      await announce();
      return true;
    },

    async recordIdentity(profileId, identity) {
      const parsed = ProfileIdentitySchema.safeParse(identity);
      if (!parsed.success) throw new Error(`profile identity for ${profileId} failed schema validation`);
      const managed = await load();
      const profile = managed.find((entry) => entry.id === profileId);
      if (profile) {
        profile.identity = parsed.data;
        await persist();
        await announce();
        return cloneProfile(profile);
      }
      const existing = (await snapshot()).find((entry) => entry.id === profileId);
      if (existing?.kind !== 'native-default') return undefined;
      nativeDefaultIdentities.set(profileId, parsed.data);
      await announce();
      return { ...existing, identity: parsed.data };
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
