/**
 * A replica for tests: the model a view would receive, driven by hand.
 *
 * It keeps the replica's promises (MV-D21): an unchanged agent keeps its
 * object, an unchanged model keeps its object, and a write that changes
 * nothing notifies no one. It notifies synchronously, so a test decides when a
 * frame happens through the slot's scheduler, never through this.
 */

import { compareMonitorRows, type MonitorAgentRow, type MonitorModelSnapshot } from '../model.js';
import { diffModels, NO_CHANGES } from '../internal/input.js';
import type { AgentView, ModelChanges, MonitorModel } from '../view.js';
import { fixtureModel, toAgentView } from './fixtures.js';

/** Backend rows are joined with what only a window knows; `AgentView`s are taken as they are. */
export type FixtureRow = AgentView | MonitorAgentRow;

export type FixtureReplicaSource = readonly FixtureRow[] | MonitorModelSnapshot | { readonly model: MonitorModel };

export interface FixtureReplica {
  getSnapshot(): { readonly model: MonitorModel; readonly changes: ModelChanges };
  subscribe(onChange: () => void): () => void;
  /** Replaces every row. The same row object as before keeps its `AgentView`. */
  set(rows: readonly FixtureRow[]): void;
  /** Upserts rows by id and removes ids, keeping every other row as it was. */
  apply(change: { readonly upsert?: readonly FixtureRow[]; readonly remove?: readonly string[] }): void;
  /** How many times subscribers were told. */
  readonly notifications: number;
  readonly subscribers: number;
}

function isSnapshot(source: FixtureReplicaSource): source is MonitorModelSnapshot {
  return !Array.isArray(source) && 'rows' in source;
}

function isModelSource(source: FixtureReplicaSource): source is { readonly model: MonitorModel } {
  return !Array.isArray(source) && 'model' in source;
}

export function createFixtureReplica(source: FixtureReplicaSource = []): FixtureReplica {
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
  if (isModelSource(source)) model = source.model;
  else if (isSnapshot(source)) model = fixtureModel(order(source.rows), source.revision);
  else model = fixtureModel(order(source), 1);
  let changes: ModelChanges = NO_CHANGES;
  let notifications = 0;
  const listeners = new Set<() => void>();

  const publish = (agents: AgentView[]): void => {
    const same = agents.length === model.agents.length && agents.every((agent, index) => agent === model.agents[index]);
    if (same) return;
    const next = fixtureModel(agents, model.revision + 1);
    changes = diffModels(model, next);
    model = next;
    notifications += 1;
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => ({ model, changes }),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    set(rows) {
      publish(order(rows));
    },
    apply({ upsert = [], remove = [] }) {
      const byId = new Map<string, FixtureRow>(model.agents.map((agent) => [agent.id, agent]));
      for (const id of remove) byId.delete(id);
      for (const row of upsert) byId.set(row.id, row);
      publish(order([...byId.values()]));
    },
    get notifications() {
      return notifications;
    },
    get subscribers() {
      return listeners.size;
    },
  };
}
