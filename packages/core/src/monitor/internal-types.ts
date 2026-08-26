import type { AgentExecutionMode, AgentGitState, ObservationLevel } from '../events.js';
import type {
  ActorRunRef,
  ArtifactRef,
  EvidenceCompleteness,
  EvidenceQuality,
  MonitorActivityKind,
  MonitorMetricFamily,
  MonitorNotification,
  MonitorPlanStep,
  MonitorStructuredQuestion,
  NativeSessionRef,
  RuntimeRunId,
} from './types.js';

/** Stable generic evidence identity; provider-native records never cross this seam. */
export interface EvidenceRef {
  namespace: string;
  id: string;
  revisionKey?: string;
  sourceInstanceId?: string;
  sourceObjectId?: string;
  sourceGeneration?: number;
  cursorStart?: number;
  cursorEnd?: number;
}

export interface EvidenceSource {
  id: string;
  kind: string;
  contractVersion?: string;
}

export interface ObservationProvenance {
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  evidence: EvidenceRef[];
}

export type ObservedValue<T> =
  | (ObservationProvenance & {
      availability: 'available';
      value: T;
    })
  | (ObservationProvenance & {
      availability: 'unavailable';
      reason: string;
    });

export interface ObservationCapability {
  family: MonitorMetricFamily;
  support: 'supported' | 'degraded' | 'unsupported';
  actorScope: 'root' | 'current-actors' | 'session';
  latency: 'hook' | 'sample' | 'response' | 'file-flush' | 'historical';
  source: string;
  contractVersion?: string;
  limitations: string[];
}

export interface ObservationCoverage {
  family: MonitorMetricFamily;
  completeness: EvidenceCompleteness;
  asOf: string;
  actor?: ActorRunRef;
  reason?: string;
}

export interface SourceWatermark {
  sourceId: string;
  sourceEpoch: string;
  sequence?: number;
  cursor?: string;
  observedThrough?: string;
}

export type MonitorRunLifecycle = 'allocated' | 'preparing' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed';

export interface MonitorRunStatusObservation {
  kind: 'run';
  lifecycle: MonitorRunLifecycle;
  alive: boolean;
  nativeSession?: NativeSessionRef;
  failure?: { code?: string; detail?: string; recoverable?: boolean };
}

export interface MonitorActivityObservation {
  kind: 'activity';
  activityKind: MonitorActivityKind;
  active: boolean;
  line?: string;
  since?: string;
  actor?: ActorRunRef;
  /** Runtime-scheduled expiry closes pulse-only activity; reducers never read the clock. */
  leaseId?: string;
}

export type MonitorInteractionKind = 'permission' | 'choice' | 'multi-choice' | 'free-form' | 'mixed';
export type MonitorInteractionState = 'pending' | 'resolved' | 'failed' | 'cancelled' | 'superseded';

export interface MonitorInteractionObservation {
  kind: 'interaction';
  interactionId: string;
  interactionKind: MonitorInteractionKind;
  state: MonitorInteractionState;
  actor?: ActorRunRef;
  questions?: MonitorStructuredQuestion[];
  permission?: { requestId: string; tool?: string };
  detail?: string;
}

export interface MonitorFailureObservation {
  kind: 'failure';
  failureId: string;
  state: 'active' | 'resolved' | 'dismissed';
  actor?: ActorRunRef;
  detail?: string;
  code?: string;
  recoverable: boolean;
}

export type MonitorStatusFamilyValue =
  MonitorRunStatusObservation | MonitorActivityObservation | MonitorInteractionObservation | MonitorFailureObservation;

export type MonitorUsageBoundary = 'response' | 'sample';

