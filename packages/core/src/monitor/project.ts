import type {
  AgentMonitorState,
  AgentMonitorStatus,
  ActorRunRef,
  MonitorActivity,
  MonitorActivityKind,
  MonitorBlocker,
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
  MonitorActorFamilyValue,
  MonitorCompactionFamilyValue,
  MonitorContextFamilyValue,
  MonitorEnvironmentFamilyValue,
  MonitorFamilyValue,
  MonitorInteractionObservation,
  MonitorModeFamilyValue,
  MonitorRunStatusObservation,
  MonitorStoredEntry,
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
  // Metrics and child state have complementary owners: provider
  // samples give the first live boundary and semantic responses make it
  // durable. Equal-quality claims therefore advance by evidence time instead
  // of allowing an older plane to mask a newer transition.
  if (
    a.family === b.family &&
    (['model', 'effort', 'context'].includes(a.family) || (a.value.kind === 'actor' && b.value.kind === 'actor'))
  ) {
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

function actorLocalSourceKey(entry: MonitorStoredEntry, actorRunKey: string): string {
  try {
    const encoded = JSON.parse(entry.key) as unknown;
    if (
      Array.isArray(encoded) &&
      encoded.length === 2 &&
      typeof encoded[0] === 'string' &&
      encoded[1] === actorRunKey
    ) {
      return encoded[0];
    }
  } catch {
    // Semantic producers use their own readable keys; only runtime actor keys
    // are tuple-encoded by translateAgentEventEnvelope.
  }
  return entry.key;
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
      // One usage identity may gain better actor attribution on a later rail.
      // Attribution is evidence, not part of the token observation identity.
      return JSON.stringify([entry.family, entry.value.usageId]);
    case 'context':
      return JSON.stringify([entry.family, actor || 'root']);
    case 'model':
    case 'effort':
      return JSON.stringify([entry.family, entry.value.intent, actor || 'root']);
    case 'mode':
      return JSON.stringify([entry.family, entry.value.modeKind, entry.value.intent ?? 'observed', actor || 'root']);
    case 'actor':
      return JSON.stringify([entry.family, 'actor', entry.value.actor.runKey]);
    case 'activity':
    case 'compaction':
      return JSON.stringify([entry.family, actor ? actorLocalSourceKey(entry, actor) : entry.key, actor]);
    case 'environment':
      return JSON.stringify([entry.family, actor || 'root']);
    case 'message':
      return JSON.stringify([entry.family, 'message', actor || 'root']);
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
    case 'mode':
    case 'environment':
    case 'compaction':
    case 'message':
      return value.actor;
    case 'actor':
      return value.actor;
    case 'run':
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
  actors: ReadonlyMap<string, ChildActor>,
  unbounded: boolean,
): {
  blockers: MonitorBlocker[];
  blockedActorRunKeys: Set<string>;
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
      if (interaction.actor && actors.get(interaction.actor.runKey)?.state?.value.state === 'stopped') continue;
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
    blockedActorRunKeys: new Set(blockers.flatMap((blocker) => (blocker.actorRunKey ? [blocker.actorRunKey] : []))),
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

type ActiveActorActivity = {
  entry: MonitorStoredEntry;
  activityKind: MonitorActivityKind | 'compacting';
  line: string;
  since: string;
};

function preferActivity(candidate: ActiveActorActivity, current: ActiveActorActivity): boolean {
  const candidatePriority = candidate.activityKind === 'compacting' ? 1 : activityPriority(candidate.activityKind);
  const currentPriority = current.activityKind === 'compacting' ? 1 : activityPriority(current.activityKind);
  return (
    candidatePriority < currentPriority ||
    (candidatePriority === currentPriority &&
      (time(candidate.since) > time(current.since) ||
        (time(candidate.since) === time(current.since) && candidate.entry.key.localeCompare(current.entry.key) < 0)))
  );
}

function projectActivity(
  entries: readonly MonitorStoredEntry[],
  run: { entry: MonitorStoredEntry; value: MonitorRunStatusObservation } | undefined,
  children: ReadonlyMap<string, MonitorActivity>,
) {
  if (run && !run.value.alive) return undefined;
  const candidates: ActivityCandidate[] = [];
  for (const entry of entries) {
    const actor = actorOf(entry.value);
    if (actor && actor.role !== 'root') continue;
    if (entry.value.kind === 'compaction' && entry.value.active) {
      candidates.push({
        kind: 'compacting',
        line: 'Compacting context',
        since: entry.effectiveAt ?? entry.observedAt,
        priority: 1,
        key: entry.key,
      });
    } else if (entry.value.kind === 'activity' && entry.value.active) {
      candidates.push({
        kind: entry.value.activityKind,
        line: entry.value.line ?? 'Working',
        since: entry.value.since ?? entry.effectiveAt ?? entry.observedAt,
        priority: activityPriority(entry.value.activityKind),
        key: entry.key,
      });
    }
  }
  for (const [key, activity] of children) {
    candidates.push({ ...activity, kind: 'delegating', line: `Subagent: ${activity.line}`, priority: 5, key });
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

/** Whether a root tool call is still open, whatever `projectActivity` ranks first (a compaction outranks a tool). */
function rootToolOpen(
  entries: readonly MonitorStoredEntry[],
  run: { entry: MonitorStoredEntry; value: MonitorRunStatusObservation } | undefined,
): boolean {
  if (run && !run.value.alive) return false;
  return entries.some((entry) => {
    const actor = actorOf(entry.value);
    if (actor && actor.role !== 'root') return false;
    return entry.value.kind === 'activity' && entry.value.active && entry.value.activityKind === 'tool';
  });
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

interface ChildActor {
  actor: ActorRunRef;
  entries: MonitorStoredEntry[];
  state?: { value: MonitorActorFamilyValue; at: string };
}

function childActors(entries: readonly MonitorStoredEntry[]): Map<string, ChildActor> {
  const actors = new Map<string, ChildActor>();
  for (const entry of entries) {
    const actor = actorOf(entry.value);
    // Attribution groups and unjoined status tasks are not proven child identities.
    if (!actor || actor.role !== 'child' || !actor.nativeAgentId) continue;
    const current: ChildActor = actors.get(actor.runKey) ?? { actor, entries: [] };
    current.entries.push(entry);
    if (entry.value.kind === 'actor') {
      current.actor = actor;
      current.state = { value: entry.value, at: entry.effectiveAt ?? entry.observedAt };
    }
    actors.set(actor.runKey, current);
  }
  return actors;
}

function childActivities(
  actors: ReadonlyMap<string, ChildActor>,
  alive: boolean,
  blocked: ReadonlySet<string>,
): Map<string, MonitorActivity> {
  const activities = new Map<string, MonitorActivity>();
  if (!alive) return activities;
  for (const [key, { state, entries }] of actors) {
    if (blocked.has(key) || state?.value.state === 'stopped') continue;
    let selected: ActiveActorActivity | undefined;
    for (const entry of entries) {
      if (actorOf(entry.value)?.runKey !== key) continue;
      const value = entry.value;
      if ((value.kind !== 'activity' && value.kind !== 'compaction') || !value.active) continue;
      const since = (value.kind === 'activity' ? value.since : undefined) ?? entry.effectiveAt ?? entry.observedAt;
      // An idle/unknown observation closes older work even if its tool/turn never emitted an end.
      if (state && state.value.state !== 'active' && time(since) <= time(state.at)) continue;
      const candidate: ActiveActorActivity = {
        entry,
        activityKind: value.kind === 'compaction' ? 'compacting' : value.activityKind,
        line: value.kind === 'compaction' ? 'Compacting context' : (value.line ?? 'Working'),
        since,
      };
      if (!selected || preferActivity(candidate, selected)) selected = candidate;
    }
    if (selected) {
      activities.set(key, { kind: selected.activityKind, line: selected.line, since: selected.since });
    } else if (state?.value.state === 'active') {
      activities.set(key, { kind: 'delegating', line: state.value.activity ?? 'Working', since: state.at });
    }
  }
  return activities;
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

function projectEnvironment(
  entries: readonly MonitorStoredEntry[],
  omitted: Partial<Record<MonitorBoundedCollection, number>>,
  unbounded: boolean,
) {
  const environment = familyEntries(entries, 'environment')
    .filter(
      (entry): entry is MonitorStoredEntry & { value: MonitorEnvironmentFamilyValue } =>
        entry.value.kind === 'environment' && (entry.value.actor === undefined || entry.value.actor.role === 'root'),
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
  const actors = childActors(entries);
  const blockerProjection = projectBlockers(entries, actors, unbounded);
  if (blockerProjection.omittedBlockers > 0) omitted.blockers = blockerProjection.omittedBlockers;
  if (blockerProjection.omittedQuestions > 0) omitted.questions = blockerProjection.omittedQuestions;
  if (blockerProjection.omittedQuestionOptions > 0) omitted.questionOptions = blockerProjection.omittedQuestionOptions;
  const children = childActivities(actors, run?.value.alive ?? true, blockerProjection.blockedActorRunKeys);
  const activity = projectActivity(entries, run, children);
  // A runnable child keeps the main run working even if another participant needs input.
  const status: AgentMonitorStatus =
    children.size > 0 ? 'working' : blockerProjection.blockers.length > 0 ? 'blocked' : activity ? 'working' : 'idle';
  const evidenceAsOf = latestTimestamp([
    accumulator.runtime.lastAcceptedAt,
    accumulator.semantic.lastAcceptedAt,
    accumulator.workspace.lastPublicAcceptedAt,
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
  const lastAssistantMessage = projectAssistantMessage(entries);
  const model = projectModel(entries);
  const effort = projectEffort(entries);
  const subagents = projectSubagents(
    actors,
    children,
    usageProjection.actorTotals,
    usageProjection.actorBurnRates,
    usageProjection.actorCosts,
    omitted,
    unbounded,
  );
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
    'delegation',
    'compaction',
    'environment',
    'conversation',
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
    subagentCount: actors.size,
    subagents,
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
      ...(rootToolOpen(entries, run) ? { toolOpen: true } : {}),
      level: accumulator.observationLevel,
      families,
    },
    alive: run?.value.alive ?? true,
  };
  if (options.previous && comparable(options.previous) === comparable(draft)) return options.previous;
  return draft;
}
