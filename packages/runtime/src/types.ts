import type {
  AccountUsageFetchResult,
  AccountUsageProvider,
  AccountUsageService,
  AgentContinuation,
  AgentInstallation,
  AgentProfile,
  DistributionFailure,
  DistributionProvider,
  DistributionService,
  ExtensionFailure,
  ExtensionInventory,
  ExtensionProvider,
  ExtensionService,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  ProfileSet,
  ReleaseChannel,
  ReleaseSnapshot,
  UpdateReceipt,
  UpdateRecipe,
  AgentExecutionMode,
  AgentEvent,
  AgentEventEnvelope,
  AgentEventSourceRef,
  AgentHost,
  AgentLaunchProvider,
  BoundIngress,
  HostIngress,
  AgentNativeInvocation,
  AgentNativeInvocationResolution,
  AgentProviderDescriptor,
  AgentMonitorHandle,
  AgentMonitorState,
  AgentAdapterBinding,
  ExternalRef,
  MonitorNotification,
  NativeSessionRef,
  ObservationLevel,
  PromptReceipt,
  PromptSubmission,
  RuntimeRunId,
  SessionRuntimeState,
  TerminalSpec,
} from '@vibecook/puppeteer-core';
import type { ActionRecorder, ActionRecorderStatus } from '@vibecook/puppeteer-record';
import type {
  WorkspaceDiff,
  WorkspaceErrorCode,
  WorkspaceKeyedFingerprint,
  WorkspaceMode,
  Workspace,
  WorkspaceSessionMetadata,
} from '@vibecook/puppeteer-workspaces';
import type {
  CreationRequestClaimRef,
  CreationRequestRegistry,
  CreationRequestTerminalOutcome,
} from './identity/creation-registry.js';
import type { RuntimeCreationOperation } from './identity/runtime-identity.js';
import type { MonitorClock } from './monitor/clock.js';
import type { Agent } from './agent.js';

/** Provider-owned live preparation. The runtime keeps this handle private and exposes only its serializable recipe. */
export interface PreparedProviderSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentAdapterBinding>;
  dispose(): void | Promise<void>;
}

export interface AgentProviderSessionOptions {
  /** Runtime-owned join identity for private diagnostics; adapters must not reinterpret it. */
  runtimeRunId?: RuntimeRunId | undefined;
  cwd: string;
  resume?: string | undefined;
  title?: string | undefined;
  host: AgentHost;
  /** Provider-owned launch options. Built-in callers get a discriminated typed facade below. */
  agentOptions?: unknown;
  /** Registered account profile whose root the adapter binds through its own variable. */
  profile?: AgentProfile | undefined;
  /** The host's say over the session's loopback ingress (stable ingress; adapters without one ignore it). */
  ingress?: HostIngress | undefined;
}

/**
 * A provider binding for a process that is ALREADY RUNNING in a host terminal
 * (stable ingress, the restart half): the host knows the native session id it
 * persisted, the terminal it lives in, and the ingress the process was
 * launched against. The adapter rebinds its listener on that ingress, re-arms
 * its durable observation by id, and answers a binding exactly as
 * `createSession` would have — without launching anything.
 */
export interface AttachProviderSessionOptions {
  /** Runtime-owned join identity for private diagnostics; adapters must not reinterpret it. */
  runtimeRunId?: RuntimeRunId | undefined;
  /** The native session id the running process announced. */
  sessionId: string;
  /** The host's id for the terminal the process is running in. */
  runtimeSessionId: string;
  cwd: string;
  host: AgentHost;
  /** The ingress the process was launched against, when the adapter has one. */
  ingress?: BoundIngress | undefined;
  /** Provider-owned launch options the original launch carried, when the host kept them. */
  agentOptions?: unknown;
  /** Registered account profile the run was bound to. */
  profile?: AgentProfile | undefined;
}

/** Provider-private continuation codec. Its state is opaque above the adapter boundary. */
export interface AgentProviderContinuationCodec {
  capture(options: AgentProviderSessionOptions): string | undefined;
  restore(state: string | undefined, options: { cwd: string }): unknown;
}

/** Adapter-owned native launch service consumed by the generic runtime host SPI. */
export interface AgentProviderLaunchService {
  readonly provider: AgentLaunchProvider;
  normalizeInvocation?(invocation: AgentNativeInvocation): AgentNativeInvocationResolution;
  readonly continuation?: AgentProviderContinuationCodec;
}

