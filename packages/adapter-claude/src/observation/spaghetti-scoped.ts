/**
 * RFC-012D Claude session-tree observation.
 *
 * The scoped provider consumes Spaghetti's typed, store-free observer and
 * projects only provider-neutral monitor batches across the adapter seam. It
 * owns the source epoch, replacement staging, revision deduplication, and
 * native-to-monitor joins. Raw Spaghetti values never leave this module.
 *
 * This is Claude's sole transcript-derived observation source. It owns both
 * typed application conversation events and correction-aware monitor batches;
 * the retired raw transcript tail is never attached in parallel.
 */

import { basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ActorRunRef, EvidenceCompleteness, EvidenceQuality, MonitorMetricFamily } from '@vibecook/puppeteer-core';
import type { MonitorArtifactReadResult } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValue,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
  SourceWatermark,
} from '@vibecook/puppeteer-core/monitor-spi';
import type {
  ActorRunRevisionFact,
  ObserveSessionRequest,
  ObserverEvent,
  ObserverFamily,
  SemanticObserverEvent,
  SessionObserver,
} from '@vibecook/spaghetti-sdk';
import { claudePermissionMode } from '../provider-modes.js';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from './semantic-provider.js';
import { projectSpaghettiConversation, spaghettiConversationFingerprint } from './spaghetti-conversation.js';

export const SPAGHETTI_SCOPED_CONTRACT = 'spaghetti-sdk@0.7.0-local+rfc012cd';
const PRODUCER_ID = 'claude:spaghetti-scoped';
const MAX_BATCH_EVIDENCE_REFS = 256;

export type SpaghettiScopedObservationFailureCode =
  'sdk-load-failed' | 'contract-unavailable' | 'scope-invalid' | 'attach-failed' | 'observer-error' | 'observer-closed';

export class SpaghettiScopedObservationError extends Error {
  readonly name = 'SpaghettiScopedObservationError';

  constructor(
    readonly code: SpaghettiScopedObservationFailureCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

const PROJECTED_FAMILIES = [
  'status',
  'usage',
  'model',
  'effort',
  'mode',
  'planning',
  'delegation',
  'workflow',
  'compaction',
] as const satisfies readonly MonitorMetricFamily[];

export const SPAGHETTI_SCOPED_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-session-observer',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['The observer supplies structured questions, tools, and native progress, not process liveness.'],
  },
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'spaghetti-rfc012d-usage-v2',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Usage is response-boundary evidence rather than per-token streaming.'],
  },
  {
    family: 'context',
    support: 'unsupported',
    actorScope: 'current-actors',
    latency: 'historical',
    source: 'spaghetti-rfc012d-session-observer',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['usage_v2 input tokens do not prove current context-window occupancy or capacity.'],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'spaghetti-rfc012d-effective-state',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['An observed model arrives only when native response or transition evidence exists.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'spaghetti-rfc012d-effective-state',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Claude transcripts do not carry applied effort on every response.'],
  },
  {
    family: 'mode',
    support: 'supported',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-effective-state',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Only modes backed by native configuration, response, or transition evidence are emitted.'],
  },
  {
    family: 'planning',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-plan-task',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Plan step status is not native; ordered plan steps are represented with an unknown status.'],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-actor-graph',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: [
      'Actor-run existence and affiliation do not by themselves prove current liveness.',
      'The scoped runtime families expose verified affiliations, not the full configured team roster or configured per-member model.',
    ],
  },
  {
    family: 'workflow',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-actor-affiliation',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Workflow membership is observable, but bounded workflow artifact reads are not implemented.'],
  },
  {
    family: 'compaction',
    support: 'supported',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'spaghetti-rfc012d-native-marker',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: [],
  },
  {
    family: 'environment',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'spaghetti-rfc012d-session-observer',
    contractVersion: SPAGHETTI_SCOPED_CONTRACT,
    limitations: ['Workspace and Git topology remain runtime-owned.'],
  },
] as const;

export type SpaghettiScopedObservationDiagnostic =
  | {
      kind: 'barrier';
      phase: 'bootstrap' | 'resync';
      nativeSessionId: string;
      scopeEpoch: number;
      rootPresent: boolean;
      familyManifest: readonly SpaghettiScopedFamilyManifestSummary[];
      actorRunCount: number;
      actorRunDigest: string;
    }
  | {
      kind: 'overflow';
      nativeSessionId: string;
      scopeEpoch: number;
      reason: string;
      lastContiguousSequence: number;
    }
  | {
      kind: 'source-error';
      nativeSessionId: string;
      scopeEpoch: number;
      terminal: boolean;
    }
  | {
      kind: 'error';
      nativeSessionId: string;
      scopeEpoch?: number;
      code: Extract<SpaghettiScopedObservationFailureCode, 'observer-error'>;
    }
  | { kind: 'closed'; nativeSessionId: string; scopeEpoch: number; discardedEvents: number };

export interface SpaghettiScopedFamilyManifestSummary {
  family: string;
  contractVersion: number;
  entityCount: number;
  digest: string;
}

interface SpaghettiObserverFamilyManifestEntry {
  family: ObserverFamily;
  contract_version: number;
  entity_count: number;
  digest: string;
}