export interface MonitorUsageFamilyValue {
  kind: 'usage';
  usageId: string;
  actor?: ActorRunRef;
  boundary: MonitorUsageBoundary;
  /** Response usage is canonical; samples are compatible low-latency estimates/cross-checks. */
  canonical: boolean;
  totalTokens?: number;
  meterTokens?: number;
  cumulativeTokens?: number;
  deltaTokens?: number;
  inputTokens?: number;
  freshInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface MonitorContextFamilyValue {
  kind: 'context';
  actor?: ActorRunRef;
  usedTokens?: number;
  capacityTokens?: number;
  usedPercentage?: number;
  percentageSource: 'provider' | 'derived' | 'unavailable';
}

export interface MonitorModelFamilyValue {
  kind: 'model';
  actor?: ActorRunRef;
  providerModelId: string;
  displayName?: string;
  intent: 'configured' | 'observed';
}

export interface MonitorEffortFamilyValue {
  kind: 'effort';
  actor?: ActorRunRef;
  value: string;
  intent: 'configured' | 'observed';
}

export interface MonitorModeFamilyValue {
  kind: 'mode';
  modeKind: 'execution' | 'provider-session' | 'provider-permission';
  raw: string;
  normalized?: string;
  executionMode?: AgentExecutionMode;
  /** Omitted legacy values are treated as observed. */
  intent?: 'configured' | 'observed';
}

export type MonitorTaskLifecycle =
  'proposed' | 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'removed' | 'unknown';

export interface MonitorPlanFamilyValue {
  kind: 'plan';
  planId: string;
  actor?: ActorRunRef;
  steps: MonitorPlanStep[];
  provisional: boolean;
}

export interface MonitorTaskFamilyValue {
  kind: 'task';
  taskId: string;
  actor?: ActorRunRef;
  description?: string;
  status: MonitorTaskLifecycle;
  providerStatus?: string;
  teamName?: string;
  teammateName?: string;
  provisional: boolean;
}

export type MonitorPlanningFamilyValue = MonitorPlanFamilyValue | MonitorTaskFamilyValue;

export interface AffiliationRef {
  kind: 'team' | 'workflow';
  id: string;
  name?: string;
}

export interface MonitorActorFamilyValue {
  kind: 'actor';
  actor: ActorRunRef;
  state: 'active' | 'idle' | 'stopped' | 'unknown';
  activity?: string;
}

export interface MonitorAffiliationFamilyValue {
  kind: 'affiliation';
  actor: ActorRunRef;
  affiliation: AffiliationRef;
  role?: string;
}

export interface MonitorTeamFamilyValue {
  kind: 'team';
  /** Provider-neutral/canonical identity used for durable affiliation joins. */
  teamId: string;
  /** Provider-native identity used to reconcile low-latency hook claims. */
  nativeTeamId?: string;
  name?: string;
}

export interface MonitorTeamMemberFamilyValue {
  kind: 'team-member';
  membershipId: string;
  teamId: string;
  /** Provider-native aliases used only to reconcile complementary evidence rails. */
  nativeTeamId?: string;
  nativeMemberId?: string;
  actor?: ActorRunRef;
  runtimeRunId?: RuntimeRunId;
  name?: string;
  /** Membership presence is independent from the member's current activity. */
  membershipState?: 'present' | 'removed' | 'unknown';
  state: 'active' | 'idle' | 'removed' | 'unknown';
}

export type MonitorDelegationFamilyValue =
  MonitorActorFamilyValue | MonitorAffiliationFamilyValue | MonitorTeamFamilyValue | MonitorTeamMemberFamilyValue;

export interface MonitorWorkflowFamilyValue {
  kind: 'workflow';
  workflowId: string;
  name?: string;
  active: boolean;
  actorRunKeys: string[];
  artifactRefs: ArtifactRef[];
}

export interface MonitorCompactionFamilyValue {
  kind: 'compaction';
  active: boolean;
  trigger?: string;
  outcome?: 'completed' | 'cancelled' | 'failed' | 'superseded' | 'unknown';
}

export interface MonitorEnvironmentFamilyValue {
  kind: 'environment';
  /** Null explicitly clears the current cwd; omission leaves the prior fact unchanged. */
  cwd?: string | null;
  git?: AgentGitState | null;
  worktrees?: string[];
}

export interface MonitorFamilyValueMap {
  status: MonitorStatusFamilyValue;
  usage: MonitorUsageFamilyValue;
  context: MonitorContextFamilyValue;
  model: MonitorModelFamilyValue;
  effort: MonitorEffortFamilyValue;
  mode: MonitorModeFamilyValue;
  planning: MonitorPlanningFamilyValue;
  delegation: MonitorDelegationFamilyValue;
  workflow: MonitorWorkflowFamilyValue;
  compaction: MonitorCompactionFamilyValue;
  environment: MonitorEnvironmentFamilyValue;
}

export type MonitorFamilyValue = MonitorFamilyValueMap[MonitorMetricFamily];

export type MonitorFamilyUpsert<F extends MonitorMetricFamily> = {
  family: F;
  operation: 'upsert';
  key: string;
  value: MonitorFamilyValueMap[F];
};

export type MonitorFamilyRetraction<F extends MonitorMetricFamily> = {
  family: F;
  operation: 'retract';
  key: string;
};

export type MonitorFamilyReplacement<F extends MonitorMetricFamily> = {
  family: F;
  operation: 'replace';
  values: Array<{ key: string; value: MonitorFamilyValueMap[F] }>;
  coverage: EvidenceCompleteness;
};

export type MonitorFamilyUpdate = {
  [F in MonitorMetricFamily]: MonitorFamilyUpsert<F> | MonitorFamilyRetraction<F> | MonitorFamilyReplacement<F>;
}[MonitorMetricFamily];

export type MonitorObservationPhase = 'bootstrap' | 'live' | 'correction' | 'resync';

/** Atomic, provider-neutral batch emitted by an adapter before runtime identity is attached. */
export interface AdapterMonitorObservationBatch {
  schemaVersion: 1;
  batchId: string;
  producer: {
    id: string;
    epoch: string;
    /** Optional source ordering. When present, lower/equal late deliveries are rejected. */
    sequence?: number;
    contractVersion?: string;
  };
  phase: MonitorObservationPhase;
  observedAt: string;
  effectiveAt?: string;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  readiness?: 'loading' | 'ready' | 'degraded';
  scope?: {
    nativeSessionId?: string;
    actorRunKey?: string;
  };
  updates: MonitorFamilyUpdate[];
  sourceWatermarks: SourceWatermark[];
  evidence: EvidenceRef[];
  capabilities?: ObservationCapability[];
  coverage?: ObservationCoverage[];
}

/** Runtime wrapper that supplies the process-run continuity domain. */
export interface RuntimeMonitorObservationBatch extends AdapterMonitorObservationBatch {
  kind: 'semantic';
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
}

export type MonitorObservationListener = (batch: AdapterMonitorObservationBatch) => void;

export interface RuntimeMonitorInput {
  kind: 'runtime';
  schemaVersion: 1;
  eventId: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  phase: 'bootstrap' | 'live';
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  updates: MonitorFamilyUpdate[];
  evidence: EvidenceRef[];
}

export type WorkspaceMonitorObservation = {
  kind: 'workspace';
  schemaVersion: 1;
  recordId: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  evidence: EvidenceRef[];
} & (
  | {
      operation: 'upsert';
      value: MonitorEnvironmentFamilyValue;
    }
  | {
      operation: 'provenance';
      value: MonitorWorkspaceProvenanceState;
    }
  | {
      operation: 'retract';
      targetRecordId: string;
    }
);

export interface MonitorWorkspaceInterferenceObservation {
  kind: 'known-concurrent-claim' | 'baseline-dirty-overlap' | 'repository-identity-changed' | 'observation-gap';
  observedAt: string;
  count?: number;
}

export interface MonitorWorkspaceChangeSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  unmerged: number;
  untracked: number;
  other: number;
}

