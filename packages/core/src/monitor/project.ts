import type {
  AgentMonitorState,
  AgentMonitorStatus,
  ActorRunRef,
  MonitorActivity,
  MonitorBlocker,
  MonitorBoundedCollection,
  MonitorContextState,
  MonitorEffortState,
  MonitorFamilyAvailability,
  MonitorFamilySupport,
  MonitorMetricFamily,
  MonitorModelState,
  MonitorPlanState,
  MonitorProviderMode,
  MonitorSubagentState,
  MonitorTaskState,
  MonitorTeammateState,
  MonitorTeamState,
  MonitorWorkflowState,
} from './types.js';
import { AGENT_MONITOR_SCHEMA_VERSION } from './types.js';
import type {
  MonitorAccumulatorState,
  MonitorActorFamilyValue,
  MonitorCompactionFamilyValue,
  MonitorContextFamilyValue,
  MonitorEnvironmentFamilyValue,
  MonitorFamilyValue,
  MonitorInteractionObservation,
  MonitorModeFamilyValue,
  MonitorPlanFamilyValue,
  MonitorRunStatusObservation,
  MonitorStoredEntry,
  MonitorTaskFamilyValue,
  MonitorTeamFamilyValue,
  MonitorTeamMemberFamilyValue,
  MonitorWorkflowFamilyValue,
} from './internal-types.js';
import { boundMonitorCollection } from './bounds.js';
import { DEFAULT_MONITOR_BURN_RATE_WINDOW_MS, projectMonitorUsageLedger } from './rate.js';

export interface ProjectAgentMonitorOptions {
  previous?: AgentMonitorState;
  /** Explicit projection boundary; defaults to the newest accepted evidence timestamp. */
  asOf?: string;
  burnRateWindowMs?: number;
  /** Private diagnostic/notification projection; renderer state remains bounded. */
  unboundedCollections?: boolean;
}

const QUALITY_PRIORITY = {
  exact: 6,
  strong: 5,
  derived: 4,
  estimated: 3,
  inferred: 2,
  unknown: 1,
} as const;

const BLOCKER_PRIORITY = { failure: 0, question: 1, permission: 2 } as const;

function time(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
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

function planePriority(entry: MonitorStoredEntry): number {
  if (entry.family === 'environment') return entry.plane === 'workspace' ? 3 : entry.plane === 'runtime' ? 2 : 1;
  if (entry.family === 'status' && entry.value.kind === 'run') return entry.plane === 'runtime' ? 3 : 2;
  if (entry.family === 'mode') return entry.plane === 'runtime' ? 3 : entry.plane === 'semantic' ? 2 : 1;
  return entry.plane === 'semantic' ? 3 : entry.plane === 'runtime' ? 2 : 1;
}

function compareEntryPreference(a: MonitorStoredEntry, b: MonitorStoredEntry): number {
  const provisional = Number(!b.provisional) - Number(!a.provisional);
  if (provisional !== 0) return provisional;
  // Model, effort, and context have two complementary owners: provider
  // samples give the first live boundary and semantic responses make it
  // durable. Equal-quality claims therefore advance by evidence time instead
  // of allowing an older plane to mask a newer transition.
  if (a.family === b.family && ['model', 'effort', 'context'].includes(a.family)) {
    return (
      QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
      time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) ||
      planePriority(b) - planePriority(a) ||
      b.storageKey.localeCompare(a.storageKey)
    );
  }
  return (
    planePriority(b) - planePriority(a) ||
    QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
    time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) ||
    b.storageKey.localeCompare(a.storageKey)
  );
}

function allEntries(state: MonitorAccumulatorState): MonitorStoredEntry[] {
  return [...state.runtime.entries.values(), ...state.semantic.entries.values(), ...state.workspace.entries.values()];
}

function logicalEntryKey(entry: MonitorStoredEntry): string {
  const actor = actorOf(entry.value)?.runKey ?? '';
  switch (entry.value.kind) {
    case 'run':
      return JSON.stringify([entry.family, 'run']);
    case 'interaction':
      return JSON.stringify([entry.family, 'interaction', entry.value.interactionId, actor]);
    case 'failure':
      return JSON.stringify([entry.family, 'failure', entry.value.failureId, actor]);
    case 'usage':
      return JSON.stringify([entry.family, entry.value.usageId, actor]);
    case 'context':
      return JSON.stringify([entry.family, actor || 'root']);
    case 'model':
    case 'effort':
      return JSON.stringify([entry.family, entry.value.intent, actor || 'root']);
    case 'mode':
      return JSON.stringify([entry.family, entry.value.modeKind, entry.value.intent ?? 'observed']);
    case 'plan':
      return JSON.stringify([entry.family, entry.value.planId, actor]);
    case 'task':
      return JSON.stringify([entry.family, entry.value.taskId, actor]);
    case 'actor':
      return JSON.stringify([entry.family, 'actor', entry.value.actor.runKey]);
    case 'affiliation':
      return JSON.stringify([
        entry.family,
        'affiliation',
        entry.value.actor.runKey,
        entry.value.affiliation.kind,
        entry.value.affiliation.id,
      ]);
    case 'team':
      return JSON.stringify([entry.family, 'team', entry.value.teamId]);
    case 'team-member':
      return JSON.stringify([entry.family, 'team-member', entry.value.teamId, entry.value.membershipId]);
    case 'workflow':
      return JSON.stringify([entry.family, entry.value.workflowId]);
    case 'activity':
    case 'compaction':
    case 'environment':
      return JSON.stringify([entry.family, entry.key]);
  }
}

