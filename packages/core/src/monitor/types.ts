import type { AgentExecutionMode, AgentGitState, ObservationLevel } from '../events.js';

/** Current wire/schema generation for the JSON-plain monitor projection. */
export const AGENT_MONITOR_SCHEMA_VERSION = 1 as const;

/** One Puppeteer-managed provider invocation. */
export type RuntimeRunId = string;

/** One allocated working area and its runtime-owned provenance lifecycle. */
export type WorkspaceInstanceId = string;

/** Opaque caller correlation. Puppeteer transports these values but does not interpret their policy. */
export interface ExternalRef {
  namespace: string;
  id: string;
  kind: 'project' | 'contributor' | 'workflow' | 'caller' | 'other';
}

export type EvidenceQuality = 'exact' | 'strong' | 'derived' | 'estimated' | 'inferred' | 'unknown';
export type EvidenceCompleteness = 'complete' | 'partial' | 'unavailable';

/** A correctable claim about the provider's durable conversation identity. */
export interface NativeSessionRef {
  namespace: string;
  id: string;
  basis: 'configured' | 'observed' | 'inferred';
  quality: EvidenceQuality;
}

export interface RuntimeRunRef {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  providerId: string;
  executionMode: AgentExecutionMode;
  terminalSessionId?: string;
  nativeSession?: NativeSessionRef;
  externalRefs: ExternalRef[];
}

/** Evidence-backed root or child participant in a native session. */
export interface ActorRunRef {
  rootSessionKey: string;
  runKey: string;
  role: 'root' | 'child' | 'auxiliary' | 'unknown';
  parentRunKey?: string;
  nativeSessionId?: string;
  nativeAgentId?: string;
  nativeAgentType?: string;
}

/** A scoped semantic-observer attachment; its scope epoch is not the runtime epoch. */
export interface ObservationAttachmentRef {
  attachmentId: string;
  runtimeRunId: RuntimeRunId;
  observerContract: string;
  observerScopeEpoch: string;
}

export type ArtifactFamily = 'workflow-definition' | 'workflow-journal' | 'team-config' | 'other';

/** Opaque reference to content that is available only through a bounded host operation. */
export interface ArtifactRef {
  artifactId: string;
  family: ArtifactFamily;
  mediaType?: string;
  byteLength?: number;
  contentHash?: string;
  availability: 'readable' | 'metadata-only' | 'unavailable';
}

export type MonitorArtifactReadResult =
  | {
      status: 'ok';
      artifact: ArtifactRef;
      encoding: 'utf8' | 'base64';
      content: string;
    }
  | {
      status: 'denied' | 'unavailable' | 'too-large';
      artifact?: ArtifactRef;
      message?: string;
    };

export type AgentMonitorStatus = 'idle' | 'working' | 'blocked';

export interface MonitorQuestionOption {
  label: string;
  description?: string;
}

export interface MonitorStructuredQuestion {
  id?: string;
  header?: string;
  prompt: string;
  options?: MonitorQuestionOption[];
  allowMultiple?: boolean;
  allowFreeForm?: boolean;
}

export interface MonitorBlockerBase {
  id: string;
  detail?: string;
  since: string;
  actorRunKey?: string;
}

export type MonitorBlocker =
  | (MonitorBlockerBase & {
      kind: 'permission';
      permission?: { requestId: string; tool?: string };
    })
  | (MonitorBlockerBase & {
      kind: 'question';
      questions: MonitorStructuredQuestion[];
    })
  | (MonitorBlockerBase & {
      kind: 'failure';
      failure?: { code?: string; recoverable?: boolean };
    });

export type MonitorActivityKind =
  'starting' | 'responding' | 'reasoning' | 'tool' | 'delegating' | 'compacting' | 'other';

export interface MonitorActivity {
  kind: MonitorActivityKind;
  line: string;
  since: string;
}

export type MonitorMetricFamily =
  | 'status'
  | 'usage'
  | 'context'
  | 'model'
  | 'effort'
  | 'mode'
  | 'planning'
  | 'delegation'
  | 'workflow'
  | 'compaction'
  | 'environment';

