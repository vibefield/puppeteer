/**
 * A replica for tests: the model a view would receive, driven by hand.
 *
 * It keeps the replica's promises (MV-D21, M2): an unchanged agent keeps its
 * object, an unchanged model keeps its object, the spawn menu keeps its object
 * until a write carries a new one, and a write that changes nothing notifies no
 * one. Given a scheduler it notifies at most once per frame through it, as the
 * real replica does (M7: pass the slot's own); without one it notifies at once.
 */

import {
  compareMonitorRows,
  type AgentView,
  type FrameScheduler,
  type ModelChanges,
  type MonitorAgentRow,
  type MonitorModel,
  type MonitorModelSnapshot,
  type MonitorSpawnMenu,
} from '../model.js';
import { diffModels, NO_CHANGES } from '../internal/input.js';
import { fixtureModel, toAgentView } from './fixtures.js';

/** Backend rows are joined with what only a window knows; `AgentView`s are taken as they are. */
export type FixtureRow = AgentView | MonitorAgentRow;

export type FixtureReplicaSource =
  | readonly FixtureRow[]
  | MonitorModelSnapshot
  | { readonly model: MonitorModel; readonly spawn?: MonitorSpawnMenu | undefined };

export interface FixtureReplicaOptions {
  /** Batches notifications into frames, as the real replica does. Absent: every write notifies at once. */
  readonly scheduler?: FrameScheduler | undefined;
}

export interface FixtureReplicaSnapshot {
  readonly model: MonitorModel;
  /** What moved between the last two notifications. */
  readonly changes: ModelChanges;
  readonly spawn?: MonitorSpawnMenu | undefined;
}

export interface FixtureReplica {
  getSnapshot(): FixtureReplicaSnapshot;
  subscribe(onChange: () => void): () => void;
  /** Replaces every row. The same row object as before keeps its `AgentView`. */
  set(rows: readonly FixtureRow[]): void;
  /** Upserts rows by id and removes ids, keeping every other row as it was. `spawn`, when given, replaces the menu. */
  apply(change: {
    readonly upsert?: readonly FixtureRow[];
    readonly remove?: readonly string[];
    readonly spawn?: MonitorSpawnMenu | undefined;
  }): void;
  setSpawn(spawn: MonitorSpawnMenu | undefined): void;
  /** How many times subscribers were told. */
  readonly notifications: number;
  readonly subscribers: number;
}

function isSnapshot(source: FixtureReplicaSource): source is MonitorModelSnapshot {
  return !Array.isArray(source) && 'rows' in source;
}

function isModelSource(
  source: FixtureReplicaSource,
): source is { readonly model: MonitorModel; readonly spawn?: MonitorSpawnMenu | undefined } {
  return !Array.isArray(source) && 'model' in source;
}

export function createFixtureReplica(
  source: FixtureReplicaSource = [],
  options: FixtureReplicaOptions = {},
): FixtureReplica {
  const joined = new WeakMap<FixtureRow, AgentView>();
  const join = (row: FixtureRow): AgentView => {
    let view = joined.get(row);
    if (view === undefined) {
      view = toAgentView(row);
      joined.set(row, view);
    }
    return view;
  };
  const order = (rows: readonly FixtureRow[]): AgentView[] => rows.map(join).sort(compareMonitorRows);

  let model: MonitorModel;
  let spawn: MonitorSpawnMenu | undefined;
  if (isModelSource(source)) {
    model = source.model;
    spawn = source.spawn;
  } else if (isSnapshot(source)) {
    model = fixtureModel(order(source.rows), source.revision);
    spawn = source.spawn;
  } else {
    model = fixtureModel(order(source), 1);
  }
  let notified = model;
  let changes: ModelChanges = NO_CHANGES;
  let dirty = false;
  let notifications = 0;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    if (!dirty) return;
    dirty = false;
    changes = diffModels(notified, model);
    notified = model;
    notifications += 1;
    for (const listener of [...listeners]) listener();
  };
  const changed = (): void => {
    dirty = true;
    if (options.scheduler) options.scheduler.request(notify);
    else notify();
  };

  const publish = (agents: AgentView[], nextSpawn: MonitorSpawnMenu | undefined): void => {
    const sameAgents =
      agents.length === model.agents.length && agents.every((agent, index) => agent === model.agents[index]);
    if (sameAgents && nextSpawn === spawn) return;
    if (!sameAgents) model = fixtureModel(agents, model.revision + 1);
    spawn = nextSpawn;
    changed();
  };

  return {
    getSnapshot: () => ({ model, changes, ...(spawn !== undefined ? { spawn } : {}) }),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    set(rows) {
      publish(order(rows), spawn);
    },
    apply(change) {
      const byId = new Map<string, FixtureRow>(model.agents.map((agent) => [agent.id, agent]));
      for (const id of change.remove ?? []) byId.delete(id);
      for (const row of change.upsert ?? []) byId.set(row.id, row);
      publish(order([...byId.values()]), Object.hasOwn(change, 'spawn') ? change.spawn : spawn);
    },
    setSpawn(next) {
      publish([...model.agents], next);
    },
    get notifications() {
      return notifications;
    },
    get subscribers() {
      return listeners.size;
    },
  };
}