export interface MonitorWorkspaceGitObservation {
  state: 'attached' | 'detached' | 'unborn' | 'non-git' | 'unavailable';
  headCommit?: string;
  headRef?: string;
  index: MonitorWorkspaceChangeSummary;
  worktree: MonitorWorkspaceChangeSummary;
  conflicts: number;
  indexFingerprint?: { algorithm: 'hmac-sha256'; value: string };
  worktreeFingerprint?: { algorithm: 'hmac-sha256'; value: string };
}

/**
 * Privacy-safe workspace lifecycle evidence retained only in the private
 * accumulator. Canonical paths and touched file names stay in the authorized
 * workspace API and never enter renderer state.
 */
export interface MonitorWorkspaceProvenanceState {
  workspaceInstanceId: string;
  allocation: {
    mode: 'direct' | 'exclusive' | 'worktree' | 'copy';
    repositoryKind: 'git' | 'directory';
    repositoryDigest?: { algorithm: 'hmac-sha256'; value: string };
  };
  baseline: {
    capturedAt: string;
    isolation: 'managed-isolated' | 'cooperative-exclusive' | 'shared' | 'unknown';
    knownConcurrentClaims: number;
    quality: EvidenceQuality;
    completeness: EvidenceCompleteness;
    limitations: string[];
    git: MonitorWorkspaceGitObservation;
    initialDirtyFileCount: number;
  };
  finalization?: {
    finalizedAt: string;
    outcome: 'complete' | 'partial' | 'failed' | 'unavailable';
    repositoryKind: 'git' | 'directory';
    repositoryDigest?: { algorithm: 'hmac-sha256'; value: string };
    git?: MonitorWorkspaceGitObservation;
    reachableCommits?: {
      relation: 'unchanged' | 'fast-forward' | 'rewritten' | 'created' | 'removed' | 'unavailable';
      initialCommit?: string;
      finalCommit?: string;
      commits: string[];
      totalCount: number;
      truncated: boolean;
    };
    changes?: {
      filesTouchedCount: number;
      filesFingerprint?: { algorithm: 'hmac-sha256'; value: string };
      insertions: number;
      deletions: number;
    };
    knownConcurrentClaims?: number;
    cleanupOutcome: 'not-applicable' | 'removed' | 'retained-dirty' | 'failed';
    retained: boolean;
    quality: EvidenceQuality;
    completeness: EvidenceCompleteness;
    limitations: string[];
  };
  interference: MonitorWorkspaceInterferenceObservation[];
  completeness: EvidenceCompleteness;
}

