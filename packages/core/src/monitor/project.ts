import type {
  AgentMonitorState,
  ActorRunRef,
  MonitorActivity,
  MonitorBoundedCollection,
  MonitorAssistantMessageState,
  MonitorContextState,
  MonitorEffortState,
  MonitorFamilyAvailability,
  MonitorFamilySupport,
  MonitorMetricFamily,
  MonitorModelState,
  MonitorProviderMode,
  MonitorSubagentState,
  MonitorUsageAggregate,
} from './types.js';
import { AGENT_MONITOR_SCHEMA_VERSION } from './types.js';
import type {
  MonitorAccumulatorState,
  MonitorContextFamilyValue,
  MonitorFamilyValue,
  MonitorModeFamilyValue,
  MonitorRunStatusObservation,
  MonitorStoredEntry,
} from './internal-types.js';
import { DEFAULT_MONITOR_BURN_RATE_WINDOW_MS } from './rate.js';
import { actorOf, compareEntryPreference, time } from './selection.js';
import {
  blockersOf,
  familyEntries,
  maybeBound,
  transitionBasis,
  type ChildActor,
  type MonitorTransitionBasis,
} from './transitions.js';
import {
  countCompleteness,
  queryUsageIndex,
  sumCompleteness,
  summarizeFamilyEvidence,
  usageIndexOf,
  type CompletenessCount,
  type MonitorFamilyEvidence,
} from './usage-index.js';

export interface ProjectAgentMonitorOptions {
  previous?: AgentMonitorState;
  /** Explicit projection boundary; defaults to the newest accepted evidence timestamp. */
  asOf?: string;
  burnRateWindowMs?: number;
  /** Private diagnostic/notification projection; renderer state remains bounded. */
  unboundedCollections?: boolean;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
    .sort((a, b) => time(b) - time(a))[0];
}

function earliestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
    .sort((a, b) => time(a) - time(b))[0];
}

function rootEntries<T extends MonitorFamilyValue['kind']>(
  entries: readonly MonitorStoredEntry[],
  kind: T,
): Array<MonitorStoredEntry & { value: Extract<MonitorFamilyValue, { kind: T }> }> {
  return entries.filter(
    (entry): entry is MonitorStoredEntry & { value: Extract<MonitorFamilyValue, { kind: T }> } =>
      entry.value.kind === kind && (actorOf(entry.value) === undefined || actorOf(entry.value)?.role === 'root'),
  );
}

function projectAssistantMessage(entries: readonly MonitorStoredEntry[]): MonitorAssistantMessageState | undefined {
  const latest = rootEntries(entries, 'message').sort(
    (a, b) => time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) || compareEntryPreference(a, b),
  )[0];
  if (!latest) return undefined;
  return {
    text: latest.value.text,
    at: latest.effectiveAt ?? latest.observedAt,
    final: latest.value.final,
    ...(latest.value.messageId ? { messageId: latest.value.messageId } : {}),
  };
}

