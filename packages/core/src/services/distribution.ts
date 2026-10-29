import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';

/**
 * Provider-neutral distribution contracts: where an agent executable is
 * installed, how it got there, which releases exist upstream, and how the
 * agent's own updater — or, for an agent not yet here, the vendor's own
 * installer — is invoked.
 *
 * Puppeteer never reimplements an installer or updater. The host discovers
 * candidate executables (PATH, the configured executable, package roots)
 * because that machinery is provider-neutral; the adapter classifies one
 * candidate and reads its version because install fingerprints and version
 * grammar are provider facts. An update or an install runs the vendor's
 * command and the outcome is a fresh inspection, never parsed output.
 */

const NonEmptyStringSchema = z.string().trim().min(1).max(8_192);
const TimestampSchema = z.iso.datetime({ offset: true });
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'release endpoints and install scripts must use https' });
const DetectorIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const CommandNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
/** A directory under the home, written relative to it (`.local/bin`): never absolute, never climbing out. */
const HomeDirectorySchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
  .refine((value) => value.split('/').every((segment) => segment !== '.' && segment !== '..'), {
    message: 'an install directory stays under the home',
  });

export const InstallMethodSchema = z.enum([
  /** The vendor's own installer manages versions and a launcher. */
  'native-installer',
  /** The agent downloads its own binaries under its home directory. */
  'vendor-downloader',
  'npm-global',
  'brew',
  /** One executable copied into place by an install script or by hand. */
  'standalone-binary',
  /** A checkout plus a virtual environment or local build. */
  'source-checkout',
  'unknown',
]);
export type InstallMethod = z.infer<typeof InstallMethodSchema>;

export const InstallCandidateOriginSchema = z.enum([
  'configured',
  'path',
  'npm-global',
  'brew',
  /** A directory the provider's own installer leaves the executable in, found though it is not on the search path. */
  'install-directory',
]);
export type InstallCandidateOrigin = z.infer<typeof InstallCandidateOriginSchema>;

/** One executable the host found; adapters decide whether it is theirs. */
export const InstallCandidateSchema = z.strictObject({
  /** The command as the host resolved it: an absolute path or the configured value. */
  executable: NonEmptyStringSchema,
  /** Symlink-resolved file that actually runs. */
  realPath: NonEmptyStringSchema,
  origin: InstallCandidateOriginSchema,
  /** Package root when the host found the candidate through a package manager. */
  packageRoot: NonEmptyStringSchema.optional(),
});
export type InstallCandidate = z.infer<typeof InstallCandidateSchema>;

export const AutoUpdateStateSchema = z.enum(['enabled', 'disabled', 'unknown']);
export type AutoUpdateState = z.infer<typeof AutoUpdateStateSchema>;

export const ReleaseChannelSchema = z.enum(['stable', 'preview']);
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

/** An adapter-classified install. Every field is native evidence, never a guess dressed as a fact. */
export const InstalledAgentSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  executable: NonEmptyStringSchema,
  realPath: NonEmptyStringSchema,
  /** Parsed from the native version command; absent when it could not be read. */
  version: NonEmptyStringSchema.optional(),
  method: InstallMethodSchema,
  /** Package, cask, or formula name when a package manager owns the install. */
  packageName: NonEmptyStringSchema.optional(),
  /** Directory that owns the install: a versions directory, package root, cellar, or checkout. */
  location: NonEmptyStringSchema.optional(),
  /** Whether the agent updates itself, from native settings or command output. */
  autoUpdate: AutoUpdateStateSchema,
  /** Native release channel the install follows, when the agent reports one. */
  channel: NonEmptyStringSchema.optional(),
  /**
   * Which of the provider's declared release channels this install's own
   * updater follows, mapped by the adapter from its native channel setting or
   * install source (the vendor's grammar stays in the adapter). Absent when the
   * adapter cannot tell; hosts then compare against `stable`.
   */
  releaseChannel: ReleaseChannelSchema.optional(),
  detectedAt: TimestampSchema,
  warnings: z.array(z.string().max(2_000)).max(32),
});
export type InstalledAgent = z.infer<typeof InstalledAgentSchema>;

/** A host-ranked install: the classified agent plus which one the runtime launches. */
export const AgentInstallationSchema = InstalledAgentSchema.extend({
  origin: InstallCandidateOriginSchema,
  /** True for the executable the runtime launches for this provider. */
  active: z.boolean(),
});
export type AgentInstallation = z.infer<typeof AgentInstallationSchema>;