export interface MonitorLeaseExpiredInput {
  kind: 'lease-expired';
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  leaseId: string;
  expiredAt: string;
}

export type MonitorAccumulatorInput =
  RuntimeMonitorInput | RuntimeMonitorObservationBatch | WorkspaceMonitorObservation | MonitorLeaseExpiredInput;

export type MonitorEvidencePlane = 'runtime' | 'semantic' | 'workspace';

/** One source-owned current fact. Product consumers never receive this representation. */
export interface MonitorStoredEntry {
  storageKey: string;
  plane: MonitorEvidencePlane;
  ownerId: string;
  ownerEpoch: string;
  scopeKey: string;
  family: MonitorMetricFamily;
  key: string;
  value: MonitorFamilyValue;
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  phase: MonitorObservationPhase;
  evidence: EvidenceRef[];
  /** Original live boundary retained when a later correction replaces this entry. */
  rateEligible: boolean;
  rateAt?: string;
}

export interface MonitorRuntimeSlice {
  seenEventIds: ReadonlySet<string>;
  entries: ReadonlyMap<string, MonitorStoredEntry>;
  lastAcceptedAt?: string;
}

export interface MonitorSemanticProducerState {
  id: string;
  activeEpoch: string;
  retiredEpochs: ReadonlySet<string>;
  lastSequence?: number;
  readiness: 'loading' | 'ready' | 'degraded';
  capabilities: ReadonlyMap<MonitorMetricFamily, ObservationCapability>;
  coverage: ReadonlyMap<string, ObservationCoverage>;
  watermarks: ReadonlyMap<string, SourceWatermark>;
}

export interface MonitorSemanticSlice {
  seenBatchIds: ReadonlySet<string>;
  producers: ReadonlyMap<string, MonitorSemanticProducerState>;
  entries: ReadonlyMap<string, MonitorStoredEntry>;
  /** Invisible replacement slices keyed by producer until a ready barrier commits them. */
  resyncs: ReadonlyMap<
    string,
    {
      epoch: string;
      entries: ReadonlyMap<string, MonitorStoredEntry>;
      compactionStarts: number;
      producer: MonitorSemanticProducerState;
    }
  >;
  lastAcceptedAt?: string;
}

export interface MonitorWorkspaceSlice {
  seenRecordIds: ReadonlySet<string>;
  entries: ReadonlyMap<string, MonitorStoredEntry>;
  provenance: ReadonlyMap<string, MonitorWorkspaceProvenanceState>;
  lastAcceptedAt?: string;
}

export interface CreateMonitorAccumulatorOptions {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  executionMode: AgentExecutionMode;
  observationLevel: ObservationLevel;
  allocatedAt: string;
  providerId?: string;
  terminalSessionId?: string;
}

/**
 * Version-locked evidence accumulator. Its representation is deliberately
 * absent from the stable package root, but runtime and adapters share it.
 */
export interface MonitorAccumulatorState {
  schemaVersion: 1;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  executionMode: AgentExecutionMode;
  observationLevel: ObservationLevel;
  allocatedAt: string;
  providerId?: string;
  terminalSessionId?: string;
  runtime: MonitorRuntimeSlice;
  semantic: MonitorSemanticSlice;
  workspace: MonitorWorkspaceSlice;
  expiredLeaseIds: ReadonlySet<string>;
  emittedNotificationIds: ReadonlySet<string>;
  compactionCount: number;
}

export interface MonitorReduceResult {
  state: MonitorAccumulatorState;
  notifications: MonitorNotification[];
  accepted: boolean;
}
