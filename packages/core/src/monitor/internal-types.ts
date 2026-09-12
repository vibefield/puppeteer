import type { AgentExecutionMode, AgentGitState, ObservationLevel } from '../events/index.js';
import type {
  ActorRunRef,
  ArtifactRef,
  EvidenceCompleteness,
  EvidenceQuality,
  MonitorActivityKind,
  MonitorMetricFamily,
  MonitorNotification,
  MonitorStructuredQuestion,
  NativeSessionRef,
  RuntimeRunId,
} from './types.js';

/** Stable generic evidence identity; provider-native records never cross this seam. */
export interface EvidenceRef {
  namespace: string;
  id: string;
  revisionKey?: string | undefined;
  sourceInstanceId?: string | undefined;
  sourceObjectId?: string | undefined;
  sourceGeneration?: number | undefined;
  cursorStart?: number | undefined;
  cursorEnd?: number | undefined;
}

export interface EvidenceSource {
  id: string;
  kind: string;
  contractVersion?: string | undefined;
}

export interface ObservationProvenance {
  observedAt: string;
  effectiveAt?: string | undefined;
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
  contractVersion?: string | undefined;
  limitations: string[];
}

export interface ObservationCoverage {
  family: MonitorMetricFamily;
  completeness: EvidenceCompleteness;
  asOf: string;
  actor?: ActorRunRef | undefined;
  reason?: string | undefined;
}

export interface SourceWatermark {
  sourceId: string;
  sourceEpoch: string;
  sequence?: number | undefined;
  cursor?: string | undefined;
  observedThrough?: string | undefined;
}

export type MonitorRunLifecycle = 'allocated' | 'preparing' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed';

export interface MonitorRunStatusObservation {
  kind: 'run';
  lifecycle: MonitorRunLifecycle;
  alive: boolean;
  nativeSession?: NativeSessionRef | undefined;
  failure?: { code?: string | undefined; detail?: string | undefined; recoverable?: boolean | undefined } | undefined;
}

export interface MonitorActivityObservation {
  kind: 'activity';
  activityKind: MonitorActivityKind;
  active: boolean;
  line?: string | undefined;
  since?: string | undefined;
  actor?: ActorRunRef | undefined;
  /** Runtime-scheduled expiry closes pulse-only activity; reducers never read the clock. */
  leaseId?: string | undefined;
}

export type MonitorInteractionKind = 'permission' | 'choice' | 'multi-choice' | 'free-form' | 'mixed';
export type MonitorInteractionState = 'pending' | 'resolved' | 'failed' | 'cancelled' | 'superseded';

export interface MonitorInteractionObservation {
  kind: 'interaction';
  interactionId: string;
  interactionKind: MonitorInteractionKind;
  state: MonitorInteractionState;
  actor?: ActorRunRef | undefined;
  questions?: MonitorStructuredQuestion[] | undefined;
  permission?: { requestId: string; tool?: string | undefined } | undefined;
  detail?: string | undefined;
}

export interface MonitorFailureObservation {
  kind: 'failure';
  failureId: string;
  state: 'active' | 'resolved' | 'dismissed';
  actor?: ActorRunRef | undefined;
  detail?: string | undefined;
  code?: string | undefined;
  recoverable: boolean;
}

export type MonitorStatusFamilyValue =
  MonitorRunStatusObservation | MonitorActivityObservation | MonitorInteractionObservation | MonitorFailureObservation;

export type MonitorUsageBoundary = 'response' | 'sample';

