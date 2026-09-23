import {
  AgentProfileSchema,
  NATIVE_PROFILE_SET_ID,
  ProfileFailureSchema,
  ProfileGlyphSchema,
  ProfileIdentitySchema,
  type AgentHost,
  type AgentProfile,
  type ProfileFailure,
  type ProfileIdentity,
} from '@vibecook/puppeteer-core';
import type {
  CreateProfileOptions,
  CreateProfileSetOptions,
  ProfileLoginResult,
  ProfileSetInfo,
  ProfileSignOutResult,
  RemovedProfileSet,
  StartProfileLoginOptions,
  UpdateProfileSetOptions,
} from '../types.js';
import type { ProfileRegistry, ProfileRegistryProvider } from './registry.js';
import type { ProfileRootAllocator } from './roots.js';

/**
 * Profile onboarding: make a profile set and its directory, allocate an
 * account's root inside it, run the vendor's own login there, and read
 * identity back from native evidence.
 *
 * The login runs in a real host terminal because every vendor's flow is
 * interactive (device codes, browser handoff, TTY prompts). Its output is
 * never captured or parsed: whether the account is usable is answered
 * afterwards by `verify`, which reads the provider's own status surface.
 */

const MAX_PROFILE_LABEL_LENGTH = 64;

export interface ProfileOnboardingOptions {
  registry: ProfileRegistry;
  providers: ReadonlyMap<string, ProfileRegistryProvider>;
  allocator: ProfileRootAllocator;
  host: AgentHost;
  defaultCwd: string;
  now?: () => Date;
  onError?: (error: Error) => void;
}

/** Which account a spawn runs under, and in which set. */
export type SpawnProfileResolution = { profileId?: string; setId: string } | { error: string };

export interface ProfileOnboarding {
  createProfile(options: CreateProfileOptions): Promise<AgentProfile | ProfileFailure>;
  removeProfile(profileId: string): Promise<boolean>;
  retireProfile(profileId: string): Promise<AgentProfile | ProfileFailure>;
  signOutProfile(profileId: string): Promise<ProfileSignOutResult>;
  createProfileSet(options: CreateProfileSetOptions): Promise<ProfileSetInfo | ProfileFailure>;
  updateProfileSet(options: UpdateProfileSetOptions): Promise<ProfileSetInfo | ProfileFailure>;
  setDefaultProfileSet(setId: string): Promise<ProfileSetInfo | ProfileFailure>;
  removeProfileSet(setId: string): Promise<RemovedProfileSet | ProfileFailure>;
  /**
   * The account a spawn of `providerId` runs under: the named profile, else the
   * named set's account (which must exist), else the default set's account,
   * else the provider's own root.
   */
  resolveSpawnProfile(
    providerId: string,
    request: { profile?: string; profileSet?: string },
  ): Promise<SpawnProfileResolution>;
  /** Merged binding variables for a set of profiles, at most one per provider. */
  bindingEnvironment(profileIds: readonly string[]): Promise<Record<string, string>>;
  startLogin(options: StartProfileLoginOptions): Promise<ProfileLoginResult>;
  verifyProfile(profileId: string): Promise<ProfileIdentity | ProfileFailure>;
}

function failure(status: ProfileFailure['status'], message: string, provider?: string): ProfileFailure {
  return {
    status,
    ...(provider === undefined ? {} : { provider }),
    message,
    retryable: status === 'unavailable',
  };
}

function validLabel(label: string): string | undefined {
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROFILE_LABEL_LENGTH ? trimmed : undefined;
}

const LABEL_RULE = `profile label must be 1 to ${MAX_PROFILE_LABEL_LENGTH} characters`;

