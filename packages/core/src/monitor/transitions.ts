import type {
  AgentMonitorState,
  AgentMonitorStatus,
  ActorRunRef,
  MonitorActivity,
  MonitorActivityKind,
  MonitorBlocker,
  MonitorBoundedCollection,
  MonitorCompactionState,
  MonitorMetricFamily,
} from './types.js';
import type {
  MonitorAccumulatorState,
  MonitorActorFamilyValue,
  MonitorCompactionFamilyValue,
  MonitorEnvironmentFamilyValue,
  MonitorInteractionObservation,
  MonitorRunStatusObservation,
  MonitorStoredEntry,
} from './internal-types.js';
import { boundMonitorCollection } from './bounds.js';
import { actorOf, compareEntryPreference, planePriority, selectClaims, time } from './selection.js';

// The transitions view: what an accepted input can change that a consumer must hear of at once, and what every
// notification compares. It reads the selected claims of every family but usage, so its cost is the planes', never
// the usage ledger's. The full projection composes the same basis, so the two paths share one status rule. Both
// are memoized per accumulator object; the reducer and the runtime replace the accumulator, never mutate it.

/** The facts transitions compare, as the published state would show them. */
export interface MonitorTransitions {
  status: AgentMonitorStatus;
  /** Bounded exactly as the published state bounds them. */
  blockers: MonitorBlocker[];
  activity?: MonitorActivity | undefined;
  compaction: MonitorCompactionState;
  /** The root's cwd, and every worktree (unbounded, sorted). */
  environment: { cwd?: string | undefined; worktrees: string[] };
  alive: boolean;
  nativeSessionId?: string | undefined;
  /** A root tool call is open, whatever the headline activity. */
  toolOpen: boolean;
}

export interface BlockerProjection {
  blockers: MonitorBlocker[];
  blockedActorRunKeys: Set<string>;
  omittedBlockers: number;
  omittedQuestions: number;
  omittedQuestionOptions: number;
}

/** What every projection of one accumulator reads from its selected claims but usage's, derived once. */
export interface MonitorTransitionBasis {
  /** One current claim for every family/key identity but usage's (the usage index selects those per ledger). */
  entries: MonitorStoredEntry[];
  alive: boolean;
  /** The children the planes' claims name; the usage index adds those only usage names. */
  actors: Map<string, ChildActor>;
  /** Bounded as published. */
  blockers: BlockerProjection;
  children: Map<string, MonitorActivity>;
  activity: MonitorActivity | undefined;
  status: AgentMonitorStatus;
  compaction: MonitorCompactionState;
  /** The root's environment with every worktree, sorted; a projection bounds the worktrees it publishes. */
  environment: { cwd: string | undefined; git: AgentMonitorState['environment']['git']; worktrees: string[] };
  nativeSessionId: string | undefined;
  toolOpen: boolean;
}

const BLOCKER_PRIORITY = { failure: 0, question: 1, permission: 2 } as const;

/** The planes' claims of every family but usage, whose ledger the usage index reads. */
function planeEntries(state: MonitorAccumulatorState): MonitorStoredEntry[] {
  return [...state.runtime.entries.values(), ...state.semantic.entries.values(), ...state.workspace.entries.values()];
}

export function familyEntries(
  entries: readonly MonitorStoredEntry[],
  family: MonitorMetricFamily,
): MonitorStoredEntry[] {
  return entries.filter((entry) => entry.family === family);
}