/** Select one current source-owned claim for every provider-neutral family/key identity. */
function selectedEntries(state: MonitorAccumulatorState): MonitorStoredEntry[] {
  const grouped = new Map<string, MonitorStoredEntry[]>();
  for (const entry of allEntries(state)) {
    const key = logicalEntryKey(entry);
    const group = grouped.get(key);
    if (group) group.push(entry);
    else grouped.set(key, [entry]);
  }
  return [...grouped.values()]
    .map((group) => group.sort(compareEntryPreference)[0]!)
    .sort((a, b) => a.family.localeCompare(b.family) || a.key.localeCompare(b.key));
}

function familyEntries(entries: readonly MonitorStoredEntry[], family: MonitorMetricFamily): MonitorStoredEntry[] {
  return entries.filter((entry) => entry.family === family);
}

function actorOf(value: MonitorFamilyValue): ActorRunRef | undefined {
  switch (value.kind) {
    case 'activity':
    case 'interaction':
    case 'failure':
    case 'usage':
    case 'context':
    case 'model':
    case 'effort':
    case 'plan':
    case 'task':
      return value.actor;
    case 'actor':
    case 'affiliation':
      return value.actor;
    case 'team-member':
      return value.actor;
    case 'run':
    case 'mode':
    case 'team':
    case 'workflow':
    case 'compaction':
    case 'environment':
      return undefined;
  }
}

function maybeBound<T>(
  collection: MonitorBoundedCollection,
  values: readonly T[],
  unbounded: boolean,
): { values: T[]; omitted: number } {
  return unbounded ? { values: [...values], omitted: 0 } : boundMonitorCollection(collection, values);
}

function projectBlockers(
  entries: readonly MonitorStoredEntry[],
  unbounded: boolean,
): {
  blockers: MonitorBlocker[];
  omittedBlockers: number;
  omittedQuestions: number;
  omittedQuestionOptions: number;
} {
  const blockers: MonitorBlocker[] = [];
  let omittedQuestions = 0;
  let omittedQuestionOptions = 0;

  for (const entry of familyEntries(entries, 'status')) {
    const since = entry.effectiveAt ?? entry.observedAt;
    if (entry.value.kind === 'interaction' && entry.value.state === 'pending') {
      const interaction = entry.value as MonitorInteractionObservation;
      if (interaction.interactionKind === 'permission') {
        blockers.push({
          id: interaction.interactionId,
          kind: 'permission',
          since,
          ...(interaction.detail ? { detail: interaction.detail } : {}),
          ...(interaction.actor ? { actorRunKey: interaction.actor.runKey } : {}),
          ...(interaction.permission ? { permission: interaction.permission } : {}),
        });
      } else {
        const boundedQuestions = maybeBound('questions', interaction.questions ?? [], unbounded);
        omittedQuestions += boundedQuestions.omitted;
        const questions = boundedQuestions.values.map((question) => {
          const bounded = maybeBound('questionOptions', question.options ?? [], unbounded);
          omittedQuestionOptions += bounded.omitted;
          return { ...question, ...(question.options ? { options: bounded.values } : {}) };
        });
        blockers.push({
          id: interaction.interactionId,
          kind: 'question',
          since,
          ...(interaction.detail ? { detail: interaction.detail } : {}),
          ...(interaction.actor ? { actorRunKey: interaction.actor.runKey } : {}),
          questions,
        });
      }
    } else if (entry.value.kind === 'failure' && entry.value.state === 'active') {
      blockers.push({
        id: entry.value.failureId,
        kind: 'failure',
        since,
        ...(entry.value.detail ? { detail: entry.value.detail } : {}),
        ...(entry.value.actor ? { actorRunKey: entry.value.actor.runKey } : {}),
        failure: { ...(entry.value.code ? { code: entry.value.code } : {}), recoverable: entry.value.recoverable },
      });
    } else if (entry.value.kind === 'run' && entry.value.lifecycle === 'failed') {
      blockers.push({
        id: `run:${entry.ownerId}`,
        kind: 'failure',
        since,
        ...(entry.value.failure?.detail ? { detail: entry.value.failure.detail } : {}),
        failure: {
          ...(entry.value.failure?.code ? { code: entry.value.failure.code } : {}),
          recoverable: entry.value.failure?.recoverable ?? false,
        },
      });
    }
  }

  blockers.sort(
    (a, b) =>
      BLOCKER_PRIORITY[a.kind] - BLOCKER_PRIORITY[b.kind] || time(a.since) - time(b.since) || a.id.localeCompare(b.id),
  );
  const bounded = maybeBound('blockers', blockers, unbounded);
  return {
    blockers: bounded.values,
    omittedBlockers: bounded.omitted,
    omittedQuestions,
    omittedQuestionOptions,
  };
}

