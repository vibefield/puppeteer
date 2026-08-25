import type {
  AccountUsageFetchResult,
  AgentExecutionMode,
  AgentEvent,
  AgentEventEnvelope,
  AgentEventSourceRef,
  AgentHost,
  AgentMonitorHandle,
  AgentMonitorState,
  AgentAdapterSession,
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
import type { CreateAcpSessionOptions } from '@vibecook/puppeteer-adapter-acp';
import type { ClaudeHookDiagnostic, ClaudeSettingSource } from '@vibecook/puppeteer-adapter-claude';
import type { CreateCodexTuiSessionOptions } from '@vibecook/puppeteer-adapter-codex';
import type { CreateGrokSessionOptions } from '@vibecook/puppeteer-adapter-grok';
import type { CreateKimiTuiSessionOptions } from '@vibecook/puppeteer-adapter-kimi';
import type { CreateOpenCodeTuiSessionOptions } from '@vibecook/puppeteer-adapter-opencode';
import type { CreateHermesTuiSessionOptions } from '@vibecook/puppeteer-adapter-hermes';
import type { AgentConversationSnapshot } from './conversation.js';
import type {
  CreationRequestClaimRef,
  CreationRequestRegistry,
  CreationRequestTerminalOutcome,
} from './creation-registry.js';
import type { RuntimeCreationOperation } from './identity.js';
import type { MonitorClock } from './monitor-clock.js';
import type { Agent } from './agent.js';

/** Built-in provider ids. Applications select one; implementation stays here. */
export type BuiltinAgentKind = 'claude' | 'codex' | 'acp' | 'grok' | 'kimi' | 'opencode' | 'hermes';
export type BuiltinExecutableAgentKind = Exclude<BuiltinAgentKind, 'acp'>;

export interface ClaudeAgentOptions {
  /** Claude Code permission mode. Kept open because the CLI's modes evolve. */
  permissionMode?: string;
  /** Claude model alias or full model id. */
  model?: string;
  /** Claude effort value. Kept open because provider values evolve. */
  effort?: string;
  /** Claude settings layers selected by `--setting-sources`. */
  settingSources?: readonly ClaudeSettingSource[];
  /** Claude user configuration root when the launching pane overrides `CLAUDE_CONFIG_DIR`. */
  configDir?: string;
  /** Opt into Claude's matcher-gated FileChanged hook. */
  fileChangeMatcher?: string;
  /** Observe malformed known hooks without interrupting the native session. */
  onDiagnostic?: (diagnostic: ClaudeHookDiagnostic) => void;
  /** Native resume/continue argv retained when the CLI must choose identity interactively. */
  resumeInvocation?: string[];
  /**
   * Binary for this session only, overriding the runtime's configured one.
   *
   * The case this exists for is an emulated session beside real ones: an app
   * points a single session at the puppeteer imposter while every other
   * session still launches the user's real Claude Code. `PUPPETEER_CLAUDE_BIN`
   * is the same capability applied to the whole process, which is exactly what
   * makes it unusable for that.
   */
  executable?: string;
}

/**
 * `executable` is the same per-session override {@link ClaudeAgentOptions}
 * documents, and it reaches further here: the codex recipe spawns a private
 * app-server BESIDE the terminal, so this one binary answers both processes.
 */
export type CodexAgentOptions = Pick<
  CreateCodexTuiSessionOptions,
  'model' | 'sandbox' | 'approvalPolicy' | 'onApproval' | 'resumeInvocation' | 'executable' | 'appServerEnv'
>;

export type AcpAgentOptions = Omit<CreateAcpSessionOptions, 'cwd' | 'resume' | 'connector'> & {
  /** Per-session connector override; otherwise the runtime's configured ACP connector is used. */
  connector?: CreateAcpSessionOptions['connector'];
};

export type GrokAgentOptions = Omit<CreateGrokSessionOptions, 'cwd' | 'resume'> & {
  /** Per-session Grok binary override; leader, ACP, and TUI all use it. */
  executable?: string;
  /** Environment shared across Grok's three processes and persisted-log observer. */
  appServerEnv?: Record<string, string>;
};

/** Native Kimi TUI options; runtime identity, cwd, and host stay provider-owned. */
export type KimiAgentOptions = Omit<CreateKimiTuiSessionOptions, 'cwd' | 'resume' | 'host'>;

/** Native OpenCode options; runtime identity, cwd, title, and host stay provider-owned. */
export type OpenCodeAgentOptions = Omit<CreateOpenCodeTuiSessionOptions, 'cwd' | 'resume' | 'title' | 'host'>;

/** Native Hermes TUI options; runtime identity, cwd, and host stay provider-owned. */
export type HermesAgentOptions = Omit<CreateHermesTuiSessionOptions, 'cwd' | 'resume' | 'host' | 'transport'>;

/** Provider-owned live preparation. The runtime keeps this handle private and exposes only its serializable recipe. */
export interface PreparedProviderSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentAdapterSession>;
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

/** A provider is the only adapter-specific seam the unified runtime consumes. */
export interface AgentProvider {
  readonly kind: string;
  /** Provider topology; defaults to native-tui for compatibility providers. */
  readonly executionMode?: AgentExecutionMode;
  createSession(options: AgentProviderSessionOptions): Promise<AgentAdapterSession>;
  /** Fetch account-wide subscription/API quota state, independent of any session. */
  fetchAccountUsage?(): Promise<AccountUsageFetchResult>;
  /**
   * Optional push channel for live account-usage updates that do not require polling
   * (e.g. Claude status-line rate_limits). Returns an unsubscribe function.
   */
  onAccountUsage?(listener: (result: AccountUsageFetchResult) => void): () => void;
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

type BuiltinCreateBase = Omit<CreateAgentSessionOptions, 'agent' | 'agentOptions'>;

/** Type-safe launch options for the turn-key built-in provider set. */
export type BuiltinCreateAgentSessionOptions =
  | (BuiltinCreateBase & { agent: 'claude'; agentOptions?: ClaudeAgentOptions })
  | (BuiltinCreateBase & { agent: 'codex'; agentOptions?: CodexAgentOptions })
  | (BuiltinCreateBase & { agent: 'acp'; agentOptions?: AcpAgentOptions })
  | (BuiltinCreateBase & { agent: 'grok'; agentOptions?: GrokAgentOptions })
  | (BuiltinCreateBase & { agent: 'kimi'; agentOptions?: KimiAgentOptions })
  | (BuiltinCreateBase & { agent: 'opencode'; agentOptions?: OpenCodeAgentOptions })
  | (BuiltinCreateBase & { agent: 'hermes'; agentOptions?: HermesAgentOptions });

export interface AgentSessionInfo {
  agent: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  terminalSessionId: string;
  nativeSession: NativeSessionRef;
  nativeSessionRevision: number;
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
  | 'PREPARATION_ADOPT_FAILED';

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
  /** Typed rollout flags; omitted values preserve the v1-only runtime. */
  features?: Partial<RuntimeFeatureFlags>;
  /** Injectable wall-clock/scheduler used only by monitor v2. */
  monitorClock?: MonitorClock;
  /** Ordinary monitor publication coalescing. Default: 100 ms. */
  monitorCoalesceMs?: number;
  /** Per-consumer notification FIFO capacity. Default: 256. */
  monitorNotificationCapacity?: number;
  /** Maximum unacknowledged failed monitors retained by one host. Default: 256. */
  terminalFailureCapacity?: number;
}

export interface RuntimeFeatureFlags {
  agentMonitorStateV2: boolean;
  claudeSubagentStatusObservation: boolean;
  workspaceProvenanceV2: boolean;
}

export const DEFAULT_RUNTIME_FEATURE_FLAGS: Readonly<RuntimeFeatureFlags> = Object.freeze({
  agentMonitorStateV2: false,
  claudeSubagentStatusObservation: false,
  workspaceProvenanceV2: false,
});

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
  session: AgentAdapterSession;
  workspace: Workspace;
  externalRefs?: readonly ExternalRef[];
}

/** The single application-facing surface for every agent provider. */
export interface AgentRuntime {
  /** Primary API: spawn one provider and receive its per-run Agent event surface. */
  spawn(options: CreateAgentSessionOptions): Promise<SpawnAgentResult>;
  /** Resolve a live Agent by terminal-session id or runtime-run id. */
  agent(id: string): Agent | undefined;
  /** Fetch account-wide usage for a provider; concurrent calls for one provider are coalesced. */
  accountUsage(agent: string): Promise<AccountUsageFetchResult>;
  /** @deprecated Compatibility/IPC surface. Use spawn() to receive an Agent. */
  createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
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
  onAccountUsage(listener: (agent: string, result: AccountUsageFetchResult) => void): () => void;
  /** @deprecated Call agent(id)?.submitPrompt(submission). */
  submitPrompt(terminalSessionId: string, submission: PromptSubmission): Promise<PromptReceipt>;
  workspaceDiff(terminalSessionId: string): Promise<WorkspaceDiff | null>;
  handleProcessExit(terminalSessionId: string, exit: AgentProcessExit): Promise<AgentWorkspaceFinal | undefined>;
  dispose(): Promise<AgentWorkspaceFinal[]>;
}

/** Built-in runtime facade whose selected agent discriminates its launch options. */
export type BuiltinAgentRuntime = Omit<AgentRuntime, 'spawn' | 'createSession' | 'prepareSession'> & {
  spawn(options: BuiltinCreateAgentSessionOptions): Promise<SpawnAgentResult>;
  createSession(options: BuiltinCreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  prepareSession(options: BuiltinCreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
};