export interface SpaghettiScopedSessionObserverLike extends AsyncIterable<unknown> {
  close(): Promise<void>;
}

type ObserverFactory = (
  request: Record<string, unknown>,
  options?: Record<string, never>,
) => SpaghettiScopedSessionObserverLike;

export interface SpaghettiScopedObservationProviderOptions {
  observerFactory?: ObserverFactory;
  /** Claude configuration/data root. Inferred from projects/<project>/<session>.jsonl when omitted. */
  agentRoot?: string | ((transcriptPath: string) => string);
  contractVersion?: string;
  includeDescendants?: boolean;
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
  onDiagnostic?: (diagnostic: SpaghettiScopedObservationDiagnostic) => void;
}

type MonitorLedger = Map<MonitorMetricFamily, Map<string, MonitorFamilyValue>>;
type SemanticFacts = Map<string, SemanticObserverEvent>;

interface EpochState {
  epoch: number;
  facts: SemanticFacts;
  eventIds: Set<string>;
  unknownEvidence: boolean;
}

function emptyLedger(): MonitorLedger {
  return new Map(PROJECTED_FAMILIES.map((family) => [family, new Map()]));
}

function familyLedger(ledger: MonitorLedger, family: MonitorMetricFamily): Map<string, MonitorFamilyValue> {
  let values = ledger.get(family);
  if (!values) {
    values = new Map();
    ledger.set(family, values);
  }
  return values;
}

function setValue<F extends MonitorMetricFamily>(
  ledger: MonitorLedger,
  family: F,
  key: string,
  value: MonitorFamilyValueMap[F],
): void {
  familyLedger(ledger, family).set(key, value);
}

function emitDiagnostic(
  callback: SpaghettiScopedObservationProviderOptions['onDiagnostic'],
  diagnostic: SpaghettiScopedObservationDiagnostic,
): void {
  try {
    callback?.(diagnostic);
  } catch {
    // Diagnostics cannot destabilize observation.
  }
}

function inferredAgentRoot(transcriptPath: string): string {
  const projectDirectory = dirname(transcriptPath);
  const projectsDirectory = dirname(projectDirectory);
  if (basename(projectsDirectory) !== 'projects') {
    throw new Error('Cannot infer Claude agent root: transcript is not under projects/<project>/<session>.jsonl');
  }
  return dirname(projectsDirectory);
}

function resolveAgentRoot(
  configured: SpaghettiScopedObservationProviderOptions['agentRoot'],
  transcriptPath: string,
): string {
  if (typeof configured === 'function') return configured(transcriptPath);
  return configured ?? inferredAgentRoot(transcriptPath);
}