interface ActivityCandidate extends MonitorActivity {
  priority: number;
  key: string;
}

function activityPriority(kind: MonitorActivity['kind']): number {
  return kind === 'compacting'
    ? 1
    : kind === 'tool'
      ? 2
      : kind === 'reasoning'
        ? 3
        : kind === 'responding'
          ? 4
          : kind === 'delegating'
            ? 5
            : kind === 'starting'
              ? 6
              : 7;
}

type ActiveActivityEntry = {
  entry: MonitorStoredEntry;
  value: Extract<MonitorFamilyValue, { kind: 'activity' }>;
};

function activityEntryTime(candidate: ActiveActivityEntry): number {
  return time(candidate.value.since ?? candidate.entry.effectiveAt ?? candidate.entry.observedAt);
}

function preferActivity(candidate: ActiveActivityEntry, current: ActiveActivityEntry): boolean {
  const candidatePriority = activityPriority(candidate.value.activityKind);
  const currentPriority = activityPriority(current.value.activityKind);
  return (
    candidatePriority < currentPriority ||
    (candidatePriority === currentPriority &&
      (activityEntryTime(candidate) > activityEntryTime(current) ||
        (activityEntryTime(candidate) === activityEntryTime(current) &&
          candidate.entry.key.localeCompare(current.entry.key) < 0)))
  );
}

function projectActivity(
  entries: readonly MonitorStoredEntry[],
  run: { entry: MonitorStoredEntry; value: MonitorRunStatusObservation } | undefined,
) {
  // A terminal host observation seals activity even if a provider disappears
  // while a tool/turn is open and cannot emit its matching terminal record.
  if (run && !run.value.alive) return undefined;
  const stoppedActors = new Set(
    entries
      .filter(
        (entry): entry is MonitorStoredEntry & { value: MonitorActorFamilyValue } =>
          entry.value.kind === 'actor' && entry.value.state === 'stopped',
      )
      .map((entry) => entry.value.actor.runKey),
  );
  const candidates: ActivityCandidate[] = [];
  for (const entry of entries) {
    if (entry.value.kind === 'compaction' && entry.value.active) {
      candidates.push({
        kind: 'compacting',
        line: 'Compacting context',
        since: entry.effectiveAt ?? entry.observedAt,
        priority: 1,
        key: entry.key,
      });
    } else if (
      entry.value.kind === 'activity' &&
      entry.value.active &&
      (!entry.value.actor || !stoppedActors.has(entry.value.actor.runKey))
    ) {
      candidates.push({
        kind: entry.value.activityKind,
        line: entry.value.line ?? 'Working',
        since: entry.value.since ?? entry.effectiveAt ?? entry.observedAt,
        priority: activityPriority(entry.value.activityKind),
        key: entry.key,
      });
    } else if (entry.value.kind === 'actor' && entry.value.actor.role === 'child' && entry.value.state === 'active') {
      candidates.push({
        kind: 'delegating',
        line: entry.value.activity ?? `Delegating to ${entry.value.actor.nativeAgentType ?? 'subagent'}`,
        since: entry.effectiveAt ?? entry.observedAt,
        priority: 5,
        key: entry.key,
      });
    }
  }
  if (run && ['allocated', 'preparing', 'starting'].includes(run.value.lifecycle)) {
    candidates.push({
      kind: 'starting',
      line: 'Starting',
      since: run.entry.effectiveAt ?? run.entry.observedAt,
      priority: 6,
      key: 'run',
    });
  }
  const selected = candidates.sort(
    (a, b) => a.priority - b.priority || time(b.since) - time(a.since) || a.key.localeCompare(b.key),
  )[0];
  if (!selected) return undefined;
  const { priority: _priority, key: _key, ...activity } = selected;
  return activity;
}