export type MonitorBoundedCollection =
  | 'blockers'
  | 'usageSamples'
  | 'planSteps'
  | 'tasks'
  | 'subagents'
  | 'teammates'
  | 'workflows'
  | 'artifactRefs'
  | 'workflowActorRunKeys'
  | 'worktrees'
  | 'questions'
  | 'questionOptions';

export interface MonitorUsageSample {
  at: string;
  cumulativeTokens: number;
}

export interface MonitorUsageAggregate {
  /** Corrected current estimate; source corrections may move it downward. */
  cumulativeTokens?: number;
  inputTokens?: number;
  freshInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** Never negative, and never synthesized from a bootstrap baseline. */
  burnRatePerMin?: number;
  burnRateWindowMs?: number;
  burnRateBoundary?: 'response' | 'sample' | 'mixed';
  asOf?: string;
}

export interface MonitorUsageState extends MonitorUsageAggregate {
  /** Explicit root-actor usage when the source identifies actor scope. */
  rootActor?: MonitorUsageAggregate;
  samples: MonitorUsageSample[];
}

export interface MonitorContextState {
  usedTokens?: number;
  capacityTokens?: number;
  usedPercent?: number;
  percentageSource: 'provider' | 'derived' | 'unavailable';
  asOf: string;
}

export interface MonitorModelValue {
  id: string;
  displayName?: string;
}

export interface MonitorModelState extends MonitorModelValue {
  configured?: MonitorModelValue;
  /** Omitted only by older schema-v1 producers; consumers treat omission as observed. */
  intent?: 'configured' | 'observed';
  asOf?: string;
}

export interface MonitorEffortState {
  value: string;
  configured?: string;
  /** Whether `value` is effective provider evidence or only launch intent. */
  intent?: 'configured' | 'observed';
  asOf?: string;
}

export interface MonitorProviderModeValue {
  raw: string;
  normalized?: string;
}

export interface MonitorProviderMode extends MonitorProviderModeValue {
  configured?: MonitorProviderModeValue;
  /** Omitted only by older schema-v1 producers; consumers treat omission as observed. */
  intent?: 'configured' | 'observed';
}

export interface MonitorModesState {
  execution: AgentExecutionMode;
  providerSession?: MonitorProviderMode;
  providerPermission?: MonitorProviderMode;
  asOf?: string;
}

export interface MonitorPlanStep {
  text: string;
  status: string;
}

export interface MonitorPlanState {
  updatedAt: string;
  actorRunKey?: string;
  steps: MonitorPlanStep[];
  provisional?: boolean;
}

export interface MonitorTaskState {
  id: string;
  actorRunKey?: string;
  description?: string;
  status: string;
  teamName?: string;
  teammateName?: string;
  provisional?: boolean;
}

export interface MonitorSubagentState {
  id: string;
  actorRunKey?: string;
  type?: string;
  active: boolean;
  activity?: string;
  cumulativeTokens?: number;
  burnRatePerMin?: number;
  contextPercent?: number;
  modelId?: string;
  modelIntent?: 'configured' | 'observed';
  effort?: string;
  effortIntent?: 'configured' | 'observed';
}

export interface MonitorTeammateState {
  id: string;
  name?: string;
  /** Stable in-session actor identity when the provider can join membership to usage. */
  actorRunKey?: string;
  runtimeRunId?: RuntimeRunId;
  idle?: boolean;
  activity?: string;
  cumulativeTokens?: number;
  burnRatePerMin?: number;
  contextPercent?: number;
  modelId?: string;
  modelIntent?: 'configured' | 'observed';
  effort?: string;
  effortIntent?: 'configured' | 'observed';
  /** The current activity claim is low-latency evidence awaiting durable confirmation. */
  activityProvisional?: boolean;
  /** The membership itself is low-latency evidence awaiting durable confirmation. */
  provisional?: boolean;
}

