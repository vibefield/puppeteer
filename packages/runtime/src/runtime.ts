import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  agentEventCategory,
  agentEventType,
  isAgentEventType,
  safeParseAgentEvent,
  AdapterEventCandidateSchema,
  type AccountUsageFetchResult,
  type AdapterEventCandidate,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventEnvelope,
  type AgentEventSource,
  type AgentMonitorState,
  type AgentAdapterBinding,
  type ExternalRef,
  type MonitorNotification,
  type PromptReceipt,
  type PromptSubmission,
  type ProcessExitReason,
  type SessionRuntimeState,
  type TerminalSpec,
} from '@vibecook/puppeteer-core';
import {
  createOwnActionRecordId,
  type ActionRecorderStatus,
  type OwnActionV2Input,
  type OwnActionV2InputFor,
  type WorkspaceCleanupOutcomeV2,
  type WorkspaceFinalizationTriggerV2,
} from '@vibecook/puppeteer-record';
import {
  createWorkspace,
  workspaceIdentity,
  WorkspaceError,
  type Workspace,
  type WorkspaceErrorCode,
  type WorkspaceMode,
  type WorkspaceRequest,
  type WorkspaceFinalizationRecord,
  type WorkspaceSessionMetadata,
} from '@vibecook/puppeteer-workspaces';
import type { MonitorWorkspaceProvenanceState } from '@vibecook/puppeteer-core/monitor-spi';
import type {
  AdoptPreparedSessionOptions,
  AdoptPreparedSessionResult,
  AgentProcessExit,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionFailure,
  AgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  CancelPreparedSessionResult,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PreparationFailure,
  PreparedAgentSessionInfo,
  PreparedProviderSession,
  PrepareAgentSessionResult,
  RestoreAgentSessionOptions,
  RuntimeAgentEventEnvelope,
  RuntimeRunInfo,
} from './types.js';
import { cloneAgentSessionInfo, createAgentController, type Agent, type AgentController } from './agent.js';
import { createGitStateObserver, type GitStateObserver } from './observation/git.js';
import {
  allocateRuntimeRunIdentity,
  canonicalizeCreationFingerprint,
  createNativeSessionClaim,
  reviseNativeSessionClaim,
  RuntimeIdentityError,
  type RevisionedNativeSessionClaim,
  type RuntimeCreationOperation,
  type RuntimeRunIdentity,
} from './identity/runtime-identity.js';
import type {
  CreationRequestClaim,
  CreationRequestClaimRef,
  CreationRequestTerminalOutcome,
} from './identity/creation-registry.js';
import { createSystemMonitorClock } from './monitor/clock.js';
import { AgentMonitorService, type MonitorArtifactAudit } from './services/monitor-service.js';

interface ManagedSession {
  session: AgentAdapterBinding;
  agent: Agent;
  agentController: AgentController;
  run: ManagedRun;
  info: AgentSessionInfo;
  workspace: Workspace;
  unsubscribe: () => void;
  releaseClaim: () => void;
  currentConcurrentClaims: () => number;
  gitObserver?: GitStateObserver;
  preparationId?: string;
  dispatch(event: AgentEvent, source: AgentEventSource, confidence: AgentEventConfidence, nativeEvent?: unknown): void;
}

interface WorkspaceLease {
  workspace: Workspace;
  releaseClaim: () => void;
  currentConcurrentClaims: () => number;
}

interface WorkspaceLeaseFailure {
  error: { code: WorkspaceErrorCode; message: string };
}

interface RuntimeWorkspaceFinalization {
  metadata?: WorkspaceSessionMetadata;
  retained: boolean;
  cleanupOutcome: WorkspaceCleanupOutcomeV2;
  reason?: string;
}

function activeMonitorLifecycle(lifecycle: SessionRuntimeState['lifecycle']): 'starting' | 'running' | 'stopping' {
  if (lifecycle === 'preparing' || lifecycle === 'starting') return 'starting';
  if (lifecycle === 'terminating') return 'stopping';
  // Provider/control state cannot prove host process death. Until the host
  // reports the exit, ready/running/interrupting and even a terminal-looking
  // observer snapshot remain an alive runtime run.
  return 'running';
}

type PreparationStatus = 'prepared' | 'adopting' | 'adopted';

interface ManagedPreparation extends WorkspaceLease {
  id: string;
  provider: AgentProvider;
  run: ManagedRun;
  prepared: PreparedProviderSession;
  status: PreparationStatus;
  timer: ReturnType<typeof setTimeout>;
  adoptedRuntimeSessionId?: string;
  adoptedProcessId?: number;
  adoption?: Promise<AdoptPreparedSessionResult>;
  adoptedInfo?: AgentSessionInfo;
}

interface ManagedRun {
  identity: RuntimeRunIdentity;
  operation: RuntimeCreationOperation;
  status: RuntimeRunInfo['status'];
  terminalSessionId?: string;
  nativeSessionClaim?: RevisionedNativeSessionClaim;
  nativeSessionRecordId?: string;
  recordedNativeSessionRevision?: number;
  creationClaim?: CreationRequestClaimRef;
  preparationId?: string;
  terminalOutcome?: CreationRequestTerminalOutcome;
  result?: CreateAgentSessionResult | PrepareAgentSessionResult;
  monitor?: AgentMonitorService;
}

interface TerminalFailureEntry {
  info: RuntimeRunInfo;
  monitor: AgentMonitorService;
}

interface PreparationTombstone {
  kind: 'expired' | 'cancelled';
  run: ManagedRun;
}

interface InflightCreation {
  operation: RuntimeCreationOperation;
  canonicalFingerprint: string;
  run: ManagedRun;
  promise: Promise<CreateAgentSessionResult | PrepareAgentSessionResult>;
}

/**
 * Drivers may use a transcript to enrich reducer state while also receiving the
 * same assistant text from a live hook/protocol stream. Applications should not
 * have to know that. Prefer the live stream when the session reports one, while
 * retaining transcript messages for native-log-only providers.
 */
function isCanonicalApplicationEvent(session: AgentAdapterBinding, envelope: AgentEventEnvelope): boolean {
  if (envelope.event.type !== 'conversation:assistant-message' || envelope.source !== 'native-transcript') return true;
  if (envelope.replay) return true;
  const level = session.observationLevel();
  return level !== 'native-hooks' && level !== 'structured';
}

function workspaceInfo(workspace: Workspace): AgentWorkspaceInfo {
  return {
    workspaceInstanceId: workspace.workspaceInstanceId,
    id: workspace.id,
    mode: workspace.mode,
    root: workspace.root,
    sourcePath: workspace.sourcePath,
    branch: workspace.branch,
    initialCommit: workspace.initialCommit,
    isolation: workspace.baseline.isolation,
    baselineCompleteness: workspace.baseline.completeness,
    ...(workspace.baseline.repository.digest === undefined
      ? {}
      : { repositoryDigest: { ...workspace.baseline.repository.digest } }),
  };
}

function workspaceMonitorProvenance(
  workspace: Workspace,
  finalization?: WorkspaceFinalizationRecord,
  cleanup?: Pick<RuntimeWorkspaceFinalization, 'cleanupOutcome' | 'retained'>,
): MonitorWorkspaceProvenanceState {
  const baseline = workspace.baseline;
  return {
    workspaceInstanceId: workspace.workspaceInstanceId,
    allocation: {
      mode: workspace.mode,
      repositoryKind: baseline.repository.kind,
      ...(baseline.repository.digest ? { repositoryDigest: { ...baseline.repository.digest } } : {}),
    },
    baseline: {
      capturedAt: baseline.capturedAt,
      isolation: baseline.isolation,
      knownConcurrentClaims: baseline.knownConcurrentClaims,
      quality: baseline.quality,
      completeness: baseline.completeness,
      limitations: [...baseline.limitations],
      git: {
        ...baseline.git,
        index: { ...baseline.git.index },
        worktree: { ...baseline.git.worktree },
        ...(baseline.git.indexFingerprint ? { indexFingerprint: { ...baseline.git.indexFingerprint } } : {}),
        ...(baseline.git.worktreeFingerprint ? { worktreeFingerprint: { ...baseline.git.worktreeFingerprint } } : {}),
      },
      initialDirtyFileCount: baseline.initialDirtyFiles.length,
    },
    ...(finalization
      ? {
          finalization: {
            finalizedAt: finalization.finalizedAt,
            outcome: finalization.outcome,
            repositoryKind: finalization.repository.kind,
            ...(finalization.repository.digest ? { repositoryDigest: { ...finalization.repository.digest } } : {}),
            git: {
              ...finalization.git,
              index: { ...finalization.git.index },
              worktree: { ...finalization.git.worktree },
              ...(finalization.git.indexFingerprint
                ? { indexFingerprint: { ...finalization.git.indexFingerprint } }
                : {}),
              ...(finalization.git.worktreeFingerprint
                ? { worktreeFingerprint: { ...finalization.git.worktreeFingerprint } }
                : {}),
            },
            reachableCommits: {
              ...finalization.reachableCommits,
              commits: [...finalization.reachableCommits.commits],
            },
            changes: {
              filesTouchedCount: finalization.changes.filesTouchedCount,
              ...(finalization.changes.filesFingerprint
                ? { filesFingerprint: { ...finalization.changes.filesFingerprint } }
                : {}),
              insertions: finalization.changes.insertions,
              deletions: finalization.changes.deletions,
            },
            knownConcurrentClaims: finalization.knownConcurrentClaims,
            cleanupOutcome: cleanup?.cleanupOutcome ?? 'not-applicable',
            retained: cleanup?.retained ?? false,
            quality: finalization.quality,
            completeness: finalization.completeness,
            limitations: [...finalization.limitations],
          },
        }
      : {}),
    interference: finalization?.interference.map((entry) => ({ ...entry })) ?? [],
    completeness: finalization?.completeness ?? baseline.completeness,
  };
}

function failedWorkspaceMonitorProvenance(
  workspace: Workspace,
  finalizedAt: string,
  code: string,
  cleanup: Pick<RuntimeWorkspaceFinalization, 'cleanupOutcome' | 'retained'>,
): MonitorWorkspaceProvenanceState {
  return {
    ...workspaceMonitorProvenance(workspace),
    finalization: {
      finalizedAt,
      outcome: 'failed',
      repositoryKind: workspace.baseline.repository.kind,
      ...(workspace.baseline.repository.digest
        ? { repositoryDigest: { ...workspace.baseline.repository.digest } }
        : {}),
      cleanupOutcome: cleanup.cleanupOutcome,
      retained: cleanup.retained,
      quality: 'unknown',
      completeness: 'unavailable',
      limitations: [code],
    },
    interference: [{ kind: 'observation-gap', observedAt: finalizedAt }],
    completeness: 'unavailable',
  };
}

function cloneLaunch(launch: TerminalSpec): TerminalSpec {
  return {
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    env: launch.env ? { ...launch.env } : undefined,
    cols: launch.cols,
    rows: launch.rows,
  };
}

function identityFields(identity: RuntimeRunIdentity): {
  runtimeRunId: string;
  runtimeEpoch: number;
  externalRefs: ExternalRef[];
} {
  return {
    runtimeRunId: identity.runtimeRunId,
    runtimeEpoch: identity.runtimeEpoch,
    externalRefs: identity.externalRefs.map((ref) => ({ ...ref })),
  };
}