/** Declarative release detectors. The host executes them; adapters only declare them. */
export const ReleaseDetectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    id: DetectorIdSchema,
    channel: ReleaseChannelSchema,
    url: HttpsUrlSchema,
    /** Regular expression whose first capture group is the version. */
    versionPattern: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('github-release'),
    id: DetectorIdSchema,
    channel: ReleaseChannelSchema,
    /** A GitHub REST releases URL; the host paginates nothing beyond it. */
    url: HttpsUrlSchema,
    /** Regular expression over the tag whose first capture group is the version. */
    tagPattern: NonEmptyStringSchema,
    /** Optional pattern over the release title when the tag does not carry the version. */
    titlePattern: NonEmptyStringSchema.optional(),
    /** Whether prereleases are considered. */
    prerelease: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('npm-registry'),
    id: DetectorIdSchema,
    channel: ReleaseChannelSchema,
    package: NonEmptyStringSchema,
    distTag: NonEmptyStringSchema,
  }),
]);
export type ReleaseDetector = z.infer<typeof ReleaseDetectorSchema>;

export const ReleaseSourceKindSchema = z.enum(['native-oracle', 'text', 'github-release', 'npm-registry']);
export type ReleaseSourceKind = z.infer<typeof ReleaseSourceKindSchema>;

export const ReleaseSnapshotSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  channel: ReleaseChannelSchema,
  version: NonEmptyStringSchema,
  publishedAt: TimestampSchema.optional(),
  url: HttpsUrlSchema.optional(),
  fetchedAt: TimestampSchema,
  source: z.strictObject({
    kind: ReleaseSourceKindSchema,
    /** Detector id, or the native command for an oracle. */
    id: NonEmptyStringSchema,
  }),
});
export type ReleaseSnapshot = z.infer<typeof ReleaseSnapshotSchema>;

/** How to update one install. Only the native and package-manager commands the vendor documents. */
/** How long a vendor's updater may honestly take, when longer than the runner's default. */
const UpdateTimeoutSchema = z
  .number()
  .int()
  .min(1_000)
  .max(4 * 60 * 60_000);
const EnvironmentNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/u);

const NativeSelfUpdateRecipeSchema = z.strictObject({
  kind: z.literal('native-self-update'),
  /** Complete argv; the first entry is the executable to run. */
  argv: z.array(z.string().max(8_192)).min(1).max(32),
  timeoutMs: UpdateTimeoutSchema.optional(),
});
const NpmGlobalRecipeSchema = z.strictObject({
  kind: z.literal('npm-global'),
  package: NonEmptyStringSchema,
  /** Explicit target; defaults to the `latest` dist-tag. */
  version: NonEmptyStringSchema.optional(),
});
const BrewRecipeSchema = z.strictObject({
  kind: z.literal('brew'),
  name: NonEmptyStringSchema,
  cask: z.boolean(),
});
const InstallerScriptRecipeSchema = z.strictObject({
  /**
   * The vendor's documented install script: a first install, or run again to
   * update an install its own updater will not move (a native installer whose
   * upgrade command answers with these very instructions). Unix only: the
   * runner fetches it over https and pipes it to the vendor's shell, exactly
   * as the vendor tells a person to.
   */
  kind: z.literal('installer-script'),
  url: HttpsUrlSchema,
  /** The shell the vendor pipes the script to: bash unless the vendor documents `| sh`. */
  shell: z.enum(['bash', 'sh']).optional(),
  /** Variables the script itself documents: its install directory, leaving the shell rc alone. */
  env: z.record(EnvironmentNameSchema, z.string().max(8_192)).optional(),
  /** Commands the script itself runs that a person must already have (Node for one that installs with npm). */
  needs: z.array(CommandNameSchema).max(8).optional(),
  timeoutMs: UpdateTimeoutSchema.optional(),
});
const ManualRecipeSchema = z.strictObject({
  kind: z.literal('manual'),
  instructions: NonEmptyStringSchema,
});

export const UpdateRecipeSchema = z.discriminatedUnion('kind', [
  NativeSelfUpdateRecipeSchema,
  NpmGlobalRecipeSchema,
  BrewRecipeSchema,
  InstallerScriptRecipeSchema,
  ManualRecipeSchema,
]);
export type UpdateRecipe = z.infer<typeof UpdateRecipeSchema>;

/**
 * How to install an agent that is not installed: the vendor's documented first
 * install, through the same runner as an update. The members are the update
 * recipe's own; a native command is not one, since there is no executable yet
 * to run it.
 */
