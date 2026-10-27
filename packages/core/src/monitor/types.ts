import type { AgentExecutionMode, AgentGitState, ObservationLevel } from '../events/index.js';

/** Current wire/schema generation for the JSON-plain monitor projection. */
export const AGENT_MONITOR_SCHEMA_VERSION = 3 as const;

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
  terminalSessionId?: string | undefined;
  nativeSession?: NativeSessionRef | undefined;
  externalRefs: ExternalRef[];
}

/** Evidence-backed root or child participant in a native session. */
export interface ActorRunRef {
  rootSessionKey: string;
  runKey: string;
  role: 'root' | 'child' | 'auxiliary' | 'unknown';
  parentRunKey?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeAgentId?: string | undefined;
  nativeAgentType?: string | undefined;
}

export type AgentMonitorStatus = 'idle' | 'working' | 'blocked';

export interface MonitorQuestionOption {
  label: string;
  description?: string | undefined;
}

export interface MonitorStructuredQuestion {
  id?: string | undefined;
  header?: string | undefined;
  prompt: string;
  options?: MonitorQuestionOption[] | undefined;
  allowMultiple?: boolean | undefined;
  allowFreeForm?: boolean | undefined;
}

export interface MonitorBlockerBase {
  id: string;
  detail?: string | undefined;
  since: string;
  actorRunKey?: string | undefined;
}

export type MonitorBlocker =
  | (MonitorBlockerBase & {
      kind: 'permission';
      permission?: { requestId: string; tool?: string | undefined } | undefined;
    })
  | (MonitorBlockerBase & {
      kind: 'question';
      questions: MonitorStructuredQuestion[];
    })
  | (MonitorBlockerBase & {
      kind: 'failure';
      failure?: { code?: string | undefined; recoverable?: boolean | undefined } | undefined;
    });

export type MonitorActivityKind =
  'starting' | 'responding' | 'reasoning' | 'tool' | 'delegating' | 'compacting' | 'other';

export interface MonitorActivity {
  kind: MonitorActivityKind;
  line: string;
  since: string;
}

/**
 * The root agent's latest assistant message, bounded. Provider display and
 * transcript observation both feed it; `final` is false while a reply is still
 * streaming. Views show it as one line; the full text is never what this is for.
 */
export interface MonitorAssistantMessageState {
  text: string;
  at: string;
  final: boolean;
  messageId?: string | undefined;
}

export type MonitorMetricFamily =
  | 'status'
  | 'usage'
  | 'context'
  | 'model'
  | 'effort'
  | 'mode'
  | 'delegation'
  | 'compaction'
  | 'environment'
  | 'conversation';

export type MonitorBoundedCollection =
  'blockers' | 'usageSamples' | 'subagents' | 'worktrees' | 'questions' | 'questionOptions';

export interface MonitorUsageSample {
  at: string;
  cumulativeTokens: number;
  /** Cumulative prompt-side tokens (input, cache reads, cache creation) when the source splits usage. */
  inputTokens?: number | undefined;
  /** Cumulative completion-side tokens (output, reasoning) when the source splits usage. */
  outputTokens?: number | undefined;
}

export interface MonitorUsageAggregate {
  /** Corrected current estimate; source corrections may move it downward. */
  cumulativeTokens?: number | undefined;
  inputTokens?: number | undefined;
  freshInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  costUsd?: number | undefined;
  /** Estimated API-equivalent USD, for observed work only; never a subscription invoice. */
  costCoverage?: 'complete' | 'partial' | 'unavailable' | undefined;
  pricedObservations?: number | undefined;
  unpricedObservations?: number | undefined;
  costRatePerMin?: number | undefined;
  /** Never negative, and never synthesized from a bootstrap baseline. */
  burnRatePerMin?: number | undefined;
  burnRateWindowMs?: number | undefined;
  burnRateBoundary?: 'response' | 'sample' | 'mixed' | undefined;
  asOf?: string | undefined;
}

export interface MonitorUsageState extends MonitorUsageAggregate {
  /** Corrected costs in fixed 30-second buckets, including the current bucket. */
  costHistory?: MonitorCostBucket[] | undefined;
  /** Explicit root-actor usage when the source identifies actor scope. */
  rootActor?: MonitorUsageAggregate | undefined;
  samples: MonitorUsageSample[];
}

export interface MonitorCostBucket {
  at: string;
  costUsd: number;
  inputUsd?: number | undefined;
  outputUsd?: number | undefined;
}