function latestRun(
  entries: readonly MonitorStoredEntry[],
): { entry: MonitorStoredEntry; value: MonitorRunStatusObservation } | undefined {
  const runs = familyEntries(entries, 'status').filter(
    (entry): entry is MonitorStoredEntry & { value: MonitorRunStatusObservation } => entry.value.kind === 'run',
  );
  const entry = runs.sort(compareEntryPreference)[0];
  return entry ? { entry, value: entry.value } : undefined;
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

function projectPlan(
  entries: readonly MonitorStoredEntry[],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const candidates = entries
    .filter((entry): entry is MonitorStoredEntry & { value: MonitorPlanFamilyValue } => entry.value.kind === 'plan')
    .sort((a, b) => Number(!b.value.provisional) - Number(!a.value.provisional) || compareEntryPreference(a, b));
  const selected = candidates[0];
  if (!selected) return undefined;
  const steps = maybeBound('planSteps', selected.value.steps, unbounded);
  if (steps.omitted > 0) omitted.planSteps = steps.omitted;
  return {
    updatedAt: selected.effectiveAt ?? selected.observedAt,
    ...(selected.value.actor ? { actorRunKey: selected.value.actor.runKey } : {}),
    steps: steps.values,
    ...(selected.value.provisional ? { provisional: true } : {}),
  } satisfies MonitorPlanState;
}

function projectTasks(
  entries: readonly MonitorStoredEntry[],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const values = entries
    .filter((entry): entry is MonitorStoredEntry & { value: MonitorTaskFamilyValue } => entry.value.kind === 'task')
    .filter((entry) => entry.value.status !== 'removed')
    .map((entry): MonitorTaskState => ({
      id: entry.value.taskId,
      ...(entry.value.actor ? { actorRunKey: entry.value.actor.runKey } : {}),
      ...(entry.value.description ? { description: entry.value.description } : {}),
      status: entry.value.status,
      ...(entry.value.teamName ? { teamName: entry.value.teamName } : {}),
      ...(entry.value.teammateName ? { teammateName: entry.value.teammateName } : {}),
      ...(entry.value.provisional ? { provisional: true } : {}),
    }))
    .sort((a, b) => {
      const active = (task: MonitorTaskState) => ['proposed', 'pending', 'in-progress'].includes(task.status);
      return Number(active(b)) - Number(active(a)) || a.id.localeCompare(b.id);
    });
  const bounded = maybeBound('tasks', values, unbounded);
  if (bounded.omitted > 0) omitted.tasks = bounded.omitted;
  return bounded.values;
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

function contextPercentage(value: MonitorContextFamilyValue): number | undefined {
  return (
    value.usedPercentage ??
    (value.usedTokens !== undefined && value.capacityTokens !== undefined && value.capacityTokens > 0
      ? Math.min(100, Math.max(0, (value.usedTokens / value.capacityTokens) * 100))
      : undefined)
  );
}

function projectSubagents(
  entries: readonly MonitorStoredEntry[],
  actorTotals: ReadonlyMap<string, number>,
  actorBurnRates: ReadonlyMap<string, number>,
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const actors = new Map<string, { actor: ActorRunRef; state?: MonitorActorFamilyValue }>();
  const activities = new Map<string, ActiveActivityEntry>();
  for (const entry of entries) {
    const actor = actorOf(entry.value);
    if (!actor || actor.role !== 'child') continue;
    const current = actors.get(actor.runKey);
    if (entry.value.kind === 'actor') actors.set(actor.runKey, { actor, state: entry.value });
    else if (!current) actors.set(actor.runKey, { actor });
    if (entry.value.kind === 'activity' && entry.value.active) {
      const currentActivity = activities.get(actor.runKey);
      const candidate = { entry, value: entry.value };
      if (!currentActivity || preferActivity(candidate, currentActivity)) {
        activities.set(actor.runKey, candidate);
      }
    }
  }
  const values = [...actors.values()]
    .map(({ actor, state }): MonitorSubagentState => {
      const context = actorMetric(entries, actor.runKey, 'context');
      const model = actorMetric(entries, actor.runKey, 'model');
      const effort = actorMetric(entries, actor.runKey, 'effort');
      const activity = activities.get(actor.runKey)?.value;
      const contextPercent = context ? contextPercentage(context.value) : undefined;
      const active =
        state?.state === 'stopped'
          ? false
          : state?.state === 'active' || state?.state === 'idle' || activity !== undefined;
      return {
        id: actor.nativeAgentId ?? actor.runKey,
        actorRunKey: actor.runKey,
        ...(actor.nativeAgentType ? { type: actor.nativeAgentType } : {}),
        active,
        ...(active && (state?.activity || activity?.line) ? { activity: state?.activity ?? activity?.line } : {}),
        ...(actorTotals.has(actor.runKey) ? { cumulativeTokens: actorTotals.get(actor.runKey) } : {}),
        ...(actorBurnRates.has(actor.runKey) ? { burnRatePerMin: actorBurnRates.get(actor.runKey) } : {}),
        ...(contextPercent !== undefined ? { contextPercent } : {}),
        ...(model ? { modelId: model.value.providerModelId } : {}),
        ...(model ? { modelIntent: model.value.intent } : {}),
        ...(effort ? { effort: effort.value.value } : {}),
        ...(effort ? { effortIntent: effort.value.intent } : {}),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
  const bounded = maybeBound('subagents', values, unbounded);
  if (bounded.omitted > 0) omitted.subagents = bounded.omitted;
  return bounded.values;
}

type TeamEntry = MonitorStoredEntry & { value: MonitorTeamFamilyValue };
type TeamMemberEntry = MonitorStoredEntry & { value: MonitorTeamMemberFamilyValue };

function aliases(...values: Array<string | undefined>): Set<string> {
  return new Set(values.filter((value): value is string => value !== undefined && value.length > 0));
}

function sharesIdentity(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function teamAliases(value: MonitorTeamFamilyValue): Set<string> {
  return aliases(value.teamId, value.nativeTeamId);
}

function memberTeamAliases(value: MonitorTeamMemberFamilyValue): Set<string> {
  return aliases(value.teamId, value.nativeTeamId);
}

function memberAliases(value: MonitorTeamMemberFamilyValue): Set<string> {
  return aliases(value.membershipId, value.nativeMemberId);
}

function groupMemberClaims(entries: readonly TeamMemberEntry[]): TeamMemberEntry[][] {
  const groups: TeamMemberEntry[][] = [];
  for (const entry of entries) {
    const identity = memberAliases(entry.value);
    const matching: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index]!.some((candidate) => sharesIdentity(identity, memberAliases(candidate.value)))) {
        matching.push(index);
      }
    }
    if (matching.length === 0) {
      groups.push([entry]);
      continue;
    }
    const combined = [entry, ...matching.flatMap((index) => groups[index]!)];
    for (const index of [...matching].sort((a, b) => b - a)) groups.splice(index, 1);
    groups.push(combined);
  }
  return groups;
}

function membershipState(entry: TeamMemberEntry): 'present' | 'removed' | 'unknown' {
  if (entry.value.membershipState) return entry.value.membershipState;
  if (entry.value.state === 'removed') return 'removed';
  if (entry.value.state === 'active' || entry.value.state === 'idle') return 'present';
  return 'unknown';
}

interface TeammateActivityClaim {
  state: 'active' | 'idle' | 'stopped';
  entry: MonitorStoredEntry;
  at: number;
  line?: string;
}

function compareTeammateActivity(a: TeammateActivityClaim, b: TeammateActivityClaim): number {
  return (
    b.at - a.at || Number(a.entry.provisional) - Number(b.entry.provisional) || compareEntryPreference(a.entry, b.entry)
  );
}

function projectTeam(
  claims: readonly MonitorStoredEntry[],
  entries: readonly MonitorStoredEntry[],
  actorTotals: ReadonlyMap<string, number>,
  actorBurnRates: ReadonlyMap<string, number>,
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const allMemberClaims = claims.filter((entry): entry is TeamMemberEntry => entry.value.kind === 'team-member');
  const rootTeamAliases = allMemberClaims
    .filter((entry) => entry.value.actor?.role === 'root' && membershipState(entry) !== 'removed')
    .reduce((values, entry) => new Set([...values, ...memberTeamAliases(entry.value)]), new Set<string>());
  const teams = claims
    .filter((entry): entry is TeamEntry => entry.value.kind === 'team')
    .sort(
      (a, b) =>
        Number(!sharesIdentity(rootTeamAliases, teamAliases(a.value))) -
          Number(!sharesIdentity(rootTeamAliases, teamAliases(b.value))) || compareEntryPreference(a, b),
    );
  const selected = teams[0];
  if (!selected) return undefined;
  const selectedTeamAliases = teamAliases(selected.value);
  const relatedTeams = teams.filter((entry) => sharesIdentity(selectedTeamAliases, teamAliases(entry.value)));
  const namedTeam = relatedTeams.filter((entry) => entry.value.name).sort(compareEntryPreference)[0];
  const memberClaims = allMemberClaims.filter((entry) =>
    sharesIdentity(selectedTeamAliases, memberTeamAliases(entry.value)),
  );
  const teammates = groupMemberClaims(memberClaims)
    .map((group): MonitorTeammateState | undefined => {
      const preferred = [...group].sort(compareEntryPreference);
      const identity = preferred[0]!;
      const presenceClaims = preferred.filter((entry) => membershipState(entry) !== 'unknown');
      const presence = presenceClaims[0] ?? identity;
      if (membershipState(presence) === 'removed') return undefined;

      const actorClaim = preferred.find((entry) => entry.value.actor);
      const runtimeClaim = preferred.find((entry) => entry.value.runtimeRunId);
      const nameClaim = preferred.find((entry) => entry.value.name);
      const actor = actorClaim?.value.actor;
      const actorRunKey = actor?.runKey;
      const activityClaims: TeammateActivityClaim[] = group.flatMap((entry) =>
        entry.value.state === 'active' || entry.value.state === 'idle'
          ? [
              {
                state: entry.value.state,
                entry,
                at: time(entry.effectiveAt ?? entry.observedAt),
              } satisfies TeammateActivityClaim,
            ]
          : [],
      );
      if (actorRunKey) {
        for (const entry of entries) {
          if (actorOf(entry.value)?.runKey !== actorRunKey) continue;
          if (
            entry.value.kind === 'actor' &&
            (entry.value.state === 'active' || entry.value.state === 'idle' || entry.value.state === 'stopped')
          ) {
            activityClaims.push({
              state: entry.value.state,
              entry,
              at: time(entry.effectiveAt ?? entry.observedAt),
              ...(entry.value.activity ? { line: entry.value.activity } : {}),
            });
          } else if (entry.value.kind === 'activity' && entry.value.active) {
            activityClaims.push({
              state: 'active',
              entry,
              at: time(entry.value.since ?? entry.effectiveAt ?? entry.observedAt),
              ...(entry.value.line ? { line: entry.value.line } : {}),
            });
          }
        }
      }
      const activity = activityClaims.sort(compareTeammateActivity)[0];
      const idle = activity?.state === 'idle' ? true : activity?.state === 'active' ? false : undefined;
      const context = actorRunKey ? actorMetric(entries, actorRunKey, 'context') : undefined;
      const model = actorRunKey ? actorMetric(entries, actorRunKey, 'model') : undefined;
      const effort = actorRunKey ? actorMetric(entries, actorRunKey, 'effort') : undefined;
      const contextPercent = context ? contextPercentage(context.value) : undefined;
      return {
        id: identity.value.membershipId,
        ...(nameClaim?.value.name ? { name: nameClaim.value.name } : {}),
        ...(actorRunKey ? { actorRunKey } : {}),
        ...(runtimeClaim?.value.runtimeRunId ? { runtimeRunId: runtimeClaim.value.runtimeRunId } : {}),
        ...(idle === undefined ? {} : { idle }),
        ...(activity?.state === 'active' && activity.line ? { activity: activity.line } : {}),
        ...(actorRunKey && actorTotals.has(actorRunKey) ? { cumulativeTokens: actorTotals.get(actorRunKey) } : {}),
        ...(actorRunKey && actorBurnRates.has(actorRunKey) ? { burnRatePerMin: actorBurnRates.get(actorRunKey) } : {}),
        ...(contextPercent !== undefined ? { contextPercent } : {}),
        ...(model ? { modelId: model.value.providerModelId } : {}),
        ...(model ? { modelIntent: model.value.intent } : {}),
        ...(effort ? { effort: effort.value.value } : {}),
        ...(effort ? { effortIntent: effort.value.intent } : {}),
        ...(activity?.entry.provisional ? { activityProvisional: true } : {}),
        ...(presence.provisional ? { provisional: true } : {}),
      };
    })
    .filter((value): value is MonitorTeammateState => value !== undefined)
    .sort((a, b) => {
      const activityRank = (value: MonitorTeammateState) =>
        value.idle === false ? 0 : value.idle === undefined ? 1 : 2;
      return activityRank(a) - activityRank(b) || a.id.localeCompare(b.id);
    });
  const rootActorRunKeys = new Set(
    memberClaims
      .filter((entry) => entry.value.actor?.role === 'root')
      .map((entry) => entry.value.actor?.runKey)
      .filter((value): value is string => value !== undefined),
  );
  const currentMember = teammates.find(
    (teammate) => teammate.actorRunKey !== undefined && rootActorRunKeys.has(teammate.actorRunKey),
  );
  const peerTeammates = currentMember ? teammates.filter((teammate) => teammate !== currentMember) : teammates;
  const bounded = maybeBound('teammates', peerTeammates, unbounded);
  if (bounded.omitted > 0) omitted.teammates = bounded.omitted;
  return {
    id: selected.value.teamId,
    ...(namedTeam?.value.name ? { name: namedTeam.value.name } : {}),
    ...(currentMember ? { memberId: currentMember.id } : {}),
    ...(currentMember?.name ? { memberName: currentMember.name } : {}),
    teammates: bounded.values,
    ...(selected.provisional ? { provisional: true } : {}),
  } satisfies MonitorTeamState;
}

function projectWorkflows(
  entries: readonly MonitorStoredEntry[],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  let omittedArtifacts = 0;
  let omittedActorRunKeys = 0;
  const workflows = entries
    .filter(
      (entry): entry is MonitorStoredEntry & { value: MonitorWorkflowFamilyValue } => entry.value.kind === 'workflow',
    )
    .map((entry): MonitorWorkflowState => {
      const artifacts = maybeBound('artifactRefs', entry.value.artifactRefs, unbounded);
      const actorRunKeys = maybeBound('workflowActorRunKeys', [...entry.value.actorRunKeys].sort(), unbounded);
      omittedArtifacts += artifacts.omitted;
      omittedActorRunKeys += actorRunKeys.omitted;
      return {
        id: entry.value.workflowId,
        ...(entry.value.name ? { name: entry.value.name } : {}),
        active: entry.value.active,
        actorRunKeys: actorRunKeys.values,
        artifactRefs: artifacts.values,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
  const bounded = maybeBound('workflows', workflows, unbounded);
  if (bounded.omitted > 0) omitted.workflows = bounded.omitted;
  if (omittedArtifacts > 0) omitted.artifactRefs = omittedArtifacts;
  if (omittedActorRunKeys > 0) omitted.workflowActorRunKeys = omittedActorRunKeys;
  return bounded.values;
}

function projectEnvironment(
  entries: readonly MonitorStoredEntry[],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const environment = familyEntries(entries, 'environment')
    .filter(
      (entry): entry is MonitorStoredEntry & { value: MonitorEnvironmentFamilyValue } =>
        entry.value.kind === 'environment',
    )
    .sort((a, b) => time(a.observedAt) - time(b.observedAt) || planePriority(a) - planePriority(b));
  let cwd: string | undefined;
  let git: AgentMonitorState['environment']['git'];
  let worktrees: string[] = [];
  for (const entry of environment) {
    if (entry.value.cwd !== undefined) cwd = entry.value.cwd ?? undefined;
    if (entry.value.git !== undefined) git = entry.value.git;
    if (entry.value.worktrees !== undefined) worktrees = [...entry.value.worktrees].sort();
  }
  const boundedWorktrees = maybeBound('worktrees', worktrees, unbounded);
  if (boundedWorktrees.omitted > 0) omitted.worktrees = boundedWorktrees.omitted;
  return { ...(cwd ? { cwd } : {}), ...(git !== undefined ? { git } : {}), worktrees: boundedWorktrees.values };
}

function familySupport(
  state: MonitorAccumulatorState,
  entries: readonly MonitorStoredEntry[],
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
  const current = familyEntries(entries, family);
  if (!support && current.length > 0) {
    support = current.some((entry) => entry.completeness === 'complete') ? 'supported' : 'degraded';
  }
  if (!support) return undefined;
  const relevantProducers = producers.filter((producer) => {
    const capability = producer.capabilities.get(family);
    if (capability?.support === 'unsupported') return false;
    return (
      capability !== undefined ||
      [...producer.coverage.values()].some((item) => item.family === family) ||
      current.some((entry) => entry.plane === 'semantic' && entry.ownerId === producer.id)
    );
  });
  const producerIds = new Set(producers.map((producer) => producer.id));
  const coverage = relevantProducers.flatMap((producer) =>
    [...producer.coverage.values()].filter((item) => item.family === family),
  );
  const completeness = relevantProducers.flatMap((producer) => {
    const producerCoverage = [...producer.coverage.values()].filter((item) => item.family === family);
    if (producerCoverage.length > 0) return producerCoverage.map((item) => item.completeness);
    return current
      .filter((entry) => entry.plane === 'semantic' && entry.ownerId === producer.id)
      .map((entry) => entry.completeness);
  });
  completeness.push(
    ...current
      .filter((entry) => entry.plane !== 'semantic' || !producerIds.has(entry.ownerId))
      .map((entry) => entry.completeness),
  );
  const allRelevantProducersDegraded =
    relevantProducers.length > 0 && relevantProducers.every((producer) => producer.readiness === 'degraded');
  let availability: MonitorFamilyAvailability;
  if (support === 'unsupported') availability = 'unavailable';
  else if (relevantProducers.length > 0 && relevantProducers.every((producer) => producer.readiness === 'loading')) {
    availability = 'loading';
  } else if (completeness.length > 0) {
    const complete = completeness.filter((value) => value === 'complete').length;
    const unavailable = completeness.filter((value) => value === 'unavailable').length;
    availability =
      unavailable === completeness.length ? 'unavailable' : complete === completeness.length ? 'available' : 'partial';
    if (availability === 'available' && allRelevantProducersDegraded) availability = 'partial';
  } else if (current.length > 0) {
    const currentCompleteness = current.map((entry) => entry.completeness);
    availability = allRelevantProducersDegraded
      ? 'partial'
      : currentCompleteness.every((value) => value === 'complete')
        ? 'available'
        : currentCompleteness.every((value) => value === 'unavailable')
          ? 'unavailable'
          : 'partial';
  } else {
    availability = 'unavailable';
  }
  const asOf = latestTimestamp([...current.map((entry) => entry.observedAt), ...coverage.map((item) => item.asOf)]);
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
  const entries = selectedEntries(accumulator);
  const unbounded = options.unboundedCollections ?? false;
  const omitted: Partial<Record<MonitorBoundedCollection, number>> = {};
  const run = latestRun(entries);
  const blockerProjection = projectBlockers(entries, unbounded);
  if (blockerProjection.omittedBlockers > 0) omitted.blockers = blockerProjection.omittedBlockers;
  if (blockerProjection.omittedQuestions > 0) omitted.questions = blockerProjection.omittedQuestions;
  if (blockerProjection.omittedQuestionOptions > 0) omitted.questionOptions = blockerProjection.omittedQuestionOptions;
  const activity = projectActivity(entries, run);
  const status: AgentMonitorStatus = blockerProjection.blockers.length > 0 ? 'blocked' : activity ? 'working' : 'idle';
  const evidenceAsOf = latestTimestamp([
    accumulator.runtime.lastAcceptedAt,
    accumulator.semantic.lastAcceptedAt,
    accumulator.workspace.lastAcceptedAt,
    accumulator.allocatedAt,
  ]);
  const projectionAsOf = options.asOf ?? evidenceAsOf ?? accumulator.allocatedAt;
  const asOfMs = time(projectionAsOf);
  const usageProjection = projectMonitorUsageLedger(
    familyEntries(entries, 'usage'),
    asOfMs,
    options.burnRateWindowMs ?? DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
  );
  if (usageProjection.omittedSamples > 0) omitted.usageSamples = usageProjection.omittedSamples;

  const context = projectContext(entries);
  const model = projectModel(entries);
  const effort = projectEffort(entries);
  const plan = projectPlan(entries, omitted, unbounded);
  const tasks = projectTasks(entries, omitted, unbounded);
  const subagents = projectSubagents(
    entries,
    usageProjection.actorTotals,
    usageProjection.actorBurnRates,
    omitted,
    unbounded,
  );
  const team = projectTeam(
    allEntries(accumulator),
    entries,
    usageProjection.actorTotals,
    usageProjection.actorBurnRates,
    omitted,
    unbounded,
  );
  const workflows = projectWorkflows(entries, omitted, unbounded);
  // Project before spreading `omitted`; worktree truncation is discovered here.
  const environment = projectEnvironment(entries, omitted, unbounded);
  const compactions = entries.filter(
    (entry): entry is MonitorStoredEntry & { value: MonitorCompactionFamilyValue } => entry.value.kind === 'compaction',
  );
  const activeCompaction = compactions.some((entry) => entry.value.active);
  const provisionalCompaction =
    activeCompaction && compactions.filter((entry) => entry.value.active).every((entry) => entry.provisional);
  const lastCompaction = compactions
    .filter((entry) => !entry.value.active)
    .sort(
      (a, b) =>
        time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) || compareEntryPreference(a, b),
    )[0];
  const nativeSessionEntry = familyEntries(allEntries(accumulator), 'status')
    .filter(
      (entry): entry is MonitorStoredEntry & { value: MonitorRunStatusObservation } =>
        entry.value.kind === 'run' && entry.value.nativeSession !== undefined,
    )
    .sort(
      (a, b) =>
        Number(b.plane === 'semantic') - Number(a.plane === 'semantic') ||
        time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) ||
        compareEntryPreference(a, b),
    )[0];
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
    'planning',
    'delegation',
    'workflow',
    'compaction',
    'environment',
  ];
  for (const family of familyNames) {
    const freshness = familySupport(accumulator, entries, family);
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
    ...(plan ? { plan } : {}),
    tasks,
    subagents,
    ...(team ? { team } : {}),
    workflows,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
    compaction: {
      active: activeCompaction,
      ...(provisionalCompaction ? { provisional: true } : {}),
      ...(lastCompaction ? { lastAt: lastCompaction.effectiveAt ?? lastCompaction.observedAt } : {}),
      ...(lastCompaction ? { lastOutcome: lastCompaction.value.outcome ?? ('completed' as const) } : {}),
      count: accumulator.compactionCount,
    },
    environment,
    session: {
      ...(nativeSessionEntry?.value.nativeSession
        ? { nativeSessionId: nativeSessionEntry.value.nativeSession.id }
        : {}),
      ...(startedAt ? { startedAt } : {}),
    },
    freshness: {
      ...(evidenceAsOf ? { lastEvidenceAt: evidenceAsOf } : {}),
      level: accumulator.observationLevel,
      families,
    },
    alive: run?.value.alive ?? true,
  };
  if (options.previous && comparable(options.previous) === comparable(draft)) return options.previous;
  return draft;
}