export function maybeBound<T>(
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
  alive: boolean,
): BlockerProjection {
  const blockers: MonitorBlocker[] = [];
  let omittedQuestions = 0;
  let omittedQuestionOptions = 0;

  for (const entry of familyEntries(entries, 'status')) {
    const since = entry.effectiveAt ?? entry.observedAt;
    if (entry.value.kind === 'interaction' && entry.value.state === 'pending') {
      // Nobody can answer a dead run, so only its failures block it. The prompt stays evidence, not a blocker.
      if (!alive) continue;
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
  // Only a run with no process yet is starting. Once the host runs the process (`starting`), waiting for the
  // provider's session evidence is readiness, not work: an agent with no turn yet is idle (RFC 001).
  if (run && ['allocated', 'preparing'].includes(run.value.lifecycle)) {
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

export interface ChildActor {
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

/** The root's cwd, Git state and worktrees, folded from its environment claims, oldest first. */
function environmentOf(entries: readonly MonitorStoredEntry[]): MonitorTransitionBasis['environment'] {
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
  return { cwd, git, worktrees };
}

function basisOf(state: MonitorAccumulatorState): MonitorTransitionBasis {
  const entries = selectClaims(planeEntries(state));
  const run = latestRun(entries);
  const alive = run?.value.alive ?? true;
  const actors = childActors(entries);
  const blockers = projectBlockers(entries, actors, false, alive);
  const children = childActivities(actors, alive, blockers.blockedActorRunKeys);
  const activity = projectActivity(entries, run, children);
  // A runnable child keeps the main run working even if another participant needs input.
  const status: AgentMonitorStatus =
    children.size > 0 ? 'working' : blockers.blockers.length > 0 ? 'blocked' : activity ? 'working' : 'idle';
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
  // Every run claim of the planes, not only the one selection keeps: a semantic run claim names the session first.
  const nativeSessionEntry = familyEntries(planeEntries(state), 'status')
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
  return {
    entries,
    alive,
    actors,
    blockers,
    children,
    activity,
    status,
    compaction: {
      active: activeCompaction,
      ...(provisionalCompaction ? { provisional: true } : {}),
      ...(lastCompaction ? { lastAt: lastCompaction.effectiveAt ?? lastCompaction.observedAt } : {}),
      ...(lastCompaction ? { lastOutcome: lastCompaction.value.outcome ?? ('completed' as const) } : {}),
      count: state.compactionCount,
    },
    environment: environmentOf(entries),
    nativeSessionId: nativeSessionEntry?.value.nativeSession?.id,
    toolOpen: rootToolOpen(entries, run),
  };
}

interface TransitionMemo {
  basis: MonitorTransitionBasis;
  unboundedBlockers?: BlockerProjection;
  view?: MonitorTransitions;
}

const memos = new WeakMap<MonitorAccumulatorState, TransitionMemo>();

function memoOf(state: MonitorAccumulatorState): TransitionMemo {
  let memo = memos.get(state);
  if (!memo) {
    memo = { basis: basisOf(state) };
    memos.set(state, memo);
  }
  return memo;
}

/** The accumulator's transition basis, derived once per accumulator object. */
export function transitionBasis(state: MonitorAccumulatorState): MonitorTransitionBasis {
  return memoOf(state).basis;
}

/** The accumulator's blockers, bounded as published or every one of them. */
export function blockersOf(state: MonitorAccumulatorState, unbounded: boolean): BlockerProjection {
  const memo = memoOf(state);
  if (!unbounded) return memo.basis.blockers;
  memo.unboundedBlockers ??= projectBlockers(memo.basis.entries, memo.basis.actors, true, memo.basis.alive);
  return memo.unboundedBlockers;
}

/**
 * What an accepted input can change that is urgent or notified: status, blockers, activity, compaction, the root's
 * cwd and worktrees, liveness, the native session and an open tool. It never reads the usage ledger or the clock.
 */
export function projectMonitorTransitions(state: MonitorAccumulatorState): MonitorTransitions {
  const memo = memoOf(state);
  if (!memo.view) {
    const { basis } = memo;
    const { cwd, worktrees } = basis.environment;
    memo.view = {
      status: basis.status,
      blockers: basis.blockers.blockers,
      ...(basis.activity ? { activity: basis.activity } : {}),
      compaction: basis.compaction,
      environment: { ...(cwd ? { cwd } : {}), worktrees },
      alive: basis.alive,
      ...(basis.nativeSessionId !== undefined ? { nativeSessionId: basis.nativeSessionId } : {}),
      toolOpen: basis.toolOpen,
    };
  }
  return memo.view;
}
