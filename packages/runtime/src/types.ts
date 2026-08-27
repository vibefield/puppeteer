import type {
  AccountUsageFetchResult,
  AccountUsageProvider,
  AccountUsageService,
  AgentContinuation,
  AgentExecutionMode,
  AgentEvent,
  AgentEventEnvelope,
  AgentEventSourceRef,
  AgentHost,
  AgentLaunchProvider,
  AgentNativeInvocation,
  AgentNativeInvocationResolution,
  AgentProviderDescriptor,
  AgentMonitorHandle,
  AgentMonitorState,
  AgentAdapterBinding,
  ExternalRef,
  MonitorArtifactReadResult,
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
import type { AgentConversationSnapshot } from './services/conversation-service.js';
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
  runtimeRunId?: RuntimeRunId;
  cwd: string;
  resume?: string;
  title?: string;
  host: AgentHost;
  /** Provider-owned launch options. Built-in callers get a discriminated typed facade below. */
  agentOptions?: unknown;
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
  /** Adapter-owned CLI grammar, transport topology, and continuation semantics. */
  readonly launch?: AgentProviderLaunchService;
  /** Optional split-phase launch for caller-owned terminals. Generic ACP intentionally omits this capability. */
  prepareSession?(options: AgentProviderSessionOptions): Promise<PreparedProviderSession>;
  dispose?(): void | Promise<void>;
}

export interface AgentWorkspaceRequest {
  mode?: WorkspaceMode;
  path?: string;
  baseRef?: string;
  branchName?: string;
  resumeBranch?: string;
  resumeRoot?: string;
  workspacesRoot?: string;
}

export interface AgentWorkspaceInfo {
  workspaceInstanceId?: string;
  /** @deprecated Use workspaceInstanceId. */
  id?: string;
  mode: WorkspaceMode;
  root: string;
  sourcePath: string;
  branch?: string;
  initialCommit?: string;
  isolation?: 'managed-isolated' | 'cooperative-exclusive' | 'shared' | 'unknown';
  baselineCompleteness?: 'complete' | 'partial' | 'unavailable';
  repositoryDigest?: WorkspaceKeyedFingerprint;
}

export interface CreateAgentSessionOptions {
  agent: string;
  cwd?: string;
  /** @deprecated Consumer resume uses runtime.resume({ continuation }); retained for provider/compatibility calls. */
  resume?: string;
  title?: string;
  /** Caller-scoped idempotency key. Requires a durable creation registry. */
  creationRequestId?: string;
  /** Opaque caller correlation; transported but never interpreted as policy. */
  externalRefs?: readonly ExternalRef[];
  /** Defaults to direct mode rooted at cwd/defaultCwd. */
  workspace?: AgentWorkspaceRequest;
  /** Opaque to the runtime; interpreted only by the selected provider. */
  agentOptions?: unknown;
}

/** Consumer-facing spawn request. Native resume identity is accepted only through resume(). */
export type SpawnAgentOptions = Omit<CreateAgentSessionOptions, 'resume'>;

/** Consumer-facing resume request: no provider argv, environment, or transport knobs. */
export interface ResumeAgentOptions {
  continuation: AgentContinuation;
  cwd?: string;
  title?: string;
  creationRequestId?: string;
  externalRefs?: readonly ExternalRef[];
  workspace?: AgentWorkspaceRequest;
}

/** Host-only native invocation request. Adapters normalize it before normal preparation. */
export interface PrepareAgentInvocationOptions extends AgentNativeInvocation {
  title?: string;
  creationRequestId?: string;
  externalRefs?: readonly ExternalRef[];
  workspace?: AgentWorkspaceRequest;
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
}

export type AgentSessionErrorCode =
  | WorkspaceErrorCode
  | 'AGENT_NOT_FOUND'
  | 'AGENT_SESSION_CREATE_FAILED'
  | 'INVALID_CREATION_REQUEST_ID'
  | 'INVALID_EXTERNAL_REFS'
  | 'CREATION_REQUEST_NOT_FINGERPRINTABLE'
  | 'CREATION_CLAIM_STORE_UNAVAILABLE'
  | 'CREATION_REQUEST_CONFLICT'
  | 'CREATION_REQUEST_RECOVERY_REQUIRED'
  | 'CREATION_REQUEST_TERMINAL'
  | 'RUNTIME_RUN_CONFLICT'
  | 'RUNTIME_RESTORE_FAILED';

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
}

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

/** Explicit host reconstruction after loss of runtime continuity. */
export interface RestoreAgentSessionOptions {
  creationRequestId: string;
  runtimeRunId: RuntimeRunId;
  expectedRuntimeEpoch: number;
  agent: string;
  session: AgentAdapterBinding;
  workspace: Workspace;
  externalRefs?: readonly ExternalRef[];
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
  /** Fetch account-wide usage for a provider; concurrent calls for one provider are coalesced. */
  accountUsage(providerId: string): Promise<AccountUsageFetchResult>;
  /** Enumerate adapter-declared launch capabilities for terminal hosts and product discovery. */
  launchProviders(): readonly AgentLaunchProvider[];
  /** @deprecated Compatibility/IPC surface. Use spawn() to receive an Agent. */
  createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  /** Host SPI: normalize a native CLI invocation and prepare its adapter-owned recipe. */
  prepareInvocation(options: PrepareAgentInvocationOptions): Promise<PrepareAgentSessionResult>;
  /** Low-level provider-composition API. Terminal hosts use prepareInvocation(). */
  prepareSession(options: CreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
  adoptPrepared(preparationId: string, options: AdoptPreparedSessionOptions): Promise<AdoptPreparedSessionResult>;
  restoreSession(options: RestoreAgentSessionOptions): Promise<CreateAgentSessionResult>;
  cancelPrepared(preparationId: string): Promise<CancelPreparedSessionResult>;
  runtimeRunInfo(runtimeRunId: RuntimeRunId): RuntimeRunInfo | undefined;
  monitorState(runtimeRunId: RuntimeRunId): AgentMonitorState | undefined;
  observeMonitor(runtimeRunId: RuntimeRunId): AgentMonitorHandle;
  onMonitorState(listener: (state: AgentMonitorState) => void): () => void;
  onMonitorNotification(listener: (notice: MonitorNotification) => void): () => void;
  onMonitorRemoved(listener: (runtimeRunId: RuntimeRunId) => void): () => void;
  acknowledgeFailureBlocker(runtimeRunId: RuntimeRunId, blockerId: string): Promise<boolean>;
  readMonitorArtifact(
    runtimeRunId: RuntimeRunId,
    artifactId: string,
    options?: { maxBytes?: number },
  ): Promise<MonitorArtifactReadResult>;
  /** Best-effort audit-log health; undefined when recording is not configured. */
  recordingStatus(): ActionRecorderStatus | undefined;
  onRecordingStatus(listener: (status: ActionRecorderStatus) => void): () => void;
  sessionInfo(terminalSessionId: string): AgentSessionInfo | undefined;
  /** @deprecated Read agent(id)?.state. */
  sessionState(terminalSessionId: string): SessionRuntimeState | undefined;
  /** @deprecated Read agent(id)?.observationLevel. */
  observationLevel(terminalSessionId: string): ObservationLevel | undefined;
  /** @deprecated Read agent(id)?.conversation. */
  conversationSnapshot(terminalSessionId: string): AgentConversationSnapshot | undefined;
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
  dispose(): Promise<AgentWorkspaceFinal[]>;
}
