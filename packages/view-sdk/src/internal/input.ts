/**
 * Identity helpers shared by the adapter, the view host and the testing kit.
 *
 * MV-D21 makes identity part of the contract: an unchanged agent keeps its
 * object, an unchanged model keeps its object, and so does every other part of
 * the input. These helpers are the one reading of that rule, so the adapter's
 * memo, the host's gate and the fixtures can never disagree about it.
 */

import type { ModelChanges, MonitorModel } from '../model.js';
import type { MonitorViewInput } from '../view.js';

const NONE: readonly string[] = Object.freeze([]);

/** No agent moved. One object, so an input whose model did not change keeps its `changes` too. */
export const NO_CHANGES: ModelChanges = Object.freeze({ added: NONE, updated: NONE, removed: NONE });

/** True when every part of two inputs is the same object. */
export function sameInputParts(a: MonitorViewInput, b: MonitorViewInput): boolean {
  return (
    a === b ||
    (a.model === b.model &&
      a.changes === b.changes &&
      a.stage === b.stage &&
      a.theme === b.theme &&
      a.parameters === b.parameters &&
      a.capabilities === b.capabilities)
  );
}

/** Every agent of a model, as news to a view that has drawn nothing yet. */
export function allAdded(model: MonitorModel): ModelChanges {
  return model.agents.length === 0
    ? NO_CHANGES
    : Object.freeze({ added: Object.freeze(model.agents.map((agent) => agent.id)), updated: NONE, removed: NONE });
}

/**
 * Which agents moved from one model to the next, by identity: an agent whose
 * object changed was updated. A model that kept every agent's object answers
 * `NO_CHANGES`, whatever else about it moved (its revision, its order).
 */
export function diffModels(previous: MonitorModel | undefined, next: MonitorModel): ModelChanges {
  if (previous === undefined) return allAdded(next);
  if (previous === next) return NO_CHANGES;
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const agent of next.agents) {
    const before = previous.byId.get(agent.id);
    if (before === undefined) added.push(agent.id);
    else if (before !== agent) updated.push(agent.id);
  }
  for (const agent of previous.agents) {
    if (!next.byId.has(agent.id)) removed.push(agent.id);
  }
  if (added.length === 0 && updated.length === 0 && removed.length === 0) return NO_CHANGES;
  return Object.freeze({
    added: added.length === 0 ? NONE : Object.freeze(added),
    updated: updated.length === 0 ? NONE : Object.freeze(updated),
    removed: removed.length === 0 ? NONE : Object.freeze(removed),
  });
}
