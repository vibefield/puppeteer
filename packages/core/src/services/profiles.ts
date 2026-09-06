import { z } from 'zod';
import type { TerminalSpec } from '../host.js';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';

/**
 * Account profiles: one persistent native data root per account, bound to a
 * child process through the provider's own root variable.
 *
 * A profile is a launch selection. It is never a machine-wide switch, it never
 * copies or moves credentials, and it is not a security boundary between
 * accounts. Onboarding runs the native login inside the root; identity and
 * usage are read back from native evidence.
 */

const NonEmptyStringSchema = z.string().trim().min(1).max(8_192);
const TimestampSchema = z.iso.datetime({ offset: true });

export const AgentProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);
export type AgentProfileId = z.infer<typeof AgentProfileIdSchema>;

export const AgentProfileKindSchema = z.enum([
  /** The provider's own default root with no variable injected. */
  'native-default',
  /** A runtime-allocated root the user logged into. */
  'managed',
]);
export type AgentProfileKind = z.infer<typeof AgentProfileKindSchema>;

/** What the native status surface says about who is logged in. Never carries a token. */
export const ProfileIdentitySchema = z.strictObject({
  loggedIn: z.boolean(),
  /** Native login method label, such as a subscription or API-key mode. */
  method: NonEmptyStringSchema.optional(),
  email: NonEmptyStringSchema.optional(),
  organization: NonEmptyStringSchema.optional(),
  /** Native plan or subscription label. */
  plan: NonEmptyStringSchema.optional(),
  verifiedAt: TimestampSchema,
  source: z.strictObject({
    kind: z.enum(['native-status', 'native-protocol']),
    stability: z.enum(['documented', 'experimental']),
  }),
});
export type ProfileIdentity = z.infer<typeof ProfileIdentitySchema>;

export const AgentProfileSchema = z.strictObject({
  id: AgentProfileIdSchema,
  provider: AgentProviderIdSchema,
  label: z.string().trim().min(1).max(64),
  kind: AgentProfileKindSchema,
  /** Absolute native data root. Immutable for managed profiles: credential stores may key on the path. */
  dataRoot: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  /** Last verification result; absent until verify() has succeeded once. */
  identity: ProfileIdentitySchema.optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const ProfileSupportSchema = z.strictObject({
  supported: z.boolean(),
  /** How verify() learns who is logged in. */
  identity: z.enum(['native-status', 'native-protocol', 'none']),
  /** Native surfaces every profile of this provider shares; documented, not enforced. */
  sharedSurfaces: z.array(z.string().trim().min(1).max(500)).max(16),
  /** Absolute native root used when no variable is set. */
  nativeDefaultRoot: NonEmptyStringSchema.optional(),
});
export type ProfileSupport = z.infer<typeof ProfileSupportSchema>;

export const ProfileFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'unavailable', 'not-found', 'invalid']),
  provider: AgentProviderIdSchema.optional(),
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
});
export type ProfileFailure = z.infer<typeof ProfileFailureSchema>;

export const ProfileProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  support: ProfileSupportSchema,
});
export type ProfileProvider = z.infer<typeof ProfileProviderSchema>;

/** One adapter-owned profile capability, independent of live sessions. */
export interface ProfileService {
  readonly provider: ProfileProvider;
  /**
   * Variables that bind a child process to the profile root. Names must be a
   * subset of the provider's launch allow-list; empty for the native default.
   */
  bindingEnvironment(profile: AgentProfile): Record<string, string>;
  /** Prepare a freshly allocated managed root, for example by writing a minimal native config. */
  initializeRoot?(profile: AgentProfile): Promise<void>;
  /**
   * The native interactive login for a host terminal. The host merges
   * bindingEnvironment(profile) over spec.env and over its clean environment.
   */
  loginInvocation(profile: AgentProfile, options: { cwd: string }): TerminalSpec;
  verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure>;
}