/** A provider is the only adapter-specific seam the unified runtime consumes. */
export interface AgentProvider {
  readonly descriptor: AgentProviderDescriptor;
  /** Provider topology; defaults to native-tui for compatibility providers. */
  readonly executionMode?: AgentExecutionMode;
  createSession(options: AgentProviderSessionOptions): Promise<AgentAdapterBinding>;
  /** Adapter-owned account-wide quota capability, independent of any session. */
  readonly accountUsage?: AccountUsageService;
  /** Adapter-owned install classification, release detectors, and update recipes. */
  readonly distribution?: DistributionService;
  /** Adapter-owned account-profile binding, login, and identity verification. */
  readonly profiles?: ProfileService;
  /** Adapter-owned inventory of the agent's plugins, marketplaces, MCP servers and skills per profile. */
  readonly extensions?: ExtensionService;
  /** Adapter-owned CLI grammar, transport topology, and continuation semantics. */
  readonly launch?: AgentProviderLaunchService;
  /** Optional cache warming only: no sessions/model input; must stop promptly when the signal aborts. */
  prewarm?(options: { profile?: AgentProfile; signal: AbortSignal }): Promise<void>;
  /** Optional split-phase launch for caller-owned terminals. Generic ACP intentionally omits this capability. */
  prepareSession?(options: AgentProviderSessionOptions): Promise<PreparedProviderSession>;
  /**
   * Optional binding for a process already running in a host terminal (stable
   * ingress, the restart half). Absent = the provider cannot re-attach; a host
   * then resumes the continuation instead.
   */
  attachSession?(options: AttachProviderSessionOptions): Promise<AgentAdapterBinding>;
  dispose?(): void | Promise<void>;
}

export interface AgentWorkspaceRequest {
  mode?: WorkspaceMode | undefined;
  path?: string | undefined;
  baseRef?: string | undefined;
  branchName?: string | undefined;
  resumeBranch?: string | undefined;
  resumeRoot?: string | undefined;
  workspacesRoot?: string | undefined;
}

export interface AgentWorkspaceInfo {
  workspaceInstanceId?: string | undefined;
  /** @deprecated Use workspaceInstanceId. */
  id?: string | undefined;
  mode: WorkspaceMode;
  root: string;
  sourcePath: string;
  branch?: string | undefined;
  initialCommit?: string | undefined;
  isolation?: 'managed-isolated' | 'cooperative-exclusive' | 'shared' | 'unknown' | undefined;
  baselineCompleteness?: 'complete' | 'partial' | 'unavailable' | undefined;
  repositoryDigest?: WorkspaceKeyedFingerprint | undefined;
}

export interface CreateAgentSessionOptions {
  agent: string;
  cwd?: string | undefined;
  /** @deprecated Consumer resume uses runtime.resume({ continuation }); retained for provider/compatibility calls. */
  resume?: string | undefined;
  title?: string | undefined;
  /** Caller-scoped idempotency key. Requires a durable creation registry. */
  creationRequestId?: string | undefined;
  /** Opaque caller correlation; transported but never interpreted as policy. */
  externalRefs?: readonly ExternalRef[] | undefined;
  /** Defaults to direct mode rooted at cwd/defaultCwd. */
  workspace?: AgentWorkspaceRequest | undefined;
  /** Opaque to the runtime; interpreted only by the selected provider. */
  agentOptions?: unknown;
  /** Registered profile id; the runtime resolves it and hands the provider the profile. */
  profile?: string | undefined;
  /**
   * Run under this profile set's account for the agent; the set must hold
   * one, and a `profile` named beside it must be that account. With neither,
   * `spawn` — and only `spawn` — uses the DEFAULT set's account when it holds
   * one for the agent, else the provider's own root: resume and attach never
   * consult the default, so a run continues in the account it was born under.
   */
  profileSet?: string | undefined;
  /** The host's say over the session's loopback ingress (stable ingress). */
  ingress?: HostIngress | undefined;
}

/** Consumer-facing spawn request. Native resume identity is accepted only through resume(). */
export type SpawnAgentOptions = Omit<CreateAgentSessionOptions, 'resume'>;