export const InstallRecipeSchema = z.discriminatedUnion('kind', [
  NpmGlobalRecipeSchema,
  BrewRecipeSchema,
  InstallerScriptRecipeSchema,
  ManualRecipeSchema,
]);
export type InstallRecipe = z.infer<typeof InstallRecipeSchema>;

export const UpdateReceiptSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  /**
   * `updated`: the version moved (re-inspection is the only evidence).
   * `unchanged`: the updater exited 0 and the version did not move — current,
   * or an updater that declined; its output says which, and a host that knows
   * of a newer release says so. `already-current` is kept for receipts written
   * before `unchanged` existed: the runner no longer claims a currency it has
   * no evidence for. `failed`: the updater did not finish (a non-zero exit, a
   * signal, a timeout, a stop). `unsupported`: the recipe is manual.
   */
  status: z.enum(['updated', 'unchanged', 'already-current', 'failed', 'unsupported']),
  recipe: UpdateRecipeSchema.optional(),
  before: InstalledAgentSchema.optional(),
  /** Fresh inspection after the command finished; the only evidence of success. */
  after: InstalledAgentSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  exitCode: z.number().int().optional(),
  /** Opaque command output kept 0600 by the host; never parsed for semantics. */
  transcriptPath: NonEmptyStringSchema.optional(),
  message: z.string().max(4_000).optional(),
});
export type UpdateReceipt = z.infer<typeof UpdateReceiptSchema>;

export const InstallReceiptSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  /**
   * `installed`: a fresh inspection found the agent after the installer ran —
   * the only evidence, whatever the exit code said. `present`: an install was
   * already there, so nothing ran; `after` is that install. `not-found`: the
   * installer exited 0 and no inspection found the agent, on the search path
   * the host gave the runtime or in the provider's install directories. `failed`: the installer did not finish (a
   * non-zero exit, a signal, a timeout, a stop), or a command it needs is not
   * on the search path (`missing`) and it never ran. `unsupported`: the
   * adapter declares no install, the recipe is manual, or the recipe cannot
   * run on this platform.
   */
  status: z.enum(['installed', 'present', 'not-found', 'failed', 'unsupported']),
  recipe: InstallRecipeSchema.optional(),
  /** Fresh inspection after the command finished, or the install already present. */
  after: InstalledAgentSchema.optional(),
  /** Commands the recipe runs from the search path that it does not hold; the installer did not run. */
  missing: z.array(CommandNameSchema).max(8).optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  exitCode: z.number().int().optional(),
  /** Opaque command output kept 0600 by the host; never parsed for semantics. */
  transcriptPath: NonEmptyStringSchema.optional(),
  message: z.string().max(4_000).optional(),
});
export type InstallReceipt = z.infer<typeof InstallReceiptSchema>;

export const DistributionFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'unavailable']),
  provider: AgentProviderIdSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
});
export type DistributionFailure = z.infer<typeof DistributionFailureSchema>;

/** Adapter-declared distribution facts a host needs before touching the machine. */
export const DistributionProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  /** Executable names the host searches on PATH. */
  commands: z.array(CommandNameSchema).min(1).max(8),
  /** npm packages whose global installs may provide the executable. */
  npmPackages: z.array(NonEmptyStringSchema).max(8),
  /** Homebrew casks or formulae that may provide the executable. */
  brewNames: z.array(NonEmptyStringSchema).max(8),
  /**
   * Directories under the home where the vendor's own installer leaves the
   * executable (`.local/bin`). The host searches them after the search path,
   * so an install a person's shell finds is found where PATH is short: an app
   * launched from the Finder has launchd's PATH, which names none of them.
   */
  installDirectories: z.array(HomeDirectorySchema).max(8).optional(),
  detectors: z.array(ReleaseDetectorSchema).max(8),
  /** True when checkUpdate() is implemented with the agent's own oracle. */
  nativeUpdateCheck: z.boolean(),
});
export type DistributionProvider = z.infer<typeof DistributionProviderSchema>;

/** One adapter-owned distribution capability, independent of live sessions. */
export interface DistributionService {
  readonly provider: DistributionProvider;
  /** Classify one host-discovered candidate and read its version; undefined when it is not this agent. */
  inspect(candidate: InstallCandidate): Promise<InstalledAgent | undefined>;
  recipeFor(install: InstalledAgent): UpdateRecipe;
  /**
   * The vendor's documented first install, for an agent this machine does not
   * have. Absent when the vendor documents none a runner can follow.
   */
  installRecipe?(): InstallRecipe;
  /** The agent's own update oracle, such as a `--check --json` subcommand. */
  checkUpdate?(install: InstalledAgent): Promise<ReleaseSnapshot | DistributionFailure>;
}