function projectContext(entries: readonly MonitorStoredEntry[]): MonitorContextState | undefined {
  const candidates = rootEntries(entries, 'context').sort((a, b) => {
    const sourcePriority = (value: MonitorContextFamilyValue) =>
      value.percentageSource === 'provider' ? 2 : value.percentageSource === 'derived' ? 1 : 0;
    return sourcePriority(b.value) - sourcePriority(a.value) || compareEntryPreference(a, b);
  });
  const selected = candidates[0];
  if (!selected) return undefined;
  const usedPercent =
    selected.value.usedPercentage ??
    (selected.value.usedTokens !== undefined &&
    selected.value.capacityTokens !== undefined &&
    selected.value.capacityTokens > 0
      ? Math.min(100, Math.max(0, (selected.value.usedTokens / selected.value.capacityTokens) * 100))
      : undefined);
  return {
    ...(selected.value.usedTokens !== undefined ? { usedTokens: selected.value.usedTokens } : {}),
    ...(selected.value.capacityTokens !== undefined ? { capacityTokens: selected.value.capacityTokens } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    percentageSource:
      selected.value.usedPercentage !== undefined
        ? selected.value.percentageSource
        : usedPercent !== undefined
          ? 'derived'
          : 'unavailable',
    asOf: selected.observedAt,
  };
}

function projectModel(entries: readonly MonitorStoredEntry[]): MonitorModelState | undefined {
  const candidates = rootEntries(entries, 'model');
  const observed = candidates.filter((entry) => entry.value.intent === 'observed').sort(compareEntryPreference)[0];
  const configured = candidates.filter((entry) => entry.value.intent === 'configured').sort(compareEntryPreference)[0];
  const selected = observed ?? configured;
  return selected
    ? {
        id: selected.value.providerModelId,
        ...(selected.value.displayName ? { displayName: selected.value.displayName } : {}),
        ...(configured
          ? {
              configured: {
                id: configured.value.providerModelId,
                ...(configured.value.displayName ? { displayName: configured.value.displayName } : {}),
              },
            }
          : {}),
        intent: selected.value.intent,
        asOf: selected.observedAt,
      }
    : undefined;
}

function projectEffort(entries: readonly MonitorStoredEntry[]): MonitorEffortState | undefined {
  const candidates = rootEntries(entries, 'effort');
  const observed = candidates.filter((entry) => entry.value.intent === 'observed').sort(compareEntryPreference)[0];
  const configured = candidates.filter((entry) => entry.value.intent === 'configured').sort(compareEntryPreference)[0];
  const selected = observed ?? configured;
  return selected
    ? {
        value: selected.value.value,
        ...(configured ? { configured: configured.value.value } : {}),
        intent: selected.value.intent,
        asOf: selected.observedAt,
      }
    : undefined;
}

function providerMode(entries: readonly MonitorStoredEntry[], modeKind: 'provider-session' | 'provider-permission') {
  const candidates = entries.filter(
    (entry): entry is MonitorStoredEntry & { value: MonitorModeFamilyValue } =>
      entry.value.kind === 'mode' && entry.value.modeKind === modeKind,
  );
  const observed = candidates.filter((entry) => entry.value.intent !== 'configured').sort(compareEntryPreference)[0];
  const configured = candidates.filter((entry) => entry.value.intent === 'configured').sort(compareEntryPreference)[0];
  const selected = observed ?? configured;
  if (!selected || selected.value.kind !== 'mode') return undefined;
  return {
    raw: selected.value.raw,
    ...(selected.value.normalized ? { normalized: selected.value.normalized } : {}),
    ...(configured
      ? {
          configured: {
            raw: configured.value.raw,
            ...(configured.value.normalized ? { normalized: configured.value.normalized } : {}),
          },
        }
      : {}),
    intent: selected.value.intent ?? 'observed',
  } satisfies MonitorProviderMode;
}

function actorMetric<T extends 'context' | 'model' | 'effort'>(
  entries: readonly MonitorStoredEntry[],
  actorRunKey: string,
  kind: T,
): (MonitorStoredEntry & { value: Extract<MonitorFamilyValue, { kind: T }> }) | undefined {
  return entries
    .filter(
      (entry): entry is MonitorStoredEntry & { value: Extract<MonitorFamilyValue, { kind: T }> } =>
        entry.value.kind === kind && actorOf(entry.value)?.runKey === actorRunKey,
    )
    .sort((a, b) => {
      const observed = (entry: typeof a) => ('intent' in entry.value && entry.value.intent === 'observed' ? 1 : 0);
      return observed(b) - observed(a) || compareEntryPreference(a, b);
    })[0];
}

/**
 * Every child of the run: those the planes' claims name, then those only its usage names. Usage is the last family
 * in claim order, so this is the order one walk over every selected claim gave. A usage-only child has no state,
 * activity, model or effort to read: it counts, and carries its usage.
 */
function withUsageActors(
  actors: ReadonlyMap<string, ChildActor>,
  usageActors: ReadonlyMap<string, ActorRunRef>,
): Map<string, ChildActor> {
  const all = new Map(actors);
  for (const [runKey, actor] of usageActors) if (!all.has(runKey)) all.set(runKey, { actor, entries: [] });
  return all;
}

function projectSubagents(
  actors: ReadonlyMap<string, ChildActor>,
  activities: ReadonlyMap<string, MonitorActivity>,
  actorTotals: ReadonlyMap<string, number>,
  actorBurnRates: ReadonlyMap<string, number>,
  actorCosts: ReadonlyMap<string, MonitorUsageAggregate>,
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
): MonitorSubagentState[] {
  const values = [...actors.values()]
    .map(({ actor, entries }): MonitorSubagentState => {
      const model = actorMetric(entries, actor.runKey, 'model');
      const effort = actorMetric(entries, actor.runKey, 'effort');
      const activity = activities.get(actor.runKey);
      return {
        id: actor.nativeAgentId!,
        working: activity !== undefined,
        ...(activity ? { activity: activity.line } : {}),
        ...(model ? { modelId: model.value.providerModelId } : {}),
        ...(effort ? { effort: effort.value.value } : {}),
        ...(actorTotals.has(actor.runKey) ? { cumulativeTokens: actorTotals.get(actor.runKey) } : {}),
        ...(actorBurnRates.has(actor.runKey) ? { burnRatePerMin: actorBurnRates.get(actor.runKey) } : {}),
        ...(actorCosts.get(actor.runKey)?.costUsd !== undefined
          ? { costUsd: actorCosts.get(actor.runKey)!.costUsd }
          : {}),
        ...(actorCosts.get(actor.runKey)?.costRatePerMin !== undefined
          ? { costRatePerMin: actorCosts.get(actor.runKey)!.costRatePerMin }
          : {}),
        ...(actorCosts.has(actor.runKey) ? { costCoverage: actorCosts.get(actor.runKey)!.costCoverage } : {}),
      };
    })
    .sort((a, b) => Number(b.working) - Number(a.working) || a.id.localeCompare(b.id));
  const bounded = maybeBound('subagents', values, unbounded);
  if (bounded.omitted > 0) omitted.subagents = bounded.omitted;
  return bounded.values;
}

/** The root's environment as published: its worktrees bounded unless the projection is unbounded. */
function projectEnvironment(
  { cwd, git, worktrees }: MonitorTransitionBasis['environment'],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const boundedWorktrees = maybeBound('worktrees', worktrees, unbounded);
  if (boundedWorktrees.omitted > 0) omitted.worktrees = boundedWorktrees.omitted;
  return { ...(cwd ? { cwd } : {}), ...(git !== undefined ? { git } : {}), worktrees: boundedWorktrees.values };
}

function familySupport(
  state: MonitorAccumulatorState,
  evidence: MonitorFamilyEvidence,
  family: MonitorMetricFamily,
) {
  const producers = [...state.semantic.producers.values()];
  const capabilities = producers
    .map((producer) => producer.capabilities.get(family))
    .filter((capability) => capability !== undefined);
  let support: MonitorFamilySupport | undefined;
  if (capabilities.some((capability) => capability.support === 'supported')) support = 'supported';
  else if (capabilities.some((capability) => capability.support === 'degraded')) support = 'degraded';
  else if (capabilities.length > 0) support = 'unsupported';
  const current = evidence.all;
  if (!support && current.count > 0) support = current.complete > 0 ? 'supported' : 'degraded';
  if (!support) return undefined;
  const relevantProducers = producers.filter((producer) => {
    const capability = producer.capabilities.get(family);
    if (capability?.support === 'unsupported') return false;
    return (
      capability !== undefined ||
      [...producer.coverage.values()].some((item) => item.family === family) ||
      evidence.semantic.has(producer.id)
    );
  });
  const producerIds = new Set(producers.map((producer) => producer.id));
  const coverage = relevantProducers.flatMap((producer) =>
    [...producer.coverage.values()].filter((item) => item.family === family),
  );
  // A relevant producer counts its coverage, or else its own claims; a claim no producer owns counts as itself.
  const counts: CompletenessCount[] = [evidence.other];
  for (const producer of relevantProducers) {
    const producerCoverage = [...producer.coverage.values()].filter((item) => item.family === family);
    const owned = evidence.semantic.get(producer.id);
    if (producerCoverage.length > 0) counts.push(countCompleteness(producerCoverage.map((item) => item.completeness)));
    else if (owned) counts.push(owned);
  }
  for (const [ownerId, owned] of evidence.semantic) if (!producerIds.has(ownerId)) counts.push(owned);
  const { count, complete, unavailable } = sumCompleteness(counts);
  const allRelevantProducersDegraded =
    relevantProducers.length > 0 && relevantProducers.every((producer) => producer.readiness === 'degraded');
  let availability: MonitorFamilyAvailability;
  if (support === 'unsupported') availability = 'unavailable';
  else if (relevantProducers.length > 0 && relevantProducers.every((producer) => producer.readiness === 'loading')) {
    availability = 'loading';
  } else if (count > 0) {
    availability = unavailable === count ? 'unavailable' : complete === count ? 'available' : 'partial';
    if (availability === 'available' && allRelevantProducersDegraded) availability = 'partial';
  } else if (current.count > 0) {
    availability = allRelevantProducersDegraded
      ? 'partial'
      : current.complete === current.count
        ? 'available'
        : current.unavailable === current.count
          ? 'unavailable'
          : 'partial';
  } else {
    availability = 'unavailable';
  }
  const asOf = latestTimestamp([evidence.latestObservedAt, ...coverage.map((item) => item.asOf)]);
  const reason = coverage.filter((item) => item.reason).sort((a, b) => time(b.asOf) - time(a.asOf))[0]?.reason;
  return { support, availability, ...(asOf ? { asOf } : {}), ...(reason ? { reason } : {}) };
}

function comparable(state: AgentMonitorState): string {
  const { revision: _revision, ...value } = state;
  return JSON.stringify(value);
}

/** Pure full-state projection. Supplying `previous` preserves status timing and increments only on a public change. */
export function projectAgentMonitorState(
  accumulator: MonitorAccumulatorState,
  options: ProjectAgentMonitorOptions = {},
): AgentMonitorState {
  // Status, blockers, activity, compaction, the environment and liveness are the transitions view's basis: one rule.
  const basis = transitionBasis(accumulator);
  const { entries, actors, children, activity, status } = basis;
  const unbounded = options.unboundedCollections ?? false;
  const omitted: Partial<Record<MonitorBoundedCollection, number>> = {};
  const blockerProjection = blockersOf(accumulator, unbounded);
  if (blockerProjection.omittedBlockers > 0) omitted.blockers = blockerProjection.omittedBlockers;
  if (blockerProjection.omittedQuestions > 0) omitted.questions = blockerProjection.omittedQuestions;
  if (blockerProjection.omittedQuestionOptions > 0) omitted.questionOptions = blockerProjection.omittedQuestionOptions;
  const evidenceAsOf = latestTimestamp([
    accumulator.runtime.lastAcceptedAt,
    accumulator.semantic.lastAcceptedAt,
    accumulator.workspace.lastPublicAcceptedAt,
    accumulator.allocatedAt,
  ]);
  const projectionAsOf = options.asOf ?? evidenceAsOf ?? accumulator.allocatedAt;
  const asOfMs = time(projectionAsOf);
  const usageIndex = usageIndexOf(accumulator);
  const usageProjection = queryUsageIndex(
    usageIndex,
    asOfMs,
    options.burnRateWindowMs ?? DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
  );
  if (usageProjection.omittedSamples > 0) omitted.usageSamples = usageProjection.omittedSamples;

  const context = projectContext(entries);
  const lastAssistantMessage = projectAssistantMessage(entries);
  const model = projectModel(entries);
  const effort = projectEffort(entries);
  const subagentActors = withUsageActors(actors, usageIndex.childActors);
  const subagents = projectSubagents(
    subagentActors,
    children,
    usageProjection.actorTotals,
    usageProjection.actorBurnRates,
    usageProjection.actorCosts,
    omitted,
    unbounded,
  );
  // Project before spreading `omitted`; worktree truncation is discovered here.
  const environment = projectEnvironment(basis.environment, omitted, unbounded);
  const startedAt = earliestTimestamp(
    familyEntries(entries, 'status')
      .filter(
        (entry) =>
          entry.value.kind === 'run' &&
          ['starting', 'running'].includes((entry.value as MonitorRunStatusObservation).lifecycle),
      )
      .map((entry) => entry.effectiveAt ?? entry.observedAt),
  );
  const families: AgentMonitorState['freshness']['families'] = {};
  const familyNames: MonitorMetricFamily[] = [
    'status',
    'usage',
    'context',
    'model',
    'effort',
    'mode',
    'delegation',
    'compaction',
    'environment',
    'conversation',
  ];
  for (const family of familyNames) {
    const evidence =
      family === 'usage' ? usageIndex.evidence : summarizeFamilyEvidence(familyEntries(entries, family));
    const freshness = familySupport(accumulator, evidence, family);
    if (freshness) families[family] = freshness;
  }

  const statusSinceCandidate =
    status === 'blocked'
      ? blockerProjection.blockers[0]!.since
      : status === 'working'
        ? activity?.since || accumulator.allocatedAt
        : (evidenceAsOf ?? accumulator.allocatedAt);
  const statusSince = options.previous?.status === status ? options.previous.statusSince : statusSinceCandidate;
  const modeEntries = familyEntries(entries, 'mode');
  const modeAsOf = latestTimestamp(modeEntries.map((entry) => entry.observedAt));
  const draft: AgentMonitorState = {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeEpoch: accumulator.runtimeEpoch,
    revision: options.previous ? options.previous.revision + 1 : 1,
    runtimeRunId: accumulator.runtimeRunId,
    status,
    statusSince,
    blockers: blockerProjection.blockers,
    ...(activity ? { activity } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    usage: usageProjection.usage,
    ...(context ? { context } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    modes: {
      execution: accumulator.executionMode,
      ...(providerMode(modeEntries, 'provider-session')
        ? { providerSession: providerMode(modeEntries, 'provider-session') }
        : {}),
      ...(providerMode(modeEntries, 'provider-permission')
        ? { providerPermission: providerMode(modeEntries, 'provider-permission') }
        : {}),
      ...(modeAsOf ? { asOf: modeAsOf } : {}),
    },
    subagentCount: subagentActors.size,
    subagents,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
    compaction: basis.compaction,
    environment,
    session: {
      ...(basis.nativeSessionId !== undefined ? { nativeSessionId: basis.nativeSessionId } : {}),
      ...(startedAt ? { startedAt } : {}),
    },
    freshness: {
      ...(evidenceAsOf ? { lastEvidenceAt: evidenceAsOf } : {}),
      ...(basis.toolOpen ? { toolOpen: true } : {}),
      level: accumulator.observationLevel,
      families,
    },
    alive: basis.alive,
  };
  if (options.previous && comparable(options.previous) === comparable(draft)) return options.previous;
  return draft;
}
