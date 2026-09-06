import {
  AgentProfileSchema,
  ProfileFailureSchema,
  ProfileIdentitySchema,
  type AgentHost,
  type AgentProfile,
  type ProfileFailure,
  type ProfileIdentity,
} from '@vibecook/puppeteer-core';
import type { CreateProfileOptions, ProfileLoginResult, StartProfileLoginOptions } from '../types.js';
import type { ProfileRegistry, ProfileRegistryProvider } from './registry.js';
import type { ProfileRootAllocator } from './roots.js';

/**
 * Profile onboarding: allocate a root, run the vendor's own login inside it,
 * and read identity back from native evidence.
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

export interface ProfileOnboarding {
  createProfile(options: CreateProfileOptions): Promise<AgentProfile | ProfileFailure>;
  removeProfile(profileId: string): Promise<boolean>;
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

export function createProfileOnboarding(options: ProfileOnboardingOptions): ProfileOnboarding {
  const now = options.now ?? (() => new Date());
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

  return {
    async createProfile(request) {
      const label = request.label.trim();
      if (!label || label.length > MAX_PROFILE_LABEL_LENGTH) {
        return failure(
          'invalid',
          `profile label must be 1 to ${MAX_PROFILE_LABEL_LENGTH} characters`,
          request.providerId,
        );
      }
      const entry = supporting(request.providerId);
      if ('status' in entry) return entry;

      let allocated;
      try {
        allocated = await options.allocator.allocate(request.providerId);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile root could not be allocated', request.providerId);
      }

      const parsed = AgentProfileSchema.safeParse({
        id: allocated.id,
        provider: request.providerId,
        label,
        kind: 'managed',
        dataRoot: allocated.dataRoot,
        createdAt: now().toISOString(),
      });
      if (!parsed.success) return failure('invalid', 'profile could not be constructed', request.providerId);
      const profile = parsed.data;

      try {
        // Adapters write only minimal, credential-free native config here.
        await entry.service.initializeRoot?.(profile);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile root could not be initialized', request.providerId);
      }

      try {
        await options.registry.add(profile);
      } catch (error) {
        report(error);
        return failure('unavailable', 'profile could not be registered', request.providerId);
      }
      return profile;
    },

    async removeProfile(profileId) {
      const profile = await options.registry.get(profileId);
      // Native defaults are derived from the adapter, not registered, so there
      // is nothing to remove. The managed root stays on disk: deleting an
      // account's credentials and history is the user's decision, not ours.
      if (!profile || profile.kind !== 'managed') return false;
      return options.registry.remove(profileId);
    },

    async bindingEnvironment(profileIds) {
      const merged: Record<string, string> = {};
      const boundProviders = new Set<string>();
      for (const profileId of profileIds) {
        const profile = await options.registry.get(profileId);
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
      const profile = await options.registry.get(request.profileId);
      if (!profile) return failure('not-found', `unknown agent profile: ${request.profileId}`);
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
      const profile = await options.registry.get(profileId);
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
          await options.registry.recordIdentity(profileId, identity.data);
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