function preparationFailure(
  code: PreparationFailure['error']['code'],
  message: string,
  run?: ManagedRun,
  terminalOutcome?: CreationRequestTerminalOutcome,
): PreparationFailure {
  return {
    ...(run ? identityFields(run.identity) : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    error: { code, message },
  };
}

function runInfo(run: ManagedRun): RuntimeRunInfo {
  return {
    ...identityFields(run.identity),
    agent: run.identity.providerId,
    operation: run.operation,
    status: run.status,
    ...(run.terminalSessionId ? { terminalSessionId: run.terminalSessionId } : {}),
    ...(run.nativeSessionClaim
      ? {
          nativeSession: { ...run.nativeSessionClaim.value },
          nativeSessionRevision: run.nativeSessionClaim.revision,
        }
      : {}),
    ...(run.preparationId ? { preparationId: run.preparationId } : {}),
    ...(run.creationClaim ? { creationClaim: { ...run.creationClaim } } : {}),
    ...(run.terminalOutcome ? { terminalOutcome: run.terminalOutcome } : {}),
  };
}

function sourceDerivedEventId(runtimeRunId: string, source: NonNullable<AgentEventEnvelope['sourceEventRef']>): string {
  const digest = createHash('sha256')
    .update(runtimeRunId)
    .update('\0')
    .update(
      JSON.stringify([
        source.namespace,
        source.eventId,
        source.revisionKey ?? null,
        source.sourceGeneration ?? null,
        source.cursorStart ?? null,
        source.cursorEnd ?? null,
      ]),
    )
    .digest('hex');
  return `source:${digest}`;
}

const MAX_ACKNOWLEDGED_FAILURE_BLOCKERS = 1_024;
const MAX_SOURCE_EVENT_IDENTITIES = 20_000;
const DEFAULT_TERMINAL_FAILURE_CAPACITY = 256;
const MAX_TERMINAL_RUN_INFOS = 1_024;

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const providers = new Map(options.providers.map((provider) => [provider.kind, provider]));
  const monitorClock = options.monitorClock ?? createSystemMonitorClock();
  const runs = new Map<string, ManagedRun>();
  const terminalFailuresByRunId = new Map<string, TerminalFailureEntry>();
  const terminalRunInfos = new Map<string, RuntimeRunInfo>();
  const sessionsByRunId = new Map<string, ManagedSession>();
  const sessionsByTerminalId = new Map<string, ManagedSession>();
  const preparations = new Map<string, ManagedPreparation>();
  const preparationTombstones = new Map<string, PreparationTombstone>();
  const preparationCleanups = new Map<string, Promise<void>>();
  const workspaceFinalizations = new WeakMap<Workspace, Promise<RuntimeWorkspaceFinalization>>();
  const inflightCreations = new Map<string, InflightCreation>();
  const claims = new Map<string, Map<symbol, 'direct' | 'exclusive'>>();
  const listeners = new Set<(terminalSessionId: string, envelope: RuntimeAgentEventEnvelope) => void>();
  const monitorStateListeners = new Set<(state: AgentMonitorState) => void>();
  const monitorNotificationListeners = new Set<(notification: MonitorNotification) => void>();
  const monitorRemovedListeners = new Set<(runtimeRunId: string) => void>();
  const acknowledgedFailureBlockers = new Set<string>();
  const accountUsageListeners = new Set<(agent: string, result: AccountUsageFetchResult) => void>();
  const accountUsageInflight = new Map<string, Promise<AccountUsageFetchResult>>();
  const preparationTtlMs = options.preparationTtlMs ?? 30_000;
  const terminalFailureCapacity = options.terminalFailureCapacity ?? DEFAULT_TERMINAL_FAILURE_CAPACITY;
  if (!Number.isFinite(preparationTtlMs) || preparationTtlMs <= 0) {
    throw new Error('preparationTtlMs must be a positive finite number');
  }
  if (!Number.isSafeInteger(terminalFailureCapacity) || terminalFailureCapacity <= 0) {
    throw new Error('terminalFailureCapacity must be a positive safe integer');
  }
  let disposed = false;

  const report = (err: unknown): void => options.onError?.(err instanceof Error ? err : new Error(String(err)));

  function actionBase(
    run: ManagedRun,
    semanticActionKey: string,
    effectiveAt?: string,
  ): Pick<
    OwnActionV2Input,
    | 'recordId'
    | 'runtimeRunId'
    | 'runtimeEpoch'
    | 'effectiveAt'
    | 'quality'
    | 'completeness'
    | 'terminalSessionId'
    | 'nativeSession'
  > {
    return {
      recordId: createOwnActionRecordId(run.identity.runtimeRunId, semanticActionKey),
      runtimeRunId: run.identity.runtimeRunId,
      runtimeEpoch: run.identity.runtimeEpoch,
      quality: 'exact',
      completeness: 'complete',
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
      ...(run.terminalSessionId === undefined ? {} : { terminalSessionId: run.terminalSessionId }),
      ...(run.nativeSessionClaim === undefined ? {} : { nativeSession: { ...run.nativeSessionClaim.value } }),
    };
  }

  async function recordAction(action: OwnActionV2Input): Promise<void> {
    try {
      await options.recorder?.recordV2(action);
    } catch (error) {
      // Custom recorder implementations still cannot interrupt the process path.
      report(error);
    }
  }

  function fanOutMonitorState(state: AgentMonitorState): void {
    for (const listener of monitorStateListeners) {
      try {
        listener(state);
      } catch (error) {
        report(error);
      }
    }
  }

  function fanOutMonitorNotification(notification: MonitorNotification): void {
    for (const listener of monitorNotificationListeners) {
      try {
        listener(notification);
      } catch (error) {
        report(error);
      }
    }
  }

  function recordArtifactAudit(run: ManagedRun, audit: MonitorArtifactAudit): Promise<void> {
    const attemptId = randomUUID();
    return recordAction({
      ...actionBase(run, `artifact-read:${run.identity.runtimeEpoch}:${attemptId}`, monitorClock.now().toISOString()),
      type: 'artifact.read',
      artifactId: audit.artifactId,
      maxBytes: audit.maxBytes,
      outcome: audit.outcome,
      ...(audit.returnedBytes === undefined ? {} : { returnedBytes: audit.returnedBytes }),
      ...(audit.mediaType === undefined ? {} : { mediaType: audit.mediaType }),
    });
  }

  function installRunMonitor(run: ManagedRun): void {
    if (run.monitor) return;
    const provider = providers.get(run.identity.providerId);
    run.monitor = new AgentMonitorService({
      runtimeRunId: run.identity.runtimeRunId,
      runtimeEpoch: run.identity.runtimeEpoch,
      providerId: run.identity.providerId,
      executionMode: provider?.executionMode ?? 'native-tui',
      observationLevel: 'terminal-only',
      allocatedAt: monitorClock.now().toISOString(),
      clock: monitorClock,
      ...(options.monitorCoalesceMs === undefined ? {} : { coalesceMs: options.monitorCoalesceMs }),
      ...(options.monitorNotificationCapacity === undefined
        ? {}
        : { notificationCapacity: options.monitorNotificationCapacity }),
      onState: fanOutMonitorState,
      onNotification: fanOutMonitorNotification,
      onArtifactAudit: (audit) => recordArtifactAudit(run, audit),
      onError: report,
    });
  }

  function startRunMonitor(run: ManagedRun): void {
    installRunMonitor(run);
    run.monitor?.start();
  }

  function discardRunMonitor(run: ManagedRun): void {
    run.monitor?.remove();
    run.monitor = undefined;
  }

  function removeRunMonitor(run: ManagedRun): void {
    const monitor = run.monitor;
    if (!monitor) return;
    monitor.remove();
    run.monitor = undefined;
    publishMonitorRemoved(run.identity.runtimeRunId);
  }

  function publishMonitorRemoved(runtimeRunId: string): void {
    for (const listener of monitorRemovedListeners) {
      try {
        listener(runtimeRunId);
      } catch (error) {
        report(error);
      }
    }
  }

  function rememberTerminalRunInfo(info: RuntimeRunInfo): void {
    terminalRunInfos.delete(info.runtimeRunId);
    terminalRunInfos.set(info.runtimeRunId, info);
    while (terminalRunInfos.size > MAX_TERMINAL_RUN_INFOS) {
      const oldest = terminalRunInfos.keys().next().value as string | undefined;
      if (!oldest) break;
      terminalRunInfos.delete(oldest);
    }
  }

  function removeTerminalFailure(runtimeRunId: string, rememberInfo = true): boolean {
    const retained = terminalFailuresByRunId.get(runtimeRunId);
    if (!retained) return false;
    terminalFailuresByRunId.delete(runtimeRunId);
    retained.monitor.remove();
    publishMonitorRemoved(runtimeRunId);
    if (rememberInfo) rememberTerminalRunInfo(retained.info);
    return true;
  }

  function retainTerminalFailure(run: ManagedRun): void {
    const monitor = run.monitor;
    if (!monitor) {
      // Allocation/preparation can fail before the canonical monitor service is
      // constructed. Release that incomplete run instead of retaining it.
      if (!terminalFailuresByRunId.has(run.identity.runtimeRunId)) releaseTerminalRun(run);
      return;
    }
    monitor.freeze();
    run.monitor = undefined;
    runs.delete(run.identity.runtimeRunId);
    terminalRunInfos.delete(run.identity.runtimeRunId);
    terminalFailuresByRunId.delete(run.identity.runtimeRunId);
    terminalFailuresByRunId.set(run.identity.runtimeRunId, { info: runInfo(run), monitor });
    while (terminalFailuresByRunId.size > terminalFailureCapacity) {
      const oldest = terminalFailuresByRunId.keys().next().value as string | undefined;
      if (!oldest) break;
      removeTerminalFailure(oldest);
    }
  }

  function releaseTerminalRun(run: ManagedRun): void {
    runs.delete(run.identity.runtimeRunId);
    rememberTerminalRunInfo(runInfo(run));
  }

  function recordRunAllocated(run: ManagedRun, completeness: 'complete' | 'partial' = 'complete'): Promise<void> {
    return recordAction({
      ...actionBase(run, 'run.allocated'),
      type: 'run.allocated',
      completeness,
      providerId: run.identity.providerId,
      operation: run.operation,
      externalRefs: run.identity.externalRefs.map((ref) => ({ ...ref })),
      ...(run.creationClaim === undefined ? {} : { creationClaim: { ...run.creationClaim } }),
    });
  }

  function recordRunStartFailure(
    run: ManagedRun,
    stage: OwnActionV2InputFor<'run.start-failed'>['stage'],
    code: string,
  ): Promise<void> {
    return recordAction({
      ...actionBase(run, `run.start-failed:${run.identity.runtimeEpoch}:${stage}:${code}`, new Date().toISOString()),
      type: 'run.start-failed',
      stage,
      code,
    });
  }

  function recordPolicyConflict(
    run: ManagedRun,
    code: string,
    policy: OwnActionV2InputFor<'policy.conflict'>['policy'],
  ): Promise<void> {
    const conflictId = randomUUID();
    return recordAction({
      ...actionBase(run, `policy-conflict:${run.identity.runtimeEpoch}:${conflictId}`, new Date().toISOString()),
      type: 'policy.conflict',
      code,
      policy,
    });
  }

  async function recordWorkspaceEvidence(run: ManagedRun, workspace: Workspace): Promise<void> {
    const baseline = workspace.baseline;
    await recordAction({
      ...actionBase(run, `workspace:${workspace.workspaceInstanceId}:allocated`, baseline.capturedAt),
      type: 'workspace.allocated',
      workspaceInstanceId: workspace.workspaceInstanceId,
      mode: workspace.mode,
      ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
      repositoryKind: baseline.repository.kind,
      ...(baseline.repository.digest === undefined ? {} : { repositoryDigest: { ...baseline.repository.digest } }),
      isolation: baseline.isolation,
      knownConcurrentClaims: baseline.knownConcurrentClaims,
    });
    await recordAction({
      ...actionBase(run, `workspace:${workspace.workspaceInstanceId}:baseline`, baseline.capturedAt),
      type: 'workspace.baseline',
      quality: baseline.quality,
      completeness: baseline.completeness,
      workspaceInstanceId: workspace.workspaceInstanceId,
      ...(workspace.initialCommit === undefined ? {} : { initialCommit: workspace.initialCommit }),
      initialDirtyFileCount: workspace.initialDirtyFiles.length,
      capturedAt: baseline.capturedAt,
      git: baseline.git,
    });
    run.monitor?.acceptWorkspace({
      kind: 'workspace',
      schemaVersion: 1,
      recordId: `workspace:${workspace.workspaceInstanceId}:topology`,
      observedAt: monitorClock.now().toISOString(),
      source: { id: 'runtime-workspace', kind: 'workspace-allocation' },
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      evidence: [{ namespace: 'workspace', id: workspace.workspaceInstanceId }],
      operation: 'upsert',
      value: {
        kind: 'environment',
        cwd: workspace.root,
        worktrees: workspace.mode === 'worktree' ? [workspace.root] : [],
      },
    });
    run.monitor?.acceptWorkspace({
      kind: 'workspace',
      schemaVersion: 1,
      recordId: `workspace:${workspace.workspaceInstanceId}:provenance-baseline`,
      observedAt: monitorClock.now().toISOString(),
      source: { id: 'runtime-workspace', kind: 'workspace-provenance' },
      quality: baseline.quality,
      completeness: baseline.completeness,
      provisional: false,
      evidence: [{ namespace: 'workspace', id: `${workspace.workspaceInstanceId}:baseline` }],
      operation: 'provenance',
      value: workspaceMonitorProvenance(workspace),
    });
  }

  function recordProcessSpawned(
    run: ManagedRun,
    terminalSessionId: string,
    processId?: number,
    restored = false,
  ): Promise<void> {
    return recordAction({
      ...actionBase(run, `process:${run.identity.runtimeEpoch}:spawned`, new Date().toISOString()),
      type: 'process.spawned',
      terminalSessionId,
      ...(processId === undefined ? {} : { processId }),
      ...(restored ? { restored: true } : {}),
    });
  }

  function recordNativeSessionCorrelation(
    run: ManagedRun,
    effectiveAt = new Date().toISOString(),
    evidence?: { namespace: string; id: string; revisionKey?: string },
  ): Promise<void> {
    const claim = run.nativeSessionClaim;
    if (!claim || run.recordedNativeSessionRevision === claim.revision) return Promise.resolve();
    const previousRecordId = run.nativeSessionRecordId;
    const semanticActionKey = `native-session:${run.identity.runtimeEpoch}:${claim.revision}`;
    const recordId = createOwnActionRecordId(run.identity.runtimeRunId, semanticActionKey);
    run.recordedNativeSessionRevision = claim.revision;
    run.nativeSessionRecordId = recordId;
    return recordAction({
      ...actionBase(run, semanticActionKey, effectiveAt),
      type: 'native-session.correlated',
      recordId,
      nativeSession: { ...claim.value },
      nativeSessionRevision: claim.revision,
      ...(evidence === undefined ? {} : { evidence: [evidence] }),
      ...(previousRecordId === undefined ? {} : { correctionOfRecordId: previousRecordId }),
    });
  }

  function processExitReason(exit: AgentProcessExit): ProcessExitReason {
    switch (exit.reason) {
      case 'completed':
      case 'user-terminated':
      case 'runtime-terminated':
      case 'signal':
      case 'crash':
      case 'spawn-failed':
      case 'workspace-failed':
        return exit.reason;
      // Ghosttea owns the terminal process and reports its more specific exit
      // vocabulary at the app/runtime boundary. Normalize those outcomes here
      // so an expected host termination never becomes an `unknown` crash.
      case 'application-terminated':
      case 'service-terminated':
        return 'runtime-terminated';
      case 'crashed':
        return 'crash';
      case 'signaled':
        return 'signal';
      default:
        if (exit.requestedTermination === 'user') return 'user-terminated';
        if (exit.requestedTermination === 'application' || exit.requestedTermination === 'service-shutdown') {
          return 'runtime-terminated';
        }
        // Some terminal hosts only report that the adopted PID disappeared.
        // A concrete signal or non-zero exit is still failure evidence; null
        // process data is not, and must remain an unclassified exit.
        if (exit.signal !== null) return 'signal';
        if (exit.exitCode !== null && exit.exitCode !== 0) return 'crash';
        return 'unknown';
    }
  }

  function allocateRun(
    request: CreateAgentSessionOptions,
    operation: RuntimeCreationOperation,
  ): { run: ManagedRun; validationError?: RuntimeIdentityError } {
    const runtimeRunId = randomUUID();
    try {
      const run: ManagedRun = {
        identity: allocateRuntimeRunIdentity({
          providerId: request.agent,
          creationRequestId: request.creationRequestId,
          externalRefs: request.externalRefs,
          runtimeRunId,
        }),
        operation,
        status: 'allocated',
      };
      runs.set(runtimeRunId, run);
      installRunMonitor(run);
      return { run };
    } catch (error) {
      if (!(error instanceof RuntimeIdentityError)) throw error;
      const run: ManagedRun = {
        identity: {
          runtimeRunId,
          runtimeEpoch: 1,
          providerId: request.agent,
          externalRefs: [],
        },
        operation,
        status: 'terminal',
        terminalOutcome: { kind: 'failed', code: error.code },
      };
      runs.set(runtimeRunId, run);
      installRunMonitor(run);
      return { run, validationError: error };
    }
  }

  function sessionFailure(
    run: ManagedRun,
    code: AgentSessionFailure['error']['code'],
    message: string,
    terminalOutcome = run.terminalOutcome,
  ): AgentSessionFailure {
    return {
      ...identityFields(run.identity),
      ...(terminalOutcome ? { terminalOutcome } : {}),
      error: { code, message },
    };
  }

  function operationFailure(
    run: ManagedRun,
    code: AgentSessionFailure['error']['code'] | PreparationFailure['error']['code'],
    message: string,
    terminalOutcome = run.terminalOutcome,
  ): AgentSessionFailure | PreparationFailure {
    return run.operation === 'create'
      ? sessionFailure(run, code as AgentSessionFailure['error']['code'], message, terminalOutcome)
      : preparationFailure(code as PreparationFailure['error']['code'], message, run, terminalOutcome);
  }

  async function markRunTerminal(
    run: ManagedRun,
    outcome: CreationRequestTerminalOutcome,
    retention: { deferFailureRetention?: boolean } = {},
  ): Promise<void> {
    run.status = 'terminal';
    run.terminalOutcome = outcome;
    startRunMonitor(run);
    if (outcome.kind === 'failed') {
      const current = run.monitor?.current();
      const alreadyPublishedByHostExit =
        current !== undefined &&
        !current.alive &&
        current.blockers.some(
          (blocker) =>
            blocker.id === 'run:runtime' && blocker.kind === 'failure' && blocker.failure?.code === outcome.code,
        );
      if (!alreadyPublishedByHostExit) {
        run.monitor?.updateRun('failed', {
          alive: false,
          code: outcome.code,
          detail: `Run failed: ${outcome.code}`,
          recoverable: false,
        });
      }
    } else if (run.monitor?.current().alive) {
      run.monitor.updateRun('exited', { alive: false });
    }
    const creationRequestId = run.identity.creationRequestId;
    if (creationRequestId && options.creationRegistry) {
      try {
        await options.creationRegistry.markTerminal({
          creationRequestId,
          runtimeRunId: run.identity.runtimeRunId,
          runtimeEpoch: run.identity.runtimeEpoch,
          outcome,
        });
      } catch (error) {
        report(error);
      }
    }
    if (outcome.kind === 'failed' && !retention.deferFailureRetention) retainTerminalFailure(run);
  }

  function creationFingerprint(
    operation: RuntimeCreationOperation,
    request: CreateAgentSessionOptions,
    externalRefs: readonly ExternalRef[],
  ): string {
    const cwd = request.cwd ?? options.defaultCwd;
    const workspace = {
      mode: request.workspace?.mode ?? 'direct',
      path: request.workspace?.path ?? cwd,
      ...(request.workspace?.baseRef === undefined ? {} : { baseRef: request.workspace.baseRef }),
      ...(request.workspace?.branchName === undefined ? {} : { branchName: request.workspace.branchName }),
      ...(request.workspace?.resumeBranch === undefined ? {} : { resumeBranch: request.workspace.resumeBranch }),
      ...(request.workspace?.resumeRoot === undefined ? {} : { resumeRoot: request.workspace.resumeRoot }),
      ...(request.workspace?.workspacesRoot === undefined ? {} : { workspacesRoot: request.workspace.workspacesRoot }),
    };
    return canonicalizeCreationFingerprint({
      operation,
      agent: request.agent,
      cwd,
      workspace,
      externalRefs,
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
    });
  }

  function runFromClaim(
    request: CreateAgentSessionOptions,
    claim: CreationRequestClaim,
    compatiblePayload = true,
  ): ManagedRun {
    const current = runs.get(claim.runtimeRunId);
    if (current) {
      current.creationClaim ??= { ...claim.ref };
      return current;
    }
    const retainedFailure = terminalFailuresByRunId.get(claim.runtimeRunId);
    if (retainedFailure) {
      return {
        identity: {
          runtimeRunId: retainedFailure.info.runtimeRunId,
          runtimeEpoch: retainedFailure.info.runtimeEpoch,
          providerId: retainedFailure.info.agent,
          creationRequestId: request.creationRequestId,
          externalRefs: retainedFailure.info.externalRefs.map((ref) => ({ ...ref })),
        },
        operation: retainedFailure.info.operation,
        status: 'terminal',
        terminalSessionId: retainedFailure.info.terminalSessionId,
        terminalOutcome: retainedFailure.info.terminalOutcome,
        creationClaim: { ...claim.ref },
        monitor: retainedFailure.monitor,
      };
    }
    const run: ManagedRun = {
      identity: compatiblePayload
        ? allocateRuntimeRunIdentity({
            providerId: request.agent,
            creationRequestId: request.creationRequestId,
            externalRefs: request.externalRefs,
            runtimeRunId: claim.runtimeRunId,
            runtimeEpoch: claim.runtimeEpoch,
          })
        : {
            runtimeRunId: claim.runtimeRunId,
            runtimeEpoch: claim.runtimeEpoch,
            providerId: 'unknown',
            externalRefs: [],
          },
      operation: claim.operation,
      status: claim.state === 'terminal' ? 'terminal' : 'allocated',
      creationClaim: { ...claim.ref },
      ...(claim.terminalOutcome ? { terminalOutcome: claim.terminalOutcome } : {}),
    };
    if (compatiblePayload) {
      if (claim.state !== 'terminal' || claim.terminalOutcome?.kind === 'failed') {
        runs.set(run.identity.runtimeRunId, run);
        installRunMonitor(run);
        startRunMonitor(run);
      }
      if (claim.terminalOutcome?.kind === 'failed') {
        run.monitor?.updateRun('failed', {
          alive: false,
          code: claim.terminalOutcome.code,
          detail: `Run failed: ${claim.terminalOutcome.code}`,
          recoverable: false,
        });
        retainTerminalFailure(run);
      } else if (claim.state === 'terminal') {
        rememberTerminalRunInfo(runInfo(run));
      }
    }
    return run;
  }

  function terminalClaimFailure(run: ManagedRun): AgentSessionFailure | PreparationFailure {
    return operationFailure(
      run,
      'CREATION_REQUEST_TERMINAL',
      `creation request already reached a terminal outcome for run ${run.identity.runtimeRunId}`,
      run.terminalOutcome,
    );
  }

  function beginCreation<T extends CreateAgentSessionResult | PrepareAgentSessionResult>(
    operation: RuntimeCreationOperation,
    request: CreateAgentSessionOptions,
    execute: (run: ManagedRun) => Promise<T>,
  ): Promise<T> {
    const accepted = allocateRun(request, operation);
    const proposedRun = accepted.run;
    if (accepted.validationError) {
      const failure = operationFailure(
        proposedRun,
        accepted.validationError.code,
        accepted.validationError.message,
      ) as T;
      proposedRun.result = failure;
      return (async () => {
        await markRunTerminal(proposedRun, { kind: 'failed', code: accepted.validationError!.code });
        await recordRunAllocated(proposedRun, 'partial');
        await recordRunStartFailure(proposedRun, 'validation', accepted.validationError!.code);
        return failure;
      })();
    }

    const creationRequestId = proposedRun.identity.creationRequestId;
    if (!creationRequestId) {
      startRunMonitor(proposedRun);
      const promise = (async () => {
        await recordRunAllocated(proposedRun);
        return execute(proposedRun);
      })();
      promise.then((result) => (proposedRun.result = result), report);
      return promise;
    }

    let canonicalFingerprint: string;
    try {
      canonicalFingerprint = creationFingerprint(operation, request, proposedRun.identity.externalRefs);
    } catch (error) {
      if (!(error instanceof RuntimeIdentityError)) throw error;
      proposedRun.status = 'terminal';
      proposedRun.terminalOutcome = { kind: 'failed', code: error.code };
      const failure = operationFailure(proposedRun, error.code, error.message) as T;
      proposedRun.result = failure;
      return (async () => {
        await markRunTerminal(proposedRun, { kind: 'failed', code: error.code });
        await recordRunAllocated(proposedRun, 'partial');
        await recordRunStartFailure(proposedRun, 'validation', error.code);
        return failure;
      })();
    }

    const inflight = inflightCreations.get(creationRequestId);
    if (inflight) {
      runs.delete(proposedRun.identity.runtimeRunId);
      discardRunMonitor(proposedRun);
      if (inflight.operation !== operation || inflight.canonicalFingerprint !== canonicalFingerprint) {
        const failure = operationFailure(
          inflight.run,
          'CREATION_REQUEST_CONFLICT',
          `creationRequestId is already bound to a different request: ${creationRequestId}`,
        ) as T;
        return (async () => {
          await recordPolicyConflict(inflight.run, 'CREATION_REQUEST_CONFLICT', 'runtime-identity');
          return failure;
        })();
      }
      return inflight.promise as Promise<T>;
    }

    const promise = (async (): Promise<T> => {
      if (!options.creationRegistry) {
        await markRunTerminal(proposedRun, { kind: 'failed', code: 'CREATION_CLAIM_STORE_UNAVAILABLE' });
        await recordRunAllocated(proposedRun, 'partial');
        await recordRunStartFailure(proposedRun, 'binding', 'CREATION_CLAIM_STORE_UNAVAILABLE');
        return operationFailure(
          proposedRun,
          'CREATION_CLAIM_STORE_UNAVAILABLE',
          'creationRequestId requires an available durable creation registry',
        ) as T;
      }

      let claimResult;
      try {
        claimResult = await options.creationRegistry.claim({
          creationRequestId,
          canonicalFingerprint,
          proposedRuntimeRunId: proposedRun.identity.runtimeRunId,
          operation,
        });
      } catch (error) {
        await markRunTerminal(proposedRun, { kind: 'failed', code: 'CREATION_CLAIM_STORE_UNAVAILABLE' });
        report(error);
        await recordRunAllocated(proposedRun, 'partial');
        await recordRunStartFailure(proposedRun, 'binding', 'CREATION_CLAIM_STORE_UNAVAILABLE');
        return operationFailure(
          proposedRun,
          'CREATION_CLAIM_STORE_UNAVAILABLE',
          'durable creation request allocation failed before workspace or process creation',
        ) as T;
      }

      if (claimResult.status === 'conflict') {
        runs.delete(proposedRun.identity.runtimeRunId);
        discardRunMonitor(proposedRun);
        const claimedRun = runFromClaim(request, claimResult.claim, false);
        await recordPolicyConflict(claimedRun, 'CREATION_REQUEST_CONFLICT', 'runtime-identity');
        return operationFailure(
          claimedRun,
          'CREATION_REQUEST_CONFLICT',
          `creationRequestId is already bound to a different request: ${creationRequestId}`,
        ) as T;
      }

      if (claimResult.status === 'existing') {
        runs.delete(proposedRun.identity.runtimeRunId);
        discardRunMonitor(proposedRun);
        const claimedRun = runFromClaim(request, claimResult.claim);
        if (claimedRun.status === 'terminal') return terminalClaimFailure(claimedRun) as T;
        if (claimedRun.result) return claimedRun.result as T;
        return operationFailure(
          claimedRun,
          'CREATION_REQUEST_RECOVERY_REQUIRED',
          `run ${claimedRun.identity.runtimeRunId} is allocated but is not restored in this runtime host`,
        ) as T;
      }

      proposedRun.creationClaim = { ...claimResult.claim.ref };
      startRunMonitor(proposedRun);
      await recordRunAllocated(proposedRun);
      const result = await execute(proposedRun);
      proposedRun.result = result;
      return result;
    })();

    const entry: InflightCreation = { operation, canonicalFingerprint, run: proposedRun, promise };
    inflightCreations.set(creationRequestId, entry);
    const clear = () => {
      if (inflightCreations.get(creationRequestId) === entry) inflightCreations.delete(creationRequestId);
    };
    promise.then(clear, clear);
    return promise;
  }

  const providerAccountUsageUnsubs = [...providers.values()]
    .map((provider) => {
      if (!provider.onAccountUsage) return undefined;
      return provider.onAccountUsage((result) => {
        if (disposed) return;
        for (const listener of accountUsageListeners) {
          try {
            listener(provider.kind, result);
          } catch (error) {
            report(error);
          }
        }
      });
    })
    .filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined);

  function rememberTombstone(preparationId: string, tombstone: PreparationTombstone): void {
    preparationTombstones.set(preparationId, tombstone);
    if (preparationTombstones.size > 1_024) {
      const oldest = preparationTombstones.keys().next().value as string | undefined;
      if (oldest) preparationTombstones.delete(oldest);
    }
  }

  async function cleanupWorkspace(workspace: Workspace): Promise<{
    retained: boolean;
    cleanupOutcome: WorkspaceCleanupOutcomeV2;
    reason?: string;
  }> {
    if (workspace.mode !== 'worktree' && workspace.mode !== 'copy') {
      return { retained: false, cleanupOutcome: 'not-applicable' };
    }
    let retained = false;
    let reason: string | undefined;
    try {
      await workspace.destroy();
      return { retained, cleanupOutcome: 'removed' };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'WORKSPACE_DIRTY') {
        retained = true;
        reason = error.message;
        return { retained, cleanupOutcome: 'retained-dirty', reason };
      }
      report(error);
      return { retained: true, cleanupOutcome: 'failed', reason: 'workspace cleanup failed' };
    }
  }

  function triggerForExit(reason: ProcessExitReason | undefined): WorkspaceFinalizationTriggerV2 {
    if (reason === undefined) return 'runtime-disposal';
    if (reason === 'completed') return 'clean-exit';
    if (reason === 'unknown') return 'unclassified-exit';
    if (reason === 'user-terminated' || reason === 'runtime-terminated') return 'cancellation';
    return 'crash';
  }

  function finalizeWorkspace(
    run: ManagedRun,
    lease: WorkspaceLease,
    trigger: WorkspaceFinalizationTriggerV2,
  ): Promise<RuntimeWorkspaceFinalization> {
    const existing = workspaceFinalizations.get(lease.workspace);
    if (existing) return existing;
    const { workspace } = lease;
    const finalization = (async (): Promise<RuntimeWorkspaceFinalization> => {
      let metadata: WorkspaceSessionMetadata | undefined;
      try {
        metadata = await workspace.finalize({ knownConcurrentClaims: lease.currentConcurrentClaims() });
      } catch (error) {
        report(error);
        const cleanup = await cleanupWorkspace(workspace);
        const failedAt = new Date().toISOString();
        const failureCode = error instanceof WorkspaceError ? error.code : 'WORKSPACE_FINALIZE_FAILED';
        run.monitor?.acceptWorkspace({
          kind: 'workspace',
          schemaVersion: 1,
          recordId: `workspace:${workspace.workspaceInstanceId}:provenance-finalization-failed`,
          observedAt: failedAt,
          source: { id: 'runtime-workspace', kind: 'workspace-provenance' },
          quality: 'unknown',
          completeness: 'unavailable',
          provisional: false,
          evidence: [{ namespace: 'workspace', id: `${workspace.workspaceInstanceId}:finalization-failed` }],
          operation: 'provenance',
          value: failedWorkspaceMonitorProvenance(workspace, failedAt, failureCode, cleanup),
        });
        await recordAction({
          ...actionBase(run, `workspace:${workspace.workspaceInstanceId}:finalization-failed`, failedAt),
          type: 'workspace.finalization-failed',
          quality: 'unknown',
          completeness: 'unavailable',
          workspaceInstanceId: workspace.workspaceInstanceId,
          code: failureCode,
          outcome: 'failed',
          trigger,
          cleanupOutcome: cleanup.cleanupOutcome,
          retained: cleanup.retained,
        });
        return cleanup;
      } finally {
        // The cooperative lease covers the final Git observation and cleanup boundary.
        if (metadata === undefined) lease.releaseClaim();
      }

      const cleanup = await cleanupWorkspace(workspace);
      const provenance = metadata.provenance;
      const outcome =
        cleanup.cleanupOutcome === 'failed' && provenance.outcome === 'complete'
          ? ('partial' as const)
          : provenance.outcome === 'failed'
            ? ('unavailable' as const)
            : provenance.outcome;
      const completeness =
        cleanup.cleanupOutcome === 'failed' && provenance.completeness === 'complete'
          ? ('partial' as const)
          : provenance.completeness;
      const quality =
        cleanup.cleanupOutcome === 'failed' && (provenance.quality === 'strong' || provenance.quality === 'exact')
          ? ('derived' as const)
          : provenance.quality;
      run.monitor?.acceptWorkspace({
        kind: 'workspace',
        schemaVersion: 1,
        recordId: `workspace:${workspace.workspaceInstanceId}:provenance-finalized`,
        observedAt: provenance.finalizedAt,
        source: { id: 'runtime-workspace', kind: 'workspace-provenance' },
        quality,
        completeness,
        provisional: false,
        evidence: [{ namespace: 'workspace', id: `${workspace.workspaceInstanceId}:finalized` }],
        operation: 'provenance',
        value: workspaceMonitorProvenance(workspace, { ...provenance, outcome, quality, completeness }, cleanup),
      });
      try {
        await recordAction({
          ...actionBase(run, `workspace:${workspace.workspaceInstanceId}:finalized`, provenance.finalizedAt),
          type: 'workspace.finalized',
          quality,
          completeness,
          workspaceInstanceId: workspace.workspaceInstanceId,
          ...(metadata.initialCommit === undefined ? {} : { initialCommit: metadata.initialCommit }),
          ...(metadata.finalCommit === undefined ? {} : { finalCommit: metadata.finalCommit }),
          filesTouchedCount: provenance.changes.filesTouchedCount,
          insertions: provenance.changes.insertions,
          deletions: provenance.changes.deletions,
          retained: cleanup.retained,
          outcome,
          trigger,
          cleanupOutcome: cleanup.cleanupOutcome,
          git: provenance.git,
          reachableCommits: provenance.reachableCommits,
          ...(provenance.changes.filesFingerprint === undefined
            ? {}
            : { filesFingerprint: { ...provenance.changes.filesFingerprint } }),
          interference: provenance.interference.map((entry) => ({ ...entry })),
          knownConcurrentClaims: provenance.knownConcurrentClaims,
        });
        return { metadata, ...cleanup };
      } finally {
        lease.releaseClaim();
      }
    })();
    workspaceFinalizations.set(workspace, finalization);
    return finalization;
  }

  async function closeManaged(
    managed: ManagedSession,
    exit?: AgentProcessExit,
  ): Promise<AgentWorkspaceFinal | undefined> {
    if (sessionsByTerminalId.get(managed.info.terminalSessionId) !== managed) return undefined;
    const normalizedExitReason = exit ? processExitReason(exit) : undefined;
    if (exit) {
      managed.dispatch(
        {
          type: 'process:exited',
          ...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
          ...(exit.signal === null ? {} : { signal: exit.signal }),
          reason: normalizedExitReason!,
        },
        'runtime',
        'authoritative',
      );
    }
    sessionsByTerminalId.delete(managed.info.terminalSessionId);
    if (sessionsByRunId.get(managed.run.identity.runtimeRunId) === managed) {
      sessionsByRunId.delete(managed.run.identity.runtimeRunId);
    }
    if (managed.preparationId) {
      preparations.delete(managed.preparationId);
      rememberTombstone(managed.preparationId, { kind: 'cancelled', run: managed.run });
    }
    managed.unsubscribe();
    managed.run.monitor?.detachSession();
    managed.gitObserver?.stop();
    const terminalOutcome: CreationRequestTerminalOutcome = !exit
      ? { kind: 'closed', reason: 'runtime-disposed' }
      : normalizedExitReason === 'completed'
        ? { kind: 'closed', reason: 'process-exit' }
        : normalizedExitReason === 'unknown'
          ? { kind: 'closed', reason: 'unclassified-process-exit' }
          : normalizedExitReason === 'user-terminated' || normalizedExitReason === 'runtime-terminated'
            ? { kind: 'cancelled' }
            : { kind: 'failed', code: normalizedExitReason ?? 'unknown' };
    const terminalClaim = markRunTerminal(managed.run, terminalOutcome, {
      deferFailureRetention: terminalOutcome.kind === 'failed',
    });

    if (exit) {
      await recordAction({
        ...actionBase(managed.run, `process:${managed.run.identity.runtimeEpoch}:exited`, new Date().toISOString()),
        type: 'process.exited',
        terminalSessionId: managed.info.terminalSessionId,
        exitCode: exit.exitCode,
        signal: exit.signal,
        reason: normalizedExitReason!,
      });
    }

    await managed.agentController.dispose().catch(report);
    await terminalClaim;
    let final: AgentWorkspaceFinal | undefined;
    try {
      const finalized = await finalizeWorkspace(managed.run, managed, triggerForExit(normalizedExitReason));
      if (finalized.metadata) {
        final = {
          runtimeRunId: managed.run.identity.runtimeRunId,
          runtimeEpoch: managed.run.identity.runtimeEpoch,
          terminalSessionId: managed.info.terminalSessionId,
          runtimeSessionId: managed.info.terminalSessionId,
          metadata: finalized.metadata,
          retained: finalized.retained,
          ...(finalized.reason === undefined ? {} : { reason: finalized.reason }),
        };
      }
    } finally {
      if (terminalOutcome.kind === 'failed') {
        retainTerminalFailure(managed.run);
      } else {
        removeRunMonitor(managed.run);
        releaseTerminalRun(managed.run);
      }
    }
    return final;
  }

  function reserveClaim(
    identity: string,
    mode: WorkspaceMode,
  ): Pick<WorkspaceLease, 'releaseClaim' | 'currentConcurrentClaims'> {
    if (mode !== 'direct' && mode !== 'exclusive') {
      return { releaseClaim: () => undefined, currentConcurrentClaims: () => 0 };
    }
    const active = claims.get(identity);
    const conflict =
      mode === 'exclusive' ? active && active.size > 0 : active && [...active.values()].includes('exclusive');
    if (conflict) {
      const description =
        mode === 'exclusive' ? 'another direct or exclusive agent is active' : 'an exclusive agent is active';
      throw new WorkspaceError('WORKSPACE_CONFLICT', `cannot start ${mode} agent on ${identity}: ${description}`);
    }

    const token = Symbol(mode);
    const entries = active ?? new Map<symbol, 'direct' | 'exclusive'>();
    entries.set(token, mode);
    claims.set(identity, entries);
    let released = false;
    return {
      currentConcurrentClaims: () => {
        const current = claims.get(identity);
        return Math.max(0, (current?.size ?? 0) - (current?.has(token) ? 1 : 0));
      },
      releaseClaim: () => {
        if (released) return;
        released = true;
        const current = claims.get(identity);
        current?.delete(token);
        if (current?.size === 0) claims.delete(identity);
      },
    };
  }

  async function acquireWorkspace(
    request: CreateAgentSessionOptions,
    run: ManagedRun,
  ): Promise<WorkspaceLease | WorkspaceLeaseFailure> {
    const cwd = request.cwd ?? options.defaultCwd;
    const workspaceRequest: WorkspaceRequest = {
      mode: request.workspace?.mode ?? 'direct',
      path: request.workspace?.path ?? cwd,
      baseRef: request.workspace?.baseRef,
      branchName: request.workspace?.branchName,
      resumeBranch: request.workspace?.resumeBranch,
      resumeRoot: request.workspace?.resumeRoot,
      workspacesRoot: request.workspace?.workspacesRoot,
    };

    let claim: Pick<WorkspaceLease, 'releaseClaim' | 'currentConcurrentClaims'> = {
      releaseClaim: () => undefined,
      currentConcurrentClaims: () => 0,
    };
    try {
      if (workspaceRequest.mode === 'direct' || workspaceRequest.mode === 'exclusive') {
        claim = reserveClaim(await workspaceIdentity(workspaceRequest.path), workspaceRequest.mode);
      }
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
      if (err.code === 'WORKSPACE_CONFLICT') {
        await recordPolicyConflict(run, err.code, 'workspace-isolation');
      }
      return { error: { code: err.code, message: err.message } };
    }

    try {
      workspaceRequest.provenance = {
        knownConcurrentClaims: claim.currentConcurrentClaims(),
        ...(options.recorder
          ? {
              keyedDigest: (domain, canonicalValue) =>
                options.recorder!.keyedDigest(`workspace:${domain}`, canonicalValue),
            }
          : {}),
      };
      const workspace = await createWorkspace(workspaceRequest);
      await recordWorkspaceEvidence(run, workspace);
      return { workspace, ...claim };
    } catch (err) {
      claim.releaseClaim();
      if (err instanceof WorkspaceError) return { error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  async function submitManagedPrompt(managed: ManagedSession, submission: PromptSubmission): Promise<PromptReceipt> {
    const injectionId = randomUUID();
    const receipt = await managed.session.services.prompt.submit(submission);
    managed.run.monitor?.recordPromptReceipt(injectionId, monitorClock.now().toISOString());
    try {
      await options.recorder?.recordInjection({
        ...actionBase(managed.run, `injection:${injectionId}`, new Date().toISOString()),
        type: 'injection.receipt',
        injectionId,
        prompt: submission.text,
        outcome: receipt.status,
        ...(receipt.status === 'confirmed'
          ? receipt.turnId === undefined
            ? {}
            : { turnId: receipt.turnId }
          : { reasonPresent: receipt.reason.length > 0 }),
      });
    } catch (error) {
      report(error);
    }
    return receipt;
  }

  function manageSession(
    provider: AgentProvider,
    session: AgentAdapterBinding,
    lease: WorkspaceLease,
    run: ManagedRun,
    extras: { preparationId?: string; processId?: number; restored?: boolean } = {},
  ): AgentSessionInfo {
    if (sessionsByTerminalId.has(session.runtimeSessionId)) {
      throw new Error(`terminal already has an active agent session: ${session.runtimeSessionId}`);
    }
    if (sessionsByRunId.has(run.identity.runtimeRunId)) {
      throw new Error(`runtime run already has an active agent session: ${run.identity.runtimeRunId}`);
    }
    const initialNativeClaim =
      run.nativeSessionClaim ?? createNativeSessionClaim(provider.kind, session.sessionId, 'observed');
    run.nativeSessionClaim = initialNativeClaim;
    run.terminalSessionId = session.runtimeSessionId;
    run.status = 'active';
    const info: AgentSessionInfo = {
      agent: provider.kind,
      ...identityFields(run.identity),
      terminalSessionId: session.runtimeSessionId,
      nativeSession: { ...initialNativeClaim.value },
      nativeSessionRevision: initialNativeClaim.revision,
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      workspace: workspaceInfo(lease.workspace),
    };
    if (extras.preparationId !== undefined) info.preparationId = extras.preparationId;
    if (extras.processId !== undefined) info.processId = extras.processId;
    if (!run.monitor) throw new Error(`runtime monitor was not installed for run ${run.identity.runtimeRunId}`);
    let managed: ManagedSession | undefined;
    const agentController = createAgentController({
      adapter: session,
      info,
      monitor: run.monitor,
      submitPrompt: (submission) =>
        managed
          ? submitManagedPrompt(managed, submission)
          : Promise.resolve({ status: 'rejected', reason: 'agent session is not ready' }),
      onListenerError: report,
    });
    const agent = agentController.agent;
    void recordProcessSpawned(run, session.runtimeSessionId, extras.processId, extras.restored);
    void recordNativeSessionCorrelation(run);
    run.monitor?.updateSessionMetadata({
      executionMode: provider.executionMode ?? 'native-tui',
      observationLevel: session.observationLevel(),
      terminalSessionId: session.runtimeSessionId,
    });
    run.monitor?.updateRun(activeMonitorLifecycle(agent.state.lifecycle), {
      alive: true,
      nativeSession: initialNativeClaim.value,
    });
    run.monitor?.attachSession(session);
    let deliverySequence = 0;
    const seenSourceEventIds = new Set<string>();
    let gitObserver: GitStateObserver | undefined;

    const updateNativeSession = (
      nativeSessionId: string,
      effectiveAt: string,
      evidence?: { namespace: string; id: string; revisionKey?: string },
    ): void => {
      const current = run.nativeSessionClaim!;
      const next = reviseNativeSessionClaim(current, {
        namespace: provider.kind,
        id: nativeSessionId,
        basis: 'observed',
        quality: 'exact',
      });
      if (next === current) return;
      run.nativeSessionClaim = next;
      info.nativeSession = { ...next.value };
      info.nativeSessionRevision = next.revision;
      info.sessionId = next.value.id;
      run.monitor?.updateRun(activeMonitorLifecycle(agent.state.lifecycle), { alive: true, nativeSession: next.value });
      void recordNativeSessionCorrelation(run, effectiveAt, evidence);
    };

    const dispatch = (
      event: AgentEvent,
      source: AgentEventSource,
      confidence: AgentEventConfidence,
      nativeEvent?: unknown,
      upstream?: AgentEventEnvelope | AdapterEventCandidate,
      reduceIntoState = true,
      hostProcessEvidence = false,
    ): void => {
      const sourceEventRef =
        upstream?.sourceEventRef ??
        (upstream?.eventId ? { namespace: provider.kind, eventId: upstream.eventId } : undefined);
      const eventId = sourceEventRef ? sourceDerivedEventId(run.identity.runtimeRunId, sourceEventRef) : randomUUID();
      if (sourceEventRef) {
        if (seenSourceEventIds.has(eventId)) return;
        seenSourceEventIds.add(eventId);
        while (seenSourceEventIds.size > MAX_SOURCE_EVENT_IDENTITIES) {
          const oldest = seenSourceEventIds.values().next().value as string | undefined;
          if (oldest === undefined) break;
          seenSourceEventIds.delete(oldest);
        }
      }
      const envelope: RuntimeAgentEventEnvelope = {
        eventId,
        type: agentEventType(event),
        category: agentEventCategory(event),
        runtimeRunId: run.identity.runtimeRunId,
        runtimeEpoch: run.identity.runtimeEpoch,
        sequence: ++deliverySequence,
        sessionId: upstream?.sessionId || info.sessionId,
        ...(upstream?.nativeSessionId === undefined ? {} : { nativeSessionId: upstream.nativeSessionId }),
        ...(upstream?.promptId === undefined ? {} : { promptId: upstream.promptId }),
        ...(upstream?.turnId === undefined ? {} : { turnId: upstream.turnId }),
        ...(upstream?.agentId === undefined ? {} : { agentId: upstream.agentId }),
        ...(upstream?.agentType === undefined ? {} : { agentType: upstream.agentType }),
        ...(upstream?.actorKey === undefined ? {} : { actorKey: upstream.actorKey }),
        ...(upstream?.actorRole === undefined ? {} : { actorRole: upstream.actorRole }),
        ...(upstream?.providerVersion === undefined ? {} : { providerVersion: upstream.providerVersion }),
        ...(sourceEventRef === undefined ? {} : { sourceEventRef }),
        timestamp: upstream?.timestamp ?? new Date().toISOString(),
        monotonicTime: upstream?.monotonicTime ?? performance.now(),
        source,
        confidence,
        ...(upstream?.replay ? { replay: true } : {}),
        event,
        ...(nativeEvent !== undefined ? { nativeEvent } : {}),
      };
      const nativeSessionId =
        envelope.nativeSessionId ??
        (envelope.event.type === 'session:started' ? envelope.event.nativeSessionId : undefined);
      if (nativeSessionId) {
        updateNativeSession(
          nativeSessionId,
          envelope.timestamp,
          sourceEventRef === undefined
            ? undefined
            : {
                namespace: sourceEventRef.namespace,
                id: sourceEventRef.eventId,
                ...(sourceEventRef.revisionKey === undefined ? {} : { revisionKey: sourceEventRef.revisionKey }),
              },
        );
      }
      const previousCwd = agent.state.environment.currentCwd?.value;
      if (!isCanonicalApplicationEvent(session, envelope)) {
        const projected = agentController.accept(envelope, {
          projectMonitor: false,
          projectState: reduceIntoState,
          projectConversation: false,
          publish: false,
        });
        const currentCwd = projected.state.environment.currentCwd?.value;
        if (currentCwd && currentCwd !== previousCwd) gitObserver?.setCwd(currentCwd);
        return;
      }
      const projected = agentController.accept(envelope, { projectState: reduceIntoState, hostProcessEvidence });
      const currentCwd = projected.state.environment.currentCwd?.value;
      if (currentCwd && currentCwd !== previousCwd) gitObserver?.setCwd(currentCwd);
      for (const listener of listeners) {
        try {
          listener(info.terminalSessionId, envelope);
        } catch {
          // Listener faults stay out of the observation pipeline.
        }
      }
    };

    managed = {
      session,
      agent,
      agentController,
      run,
      info,
      workspace: lease.workspace,
      unsubscribe: () => undefined,
      releaseClaim: lease.releaseClaim,
      currentConcurrentClaims: lease.currentConcurrentClaims,
      preparationId: extras.preparationId,
      dispatch: (event, source, confidence, nativeEvent) =>
        dispatch(event, source, confidence, nativeEvent, undefined, true, true),
    };
    sessionsByRunId.set(run.identity.runtimeRunId, managed);
    sessionsByTerminalId.set(info.terminalSessionId, managed);
    try {
      const updateAdapterMetadata = (): void => {
        run.monitor?.updateSessionMetadata({
          executionMode: provider.executionMode ?? 'native-tui',
          observationLevel: session.observationLevel(),
          terminalSessionId: session.runtimeSessionId,
        });
      };
      const acceptCandidate = (candidate: AdapterEventCandidate): void => {
        updateAdapterMetadata();
        const parsedCandidate = AdapterEventCandidateSchema.safeParse(candidate);
        if (!parsedCandidate.success) {
          report(new Error(`Adapter emitted invalid candidate metadata: ${parsedCandidate.error.message}`));
          return;
        }
        if (!isAgentEventType(parsedCandidate.data.type)) {
          report(new Error(`Adapter emitted an unregistered event route: ${String(candidate.type)}`));
          return;
        }
        const parsed = safeParseAgentEvent(parsedCandidate.data.type, parsedCandidate.data.event);
        if (!parsed.success) {
          report(new Error(`Adapter emitted invalid ${parsedCandidate.data.type}: ${parsed.error.message}`));
          return;
        }
        dispatch(
          parsed.data,
          parsedCandidate.data.source,
          parsedCandidate.data.confidence,
          parsedCandidate.data.nativeEvent,
          parsedCandidate.data as AdapterEventCandidate,
          true,
        );
      };

      managed.unsubscribe = session.events.onCandidate(acceptCandidate);
    } catch (error) {
      sessionsByRunId.delete(run.identity.runtimeRunId);
      sessionsByTerminalId.delete(info.terminalSessionId);
      run.monitor?.detachSession();
      throw error;
    }

    if (!agent.state.environment.currentCwd) {
      dispatch({ type: 'environment:updated', currentCwd: lease.workspace.root }, 'runtime', 'derived');
    }
    gitObserver = createGitStateObserver({
      cwd: agent.state.environment.currentCwd?.value ?? lease.workspace.root,
      onChange: (git) => dispatch({ type: 'environment:updated', git }, 'runtime', 'derived'),
      onError: report,
    });
    managed.gitObserver = gitObserver;
    return cloneAgentSessionInfo(info);
  }

  async function destroyUnusedPreparation(
    preparation: ManagedPreparation,
    tombstone: PreparationTombstone['kind'],
    trigger: WorkspaceFinalizationTriggerV2 = 'cancellation',
    outcome: CreationRequestTerminalOutcome = { kind: 'cancelled' },
  ): Promise<void> {
    if (preparations.get(preparation.id) !== preparation) return;
    preparations.delete(preparation.id);
    rememberTombstone(preparation.id, { kind: tombstone, run: preparation.run });
    clearTimeout(preparation.timer);
    const terminalClaim = markRunTerminal(preparation.run, outcome, {
      deferFailureRetention: outcome.kind === 'failed',
    });
    const cleanup = (async () => {
      try {
        await preparation.prepared.dispose();
      } catch (err) {
        report(err);
      }
      await finalizeWorkspace(preparation.run, preparation, trigger);
      await terminalClaim;
      if (outcome.kind === 'failed') retainTerminalFailure(preparation.run);
      else {
        removeRunMonitor(preparation.run);
        releaseTerminalRun(preparation.run);
      }
    })();
    preparationCleanups.set(preparation.id, cleanup);
    await cleanup;
    if (preparationCleanups.get(preparation.id) === cleanup) preparationCleanups.delete(preparation.id);
  }

  async function tombstoneFailure(preparationId: string): Promise<PreparationFailure> {
    await preparationCleanups.get(preparationId);
    const tombstone = preparationTombstones.get(preparationId);
    if (tombstone?.kind === 'expired') {
      return preparationFailure('PREPARATION_EXPIRED', `prepared session expired: ${preparationId}`, tombstone.run);
    }
    if (tombstone?.kind === 'cancelled') {
      return preparationFailure(
        'PREPARATION_CANCELLED',
        `prepared session was cancelled or closed: ${preparationId}`,
        tombstone.run,
      );
    }
    return preparationFailure('PREPARATION_NOT_FOUND', `prepared session not found: ${preparationId}`);
  }

  async function cancelPrepared(preparationId: string): Promise<CancelPreparedSessionResult> {
    const preparation = preparations.get(preparationId);
    if (!preparation) {
      const tombstone = preparationTombstones.get(preparationId);
      if (tombstone?.kind === 'cancelled') return { cancelled: true };
      return tombstoneFailure(preparationId);
    }
    if (preparation.status === 'adopting') {
      await preparation.adoption;
      return cancelPrepared(preparationId);
    }
    if (preparation.status === 'adopted') {
      const managed = sessionsByTerminalId.get(preparation.adoptedRuntimeSessionId!);
      if (managed) {
        await closeManaged(managed, {
          exitCode: null,
          signal: null,
          reason: 'runtime-terminated',
        });
      }
      rememberTombstone(preparationId, { kind: 'cancelled', run: preparation.run });
      return { cancelled: true };
    }
    await destroyUnusedPreparation(preparation, 'cancelled');
    return { cancelled: true };
  }

  const runtime: AgentRuntime = {
    async spawn(request) {
      const created = await runtime.createSession(request);
      if ('error' in created) return created;
      const agent = sessionsByTerminalId.get(created.terminalSessionId)?.agent;
      if (!agent) {
        return sessionFailure(
          runs.get(created.runtimeRunId)!,
          'AGENT_SESSION_CREATE_FAILED',
          'agent session was created without a runtime Agent instance',
        );
      }
      return agent;
    },

    agent(id) {
      return sessionsByTerminalId.get(id)?.agent ?? sessionsByRunId.get(id)?.agent;
    },

    async accountUsage(agent): Promise<AccountUsageFetchResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const existing = accountUsageInflight.get(agent);
      if (existing) return existing;

      const provider = providers.get(agent);
      if (!provider) {
        return {
          status: 'unsupported',
          provider: agent,
          message: `unknown agent provider: ${agent}`,
          retryable: false,
        };
      }
      if (!provider.fetchAccountUsage) {
        return {
          status: 'unsupported',
          provider: agent,
          message: `agent provider does not expose account usage: ${agent}`,
          retryable: false,
        };
      }

      const fetchAccountUsage = provider.fetchAccountUsage;
      const request = Promise.resolve()
        .then(() => fetchAccountUsage.call(provider))
        .catch((error: unknown): AccountUsageFetchResult => {
          report(error);
          return {
            status: 'unavailable',
            provider: agent,
            message: `account usage fetch failed for ${agent}`,
            retryable: true,
          };
        })
        .finally(() => accountUsageInflight.delete(agent));
      accountUsageInflight.set(agent, request);
      return request;
    },

    createSession(request: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      return beginCreation('create', request, async (run) => {
        run.status = 'preparing';
        run.monitor?.updateRun('preparing', { alive: true });
        const provider = providers.get(request.agent);
        if (!provider) {
          await markRunTerminal(run, { kind: 'failed', code: 'AGENT_NOT_FOUND' });
          await recordRunStartFailure(run, 'provider-lookup', 'AGENT_NOT_FOUND');
          return sessionFailure(run, 'AGENT_NOT_FOUND', `unknown agent provider: ${request.agent}`);
        }

        let lease: WorkspaceLease | WorkspaceLeaseFailure;
        try {
          lease = await acquireWorkspace(request, run);
        } catch (error) {
          report(error);
          await markRunTerminal(run, { kind: 'failed', code: 'WORKSPACE_CREATE_FAILED' });
          await recordRunStartFailure(run, 'workspace', 'WORKSPACE_CREATE_FAILED');
          return sessionFailure(run, 'WORKSPACE_CREATE_FAILED', 'workspace allocation failed');
        }
        if ('error' in lease) {
          await markRunTerminal(run, { kind: 'failed', code: lease.error.code });
          await recordRunStartFailure(run, 'workspace', lease.error.code);
          return sessionFailure(run, lease.error.code, lease.error.message);
        }

        let session: AgentAdapterBinding;
        try {
          session = await provider.createSession({
            runtimeRunId: run.identity.runtimeRunId,
            cwd: lease.workspace.root,
            resume: request.resume,
            title: request.title,
            host: options.host,
            agentOptions: request.agentOptions,
          });
        } catch (error) {
          report(error);
          await markRunTerminal(
            run,
            { kind: 'failed', code: 'AGENT_SESSION_CREATE_FAILED' },
            { deferFailureRetention: true },
          );
          await recordRunStartFailure(run, 'process-spawn', 'AGENT_SESSION_CREATE_FAILED');
          await finalizeWorkspace(run, lease, 'preparation-failure');
          retainTerminalFailure(run);
          return sessionFailure(run, 'AGENT_SESSION_CREATE_FAILED', `agent session creation failed: ${request.agent}`);
        }

        try {
          return manageSession(provider, session, lease, run);
        } catch (error) {
          await session.dispose().catch(report);
          report(error);
          await markRunTerminal(
            run,
            { kind: 'failed', code: 'AGENT_SESSION_CREATE_FAILED' },
            { deferFailureRetention: true },
          );
          await recordRunStartFailure(run, 'binding', 'AGENT_SESSION_CREATE_FAILED');
          await finalizeWorkspace(run, lease, 'preparation-failure');
          retainTerminalFailure(run);
          return sessionFailure(run, 'AGENT_SESSION_CREATE_FAILED', `agent session binding failed: ${request.agent}`);
        }
      });
    },

    prepareSession(request: CreateAgentSessionOptions): Promise<PrepareAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      return beginCreation('prepare', request, async (run) => {
        run.status = 'preparing';
        run.monitor?.updateRun('preparing', { alive: true });
        const provider = providers.get(request.agent);
        if (!provider) {
          await markRunTerminal(run, { kind: 'failed', code: 'AGENT_NOT_FOUND' });
          await recordRunStartFailure(run, 'provider-lookup', 'AGENT_NOT_FOUND');
          return preparationFailure('AGENT_NOT_FOUND', `unknown agent provider: ${request.agent}`, run);
        }
        if (!provider.prepareSession) {
          await markRunTerminal(run, { kind: 'failed', code: 'PREPARATION_UNSUPPORTED' });
          await recordRunStartFailure(run, 'preparation', 'PREPARATION_UNSUPPORTED');
          return preparationFailure(
            'PREPARATION_UNSUPPORTED',
            `agent provider does not support caller-owned terminal preparation: ${request.agent}`,
            run,
          );
        }

        let lease: WorkspaceLease | WorkspaceLeaseFailure;
        try {
          lease = await acquireWorkspace(request, run);
        } catch (error) {
          report(error);
          await markRunTerminal(run, { kind: 'failed', code: 'WORKSPACE_CREATE_FAILED' });
          await recordRunStartFailure(run, 'workspace', 'WORKSPACE_CREATE_FAILED');
          return preparationFailure('WORKSPACE_CREATE_FAILED', 'workspace allocation failed', run);
        }
        if ('error' in lease) {
          await markRunTerminal(run, { kind: 'failed', code: lease.error.code });
          await recordRunStartFailure(run, 'workspace', lease.error.code);
          return preparationFailure(lease.error.code, lease.error.message, run);
        }

        let prepared: PreparedProviderSession;
        try {
          prepared = await provider.prepareSession({
            runtimeRunId: run.identity.runtimeRunId,
            cwd: lease.workspace.root,
            resume: request.resume,
            title: request.title,
            host: options.host,
            agentOptions: request.agentOptions,
          });
        } catch (error) {
          report(error);
          await markRunTerminal(
            run,
            { kind: 'failed', code: 'AGENT_SESSION_CREATE_FAILED' },
            { deferFailureRetention: true },
          );
          await recordRunStartFailure(run, 'preparation', 'AGENT_SESSION_CREATE_FAILED');
          await finalizeWorkspace(run, lease, 'preparation-failure');
          retainTerminalFailure(run);
          return preparationFailure(
            'AGENT_SESSION_CREATE_FAILED',
            `agent session preparation failed: ${request.agent}`,
            run,
          );
        }

        const preparationId = randomUUID();
        const expiresAtMs = Date.now() + preparationTtlMs;
        const nativeSessionClaim = createNativeSessionClaim(provider.kind, prepared.sessionId, 'observed');
        run.nativeSessionClaim = nativeSessionClaim;
        await recordNativeSessionCorrelation(run);
        run.preparationId = preparationId;
        run.status = 'prepared';
        run.monitor?.updateRun('starting', { alive: true, nativeSession: nativeSessionClaim.value });
        const publicInfo: PreparedAgentSessionInfo = {
          preparationId,
          agent: provider.kind,
          ...identityFields(run.identity),
          nativeSession: { ...nativeSessionClaim.value },
          nativeSessionRevision: nativeSessionClaim.revision,
          sessionId: prepared.sessionId,
          launch: cloneLaunch(prepared.launch),
          workspace: workspaceInfo(lease.workspace),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
        const timer = setTimeout(() => {
          const current = preparations.get(preparationId);
          if (current?.status === 'prepared') void destroyUnusedPreparation(current, 'expired');
        }, preparationTtlMs);
        timer.unref?.();
        const managed: ManagedPreparation = {
          id: preparationId,
          provider,
          run,
          prepared,
          status: 'prepared',
          timer,
          ...lease,
        };
        preparations.set(preparationId, managed);
        return publicInfo;
      });
    },

    async adoptPrepared(
      preparationId: string,
      adoptOptions: AdoptPreparedSessionOptions,
    ): Promise<AdoptPreparedSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const preparation = preparations.get(preparationId);
      if (!preparation) return tombstoneFailure(preparationId);
      const terminalSessionId = adoptOptions.terminalSessionId ?? adoptOptions.runtimeSessionId;
      if (
        adoptOptions.terminalSessionId !== undefined &&
        adoptOptions.runtimeSessionId !== undefined &&
        adoptOptions.terminalSessionId !== adoptOptions.runtimeSessionId
      ) {
        return preparationFailure(
          'PREPARATION_ADOPT_FAILED',
          'terminalSessionId and deprecated runtimeSessionId must match when both are supplied',
          preparation.run,
        );
      }
      if (!terminalSessionId) {
        return preparationFailure('PREPARATION_ADOPT_FAILED', 'terminalSessionId must be non-empty', preparation.run);
      }
      if (adoptOptions.runtimeRunId && adoptOptions.runtimeRunId !== preparation.run.identity.runtimeRunId) {
        return preparationFailure(
          'PREPARATION_ADOPT_FAILED',
          `prepared session belongs to run ${preparation.run.identity.runtimeRunId}, not ${adoptOptions.runtimeRunId}`,
          preparation.run,
        );
      }
      if (
        adoptOptions.processId !== undefined &&
        (!Number.isSafeInteger(adoptOptions.processId) || adoptOptions.processId <= 0)
      ) {
        return preparationFailure(
          'PREPARATION_ADOPT_FAILED',
          'processId must be a positive safe integer',
          preparation.run,
        );
      }
      if (preparation.status === 'adopted') {
        if (preparation.adoptedRuntimeSessionId !== terminalSessionId) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is already adopted by ${preparation.adoptedRuntimeSessionId}`,
            preparation.run,
          );
        }
        if (
          preparation.adoptedProcessId !== undefined &&
          adoptOptions.processId !== undefined &&
          preparation.adoptedProcessId !== adoptOptions.processId
        ) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is already adopted by process ${preparation.adoptedProcessId}`,
            preparation.run,
          );
        }
        if (preparation.adoptedProcessId === undefined && adoptOptions.processId !== undefined) {
          preparation.adoptedProcessId = adoptOptions.processId;
          preparation.adoptedInfo!.processId = adoptOptions.processId;
        }
        return preparation.adoptedInfo!;
      }
      if (preparation.status === 'adopting') {
        if (preparation.adoptedRuntimeSessionId !== terminalSessionId) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is being adopted by ${preparation.adoptedRuntimeSessionId}`,
            preparation.run,
          );
        }
        if (
          preparation.adoptedProcessId !== undefined &&
          adoptOptions.processId !== undefined &&
          preparation.adoptedProcessId !== adoptOptions.processId
        ) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is being adopted by process ${preparation.adoptedProcessId}`,
            preparation.run,
          );
        }
        if (preparation.adoptedProcessId === undefined) preparation.adoptedProcessId = adoptOptions.processId;
        return preparation.adoption!;
      }
      if (sessionsByTerminalId.has(terminalSessionId)) {
        return preparationFailure(
          'RUNTIME_SESSION_CONFLICT',
          `terminal already has an active agent session: ${terminalSessionId}`,
          preparation.run,
        );
      }

      preparation.status = 'adopting';
      preparation.adoptedRuntimeSessionId = terminalSessionId;
      preparation.adoptedProcessId = adoptOptions.processId;
      clearTimeout(preparation.timer);
      preparation.adoption = (async (): Promise<AdoptPreparedSessionResult> => {
        try {
          const session = await preparation.prepared.adopt(terminalSessionId);
          if (session.runtimeSessionId !== terminalSessionId) {
            throw new Error(`provider adopted terminal ${session.runtimeSessionId}; expected ${terminalSessionId}`);
          }
          if (session.sessionId !== preparation.prepared.sessionId) {
            throw new Error(
              `provider adopted native session ${session.sessionId}; expected ${preparation.prepared.sessionId}`,
            );
          }
          if (disposed) throw new Error('agent runtime was disposed during adoption');
          if (sessionsByTerminalId.has(terminalSessionId)) {
            throw new Error(`terminal gained an active agent session during adoption: ${terminalSessionId}`);
          }
          const info = manageSession(preparation.provider, session, preparation, preparation.run, {
            preparationId,
            processId: preparation.adoptedProcessId,
          });
          preparation.status = 'adopted';
          preparation.adoptedInfo = info;
          return info;
        } catch (err) {
          await recordRunStartFailure(preparation.run, 'adoption', 'PREPARATION_ADOPT_FAILED');
          await destroyUnusedPreparation(preparation, 'cancelled', 'preparation-failure', {
            kind: 'failed',
            code: 'PREPARATION_ADOPT_FAILED',
          });
          return preparationFailure(
            'PREPARATION_ADOPT_FAILED',
            err instanceof Error ? err.message : String(err),
            preparation.run,
          );
        }
      })();
      return preparation.adoption;
    },

    async restoreSession(restore: RestoreAgentSessionOptions): Promise<CreateAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const current = runs.get(restore.runtimeRunId);
      if (!Number.isSafeInteger(restore.expectedRuntimeEpoch) || restore.expectedRuntimeEpoch < 1) {
        const invalidRun: ManagedRun = current ?? {
          identity: {
            runtimeRunId: restore.runtimeRunId,
            runtimeEpoch: 1,
            providerId: restore.agent,
            externalRefs: [],
          },
          operation: 'create',
          status: 'allocated',
        };
        return sessionFailure(
          invalidRun,
          'RUNTIME_RESTORE_FAILED',
          'expectedRuntimeEpoch must be a positive safe integer',
        );
      }
      const currentSession = sessionsByRunId.get(restore.runtimeRunId);
      if (currentSession) {
        let compatibleRefs = false;
        try {
          compatibleRefs =
            canonicalizeCreationFingerprint(currentSession.run.identity.externalRefs) ===
            canonicalizeCreationFingerprint(restore.externalRefs ?? []);
        } catch {
          compatibleRefs = false;
        }
        if (
          currentSession.run.identity.providerId === restore.agent &&
          currentSession.run.identity.creationRequestId === restore.creationRequestId &&
          currentSession.run.identity.runtimeEpoch === restore.expectedRuntimeEpoch + 1 &&
          compatibleRefs &&
          currentSession.info.terminalSessionId === restore.session.runtimeSessionId &&
          currentSession.info.nativeSession.id === restore.session.sessionId
        ) {
          return cloneAgentSessionInfo(currentSession.info);
        }
        return sessionFailure(
          currentSession.run,
          'RUNTIME_RUN_CONFLICT',
          `runtime run already has a different active terminal or native session: ${restore.runtimeRunId}`,
        );
      }

      let identity: RuntimeRunIdentity;
      try {
        identity = allocateRuntimeRunIdentity({
          providerId: restore.agent,
          creationRequestId: restore.creationRequestId,
          externalRefs: restore.externalRefs,
          runtimeRunId: restore.runtimeRunId,
          runtimeEpoch: restore.expectedRuntimeEpoch,
        });
      } catch (error) {
        if (!(error instanceof RuntimeIdentityError)) throw error;
        const invalidRun: ManagedRun =
          current ??
          ({
            identity: {
              runtimeRunId: restore.runtimeRunId,
              runtimeEpoch: restore.expectedRuntimeEpoch,
              providerId: restore.agent,
              externalRefs: [],
            },
            operation: 'create',
            status: 'allocated',
          } satisfies ManagedRun);
        return sessionFailure(invalidRun, error.code, error.message);
      }
      const provisional: ManagedRun = current ?? { identity, operation: 'create', status: 'allocated' as const };
      if (!options.creationRegistry) {
        return sessionFailure(
          provisional,
          'CREATION_CLAIM_STORE_UNAVAILABLE',
          'restoring a runtime run requires its durable creation registry',
        );
      }
      if (sessionsByTerminalId.has(restore.session.runtimeSessionId)) {
        return sessionFailure(
          provisional,
          'RUNTIME_RUN_CONFLICT',
          `terminal already has an active agent session: ${restore.session.runtimeSessionId}`,
        );
      }

      let restoredClaim;
      try {
        restoredClaim = await options.creationRegistry.incrementRuntimeEpoch({
          creationRequestId: restore.creationRequestId,
          runtimeRunId: restore.runtimeRunId,
          expectedRuntimeEpoch: restore.expectedRuntimeEpoch,
        });
      } catch (error) {
        report(error);
        return sessionFailure(provisional, 'RUNTIME_RESTORE_FAILED', 'durable runtime-run restoration failed');
      }
      if (!restoredClaim.advanced) {
        return sessionFailure(
          provisional,
          'RUNTIME_RESTORE_FAILED',
          `runtime epoch has already advanced to ${restoredClaim.claim.runtimeEpoch}; restore from that state instead`,
        );
      }

      const provider = providers.get(restore.agent);
      const run: ManagedRun = {
        identity: { ...identity, runtimeEpoch: restoredClaim.claim.runtimeEpoch },
        operation: restoredClaim.claim.operation,
        status: 'allocated',
        creationClaim: { ...restoredClaim.claim.ref },
      };
      if (current?.monitor) removeRunMonitor(current);
      runs.set(run.identity.runtimeRunId, run);
      installRunMonitor(run);
      startRunMonitor(run);
      run.monitor?.updateRun('preparing', { alive: true });
      if (!provider) {
        await markRunTerminal(run, { kind: 'failed', code: 'AGENT_NOT_FOUND' });
        await recordRunStartFailure(run, 'restore', 'AGENT_NOT_FOUND');
        return sessionFailure(run, 'AGENT_NOT_FOUND', `unknown agent provider: ${restore.agent}`);
      }

      let claim: Pick<WorkspaceLease, 'releaseClaim' | 'currentConcurrentClaims'>;
      try {
        claim = reserveClaim(restore.workspace.identity, restore.workspace.mode);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          if (error.code === 'WORKSPACE_CONFLICT') {
            await recordPolicyConflict(run, error.code, 'workspace-isolation');
          }
          await markRunTerminal(run, { kind: 'failed', code: error.code });
          await recordRunStartFailure(run, 'restore', error.code);
          return sessionFailure(run, error.code, error.message);
        }
        throw error;
      }
      const lease: WorkspaceLease = { workspace: restore.workspace, ...claim };
      try {
        await recordWorkspaceEvidence(run, restore.workspace);
        return manageSession(provider, restore.session, lease, run, {
          restored: true,
        });
      } catch (error) {
        await restore.session.dispose().catch(report);
        report(error);
        await markRunTerminal(run, { kind: 'failed', code: 'RUNTIME_RESTORE_FAILED' }, { deferFailureRetention: true });
        await recordRunStartFailure(run, 'restore', 'RUNTIME_RESTORE_FAILED');
        await finalizeWorkspace(run, lease, 'preparation-failure');
        retainTerminalFailure(run);
        return sessionFailure(run, 'RUNTIME_RESTORE_FAILED', 'restored agent session could not be bound');
      }
    },

    cancelPrepared,

    runtimeRunInfo: (id) => {
      const run = runs.get(id);
      return run ? runInfo(run) : (terminalFailuresByRunId.get(id)?.info ?? terminalRunInfos.get(id));
    },
    monitorState: (id) =>
      sessionsByRunId.get(id)?.agent.monitor ??
      runs.get(id)?.monitor?.current() ??
      terminalFailuresByRunId.get(id)?.monitor.current(),
    observeMonitor(id) {
      const agent = sessionsByRunId.get(id)?.agent;
      if (agent) return agent.observeMonitor();
      const monitor = runs.get(id)?.monitor ?? terminalFailuresByRunId.get(id)?.monitor;
      if (!monitor) throw new Error(`monitor not found: ${id}`);
      return monitor.observe();
    },
    onMonitorState(listener) {
      monitorStateListeners.add(listener);
      return () => monitorStateListeners.delete(listener);
    },
    onMonitorNotification(listener) {
      monitorNotificationListeners.add(listener);
      return () => monitorNotificationListeners.delete(listener);
    },
    onMonitorRemoved(listener) {
      monitorRemovedListeners.add(listener);
      return () => monitorRemovedListeners.delete(listener);
    },
    async acknowledgeFailureBlocker(runtimeRunId, blockerId) {
      const acknowledgmentKey = `${runtimeRunId}\0${blockerId}`;
      if (acknowledgedFailureBlockers.has(acknowledgmentKey)) return true;
      const retained = terminalFailuresByRunId.get(runtimeRunId);
      const monitor = retained?.monitor;
      if (!retained || !monitor || monitor.current().alive || !monitor.acknowledgeFailure(blockerId)) return false;
      acknowledgedFailureBlockers.add(acknowledgmentKey);
      if (acknowledgedFailureBlockers.size > MAX_ACKNOWLEDGED_FAILURE_BLOCKERS) {
        const oldest = acknowledgedFailureBlockers.values().next().value as string | undefined;
        if (oldest) acknowledgedFailureBlockers.delete(oldest);
      }
      removeTerminalFailure(runtimeRunId);
      return true;
    },
    readMonitorArtifact(runtimeRunId, artifactId, readOptions) {
      const agent = sessionsByRunId.get(runtimeRunId)?.agent;
      if (agent) return agent.readMonitorArtifact(artifactId, readOptions);
      const monitor = runs.get(runtimeRunId)?.monitor ?? terminalFailuresByRunId.get(runtimeRunId)?.monitor;
      return monitor
        ? monitor.readArtifact(artifactId, readOptions)
        : Promise.resolve({ status: 'unavailable', message: 'monitor is not available' });
    },
    recordingStatus: (): ActionRecorderStatus | undefined => options.recorder?.status(),
    onRecordingStatus(listener) {
      return options.recorder?.onStatus(listener) ?? (() => undefined);
    },
    sessionInfo: (id) => {
      const info = sessionsByTerminalId.get(id)?.info;
      return info ? cloneAgentSessionInfo(info) : undefined;
    },
    sessionState: (id) => sessionsByTerminalId.get(id)?.agent.state,
    observationLevel: (id) => sessionsByTerminalId.get(id)?.agent.observationLevel,
    conversationSnapshot: (id) => sessionsByTerminalId.get(id)?.agent.conversation,

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onAccountUsage(listener) {
      accountUsageListeners.add(listener);
      return () => accountUsageListeners.delete(listener);
    },

    async submitPrompt(runtimeSessionId, submission): Promise<PromptReceipt> {
      const managed = sessionsByTerminalId.get(runtimeSessionId);
      if (!managed) return { status: 'rejected', reason: 'agent session not found' };
      return managed.agent.submitPrompt(submission);
    },

    async workspaceDiff(runtimeSessionId) {
      return (await sessionsByTerminalId.get(runtimeSessionId)?.workspace.diff()) ?? null;
    },

    async handleProcessExit(runtimeSessionId, exit) {
      const managed = sessionsByTerminalId.get(runtimeSessionId);
      return managed ? closeManaged(managed, exit) : undefined;
    },

    async dispose() {
      if (disposed) return [];
      disposed = true;
      const pendingAdoptions = [...preparations.values()]
        .filter((preparation) => preparation.status === 'adopting')
        .map((preparation) => preparation.adoption!);
      await Promise.all(pendingAdoptions);
      await Promise.all(
        [...preparations.values()]
          .filter((preparation) => preparation.status === 'prepared')
          .map((preparation) => destroyUnusedPreparation(preparation, 'cancelled')),
      );
      const finals = await Promise.all([...sessionsByTerminalId.values()].map((managed) => closeManaged(managed)));
      for (const unsubscribe of providerAccountUsageUnsubs) {
        try {
          unsubscribe();
        } catch (error) {
          report(error);
        }
      }
      await Promise.all([...providers.values()].map((provider) => Promise.resolve(provider.dispose?.()).catch(report)));
      for (const run of runs.values()) removeRunMonitor(run);
      for (const runtimeRunId of [...terminalFailuresByRunId.keys()]) removeTerminalFailure(runtimeRunId, false);
      terminalRunInfos.clear();
      listeners.clear();
      monitorStateListeners.clear();
      monitorNotificationListeners.clear();
      monitorRemovedListeners.clear();
      accountUsageListeners.clear();
      return finals.filter((value): value is AgentWorkspaceFinal => value !== undefined);
    },
  };
  return runtime;
}