function isoTime(milliseconds: number | null | undefined, fallback = Date.now()): string {
  const value = typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : fallback;
  return new Date(value).toISOString();
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function qualifiedQuality(quality: string | undefined): EvidenceQuality {
  switch (quality) {
    case 'exact':
      return 'exact';
    case 'native_claimed':
      return 'strong';
    case 'derived':
      return 'derived';
    case 'estimated':
      return 'estimated';
    default:
      return 'unknown';
  }
}

function factCompleteness(event: SemanticObserverEvent): EvidenceCompleteness {
  const value = event.value;
  if (!value) return 'complete';
  let completeness: string | undefined;
  if ('UserInputRequestRevision' in value) completeness = value.UserInputRequestRevision.completeness;
  else if ('MessageRevision' in value) completeness = value.MessageRevision.completeness;
  else if ('ContentBlockRevision' in value) completeness = value.ContentBlockRevision.completeness;
  else if ('NativeRuntimeMarkerRevision' in value) completeness = value.NativeRuntimeMarkerRevision.completeness;
  else if ('TaskRevision' in value) completeness = value.TaskRevision.completeness;
  else if ('PlanRevision' in value) completeness = value.PlanRevision.completeness;
  else if ('ToolRevision' in value) completeness = value.ToolRevision.completeness;
  else if ('EffectiveStateRevision' in value) completeness = value.EffectiveStateRevision.completeness;
  return completeness === 'complete' ? 'complete' : completeness === 'partial' ? 'partial' : 'unavailable';
}

function factQuality(event: SemanticObserverEvent): EvidenceQuality {
  const value = event.value;
  if (!value) return 'exact';
  if ('EffectiveStateRevision' in value) return qualifiedQuality(value.EffectiveStateRevision.value.quality);
  if ('NativeRuntimeMarkerRevision' in value) return qualifiedQuality(value.NativeRuntimeMarkerRevision.quality);
  if ('UsageRevisionV2' in value) {
    const qualities = Object.values(value.UsageRevisionV2.buckets).map((bucket) => qualifiedQuality(bucket.quality));
    if (qualities.includes('unknown')) return 'unknown';
    if (qualities.includes('estimated')) return 'estimated';
    if (qualities.includes('derived')) return 'derived';
    if (qualities.includes('strong')) return 'strong';
  }
  return 'exact';
}

function evidenceRef(event: SemanticObserverEvent): EvidenceRef {
  return {
    namespace: 'spaghetti:rfc012d-semantic-revision',
    id: event.semantic_revision_ref.fact_revision_id,
    revisionKey: `${event.semantic_revision_ref.semantic_reference_contract_version}:${event.semantic_revision_ref.fact_revision_id}`,
    sourceInstanceId: event.source.root_name,
    sourceObjectId: `${event.source.stream_id}:${event.source.object_path}`,
    sourceGeneration: event.source.generation,
    ...(event.source.byte_start === null ? {} : { cursorStart: event.source.byte_start }),
    ...(event.source.byte_end === null ? {} : { cursorEnd: event.source.byte_end }),
  };
}

function boundedEvidence(events: Iterable<SemanticObserverEvent>): EvidenceRef[] {
  const evidence = [...events].map(evidenceRef);
  if (evidence.length <= MAX_BATCH_EVIDENCE_REFS) return evidence;
  return [evidence[0]!, ...evidence.slice(-(MAX_BATCH_EVIDENCE_REFS - 1))];
}

function watermark(event: SemanticObserverEvent): SourceWatermark {
  return {
    sourceId: `${event.source.root_name}:${event.source.stream_id}:${event.source.object_path}`,
    sourceEpoch: String(event.source.generation),
    sequence: event.sequence,
    ...(event.source.byte_end === null ? {} : { cursor: String(event.source.byte_end) }),
    observedThrough: isoTime(event.observed_at),
  };
}

function actorRefFromFact(fact: ActorRunRevisionFact): ActorRunRef {
  return {
    rootSessionKey: fact.session,
    runKey: fact.actor_run,
    role: fact.role,
    ...(fact.parent_actor_run ? { parentRunKey: fact.parent_actor_run } : {}),
    ...(fact.native_session_id ? { nativeSessionId: fact.native_session_id } : {}),
    ...(fact.native_actor_id ? { nativeAgentId: fact.native_actor_id } : {}),
    ...(fact.native_actor_type ? { nativeAgentType: fact.native_actor_type } : {}),
  };
}

function eventActor(
  event: SemanticObserverEvent,
  actors: ReadonlyMap<string, ActorRunRef>,
  rootActors: ReadonlyMap<string, ActorRunRef>,
): ActorRunRef {
  const known = actors.get(event.actor.actor_run_key);
  if (known) return known;
  const root = rootActors.get(event.actor.session_key);
  const role =
    event.actor.attribution === 'scope_fallback' || root?.runKey === event.actor.actor_run_key ? 'root' : 'child';
  return {
    rootSessionKey: event.actor.session_key,
    runKey: event.actor.actor_run_key,
    role,
    ...(role === 'child' && root ? { parentRunKey: root.runKey } : {}),
    nativeSessionId: event.actor.native_session_id,
  };
}

function interactionKind(kind: string): 'choice' | 'multi-choice' | 'free-form' | 'mixed' {
  switch (kind) {
    case 'multi_choice':
      return 'multi-choice';
    case 'free_text':
      return 'free-form';
    case 'mixed':
      return 'mixed';
    default:
      return 'choice';
  }
}

function interactionState(state: string): 'pending' | 'resolved' | 'failed' | 'cancelled' {
  return state === 'resolved' || state === 'failed' || state === 'cancelled' ? state : 'pending';
}

function taskStatus(state: string): 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'removed' {
  switch (state) {
    case 'updated':
      return 'in-progress';
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'removed':
      return state;
    default:
      return 'pending';
  }
}

function planStepText(key: string): string {
  const separator = key.indexOf(':');
  return separator >= 0 && separator + 1 < key.length ? key.slice(separator + 1) : key;
}

function deriveLedger(facts: SemanticFacts): MonitorLedger {
  const ledger = emptyLedger();
  const actors = new Map<string, ActorRunRef>();
  const rootActors = new Map<string, ActorRunRef>();
  const latestCompaction = new Map<string, { event: SemanticObserverEvent; actor: ActorRunRef }>();
  const latestProgress = new Map<string, { event: SemanticObserverEvent; actor: ActorRunRef }>();

  for (const event of facts.values()) {
    const value = event.value;
    if (!value || !('ActorRunRevision' in value)) continue;
    const actor = actorRefFromFact(value.ActorRunRevision);
    actors.set(value.ActorRunRevision.actor_run, actor);
    if (actor.role === 'root') rootActors.set(value.ActorRunRevision.session, actor);
  }

  for (const event of facts.values()) {
    const value = event.value;
    if (!value) continue;
    const actor = eventActor(event, actors, rootActors);
    const key = event.fact_id;

    if ('ActorRunRevision' in value) {
      setValue(ledger, 'delegation', `actor:${key}`, {
        kind: 'actor',
        actor: actorRefFromFact(value.ActorRunRevision),
        state: 'unknown',
      });
      continue;
    }

    if ('UserInputRequestRevision' in value) {
      const fact = value.UserInputRequestRevision;
      if (fact.operation === 'retract') continue;
      setValue(ledger, 'status', `interaction:${key}`, {
        kind: 'interaction',
        interactionId: fact.native_tool_use_id,
        interactionKind: interactionKind(fact.kind),
        state: interactionState(fact.state),
        actor,
        questions: fact.questions.map((question, index) => ({
          id: `${fact.native_tool_use_id}:${index}`,
          ...(question.header ? { header: question.header } : {}),
          prompt: question.prompt,
          ...(question.options.length > 0
            ? {
                options: question.options.map((option) => ({
                  label: option.label,
                  ...(option.description ? { description: option.description } : {}),
                })),
              }
            : {}),
          ...(question.multi_select ? { allowMultiple: true } : {}),
          ...(fact.kind === 'free_text' || fact.kind === 'mixed' ? { allowFreeForm: true } : {}),
        })),
      });
      continue;
    }

    if ('PlanRevision' in value) {
      const fact = value.PlanRevision;
      if (fact.operation === 'retract') continue;
      setValue(ledger, 'planning', `plan:${key}`, {
        kind: 'plan',
        planId: fact.native_plan_id,
        actor,
        steps: fact.ordered_step_keys.map((step) => ({ text: planStepText(step), status: 'unknown' })),
        provisional: fact.completeness !== 'complete',
      });
      continue;
    }

    if ('TaskRevision' in value) {
      const fact = value.TaskRevision;
      if (fact.operation === 'retract') continue;
      setValue(ledger, 'planning', `task:${key}`, {
        kind: 'task',
        taskId: fact.native_task_id,
        actor,
        description: fact.subject,
        status: taskStatus(fact.state),
        providerStatus: fact.state,
        provisional: fact.completeness !== 'complete',
      });
      continue;
    }

    if ('ToolRevision' in value) {
      const fact = value.ToolRevision;
      if (fact.operation === 'retract' || fact.kind !== 'call') continue;
      setValue(ledger, 'status', `tool:${key}`, {
        kind: 'activity',
        activityKind: 'tool',
        active: event.phase === 'live' && fact.correlated_native_id === null,
        line: `Running ${fact.tool_name}`,
        actor,
      });
      continue;
    }

    if ('NativeRuntimeMarkerRevision' in value) {
      const fact = value.NativeRuntimeMarkerRevision;
      if (fact.operation === 'retract') continue;
      if (fact.value.kind === 'compaction') {
        const current = latestCompaction.get(actor.runKey);
        if (!current || event.sequence > current.event.sequence) latestCompaction.set(actor.runKey, { event, actor });
      } else if (fact.value.kind === 'progress') {
        const current = latestProgress.get(actor.runKey);
        if (!current || event.sequence > current.event.sequence) latestProgress.set(actor.runKey, { event, actor });
      }
      continue;
    }

    if ('EffectiveStateRevision' in value) {
      const fact = value.EffectiveStateRevision;
      const observed = fact.value.value;
      if (fact.operation === 'retract' || observed === null) continue;
      const intent = fact.evidence_kind === 'configured_intent' ? 'configured' : 'observed';
      if (fact.dimension === 'model') {
        setValue(ledger, 'model', `${intent}:${actor.runKey}`, {
          kind: 'model',
          actor,
          providerModelId: observed,
          intent,
        });
      } else if (fact.dimension === 'effort') {
        setValue(ledger, 'effort', `${intent}:${actor.runKey}`, { kind: 'effort', actor, value: observed, intent });
      } else {
        const modeKind = fact.dimension === 'permission_mode' ? 'provider-permission' : 'provider-session';
        const normalized = fact.dimension === 'permission_mode' ? claudePermissionMode(observed).normalized : undefined;
        setValue(ledger, 'mode', `${modeKind}:${intent}`, {
          kind: 'mode',
          modeKind,
          raw: observed,
          ...(normalized ? { normalized } : {}),
          intent,
        });
      }
      continue;
    }

    if ('UsageRevisionV2' in value) {
      const fact = value.UsageRevisionV2;
      const inputTokens = finiteNonNegative(fact.buckets.input_tokens.value);
      const outputTokens = finiteNonNegative(fact.buckets.output_tokens.value);
      const cacheCreationTokens = finiteNonNegative(fact.buckets.cache_creation_input_tokens.value);
      const cacheReadTokens = finiteNonNegative(fact.buckets.cache_read_input_tokens.value);
      if (
        inputTokens === undefined &&
        outputTokens === undefined &&
        cacheCreationTokens === undefined &&
        cacheReadTokens === undefined
      ) {
        continue;
      }
      setValue(ledger, 'usage', `usage:${key}`, {
        kind: 'usage',
        usageId: `spaghetti-response:${actor.runKey}:${fact.response_key}`,
        actor,
        boundary: 'response',
        canonical: true,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      });
    }
  }

  for (const [actorRunKey, { event }] of latestCompaction) {
    const value = event.value;
    if (!value || !('NativeRuntimeMarkerRevision' in value)) continue;
    const marker = value.NativeRuntimeMarkerRevision.value;
    if (marker.kind !== 'compaction') continue;
    const terminal = marker.phase === 'completed' || marker.phase === 'failed';
    setValue(ledger, 'compaction', `compaction:${actorRunKey}`, {
      kind: 'compaction',
      active: !terminal,
      ...(marker.trigger ? { trigger: marker.trigger } : {}),
      ...(terminal ? { outcome: marker.phase === 'completed' ? 'completed' : 'failed' } : {}),
    });
  }

  for (const [actorRunKey, { event, actor }] of latestProgress) {
    const value = event.value;
    if (!value || !('NativeRuntimeMarkerRevision' in value)) continue;
    const marker = value.NativeRuntimeMarkerRevision.value;
    if (marker.kind !== 'progress') continue;
    setValue(ledger, 'status', `progress:${actorRunKey}`, {
      kind: 'activity',
      activityKind: 'other',
      active: marker.state === 'pending' || marker.state === 'active',
      line: `Native progress: ${marker.state}`,
      actor,
    });
  }

  const teamFacts = new Map<string, Array<{ event: SemanticObserverEvent; actor: ActorRunRef }>>();
  const workflowFacts = new Map<string, Array<{ event: SemanticObserverEvent; actor: ActorRunRef }>>();
  for (const event of facts.values()) {
    const value = event.value;
    if (!value || !('ActorAffiliationRevision' in value)) continue;
    const fact = value.ActorAffiliationRevision;
    const actor = actors.get(fact.actor_run) ?? eventActor(event, actors, rootActors);
    const groups = fact.dimension === 'team' ? teamFacts : workflowFacts;
    const group = groups.get(fact.target) ?? [];
    group.push({ event, actor });
    groups.set(fact.target, group);
    if (fact.state === 'present') {
      setValue(ledger, 'delegation', `affiliation:${event.fact_id}`, {
        kind: 'affiliation',
        actor,
        affiliation: {
          kind: fact.dimension,
          id: fact.target,
          ...(fact.native_target_id ? { name: fact.native_target_id } : {}),
        },
      });
    }
  }

  for (const [teamId, memberships] of teamFacts) {
    const name = memberships
      .flatMap(({ event }) => {
        const value = event.value;
        return value && 'ActorAffiliationRevision' in value && value.ActorAffiliationRevision.native_target_id
          ? [value.ActorAffiliationRevision.native_target_id]
          : [];
      })
      .sort()[0];
    setValue(ledger, 'delegation', `team:${teamId}`, {
      kind: 'team',
      teamId,
      ...(name ? { nativeTeamId: name } : {}),
      ...(name ? { name } : {}),
    });
    for (const { event, actor } of memberships) {
      const value = event.value;
      if (!value || !('ActorAffiliationRevision' in value)) continue;
      const fact = value.ActorAffiliationRevision;
      setValue(ledger, 'delegation', `team-member:${event.fact_id}`, {
        kind: 'team-member',
        membershipId: fact.native_member_id ?? fact.affiliation,
        teamId,
        ...(fact.native_target_id ? { nativeTeamId: fact.native_target_id } : {}),
        ...(fact.native_member_id ? { nativeMemberId: fact.native_member_id } : {}),
        actor,
        ...(fact.native_member_id ? { name: fact.native_member_id } : {}),
        membershipState: fact.state,
        state: 'unknown',
      });
    }
  }

  for (const [workflowId, memberships] of workflowFacts) {
    const present = memberships.filter(({ event }) => {
      const value = event.value;
      return value && 'ActorAffiliationRevision' in value && value.ActorAffiliationRevision.state === 'present';
    });
    const first = memberships[0]?.event.value;
    const name =
      first && 'ActorAffiliationRevision' in first
        ? (first.ActorAffiliationRevision.native_target_id ?? undefined)
        : undefined;
    setValue(ledger, 'workflow', `workflow:${workflowId}`, {
      kind: 'workflow',
      workflowId,
      ...(name ? { name } : {}),
      active: present.length > 0,
      actorRunKeys: [...new Set(present.map(({ actor }) => actor.runKey))].sort(),
      artifactRefs: [],
    });
  }

  return ledger;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffLedgers(before: MonitorLedger, after: MonitorLedger): MonitorFamilyUpdate[] {
  const updates: MonitorFamilyUpdate[] = [];
  for (const family of PROJECTED_FAMILIES) {
    const prior = familyLedger(before, family);
    const next = familyLedger(after, family);
    for (const key of [...prior.keys()].sort()) {
      if (!next.has(key)) updates.push({ family, operation: 'retract', key } as MonitorFamilyUpdate);
    }
    for (const [key, value] of [...next.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (!sameValue(prior.get(key), value)) {
        updates.push({ family, operation: 'upsert', key, value } as MonitorFamilyUpdate);
      }
    }
  }
  return updates;
}

function replacementUpdates(ledger: MonitorLedger, coverage: EvidenceCompleteness): MonitorFamilyUpdate[] {
  return PROJECTED_FAMILIES.map(
    (family) =>
      ({
        family,
        operation: 'replace',
        coverage,
        values: [...familyLedger(ledger, family).entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      }) as MonitorFamilyUpdate,
  );
}

const OBSERVER_TO_MONITOR_FAMILIES: Readonly<Record<ObserverFamily, readonly MonitorMetricFamily[]>> = {
  message: ['status'],
  content_block: ['status'],
  tool: ['status'],
  user_input_request: ['status'],
  plan: ['planning'],
  task: ['planning'],
  native_marker: ['status', 'compaction'],
  effective_state: ['model', 'effort', 'mode'],
  actor_run: ['delegation'],
  actor_affiliation: ['delegation', 'workflow'],
  usage_v2: ['usage'],
};

function barrierCoverage(
  manifest: readonly SpaghettiObserverFamilyManifestEntry[],
  observedAt: string,
  completeness: EvidenceCompleteness,
): ObservationCoverage[] {
  const families = new Set<MonitorMetricFamily>();
  for (const entry of manifest) {
    for (const family of OBSERVER_TO_MONITOR_FAMILIES[entry.family]) families.add(family);
  }
  return [...families].sort().map((family) => ({ family, completeness, asOf: observedAt }));
}

function unavailableArtifact(artifactId: string): MonitorArtifactReadResult {
  return {
    status: 'unavailable',
    message: `Artifact ${JSON.stringify(artifactId)} is unavailable: the local RFC-012D observer has no bounded artifact API`,
  };
}

function digestStrings(values: Iterable<string>): { count: number; digest: string } {
  const normalized = [...values].sort();
  return {
    count: normalized.length,
    digest: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

/** Claude's sole typed transcript-derived observation provider. */
export class SpaghettiScopedObservationProvider implements SemanticObservationProvider {
  private attachmentCount = 0;

  constructor(private readonly options: SpaghettiScopedObservationProviderOptions = {}) {}

  capabilities(): Promise<readonly ObservationCapability[]> {
    const contractVersion = this.options.contractVersion ?? SPAGHETTI_SCOPED_CONTRACT;
    return Promise.resolve(SPAGHETTI_SCOPED_CAPABILITIES.map((capability) => ({ ...capability, contractVersion })));
  }

  async attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle> {
    this.attachmentCount += 1;
    const attachmentId = this.attachmentCount;
    const contractVersion = this.options.contractVersion ?? SPAGHETTI_SCOPED_CONTRACT;
    let observerFactory = this.options.observerFactory;
    if (!observerFactory) {
      let sdk: typeof import('@vibecook/spaghetti-sdk');
      try {
        sdk = await import('@vibecook/spaghetti-sdk');
      } catch (error) {
        throw new SpaghettiScopedObservationError(
          'sdk-load-failed',
          'The local Spaghetti SDK could not be loaded',
          error,
        );
      }
      if (typeof sdk.observeSession !== 'function') {
        throw new SpaghettiScopedObservationError(
          'contract-unavailable',
          'The installed Spaghetti SDK does not expose the scoped observer contract',
        );
      }
      observerFactory = sdk.observeSession as unknown as ObserverFactory;
    }
    let agentRoot: string;
    try {
      agentRoot = resolveAgentRoot(this.options.agentRoot, request.transcriptPath);
    } catch (error) {
      throw new SpaghettiScopedObservationError(
        'scope-invalid',
        'The Claude transcript is outside a valid scoped-observer root',
        error,
      );
    }
    const observerRequest = {
      adapter_id: 'claude-code',
      agent_root: agentRoot,
      transcript_path: request.transcriptPath,
      native_session_id: request.nativeSessionId,
      include_descendants: this.options.includeDescendants ?? true,
      ...(this.options.maxQueuedEvents === undefined ? {} : { max_queued_events: this.options.maxQueuedEvents }),
      ...(this.options.maxQueuedBytes === undefined ? {} : { max_queued_bytes: this.options.maxQueuedBytes }),
      ...(request.pollIntervalMs === undefined ? {} : { poll_interval_ms: request.pollIntervalMs }),
    } satisfies ObserveSessionRequest;
    let observer: SessionObserver;
    try {
      observer = observerFactory(observerRequest, {}) as SessionObserver;
    } catch (error) {
      throw new SpaghettiScopedObservationError(
        'attach-failed',
        'The Spaghetti scoped observer rejected the Claude session scope',
        error,
      );
    }

    let disposed = false;
    let started = false;
    let readySettled = false;
    let installed: EpochState | undefined;
    let installedLedger = emptyLedger();
    let staging: EpochState | undefined;
    let consumePromise: Promise<void> | undefined;
    const eventListeners = new Set<(event: SemanticObservationEvent) => void>();
    const batchListeners = new Set<(batch: AdapterMonitorObservationBatch) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    const emittedAssistantFingerprints = new Map<string, string>();
    let resumeHistoryPublished = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleReady = (error?: Error): void => {
      if (readySettled) return;
      readySettled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };

    const reportError = (error: Error): void => {
      for (const listener of errorListeners) {
        try {
          listener(error);
        } catch {
          // Error observation is isolated from the source.
        }
      }
    };

    const emitEvent = (event: SemanticObservationEvent): void => {
      for (const listener of eventListeners) {
        try {
          listener(event);
        } catch {
          // Application-event consumers cannot destabilize source observation.
        }
      }
    };

    const publishConversation = (facts: SemanticFacts, resumeHistory: boolean): void => {
      const projection = projectSpaghettiConversation(facts.values());
      if (resumeHistory && !resumeHistoryPublished) {
        resumeHistoryPublished = true;
        for (const event of projection.history) emitEvent(event);
        for (const [key, event] of projection.assistants) {
          emittedAssistantFingerprints.set(key, spaghettiConversationFingerprint(event));
        }
        return;
      }
      for (const [key, event] of projection.assistants) {
        const fingerprint = spaghettiConversationFingerprint(event);
        if (emittedAssistantFingerprints.get(key) === fingerprint) continue;
        emittedAssistantFingerprints.set(key, fingerprint);
        emitEvent(event);
      }
    };

    const emitBatch = (batch: AdapterMonitorObservationBatch): void => {
      for (const listener of batchListeners) {
        try {
          listener(batch);
        } catch {
          // Monitor consumers cannot destabilize source observation.
        }
      }
    };

    const producerEpoch = (scopeEpoch: number): string =>
      `scoped:${request.nativeSessionId}:${attachmentId}:${scopeEpoch}`;

    const batchFor = (
      event: ObserverEvent,
      phase: AdapterMonitorObservationBatch['phase'],
      updates: MonitorFamilyUpdate[],
      options: {
        readiness?: AdapterMonitorObservationBatch['readiness'];
        quality?: EvidenceQuality;
        completeness?: EvidenceCompleteness;
        evidence?: EvidenceRef[];
        watermarks?: SourceWatermark[];
        coverage?: ObservationCoverage[];
        capabilities?: readonly ObservationCapability[];
        effectiveAt?: string;
      } = {},
    ): AdapterMonitorObservationBatch => ({
      schemaVersion: 1,
      batchId: `${attachmentId}:${event.scope_epoch}:${event.event_id}`,
      producer: {
        id: PRODUCER_ID,
        epoch: producerEpoch(event.scope_epoch),
        sequence: event.sequence,
        contractVersion,
      },
      phase,
      observedAt: isoTime(event.observed_at),
      ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'complete',
      provisional: false,
      readiness: options.readiness ?? 'ready',
      scope: { nativeSessionId: request.nativeSessionId },
      updates,
      sourceWatermarks: options.watermarks ?? [],
      evidence: options.evidence ?? [],
      ...(options.capabilities ? { capabilities: [...options.capabilities] } : {}),
      ...(options.coverage ? { coverage: options.coverage } : {}),
    });

    const ensureEpoch = (epoch: number): EpochState | undefined => {
      if (installed?.epoch === epoch && !staging) return installed;
      if (staging) {
        if (staging.epoch === epoch) return staging;
        if (epoch < staging.epoch) return undefined;
      } else if (installed && epoch < installed.epoch) {
        return undefined;
      }
      if (!staging || staging.epoch !== epoch) {
        staging = { epoch, facts: new Map(), eventIds: new Set(), unknownEvidence: false };
      }
      return staging;
    };

    const applySemantic = (event: SemanticObserverEvent): void => {
      const target = ensureEpoch(event.scope_epoch);
      if (!target) return;
      if (target.eventIds.has(event.event_id)) return;
      target.eventIds.add(event.event_id);
      if (event.operation === 'retract' || event.value === null) target.facts.delete(event.fact_id);
      else target.facts.set(event.fact_id, event);

      if (target !== installed || staging) return;
      const nextLedger = deriveLedger(target.facts);
      const updates = diffLedgers(installedLedger, nextLedger);
      installedLedger = nextLedger;
      if (updates.length > 0) {
        emitBatch(
          batchFor(event, event.phase === 'correction' ? 'correction' : 'live', updates, {
            quality: factQuality(event),
            completeness: factCompleteness(event),
            evidence: [evidenceRef(event)],
            watermarks: [watermark(event)],
            ...(event.native_time === null ? {} : { effectiveAt: isoTime(event.native_time) }),
          }),
        );
      }
      publishConversation(target.facts, false);
    };

    const consume = async (): Promise<void> => {
      try {
        for await (const event of observer) {
          if (disposed && event.type !== 'closed') continue;
          if (
            event.type === 'message' ||
            event.type === 'content_block' ||
            event.type === 'tool' ||
            event.type === 'user_input_request' ||
            event.type === 'plan' ||
            event.type === 'task' ||
            event.type === 'native_marker' ||
            event.type === 'effective_state' ||
            event.type === 'actor_run' ||
            event.type === 'actor_affiliation' ||
            event.type === 'usage_v2'
          ) {
            applySemantic(event);
            continue;
          }

          if (event.type === 'unknown_evidence') {
            const target = ensureEpoch(event.scope_epoch);
            if (target) target.unknownEvidence = true;
            continue;
          }

          if (event.type === 'overflow') {
            if (installed?.epoch === event.scope_epoch) staging = undefined;
            emitBatch(
              batchFor(event, 'correction', [], {
                readiness: 'degraded',
                quality: 'unknown',
                completeness: 'unavailable',
              }),
            );
            emitDiagnostic(this.options.onDiagnostic, {
              kind: 'overflow',
              nativeSessionId: request.nativeSessionId,
              scopeEpoch: event.scope_epoch,
              reason: event.reason,
              lastContiguousSequence: event.last_contiguous_sequence,
            });
            continue;
          }

          if (event.type === 'bootstrap_complete' || event.type === 'resync_complete') {
            const target = ensureEpoch(event.scope_epoch);
            if (!target) continue;
            const nextLedger = deriveLedger(target.facts);
            const objectErrors = event.coverage.filter((item) => item.error !== null);
            const completeness: EvidenceCompleteness =
              objectErrors.length > 0 || target.unknownEvidence ? 'partial' : 'complete';
            const degraded = objectErrors.length > 0 || target.unknownEvidence;
            const observedAt = isoTime(event.observed_at);
            const capabilities = await this.capabilities();
            const phase = event.type === 'resync_complete' || attachmentId > 1 ? 'resync' : 'bootstrap';
            emitBatch(
              batchFor(event, phase, replacementUpdates(nextLedger, completeness), {
                readiness: degraded ? 'degraded' : 'ready',
                quality: target.unknownEvidence ? 'unknown' : objectErrors.length > 0 ? 'strong' : 'exact',
                completeness,
                evidence: boundedEvidence(target.facts.values()),
                coverage: barrierCoverage(event.family_manifest, observedAt, completeness),
                capabilities,
              }),
            );
            installed = target;
            installedLedger = nextLedger;
            staging = undefined;
            publishConversation(target.facts, request.bootstrap && !resumeHistoryPublished);
            const actorRunSet = digestStrings(
              [...familyLedger(nextLedger, 'delegation').values()]
                .filter((value): value is Extract<MonitorFamilyValue, { kind: 'actor' }> => value.kind === 'actor')
                .map((value) => value.actor.runKey),
            );
            emitDiagnostic(this.options.onDiagnostic, {
              kind: 'barrier',
              phase,
              nativeSessionId: request.nativeSessionId,
              scopeEpoch: event.scope_epoch,
              rootPresent: event.root_present,
              familyManifest: event.family_manifest.map((entry) => ({
                family: entry.family,
                contractVersion: entry.contract_version,
                entityCount: entry.entity_count,
                digest: entry.digest,
              })),
              actorRunCount: actorRunSet.count,
              actorRunDigest: actorRunSet.digest,
            });
            settleReady();
            continue;
          }

          if (event.type === 'source_error') {
            emitBatch(
              batchFor(event, 'correction', [], {
                readiness: 'degraded',
                quality: 'unknown',
                completeness: event.terminal ? 'unavailable' : 'partial',
              }),
            );
            emitDiagnostic(this.options.onDiagnostic, {
              kind: 'source-error',
              nativeSessionId: request.nativeSessionId,
              scopeEpoch: event.scope_epoch,
              terminal: event.terminal,
            });
            continue;
          }

          if (event.type === 'error') {
            const error = new SpaghettiScopedObservationError(
              'observer-error',
              'The Spaghetti scoped observer reported a terminal error',
              new Error(event.message),
            );
            emitBatch(
              batchFor(event, 'correction', [], {
                readiness: 'degraded',
                quality: 'unknown',
                completeness: 'unavailable',
              }),
            );
            emitDiagnostic(this.options.onDiagnostic, {
              kind: 'error',
              nativeSessionId: request.nativeSessionId,
              scopeEpoch: event.scope_epoch,
              code: 'observer-error',
            });
            reportError(error);
            settleReady(error);
            continue;
          }

          if (event.type === 'closed') {
            emitDiagnostic(this.options.onDiagnostic, {
              kind: 'closed',
              nativeSessionId: request.nativeSessionId,
              scopeEpoch: event.scope_epoch,
              discardedEvents: event.discarded_events,
            });
            if (!disposed) {
              const error = new SpaghettiScopedObservationError(
                'observer-closed',
                readySettled
                  ? 'Spaghetti scoped observer closed unexpectedly'
                  : 'Spaghetti scoped observer closed before readiness',
              );
              emitBatch(
                batchFor(event, 'correction', [], {
                  readiness: 'degraded',
                  quality: 'unknown',
                  completeness: 'unavailable',
                }),
              );
              reportError(error);
              settleReady(error);
            }
          }
        }
      } catch (error) {
        const normalized =
          error instanceof SpaghettiScopedObservationError
            ? error
            : new SpaghettiScopedObservationError(
                'observer-error',
                'The Spaghetti scoped observer stream failed',
                error,
              );
        emitDiagnostic(this.options.onDiagnostic, {
          kind: 'error',
          nativeSessionId: request.nativeSessionId,
          ...(installed ? { scopeEpoch: installed.epoch } : {}),
          code: 'observer-error',
        });
        reportError(normalized);
        settleReady(normalized);
      }
    };

    const start = (): void => {
      if (started || disposed) return;
      started = true;
      consumePromise = consume();
    };

    return {
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onBatch(listener) {
        batchListeners.add(listener);
        return () => batchListeners.delete(listener);
      },
      onError(listener) {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      poll(_hint?: SemanticObservationPollHint): Promise<void> {
        start();
        return ready;
      },
      readArtifact(artifactId, _artifactOptions) {
        return Promise.resolve(unavailableArtifact(artifactId));
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        settleReady();
        await observer.close();
        await consumePromise;
        eventListeners.clear();
        batchListeners.clear();
        errorListeners.clear();
      },
    };
  }
}