/** Consumer-facing resume request: no provider argv, environment, or transport knobs. */
export interface ResumeAgentOptions {
  continuation: AgentContinuation;
  cwd?: string | undefined;
  title?: string | undefined;
  creationRequestId?: string | undefined;
  externalRefs?: readonly ExternalRef[] | undefined;
  workspace?: AgentWorkspaceRequest | undefined;
  /**
   * Registered profile id the host persisted beside the continuation. The
   * continuation already carries the account root for providers that record
   * it, so this re-binds the root explicitly and attributes the resumed run.
   */
  profile?: string | undefined;
  /** The host's say over the session's loopback ingress (stable ingress). */
  ingress?: HostIngress | undefined;
}

/** Host-only native invocation request. Adapters normalize it before normal preparation. */
export interface PrepareAgentInvocationOptions extends AgentNativeInvocation {
  title?: string | undefined;
  creationRequestId?: string | undefined;
  externalRefs?: readonly ExternalRef[] | undefined;
  workspace?: AgentWorkspaceRequest | undefined;
}

export interface AgentSessionInfo {
  /** Validated consumer-facing provider identity and label. */
  provider: AgentProviderDescriptor;
  /** @deprecated Use provider.id. */
  agent: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  terminalSessionId: string;
  nativeSession: NativeSessionRef;
  nativeSessionRevision: number;
  /** Persist this opaque token and pass it to resume(); never inspect adapter state. */
  continuation: AgentContinuation;
  externalRefs: ExternalRef[];
  /** @deprecated Use nativeSession.id. */
  sessionId: string;
  /** @deprecated Use terminalSessionId. */
  runtimeSessionId: string;
  /** Present when this session was bound to a caller-owned terminal through spawn-through. */
  preparationId?: string;
  /** External shim/vendor PID retained across exec, for caller-side lifecycle correlation. */
  processId?: number;
  workspace: AgentWorkspaceInfo;
  /** Registered profile this run is bound to, when one was selected or matched from the launch environment. */
  profileId?: string;
  /** The profile set the run was born under, when a spawn chose one or took the default set's account. */
  profileSetId?: string;
}

export type AgentSessionErrorCode =
  | WorkspaceErrorCode
  | 'AGENT_NOT_FOUND'
  | 'AGENT_PROFILE_NOT_FOUND'
  | 'AGENT_SESSION_CREATE_FAILED'
  | 'INVALID_CREATION_REQUEST_ID'
  | 'INVALID_EXTERNAL_REFS'
  | 'CREATION_REQUEST_NOT_FINGERPRINTABLE'
  | 'CREATION_CLAIM_STORE_UNAVAILABLE'
  | 'CREATION_REQUEST_CONFLICT'
  | 'CREATION_REQUEST_RECOVERY_REQUIRED'
  | 'CREATION_REQUEST_TERMINAL'
  | 'RUNTIME_RUN_CONFLICT'
  | 'RUNTIME_RESTORE_FAILED'
  | 'ATTACH_UNSUPPORTED'
  | 'ATTACH_FAILED';

export interface AgentSessionFailure {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  externalRefs: ExternalRef[];
  terminalOutcome?: CreationRequestTerminalOutcome;
  error: { code: AgentSessionErrorCode; message: string };
}

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

/** Primary object-oriented spawn result. Failures remain data so callers can render them safely. */
export type SpawnAgentResult = Agent | AgentSessionFailure;

export type PreparationErrorCode =
  | WorkspaceErrorCode
  | 'AGENT_NOT_FOUND'
  | 'AGENT_PROFILE_NOT_FOUND'
  | 'AGENT_SESSION_CREATE_FAILED'
  | 'INVALID_CREATION_REQUEST_ID'
  | 'INVALID_EXTERNAL_REFS'
  | 'CREATION_REQUEST_NOT_FINGERPRINTABLE'
  | 'CREATION_CLAIM_STORE_UNAVAILABLE'
  | 'CREATION_REQUEST_CONFLICT'
  | 'CREATION_REQUEST_RECOVERY_REQUIRED'
  | 'CREATION_REQUEST_TERMINAL'
  | 'PREPARATION_UNSUPPORTED'
  | 'PREPARATION_NOT_FOUND'
  | 'PREPARATION_EXPIRED'
  | 'PREPARATION_CANCELLED'
  | 'PREPARATION_ALREADY_ADOPTED'
  | 'RUNTIME_SESSION_CONFLICT'
  | 'PREPARATION_ADOPT_FAILED'
  | 'NATIVE_INVOCATION_UNSUPPORTED'
  | 'INVALID_NATIVE_INVOCATION';

