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

/**
 * Profile sets: the named places a person works in ("Work", "Personal"), each
 * holding at most one account profile per provider. A host shows a set as a
 * profile; Core keeps "profile" for the per-provider root every adapter binds,
 * because that root is the unit a child process is launched with.
 *
 * The native set is synthetic: the providers' own roots, never stored,
 * renamed, or removed. One set is the default for spawns that name none; with
 * no choice recorded it is the native set, which is what a spawn without a
 * profile has always meant.
 */
export const NATIVE_PROFILE_SET_ID = 'native';

/** A set id is also its directory name, made once from the set's first name. */
export const ProfileSetIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u);
export type ProfileSetId = z.infer<typeof ProfileSetIdSchema>;

export const ProfileSetKindSchema = z.enum([
  /** The providers' own default roots; synthetic. */
  'native',
  /** A set the person made; its accounts' roots live in its directory. */
  'managed',
]);
export type ProfileSetKind = z.infer<typeof ProfileSetKindSchema>;

/**
 * The mark a view draws for a set, as a token the views resolve. Open rather
 * than an enumeration, so a glyph a newer build adds never makes an older
 * build's registry unreadable.
 */
export const ProfileGlyphSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
export type ProfileGlyph = z.infer<typeof ProfileGlyphSchema>;

export const ProfileSetSchema = z.strictObject({
  id: ProfileSetIdSchema,
  kind: ProfileSetKindSchema,
  label: z.string().trim().min(1).max(64),
  glyph: ProfileGlyphSchema.optional(),
  /**
   * Absolute directory the set's account roots are allocated in; absent for
   * the native set. Never moves: a rename changes the label, not the path.
   */
  directory: NonEmptyStringSchema.optional(),
  createdAt: TimestampSchema,
});
export type ProfileSet = z.infer<typeof ProfileSetSchema>;

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
  /** The set this account belongs to; the native set for a native default. */
  set: ProfileSetIdSchema.optional(),
  /**
   * When the host signed this account out while sessions still ran under it.
   * A retired account is out of its set and out of new spawns, and stays
   * registered only until the host has removed it.
   */
  retiredAt: TimestampSchema.optional(),
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
  /**
   * Whether a root can be signed out with the vendor's own command. Adapters
   * leave it out: the runtime answers it from the service it composed (a
   * `signOut` method), so a native default is offered a sign-out only where
   * one exists.
   */
  signOut: z.boolean().optional(),
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
  /**
   * The directory whose provider-native layout holds this profile's durable
   * history — transcripts and session stores — and therefore the directory an
   * external history indexer applies the provider's layout to.
   *
   * A native-default profile answers with the provider's own layout root; a
   * managed profile answers with a path derived from `dataRoot` by the same
   * binding rule `bindingEnvironment` applies. It is not always `dataRoot`:
   * Pi binds one level inside it and OpenCode's history sits under the
   * `opencode` directory of the XDG data home it binds. The mapping is
   * provider-specific, so it is an adapter-owned rule rather than a schema
   * field a host could fill in.
   */
  observationRoot(profile: AgentProfile): string;
  /** Prepare a freshly allocated managed root, for example by writing a minimal native config. */
  initializeRoot?(profile: AgentProfile): Promise<void>;
  /**
   * The native interactive login for a host terminal. The host merges
   * bindingEnvironment(profile) over spec.env and over its clean environment.
   */
  loginInvocation(profile: AgentProfile, options: { cwd: string }): TerminalSpec;
  verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure>;
  /**
   * The vendor's own sign-out, run non-interactively under the binding. Only
   * for a credential that lives OUTSIDE the root — a keychain item keyed on
   * the root's path — which deleting the root would leave behind. Absent when
   * the credential is a file inside the root. Resolves undefined once the
   * vendor's command has run; its output is never parsed.
   */
  signOut?(profile: AgentProfile): Promise<ProfileFailure | undefined>;
}