export interface MonitorTeamState {
  id?: string;
  name?: string;
  memberId?: string;
  memberName?: string;
  teammates: MonitorTeammateState[];
  /** The team identity is low-latency evidence awaiting durable confirmation. */
  provisional?: boolean;
}

export interface MonitorWorkflowState {
  id: string;
  name?: string;
  active: boolean;
  actorRunKeys: string[];
  artifactRefs: ArtifactRef[];
}

export interface MonitorCompactionState {
  active: boolean;
  provisional?: boolean;
  lastAt?: string;
  lastOutcome?: 'completed' | 'cancelled' | 'failed' | 'superseded' | 'unknown';
  count: number;
}

export interface MonitorEnvironmentState {
  cwd?: string;
  git?: AgentGitState | null;
  worktrees: string[];
}

export interface MonitorSessionState {
  nativeSessionId?: string;
  startedAt?: string;
}

export type MonitorFamilySupport = 'supported' | 'degraded' | 'unsupported';
export type MonitorFamilyAvailability = 'available' | 'partial' | 'unavailable' | 'loading';

export interface MonitorFamilyFreshness {
  support: MonitorFamilySupport;
  /** Coverage/readiness is orthogonal to whether the provider supports the family at all. */
  availability?: MonitorFamilyAvailability;
  asOf?: string;
  reason?: string;
}

export interface MonitorFreshnessState {
  lastEvidenceAt?: string;
  level: ObservationLevel;
  families: Partial<Record<MonitorMetricFamily, MonitorFamilyFreshness>>;
}

/**
 * The complete renderer-facing state for one runtime run. It is intentionally
 * lossy and JSON-plain; source revisions and provider records stay behind the
 * version-locked monitor SPI.
 */
export interface AgentMonitorState {
  schemaVersion: number;
  runtimeEpoch: number;
  revision: number;
  runtimeRunId: RuntimeRunId;

  status: AgentMonitorStatus;
  statusSince: string;
  blockers: MonitorBlocker[];
  activity?: MonitorActivity;

  usage: MonitorUsageState;
  context?: MonitorContextState;
  model?: MonitorModelState;
  effort?: MonitorEffortState;
  modes: MonitorModesState;

  plan?: MonitorPlanState;
  tasks: MonitorTaskState[];
  subagents: MonitorSubagentState[];
  team?: MonitorTeamState;
  workflows: MonitorWorkflowState[];

  /** Number omitted from deterministic bounded public collections. */
  omitted?: Partial<Record<MonitorBoundedCollection, number>>;

  compaction: MonitorCompactionState;
  environment: MonitorEnvironmentState;
  session: MonitorSessionState;
  freshness: MonitorFreshnessState;
  alive: boolean;
}

export type MonitorNotificationType =
  | 'blocked.entered'
  | 'plan.created'
  | 'planning:updated'
  | 'delegation:task-created'
  | 'delegation:task-completed'
  | 'delegation:subagent-started'
  | 'delegation:subagent-stopped'
  | 'team.observed'
  | 'team.member-added'
  | 'team.member-removed'
  | 'team.member-idle'
  | 'workflow.started'
  | 'workflow.completed'
  | 'compaction:started'
  | 'compaction:completed'
  | 'cwd.changed'
  | 'worktree.created'
  | 'worktree.removed'
  | 'session.ended';

export interface MonitorNotification {
  notificationId: string;
  runtimeRunId: RuntimeRunId;
  at: string;
  type: MonitorNotificationType;
  summary?: string;
}

/** Race-free, per-consumer view of one runtime-owned monitor hub. */
export interface AgentMonitorHandle {
  states: AsyncIterable<AgentMonitorState>;
  notifications: AsyncIterable<MonitorNotification>;
  ready: Promise<AgentMonitorState>;
  current(): AgentMonitorState | undefined;
  readArtifact(artifactId: string, options?: { maxBytes?: number }): Promise<MonitorArtifactReadResult>;
  /** Closes this subscription, never the underlying provider session or shared source observer. */
  close(): Promise<void>;
}