export interface PreparationFailure {
  runtimeRunId?: RuntimeRunId;
  runtimeEpoch?: number;
  externalRefs?: ExternalRef[];
  terminalOutcome?: CreationRequestTerminalOutcome;
  error: { code: PreparationErrorCode; message: string };
}

export interface PreparedAgentSessionInfo {
  preparationId: string;
  agent: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  nativeSession: NativeSessionRef;
  nativeSessionRevision: number;
  continuation: AgentContinuation;
  externalRefs: ExternalRef[];
  /** @deprecated Use nativeSession.id. */
  sessionId: string;
  /** Execute this recipe exactly after binding the existing terminal with adoptPrepared. */
  launch: TerminalSpec;
  workspace: AgentWorkspaceInfo;
  expiresAt: string;
}

export type PrepareAgentSessionResult = PreparedAgentSessionInfo | PreparationFailure;

interface AdoptPreparedSessionIdentity {
  /** Runtime run returned by prepareSession. Optional only for compatibility callers. */
  runtimeRunId?: RuntimeRunId;
  /** PID of the shim that will be retained when it execs the real vendor CLI. */
  processId?: number;
}

export type AdoptPreparedSessionOptions = AdoptPreparedSessionIdentity &
  (
    | {
        /** Routing id of the already-existing pane/PTY. */
        terminalSessionId: string;
        /** @deprecated Use terminalSessionId. */
        runtimeSessionId?: string;
      }
    | {
        terminalSessionId?: undefined;
        /** @deprecated Use terminalSessionId. */
        runtimeSessionId: string;
      }
  );

export type AdoptPreparedSessionResult = AgentSessionInfo | PreparationFailure;

export type CancelPreparedSessionResult = { cancelled: true } | PreparationFailure;

export interface AgentProcessExit {
  exitCode: number | null;
  signal: string | null;
  reason: string;
  /** Host terminal intent used only when its outcome vocabulary is ambiguous. */
  requestedTermination?: string | null;
}

export interface AgentWorkspaceFinal {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  terminalSessionId: string;
  /** @deprecated Use terminalSessionId. */
  runtimeSessionId: string;
  metadata: WorkspaceSessionMetadata;
  retained: boolean;
  reason?: string;
}

export interface AgentRuntimeOptions {
  host: AgentHost;
  defaultCwd: string;
  providers: readonly AgentProvider[];
  recorder?: ActionRecorder;
  /** Required when callers opt into creationRequestId idempotency. */
  creationRegistry?: CreationRequestRegistry;
  onError?: (error: Error) => void;
  /** How long an unadopted preparation remains live. Default: 30 seconds. */
  preparationTtlMs?: number;
  /** Injectable wall-clock/scheduler for agent monitoring. */
  monitorClock?: MonitorClock;
  /** Ordinary monitor publication coalescing. Default: 100 ms. */
  monitorCoalesceMs?: number;
  /** Per-consumer notification FIFO capacity. Default: 256. */
  monitorNotificationCapacity?: number;
  /** Maximum unacknowledged failed monitors retained by one host. Default: 256. */
  terminalFailureCapacity?: number;
  profiles?: ProfileRuntimeOptions;
  distribution?: DistributionRuntimeOptions;
}

/** Host-injected persistence for the profile registry. */
export interface ProfileStore {
  /**
   * The persisted document, or undefined when there is none. A store should
   * hand back what `parseProfileRegistrySnapshot` made of its file; the
   * registry re-reads it through the parser either way, so a document from
   * before profile sets is adopted rather than refused.
   */
  load(): Promise<ProfileRegistrySnapshot | undefined>;
  save(snapshot: ProfileRegistrySnapshot): Promise<void>;
}

export interface ProfileRegistrySnapshot {
  version: 2;
  /** The set spawns use when they name none; absent means the native set. */
  defaultSet?: string;
  /** Managed sets, in the order they were made. The native set is synthetic and never stored. */
  sets: ProfileSet[];
  /** Managed account profiles; every one names its set. */
  profiles: AgentProfile[];
}

