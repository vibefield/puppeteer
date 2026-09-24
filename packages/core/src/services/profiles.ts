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

/**
 * The service a sign-in is billed through: the company whose account the work
 * runs on (Anthropic, OpenAI, xAI, …). It is not the agent. A harness such as
 * Pi holds sign-ins to several services, and several agents can hold sign-ins
 * to one. Ids are shared across adapters so a host can tell that two agents'
 * sign-ins are to the same service; RFC 006 keeps the list. An adapter maps
 * its native provider ids onto it and passes an unlisted one through, folded
 * where it does not already fit: lowercase ASCII letters and digits, with
 * `.`, `_` or `-` only between them.
 */
export const SignInServiceIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u);
export type SignInServiceId = z.infer<typeof SignInServiceIdSchema>;

export const SignInServiceSchema = z.strictObject({
  id: SignInServiceIdSchema,
  /** The service's own name as a person knows it ("Anthropic"), not a login-menu label. */
  label: z.string().trim().min(1).max(64),
});
export type SignInService = z.infer<typeof SignInServiceSchema>;

/**
 * The program whose sign-in an agent runs as when its root holds none of its
 * own: Copilot without its own login acts as the GitHub CLI's user. Such a
 * sign-in is the machine's, not the profile's — every root that borrows it
 * answers for the same account — so a host must not present it as the
 * profile's own. The adapter names the program as a person knows it.
 */
const BorrowedFromSchema = z.string().trim().min(1).max(64);

/**
 * One sign-in a root holds, for an agent whose root can hold several (a
 * harness: Pi, OpenCode, Hermes). Never carries a token or any field that
 * travels beside one. Who and which plan appear only when the agent itself
 * reports them: a harness usually keeps no email for a third party's login,
 * and a host must not fill one in.
 */
export const ProfileSignInSchema = z.strictObject({
  service: SignInServiceSchema,
  /** Native method label: `oauth`, `api-key`, `free-tier`, … */
  method: NonEmptyStringSchema,
  /** The agent's own catalog calls this login a subscription, not a pay-per-use key. */
  subscription: z.boolean().optional(),
  /** The one a new session in this root uses unless the person picks another. */
  inUse: z.boolean().optional(),
  email: NonEmptyStringSchema.optional(),
  /** A non-email handle for the account, such as a GitHub login. */
  account: NonEmptyStringSchema.optional(),
  organization: NonEmptyStringSchema.optional(),
  plan: NonEmptyStringSchema.optional(),
  borrowedFrom: BorrowedFromSchema.optional(),
});
export type ProfileSignIn = z.infer<typeof ProfileSignInSchema>;

/** What the native status surface says about who is logged in. Never carries a token. */
export const ProfileIdentitySchema = z
  .strictObject({
    loggedIn: z.boolean(),
    /** Native login method label, such as a subscription or API-key mode. */
    method: NonEmptyStringSchema.optional(),
    email: NonEmptyStringSchema.optional(),
    /** A non-email handle for the account, such as a GitHub login; a view shows it before the email. */
    account: NonEmptyStringSchema.optional(),
    organization: NonEmptyStringSchema.optional(),
    /** Native plan or subscription label. */
    plan: NonEmptyStringSchema.optional(),
    /** The program whose sign-in the agent runs as, when the root holds none of its own. */
    borrowedFrom: BorrowedFromSchema.optional(),
    /**
     * Every sign-in the root holds, for an agent whose root can hold several.
     * When present it is the whole answer: `loggedIn` is true exactly when it
     * is non-empty, and the top-level method, email, account, organization
     * and plan repeat the in-use sign-in's (absent when none is in use), so a
     * view that predates the list still reads the one that matters. The
     * runtime derives those from the list when it verifies, whatever the
     * adapter put there.
     */
    signIns: z.array(ProfileSignInSchema).max(64).optional(),
    verifiedAt: TimestampSchema,
    source: z.strictObject({
      kind: z.enum(['native-status', 'native-protocol']),
      stability: z.enum(['documented', 'experimental']),
    }),
  })
  .refine((identity) => identity.signIns === undefined || identity.loggedIn === identity.signIns.length > 0, {
    message: 'loggedIn must be true exactly when signIns is non-empty',
    path: ['loggedIn'],
  })
  .refine((identity) => (identity.signIns ?? []).filter((signIn) => signIn.inUse === true).length <= 1, {
    message: 'at most one sign-in is in use',
    path: ['signIns'],
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

/** One way to add a sign-in to a root: the agent's own login, run in a host terminal. */
export const ProfileSignInRouteSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u),
  /** What the route does, as a menu item: "Nous Portal", "Another provider…". */
  label: z.string().trim().min(1).max(64),
  /** The service the route signs in to, when it is exactly one. */
  service: SignInServiceSchema.optional(),
});
export type ProfileSignInRoute = z.infer<typeof ProfileSignInRouteSchema>;

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
  /**
   * Where a managed root's credential lives, as the adapter has established
   * it: `root` — inside the root, so deleting the root is the sign-out;
   * `external` — outside it (an OS keychain item keyed on the root's path),
   * so only the vendor's own sign-out removes it. Absent: not established,
   * and a host must not claim more than that the root was deleted.
   */
  credential: z.enum(['root', 'external']).optional(),
  /**
   * The service this agent's own sign-in is to: Claude Code's is Anthropic.
   * Absent for an agent with no service of its own (Pi signs in only to
   * other companies' services).
   */
  service: SignInServiceSchema.optional(),
  /**
   * The ways to add a sign-in to a root, for an agent whose root holds
   * several. Each is the agent's own login; `loginInvocation` takes the chosen
   * route's id, so one id names one route. Absent: one login, the default.
   */
  signInRoutes: z
    .array(ProfileSignInRouteSchema)
    .min(1)
    .max(16)
    .refine((routes) => new Set(routes.map((route) => route.id)).size === routes.length, {
      message: 'sign-in route ids are unique',
    })
    .optional(),
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
   * `route` is one of `provider.support.signInRoutes`' ids (the runtime
   * refuses any other before calling); absent, the default login.
   */
  loginInvocation(profile: AgentProfile, options: { cwd: string; route?: string }): TerminalSpec;
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