export interface MonitorUsageFamilyValue {
  kind: 'usage';
  usageId: string;
  actor?: ActorRunRef | undefined;
  boundary: MonitorUsageBoundary;
  /** Response usage is canonical; samples are compatible low-latency estimates/cross-checks. */
  canonical: boolean;
  totalTokens?: number | undefined;
  meterTokens?: number | undefined;
  cumulativeTokens?: number | undefined;
  deltaTokens?: number | undefined;
  inputTokens?: number | undefined;
  freshInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface MonitorMessageFamilyValue {
  kind: 'message';
  actor?: ActorRunRef | undefined;
  /** Bounded at the reducer; the accumulated text so far, not a delta. */
  text: string;
  final: boolean;
  messageId?: string | undefined;
}

export interface MonitorContextFamilyValue {
  kind: 'context';
  actor?: ActorRunRef | undefined;
  usedTokens?: number | undefined;
  capacityTokens?: number | undefined;
  usedPercentage?: number | undefined;
  percentageSource: 'provider' | 'derived' | 'unavailable';
}

export interface MonitorModelFamilyValue {
  kind: 'model';
  actor?: ActorRunRef | undefined;
  providerModelId: string;
  displayName?: string | undefined;
  intent: 'configured' | 'observed';
}

export interface MonitorEffortFamilyValue {
  kind: 'effort';
  actor?: ActorRunRef | undefined;
  value: string;
  intent: 'configured' | 'observed';
}

export interface MonitorModeFamilyValue {
  kind: 'mode';
  actor?: ActorRunRef | undefined;
  modeKind: 'execution' | 'provider-session' | 'provider-permission';
  raw: string;
  normalized?: string | undefined;
  executionMode?: AgentExecutionMode | undefined;
  /** Omitted legacy values are treated as observed. */
  intent?: 'configured' | 'observed' | undefined;
}

export interface AffiliationRef {
  kind: 'team' | 'workflow';
  id: string;
  name?: string | undefined;
}

export interface MonitorActorFamilyValue {
  kind: 'actor';
  actor: ActorRunRef;
  state: 'active' | 'idle' | 'stopped' | 'unknown';
  activity?: string | undefined;
}

export interface MonitorAffiliationFamilyValue {
  kind: 'affiliation';
  actor: ActorRunRef;
  affiliation: AffiliationRef;
  role?: string | undefined;
}

export interface MonitorTeamFamilyValue {
  kind: 'team';
  /** Provider-neutral/canonical identity used for durable affiliation joins. */
  teamId: string;
  /** Provider-native identity used to reconcile low-latency hook claims. */
  nativeTeamId?: string | undefined;
  name?: string | undefined;
}

export interface MonitorTeamMemberFamilyValue {
  kind: 'team-member';
  membershipId: string;
  teamId: string;
  /** Provider-native aliases used only to reconcile complementary evidence rails. */
  nativeTeamId?: string | undefined;
  nativeMemberId?: string | undefined;
  actor?: ActorRunRef | undefined;
  runtimeRunId?: RuntimeRunId | undefined;
  name?: string | undefined;
  /** Membership presence is independent from the member's current activity. */
  membershipState?: 'present' | 'removed' | 'unknown' | undefined;
  state: 'active' | 'idle' | 'removed' | 'unknown';
}

export type MonitorDelegationFamilyValue =
  MonitorActorFamilyValue | MonitorAffiliationFamilyValue | MonitorTeamFamilyValue | MonitorTeamMemberFamilyValue;

export interface MonitorWorkflowFamilyValue {
  kind: 'workflow';
  workflowId: string;
  name?: string | undefined;
  active: boolean;
  actorRunKeys: string[];
  artifactRefs: ArtifactRef[];
}

export interface MonitorCompactionFamilyValue {
  kind: 'compaction';
  actor?: ActorRunRef | undefined;
  active: boolean;
  trigger?: string | undefined;
  outcome?: 'completed' | 'cancelled' | 'failed' | 'superseded' | 'unknown' | undefined;
}

export interface MonitorEnvironmentFamilyValue {
  kind: 'environment';
  actor?: ActorRunRef | undefined;
  /** Null explicitly clears the current cwd; omission leaves the prior fact unchanged. */
  cwd?: string | null | undefined;
  git?: AgentGitState | null | undefined;
  worktrees?: string[] | undefined;
}

export interface MonitorFamilyValueMap {
  status: MonitorStatusFamilyValue;
  usage: MonitorUsageFamilyValue;
  context: MonitorContextFamilyValue;
  model: MonitorModelFamilyValue;
  effort: MonitorEffortFamilyValue;
  mode: MonitorModeFamilyValue;
  delegation: MonitorDelegationFamilyValue;
  workflow: MonitorWorkflowFamilyValue;
  compaction: MonitorCompactionFamilyValue;
  environment: MonitorEnvironmentFamilyValue;
  conversation: MonitorMessageFamilyValue;
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
    sequence?: number | undefined;
    contractVersion?: string | undefined;
  };
  phase: MonitorObservationPhase;
  observedAt: string;
  effectiveAt?: string | undefined;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  readiness?: 'loading' | 'ready' | 'degraded' | undefined;
  scope?:
    | {
        nativeSessionId?: string | undefined;
        actorRunKey?: string | undefined;
      }
    | undefined;
  updates: MonitorFamilyUpdate[];
  sourceWatermarks: SourceWatermark[];
  evidence: EvidenceRef[];
  capabilities?: ObservationCapability[] | undefined;
  coverage?: ObservationCoverage[] | undefined;
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
  effectiveAt?: string | undefined;
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
  effectiveAt?: string | undefined;
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
  count?: number | undefined;
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
  headCommit?: string | undefined;
  headRef?: string | undefined;
  index: MonitorWorkspaceChangeSummary;
  worktree: MonitorWorkspaceChangeSummary;
  conflicts: number;
  indexFingerprint?: { algorithm: 'hmac-sha256'; value: string } | undefined;
  worktreeFingerprint?: { algorithm: 'hmac-sha256'; value: string } | undefined;
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
    repositoryDigest?: { algorithm: 'hmac-sha256'; value: string } | undefined;
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
  finalization?:
    | {
        finalizedAt: string;
        outcome: 'complete' | 'partial' | 'failed' | 'unavailable';
        repositoryKind: 'git' | 'directory';
        repositoryDigest?: { algorithm: 'hmac-sha256'; value: string } | undefined;
        git?: MonitorWorkspaceGitObservation | undefined;
        reachableCommits?:
          | {
              relation: 'unchanged' | 'fast-forward' | 'rewritten' | 'created' | 'removed' | 'unavailable';
              initialCommit?: string | undefined;
              finalCommit?: string | undefined;
              commits: string[];
              totalCount: number;
              truncated: boolean;
            }
          | undefined;
        changes?:
          | {
              filesTouchedCount: number;
              filesFingerprint?: { algorithm: 'hmac-sha256'; value: string } | undefined;
              insertions: number;
              deletions: number;
            }
          | undefined;
        knownConcurrentClaims?: number | undefined;
        cleanupOutcome: 'not-applicable' | 'removed' | 'retained-dirty' | 'failed';
        retained: boolean;
        quality: EvidenceQuality;
        completeness: EvidenceCompleteness;
        limitations: string[];
      }
    | undefined;
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
  effectiveAt?: string | undefined;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  phase: MonitorObservationPhase;
  evidence: EvidenceRef[];
  /** Original live boundary retained when a later correction replaces this entry. */
  rateEligible: boolean;
  rateAt?: string | undefined;
}

export interface MonitorRuntimeSlice {
  seenEventIds: ReadonlySet<string>;
  entries: ReadonlyMap<string, MonitorStoredEntry>;
  lastAcceptedAt?: string | undefined;
}

export interface MonitorSemanticProducerState {
  id: string;
  activeEpoch: string;
  retiredEpochs: ReadonlySet<string>;
  lastSequence?: number | undefined;
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
  lastAcceptedAt?: string | undefined;
}

export interface MonitorWorkspaceSlice {
  seenRecordIds: ReadonlySet<string>;
  entries: ReadonlyMap<string, MonitorStoredEntry>;
  provenance: ReadonlyMap<string, MonitorWorkspaceProvenanceState>;
  /** Most recent private workspace-plane input, including provenance-only records. */
  lastAcceptedAt?: string | undefined;
  /** Most recent workspace input that can change the public monitor projection. */
  lastPublicAcceptedAt?: string | undefined;
}

export interface CreateMonitorAccumulatorOptions {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  executionMode: AgentExecutionMode;
  observationLevel: ObservationLevel;
  allocatedAt: string;
  providerId?: string | undefined;
  terminalSessionId?: string | undefined;
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
  providerId?: string | undefined;
  terminalSessionId?: string | undefined;
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