export interface ProfileRuntimeOptions {
  /** Defaults to ~/.puppeteer/profiles.json with atomic 0600 writes. */
  store?: ProfileStore;
  /**
   * Defaults to ~/.puppeteer/profiles. Each managed set is a directory here,
   * named once from its first name; each account's root is
   * `<set directory>/<provider>-<8 hex>`, created 0700 and never reused.
   */
  rootsDirectory?: string;
}

/** One profile set as a host lists it. */
export interface ProfileSetInfo {
  set: ProfileSet;
  /** Spawns that name no profile use this set's account for their agent. */
  isDefault: boolean;
  /**
   * The set's accounts, at most one per provider, in provider order; a
   * retired account is not one of them. The native set holds every
   * supporting provider's native default.
   */
  profiles: AgentProfile[];
}

export interface DistributionRuntimeOptions {
  /** Where opaque update transcripts are written 0600. Defaults to ~/.puppeteer/updates. */
  transcriptsDirectory?: string;
  /** Injectable fetch for release detectors; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** PATH-style list searched for candidates; defaults to process.env.PATH. */
  searchPath?: string;
}

export interface InspectInstallationsOptions {
  providerId?: string;
  /** Discard the cached inventory before inspecting. */
  refresh?: boolean;
}

export interface CheckReleasesOptions {
  providerId: string;
  /** Permit outbound requests to declared detectors; native oracles run regardless. */
  network?: boolean;
}

export interface ReleaseCheckResult {
  provider: string;
  checkedAt: string;
  installed?: AgentInstallation;
  releases: ReleaseSnapshot[];
  /** Newest release per channel that is newer than the active install. */
  behind: { channel: ReleaseChannel; version: string }[];
  /**
   * The one update the active install's own updater would take: the newest
   * release on the channel it follows (its adapter-mapped `releaseChannel`,
   * else `stable`) when that is newer than it. Absent when current or unknown.
   */
  available?: { channel: ReleaseChannel; version: string };
  failures: DistributionFailure[];
}

export interface UpdateInstallationOptions {
  providerId: string;
  /** Defaults to the active install. */
  executable?: string;
  /**
   * Opaque observer for the updater's output as it arrives, beside the 0600
   * transcript. A host may show it to the person who asked for the update;
   * nothing may parse it — the outcome is the re-inspection, never this text.
   * An observer that throws is contained and never fails the update.
   */
  onOutput?: (chunk: string) => void;
  /**
   * Aborting stops the updater and everything it started (its process group),
   * SIGTERM then SIGKILL; the receipt says it was stopped. An update may run
   * long — a gateway drained, a large fetch — and the person may stop waiting.
   */
  signal?: AbortSignal;
}

export interface UpdatePlanOptions {
  providerId: string;
  /** Defaults to the active install. */
  executable?: string;
}

/**
 * What an update would run for one install, answered before anyone runs it,
 * so a host can say which command a button will execute. Computed the way
 * {@link AgentRuntime.updateInstallation} computes it: the adapter's recipe,
 * resolved to the argv the runner would execute.
 */
export interface UpdatePlan {
  provider: string;
  /** The install this plan updates. */
  executable: string;
  recipe: UpdateRecipe;
  /** The command the runner would execute; absent when the recipe is manual. */
  argv?: string[];
}

export interface CreateProfileOptions {
  providerId: string;
  /** The managed set the account joins; it must not already hold one for the provider. */
  set?: string | undefined;
  /**
   * Without `set`: the managed set of this name that has no account for the
   * provider yet, or a new set of this name. Exactly one of the two.
   */
  label?: string | undefined;
}

export interface CreateProfileSetOptions {
  label: string;
  /** A glyph token the views draw. */
  glyph?: string | undefined;
}

export interface UpdateProfileSetOptions {
  setId: string;
  label?: string | undefined;
  /** A glyph token, or null to clear it. */
  glyph?: string | null | undefined;
}

/** What unregistering a set removed; its directory stays on disk for the host to delete. */
export interface RemovedProfileSet {
  set: ProfileSet;
  profiles: AgentProfile[];
}

