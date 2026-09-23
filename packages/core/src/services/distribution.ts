import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';

/**
 * Provider-neutral distribution contracts: where an agent executable is
 * installed, how it got there, which releases exist upstream, and how the
 * agent's own updater is invoked.
 *
 * Puppeteer never reimplements an installer or updater. The host discovers
 * candidate executables (PATH, the configured executable, package roots)
 * because that machinery is provider-neutral; the adapter classifies one
 * candidate and reads its version because install fingerprints and version
 * grammar are provider facts. An update runs the native command and the
 * outcome is a fresh inspection, never parsed updater output.
 */

const NonEmptyStringSchema = z.string().trim().min(1).max(8_192);
const TimestampSchema = z.iso.datetime({ offset: true });
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'release endpoints must use https' });
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

export const InstallCandidateOriginSchema = z.enum(['configured', 'path', 'npm-global', 'brew']);
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
export const UpdateRecipeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('native-self-update'),
    /** Complete argv; the first entry is the executable to run. */
    argv: z.array(z.string().max(8_192)).min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal('npm-global'),
    package: NonEmptyStringSchema,
    /** Explicit target; defaults to the `latest` dist-tag. */
    version: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('brew'),
    name: NonEmptyStringSchema,
    cask: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('manual'),
    instructions: NonEmptyStringSchema,
  }),
]);
export type UpdateRecipe = z.infer<typeof UpdateRecipeSchema>;

export const UpdateReceiptSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  status: z.enum(['updated', 'already-current', 'failed', 'unsupported']),
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
  /** The agent's own update oracle, such as a `--check --json` subcommand. */
  checkUpdate?(install: InstalledAgent): Promise<ReleaseSnapshot | DistributionFailure>;
}