export interface MonitorContextState {
  usedTokens?: number | undefined;
  capacityTokens?: number | undefined;
  usedPercent?: number | undefined;
  percentageSource: 'provider' | 'derived' | 'unavailable';
  asOf: string;
}

export interface MonitorModelValue {
  id: string;
  displayName?: string | undefined;
}

export interface MonitorModelState extends MonitorModelValue {
  configured?: MonitorModelValue | undefined;
  /** Omitted only by older schema-v1 producers; consumers treat omission as observed. */
  intent?: 'configured' | 'observed' | undefined;
  asOf?: string | undefined;
}

export interface MonitorEffortState {
  value: string;
  configured?: string | undefined;
  /** Whether `value` is effective provider evidence or only launch intent. */
  intent?: 'configured' | 'observed' | undefined;
  asOf?: string | undefined;
}

export interface MonitorProviderModeValue {
  raw: string;
  normalized?: string | undefined;
}

export interface MonitorProviderMode extends MonitorProviderModeValue {
  configured?: MonitorProviderModeValue | undefined;
  /** Omitted only by older schema-v1 producers; consumers treat omission as observed. */
  intent?: 'configured' | 'observed' | undefined;
}

export interface MonitorModesState {
  execution: AgentExecutionMode;
  providerSession?: MonitorProviderMode | undefined;
  providerPermission?: MonitorProviderMode | undefined;
  asOf?: string | undefined;
}

/** A known child, exposing only identity, model/effort, usage and observed work. */
export interface MonitorSubagentState {
  id: string;
  /** True only while this child has observed work; false does not assert termination. */
  working: boolean;
  activity?: string | undefined;
  modelId?: string | undefined;
  effort?: string | undefined;
  cumulativeTokens?: number | undefined;
  burnRatePerMin?: number | undefined;
  costUsd?: number | undefined;
  costRatePerMin?: number | undefined;
  costCoverage?: MonitorUsageAggregate['costCoverage'];
}

export interface MonitorCompactionState {
  active: boolean;
  provisional?: boolean | undefined;
  lastAt?: string | undefined;
  lastOutcome?: 'completed' | 'cancelled' | 'failed' | 'superseded' | 'unknown' | undefined;
  count: number;
}

export interface MonitorEnvironmentState {
  cwd?: string | undefined;
  git?: AgentGitState | null | undefined;
  worktrees: string[];
}

export interface MonitorSessionState {
  nativeSessionId?: string | undefined;
  startedAt?: string | undefined;
}

export type MonitorFamilySupport = 'supported' | 'degraded' | 'unsupported';
export type MonitorFamilyAvailability = 'available' | 'partial' | 'unavailable' | 'loading';

export interface MonitorFamilyFreshness {
  support: MonitorFamilySupport;
  /** Coverage/readiness is orthogonal to whether the provider supports the family at all. */
  availability?: MonitorFamilyAvailability | undefined;
  asOf?: string | undefined;
  reason?: string | undefined;
}

export interface MonitorFreshnessState {
  lastEvidenceAt?: string | undefined;
  /**
   * Set while a root tool call is open, whether or not it is the headline `activity` (a compaction outranks it there).
   * A tool may run silent for minutes, so its quiet is not staleness: readers hold the evidence clock while it is open.
   */
  toolOpen?: boolean | undefined;
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
  activity?: MonitorActivity | undefined;
  lastAssistantMessage?: MonitorAssistantMessageState | undefined;

  usage: MonitorUsageState;
  context?: MonitorContextState | undefined;
  model?: MonitorModelState | undefined;
  effort?: MonitorEffortState | undefined;
  modes: MonitorModesState;

  /** Known distinct children in this run, including completed children; counted before display bounds. */
  subagentCount: number;
  subagents: MonitorSubagentState[];

  /** Number omitted from deterministic bounded public collections. */
  omitted?: Partial<Record<MonitorBoundedCollection, number>> | undefined;

  compaction: MonitorCompactionState;
  environment: MonitorEnvironmentState;
  session: MonitorSessionState;
  freshness: MonitorFreshnessState;
  alive: boolean;
}

export type MonitorNotificationType =
  | 'blocked.entered'
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
  summary?: string | undefined;
}

/** Race-free, per-consumer view of one runtime-owned monitor hub. */
export interface AgentMonitorHandle {
  states: AsyncIterable<AgentMonitorState>;
  notifications: AsyncIterable<MonitorNotification>;
  ready: Promise<AgentMonitorState>;
  current(): AgentMonitorState | undefined;
  /** Closes this subscription, never the underlying provider session or shared source observer. */
  close(): Promise<void>;
}