/**
 * A sign-out's outcome. `ran: true` — the adapter's own sign-out ran and the
 * root reads signed out. `ran: false` — there is no vendor sign-out to run,
 * and `credential` says what deleting the managed root amounts to: `root`,
 * the provider keeps its credential inside the root, so deleting it is the
 * sign-out; `unknown`, where it keeps it has not been established, so a host
 * may delete the root but must not claim the account is signed out beyond it.
 * The host decides when the root goes.
 */
export type ProfileSignOutResult = { ran: true } | { ran: false; credential: 'root' | 'unknown' } | ProfileFailure;

export interface StartProfileLoginOptions {
  profileId: string;
  cwd?: string;
  /** One of the provider's `support.signInRoutes` ids; absent, its default login. */
  route?: string;
}

export type ProfileLoginResult = { runtimeSessionId: string; profile: AgentProfile } | ProfileFailure;

export type RuntimeRunStatus = 'allocated' | 'preparing' | 'prepared' | 'active' | 'terminal';

export interface RuntimeRunInfo {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  agent: string;
  operation: RuntimeCreationOperation;
  status: RuntimeRunStatus;
  terminalSessionId?: string;
  nativeSession?: NativeSessionRef;
  nativeSessionRevision?: number;
  externalRefs: ExternalRef[];
  creationClaim?: CreationRequestClaimRef;
  preparationId?: string;
  terminalOutcome?: CreationRequestTerminalOutcome;
}

export type RuntimeSourceEventRef = AgentEventSourceRef;

export interface RuntimeAgentEventEnvelope<T extends AgentEvent = AgentEvent> extends AgentEventEnvelope<T> {
  eventId: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  sourceEventRef?: RuntimeSourceEventRef;
}

/**
 * Re-attach a run to a process that outlived the host (stable ingress): the
 * host hands back what it persisted at launch — the run's durable identity
 * (creation request, run id, the epoch it last saw), the native session id,
 * the terminal, the cwd and the ingress — and the runtime asks the provider
 * for a binding to the running process, rebuilds the workspace, and restores
 * the run at the next epoch. A provider without `attachSession` answers
 * `ATTACH_UNSUPPORTED`; a host then resumes the continuation instead.
 */
export interface AttachAgentOptions {
  agent: string;
  creationRequestId: string;
  runtimeRunId: RuntimeRunId;
  expectedRuntimeEpoch: number;
  /** The native session id the running process announced (persisted by the host). */
  sessionId: string;
  /** The host's id for the terminal the process is running in. */
  terminalSessionId: string;
  cwd: string;
  /** The ingress the process was launched against, when the adapter has one. */
  ingress?: BoundIngress | undefined;
  /** Registered profile id the run was bound to. */
  profile?: string | undefined;
  /** Provider-owned launch options the original launch carried, when the host kept them. */
  agentOptions?: unknown;
  /** The workspace the run was launched in; defaults to direct mode at `cwd`. */
  workspace?: AgentWorkspaceRequest | undefined;
  externalRefs?: readonly ExternalRef[] | undefined;
}

/** Explicit host reconstruction after loss of runtime continuity. */
export interface RestoreAgentSessionOptions {
  creationRequestId: string;
  runtimeRunId: RuntimeRunId;
  expectedRuntimeEpoch: number;
  agent: string;
  session: AgentAdapterBinding;
  workspace: Workspace;
  externalRefs?: readonly ExternalRef[];
  /**
   * The process behind the binding is ALIVE (an attach, stable ingress): a
   * bind failure must not mark its durable claim terminal — the claim stays
   * allocated at the advanced epoch for the host to re-sync from — and only
   * this runtime's provisional run is dropped.
   */
  attaching?: boolean | undefined;
}

