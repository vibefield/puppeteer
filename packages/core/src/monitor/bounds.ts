import type { MonitorBoundedCollection } from './types.js';

/** Hard public-state caps from RFC-001's implementation plan. */
export const AGENT_MONITOR_COLLECTION_LIMITS: Readonly<Record<MonitorBoundedCollection, number>> = Object.freeze({
  blockers: 64,
  usageSamples: 256,
  planSteps: 256,
  tasks: 512,
  subagents: 256,
  teammates: 256,
  workflows: 128,
  artifactRefs: 32,
  workflowActorRunKeys: 256,
  worktrees: 256,
  questions: 64,
  questionOptions: 128,
});

export interface BoundedMonitorCollection<T> {
  values: T[];
  omitted: number;
}

/**
 * Applies the public cap after a projector has put values in canonical order.
 * Keeping ordering and bounding separate lets source order remain meaningful
 * for plans/questions while entity collections use identity-based ordering.
 */
export function boundMonitorCollection<T>(
  collection: MonitorBoundedCollection,
  values: readonly T[],
): BoundedMonitorCollection<T> {
  const limit = AGENT_MONITOR_COLLECTION_LIMITS[collection];
  return {
    values: values.slice(0, limit),
    omitted: Math.max(0, values.length - limit),
  };
}