export function createProfileOnboarding(options: ProfileOnboardingOptions): ProfileOnboarding {
  const now = options.now ?? (() => new Date());
  const { registry } = options;
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  function supporting(providerId: string): ProfileRegistryProvider | ProfileFailure {
    const entry = options.providers.get(providerId);
    if (!entry) {
      return failure('unsupported', `agent provider does not expose account profiles: ${providerId}`, providerId);
    }
    if (!entry.provider.support.supported) {
      return failure('unsupported', `agent provider does not support account profiles: ${providerId}`, providerId);
    }
    return entry;
  }

  async function takenSetIds(): Promise<Set<string>> {
    return new Set((await registry.sets()).map((info) => info.set.id));
  }

  async function createSet(request: CreateProfileSetOptions): Promise<ProfileSetInfo | ProfileFailure> {
    const label = validLabel(request.label);
    if (label === undefined) return failure('invalid', LABEL_RULE);
    if (request.glyph !== undefined && !ProfileGlyphSchema.safeParse(request.glyph).success) {
      return failure('invalid', `not a glyph: ${JSON.stringify(request.glyph)}`);
    }
    let allocated;
    try {
      allocated = await options.allocator.allocateSet(label, await takenSetIds());
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile directory could not be allocated');
    }
    try {
      await registry.addSet({
        id: allocated.id,
        kind: 'managed',
        label,
        ...(request.glyph === undefined ? {} : { glyph: request.glyph }),
        directory: allocated.directory,
        createdAt: now().toISOString(),
      });
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile set could not be registered');
    }
    const info = await registry.getSet(allocated.id);
    return info ?? failure('unavailable', 'profile set could not be read back');
  }

  /** The directory new accounts of a set are allocated in; an adopted set is given one on first use. */
  async function directoryOf(info: ProfileSetInfo): Promise<string | ProfileFailure> {
    if (info.set.directory !== undefined) return info.set.directory;
    try {
      const allocated = await options.allocator.allocateSet(info.set.label, await takenSetIds());
      const updated = await registry.updateSet(info.set.id, { directory: allocated.directory });
      return updated?.set.directory ?? allocated.directory;
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile directory could not be allocated');
    }
  }

  async function createInSet(providerId: string, setId: string): Promise<AgentProfile | ProfileFailure> {
    const entry = supporting(providerId);
    if ('status' in entry) return entry;
    if (setId === NATIVE_PROFILE_SET_ID) {
      return failure('invalid', "the native set is the providers' own roots; nothing is created in it", providerId);
    }
    const info = await registry.getSet(setId);
    if (!info) return failure('not-found', `unknown profile set: ${setId}`, providerId);
    if (info.profiles.some((profile) => profile.provider === providerId)) {
      return failure('invalid', `${info.set.label} already has a ${providerId} account`, providerId);
    }
    const directory = await directoryOf(info);
    if (typeof directory !== 'string') return { ...directory, provider: providerId };

    let allocated;
    try {
      allocated = await options.allocator.allocateAccount(directory, providerId);
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile root could not be allocated', providerId);
    }

    const parsed = AgentProfileSchema.safeParse({
      id: allocated.id,
      provider: providerId,
      label: info.set.label,
      kind: 'managed',
      dataRoot: allocated.dataRoot,
      createdAt: now().toISOString(),
      set: info.set.id,
    });
    if (!parsed.success) return failure('invalid', 'profile could not be constructed', providerId);
    const profile = parsed.data;

    try {
      // Adapters write only minimal, credential-free native config here.
      await entry.service.initializeRoot?.(profile);
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile root could not be initialized', providerId);
    }

    try {
      await registry.add(profile);
    } catch (error) {
      report(error);
      return failure('unavailable', 'profile could not be registered', providerId);
    }
    return profile;
  }

  return {
    async createProfile(request) {
      if (request.set !== undefined) {
        if (request.label !== undefined) {
          return failure('invalid', 'name the set or a label, not both', request.providerId);
        }
        return createInSet(request.providerId, request.set);
      }
      const label = validLabel(request.label ?? '');
      if (label === undefined) return failure('invalid', LABEL_RULE, request.providerId);
      const entry = supporting(request.providerId);
      if ('status' in entry) return entry;
      // The set of this name that has no account for the provider yet, as a
      // host that named per-provider profiles alike meant; else a new one.
      const sets = await registry.sets();
      const joined = sets.find(
        (info) =>
          info.set.kind === 'managed' &&
          info.set.label.toLowerCase() === label.toLowerCase() &&
          !info.profiles.some((profile) => profile.provider === request.providerId),
      );
      if (joined) return createInSet(request.providerId, joined.set.id);
      const made = await createSet({ label });
      if ('status' in made) return { ...made, provider: request.providerId };
      return createInSet(request.providerId, made.set.id);
    },

    async removeProfile(profileId) {
      const profile = await registry.get(profileId);
      // Native defaults are derived from the adapter, not registered, so there
      // is nothing to remove. The managed root stays on disk: deleting an
      // account's credentials and history is the user's decision, not ours.
      if (!profile || profile.kind !== 'managed') return false;
      return registry.remove(profileId);
    },

    async retireProfile(profileId) {
      const profile = await registry.get(profileId);
      if (!profile) return failure('not-found', `unknown agent profile: ${profileId}`);
      if (profile.kind !== 'managed') {
        return failure('invalid', "a native default is the provider's own root; it is never retired", profile.provider);
      }
      try {
        const retired = await registry.retire(profileId, now().toISOString());
        return retired ?? failure('not-found', `unknown agent profile: ${profileId}`, profile.provider);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile could not be retired', profile.provider);
      }
    },

    async signOutProfile(profileId) {
      const profile = await registry.get(profileId);
      if (!profile) return failure('not-found', `unknown agent profile: ${profileId}`);
      const entry = options.providers.get(profile.provider);
      if (!entry?.service.signOut) {
        // A managed root holds its own credential: deleting it is the sign-out.
        // A native default's root is never deleted, so without the vendor's
        // own command there is nothing to do here.
        return profile.kind === 'managed'
          ? { ran: false }
          : failure('unsupported', `${profile.provider} signs out in its own terminal`, profile.provider);
      }
      let outcome: ProfileFailure | undefined;
      try {
        outcome = await entry.service.signOut(profile);
      } catch (error) {
        report(error);
        return failure('unavailable', `native sign-out failed for ${profile.provider}`, profile.provider);
      }
      if (outcome === undefined) return { ran: true };
      const declared = ProfileFailureSchema.safeParse(outcome);
      return declared.success
        ? declared.data
        : failure('unavailable', 'native sign-out returned an unreadable result', profile.provider);
    },

    createProfileSet: createSet,

    async updateProfileSet(request) {
      if (request.setId === NATIVE_PROFILE_SET_ID) {
        return failure('invalid', 'the native set keeps its name and mark');
      }
      let label: string | undefined;
      if (request.label !== undefined) {
        label = validLabel(request.label);
        if (label === undefined) return failure('invalid', LABEL_RULE);
      }
      if (
        request.glyph !== undefined &&
        request.glyph !== null &&
        !ProfileGlyphSchema.safeParse(request.glyph).success
      ) {
        return failure('invalid', `not a glyph: ${JSON.stringify(request.glyph)}`);
      }
      try {
        const updated = await registry.updateSet(request.setId, {
          ...(label === undefined ? {} : { label }),
          ...(request.glyph === undefined ? {} : { glyph: request.glyph }),
        });
        return updated ?? failure('not-found', `unknown profile set: ${request.setId}`);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile set could not be updated');
      }
    },

    async setDefaultProfileSet(setId) {
      try {
        if (!(await registry.setDefault(setId))) return failure('not-found', `unknown profile set: ${setId}`);
      } catch (error) {
        report(error);
        return failure('unavailable', 'the default profile set could not be recorded');
      }
      return (await registry.getSet(setId)) ?? failure('not-found', `unknown profile set: ${setId}`);
    },

    async removeProfileSet(setId) {
      if (setId === NATIVE_PROFILE_SET_ID) {
        return failure('invalid', "the native set is the providers' own roots; it is never removed");
      }
      const info = await registry.getSet(setId);
      if (!info) return failure('not-found', `unknown profile set: ${setId}`);
      if (info.isDefault) {
        return failure(
          'invalid',
          `${info.set.label} is the default for new sessions; make another set the default first`,
        );
      }
      try {
        const removed = await registry.removeSet(setId);
        return removed ?? failure('not-found', `unknown profile set: ${setId}`);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile set could not be removed');
      }
    },

    async resolveSpawnProfile(providerId, request) {
      if (request.profile !== undefined) {
        const profile = await registry.get(request.profile);
        return { profileId: request.profile, setId: profile?.set ?? NATIVE_PROFILE_SET_ID };
      }
      const explicit = request.profileSet !== undefined;
      const setId = request.profileSet ?? (await registry.defaultSetId());
      if (setId === NATIVE_PROFILE_SET_ID) return { setId };
      const info = await registry.getSet(setId);
      if (!info) {
        // A default that vanished between reads is the native set.
        return explicit ? { error: `unknown profile set: ${setId}` } : { setId: NATIVE_PROFILE_SET_ID };
      }
      const account = info.profiles.find((profile) => profile.provider === providerId);
      if (account) return { profileId: account.id, setId };
      return explicit ? { error: `${info.set.label} has no ${providerId} account` } : { setId: NATIVE_PROFILE_SET_ID };
    },

    async bindingEnvironment(profileIds) {
      const merged: Record<string, string> = {};
      const boundProviders = new Set<string>();
      for (const profileId of profileIds) {
        const profile = await registry.get(profileId);
        // A caller that names an unregistered profile, or two profiles of one
        // provider, has a bug: one process has exactly one root per provider.
        if (!profile) throw new Error(`unknown agent profile: ${profileId}`);
        if (boundProviders.has(profile.provider)) {
          throw new Error(`profile set binds ${profile.provider} more than once: ${profileId}`);
        }
        boundProviders.add(profile.provider);
        const entry = options.providers.get(profile.provider);
        if (!entry) throw new Error(`agent provider does not expose account profiles: ${profile.provider}`);
        Object.assign(merged, entry.service.bindingEnvironment(profile));
      }
      return merged;
    },

    async startLogin(request) {
      const profile = await registry.get(request.profileId);
      if (!profile) return failure('not-found', `unknown agent profile: ${request.profileId}`);
      if (profile.retiredAt !== undefined) {
        return failure('invalid', `agent profile is signed out: ${request.profileId}`, profile.provider);
      }
      const entry = supporting(profile.provider);
      if ('status' in entry) return entry;

      try {
        const spec = entry.service.loginInvocation(profile, { cwd: request.cwd ?? options.defaultCwd });
        const binding = entry.service.bindingEnvironment(profile);
        const { runtimeSessionId } = await options.host.spawnTerminal({
          ...spec,
          env: { ...spec.env, ...binding },
        });
        return { runtimeSessionId, profile };
      } catch (error) {
        report(error);
        return failure('unavailable', `native login could not be started for ${profile.provider}`, profile.provider);
      }
    },

    async verifyProfile(profileId) {
      const profile = await registry.get(profileId);
      if (!profile) return failure('not-found', `unknown agent profile: ${profileId}`);
      const entry = supporting(profile.provider);
      if ('status' in entry) return entry;

      let outcome: unknown;
      try {
        outcome = await entry.service.verify(profile);
      } catch (error) {
        report(error);
        return failure('unavailable', `profile verification failed for ${profile.provider}`, profile.provider);
      }
      const identity = ProfileIdentitySchema.safeParse(outcome);
      if (identity.success) {
        try {
          await registry.recordIdentity(profileId, identity.data);
        } catch (error) {
          // The identity is still true even when persisting it failed.
          report(error);
        }
        return identity.data;
      }
      const declared = ProfileFailureSchema.safeParse(outcome);
      if (declared.success) return declared.data;
      report(new Error(`profile verification for ${JSON.stringify(profile.provider)} failed schema validation`));
      return failure('unavailable', `profile verification returned an unreadable result`, profile.provider);
    },
  };
}