/** The single application-facing surface for every agent provider. */
export interface AgentRuntime {
  /** Primary API: spawn one provider and receive its per-run Agent event surface. */
  spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult>;
  /** Resume an opaque continuation without provider-specific launch knowledge. */
  resume(options: ResumeAgentOptions): Promise<SpawnAgentResult>;
  /** Resolve a live Agent by terminal-session id or runtime-run id. */
  agent(id: string): Agent | undefined;
  /** Enumerate every composed provider without exposing adapter implementation details. */
  providers(): readonly AgentProviderDescriptor[];
  /** Enumerate every adapter that advertises account usage. */
  accountUsageProviders(): readonly AccountUsageProvider[];
  /** Fetch account-wide usage for a provider, or for one registered profile; concurrent calls are coalesced per target. */
  accountUsage(providerId: string, profileId?: string): Promise<AccountUsageFetchResult>;
  /** Enumerate adapter-declared launch capabilities for terminal hosts and product discovery. */
  launchProviders(): readonly AgentLaunchProvider[];
  /** Warm a provider's native caches in the background; unsupported providers are a no-op. */
  prewarm(providerId: string, profileId?: string): Promise<void>;
  /** Enumerate every adapter that advertises distribution facts. */
  distributionProviders(): readonly DistributionProvider[];
  /** Discover and classify installed executables; cached until refresh. */
  inspectInstallations(options?: InspectInstallationsOptions): Promise<AgentInstallation[]>;
  /** Compare the active install against native oracles and declared release detectors. */
  checkReleases(options: CheckReleasesOptions): Promise<ReleaseCheckResult>;
  /** Run the adapter's update recipe and re-inspect; the receipt is evidence, not parsed output. */
  updateInstallation(options: UpdateInstallationOptions): Promise<UpdateReceipt>;
  /** What {@link updateInstallation} would run for an install, without running it. */
  planUpdate(options: UpdatePlanOptions): Promise<UpdatePlan | DistributionFailure>;
  /** Enumerate every adapter that advertises account profiles. */
  profileProviders(): readonly ProfileProvider[];
  /** Registered profiles plus one synthetic native-default profile per supporting provider. */
  profiles(providerId?: string): Promise<AgentProfile[]>;
  profile(profileId: string): Promise<AgentProfile | undefined>;
  /**
   * Allocate an immutable managed root inside a profile set's directory and
   * register it; the account is empty until login.
   */
  createProfile(options: CreateProfileOptions): Promise<AgentProfile | ProfileFailure>;
  /** Unregister a managed profile. The root stays on disk; deleting it is the user's decision. */
  removeProfile(profileId: string): Promise<boolean>;
  /**
   * Take a managed account out of its set and out of new spawns and resumes
   * while sessions still run under it; it stays registered until the host has
   * let them end and calls {@link removeProfile}.
   */
  retireProfile(profileId: string): Promise<AgentProfile | ProfileFailure>;
  /**
   * The adapter's native sign-out, for a credential kept outside the root; run
   * before a host deletes a managed root, or to sign a native default out. A
   * managed account must be retired first, and is refused (`invalid`) while a
   * run of this runtime still uses it: a sign-out under a live session would
   * take its credential mid-run.
   */
  signOutProfile(profileId: string): Promise<ProfileSignOutResult>;
  /** The native set first, then every managed set in the order it was made. */
  profileSets(): Promise<ProfileSetInfo[]>;
  profileSet(setId: string): Promise<ProfileSetInfo | undefined>;
  /** Make a set and its directory; it holds no account until one is created in it. */
  createProfileSet(options: CreateProfileSetOptions): Promise<ProfileSetInfo | ProfileFailure>;
  /** Rename a managed set (its accounts take the name) or change its glyph; its directory never moves. */
  updateProfileSet(options: UpdateProfileSetOptions): Promise<ProfileSetInfo | ProfileFailure>;
  /** The set spawns use when they name no profile. */
  setDefaultProfileSet(setId: string): Promise<ProfileSetInfo | ProfileFailure>;
  /**
   * Unregister a managed set that is not the default, and every account in
   * it. The directory stays on disk; deleting it is the host's decision.
   */
  removeProfileSet(setId: string): Promise<RemovedProfileSet | ProfileFailure>;
  /** Merged binding variables for a set of profiles, at most one per provider, for seeding a host terminal. */
  profileBindingEnvironment(profileIds: readonly string[]): Promise<Record<string, string>>;
  /**
   * The directory an external history indexer applies the provider's own layout
   * to for this profile. It is the adapter's rule, not `dataRoot`: Pi and
   * OpenCode bind a level away from the layout root. Undefined when the profile
   * or its provider is unknown.
   */
  profileObservationRoot(profileId: string): Promise<string | undefined>;
  /** Spawn the native login in a host terminal bound to the profile root. */
  startProfileLogin(options: StartProfileLoginOptions): Promise<ProfileLoginResult>;
  /** Re-read native identity for a profile and persist it on the registry entry. */
  verifyProfile(profileId: string): Promise<ProfileIdentity | ProfileFailure>;
  onProfilesChanged(listener: (profiles: AgentProfile[]) => void): () => void;
  /** Enumerate every adapter that advertises extensions, with how its agent keeps each kind. */
  extensionProviders(): readonly ExtensionProvider[];
  /**
   * One profile's plugins, marketplaces, MCP servers and skills, read from the
   * agent's own stores and protocols (RFC 006 C1); the provider's native
   * default when no profile is named. Never connects to an MCP server and never
   * returns a secret. Concurrent reads of one profile coalesce.
   */
  extensionInventory(providerId: string, profileId?: string): Promise<ExtensionInventory | ExtensionFailure>;
  /** @deprecated Compatibility/IPC surface. Use spawn() to receive an Agent. */
  createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  /** Host SPI: normalize a native CLI invocation and prepare its adapter-owned recipe. */
  prepareInvocation(options: PrepareAgentInvocationOptions): Promise<PrepareAgentSessionResult>;
  /** Low-level provider-composition API. Terminal hosts use prepareInvocation(). */
  prepareSession(options: CreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
  adoptPrepared(preparationId: string, options: AdoptPreparedSessionOptions): Promise<AdoptPreparedSessionResult>;
  restoreSession(options: RestoreAgentSessionOptions): Promise<CreateAgentSessionResult>;
  /** Re-attach a run to a process that outlived the host (see {@link AttachAgentOptions}). */
  attach(options: AttachAgentOptions): Promise<CreateAgentSessionResult>;
  cancelPrepared(preparationId: string): Promise<CancelPreparedSessionResult>;
  runtimeRunInfo(runtimeRunId: RuntimeRunId): RuntimeRunInfo | undefined;
  monitorState(runtimeRunId: RuntimeRunId): AgentMonitorState | undefined;
  observeMonitor(runtimeRunId: RuntimeRunId): AgentMonitorHandle;
  onMonitorState(listener: (state: AgentMonitorState) => void): () => void;
  onMonitorNotification(listener: (notice: MonitorNotification) => void): () => void;
  onMonitorRemoved(listener: (runtimeRunId: RuntimeRunId) => void): () => void;
  acknowledgeFailureBlocker(runtimeRunId: RuntimeRunId, blockerId: string): Promise<boolean>;
  /** Best-effort audit-log health; undefined when recording is not configured. */
  recordingStatus(): ActionRecorderStatus | undefined;
  onRecordingStatus(listener: (status: ActionRecorderStatus) => void): () => void;
  sessionInfo(terminalSessionId: string): AgentSessionInfo | undefined;
  /** @deprecated Read agent(id)?.state. */
  sessionState(terminalSessionId: string): SessionRuntimeState | undefined;
  /** @deprecated Read agent(id)?.observationLevel. */
  observationLevel(terminalSessionId: string): ObservationLevel | undefined;
  /** @deprecated Subscribe with agent.on(selector, listener). */
  onEvent(listener: (terminalSessionId: string, envelope: RuntimeAgentEventEnvelope) => void): () => void;
  /**
   * Subscribe to push-style account-usage updates from providers that support them.
   * Independent of session events; account quotas are usually process-global.
   */
  onAccountUsage(listener: (provider: AccountUsageProvider, result: AccountUsageFetchResult) => void): () => void;
  /** @deprecated Call agent(id)?.submitPrompt(submission). */
  submitPrompt(terminalSessionId: string, submission: PromptSubmission): Promise<PromptReceipt>;
  workspaceDiff(terminalSessionId: string): Promise<WorkspaceDiff | null>;
  handleProcessExit(terminalSessionId: string, exit: AgentProcessExit): Promise<AgentWorkspaceFinal | undefined>;
  /**
   * Tear the runtime down. With `detach`, the managed sessions are RELEASED
   * rather than closed (stable ingress): their processes, terminals and
   * workspaces live on, their durable claims stay allocated, no exit is
   * dispatched — the host that comes back re-attaches through `attach`.
   */
  dispose(options?: DisposeAgentRuntimeOptions): Promise<AgentWorkspaceFinal[]>;
}

export interface DisposeAgentRuntimeOptions {
  /** Release the sessions for a later re-attach instead of closing them. */
  detach?: boolean | undefined;
}
