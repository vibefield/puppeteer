import type { MonitorAccumulatorInput, MonitorAccumulatorState, MonitorFamilyUpdate } from './internal-types.js';
import type { AgentMonitorState, MonitorNotification, MonitorNotificationType } from './types.js';
import { projectAgentMonitorState } from './project.js';

function inputAt(input: MonitorAccumulatorInput): string {
  return input.kind === 'lease-expired' ? input.expiredAt : input.observedAt;
}

function inputIdentity(input: MonitorAccumulatorInput): string {
  switch (input.kind) {
    case 'runtime':
      return `runtime:${input.eventId}`;
    case 'semantic':
      return `semantic:${input.producer.id}:${input.producer.epoch}:${input.batchId}`;
    case 'workspace':
      return `workspace:${input.recordId}`;
    case 'lease-expired':
      return `lease:${input.leaseId}:${input.expiredAt}`;
  }
}

function updates(input: MonitorAccumulatorInput): readonly MonitorFamilyUpdate[] {
  return input.kind === 'runtime' || input.kind === 'semantic' ? input.updates : [];
}

function suppressesNotifications(input: MonitorAccumulatorInput): boolean {
  if (input.kind === 'lease-expired') return true;
  if (input.kind === 'runtime' && input.phase === 'bootstrap') return true;
  if (input.kind === 'semantic' && input.phase !== 'live') return true;
  return updates(input).some((update) => update.operation === 'replace');
}

function stableId(runtimeRunId: string, input: MonitorAccumulatorInput, type: MonitorNotificationType, key: string) {
  return [runtimeRunId, type, inputIdentity(input), key].map(encodeURIComponent).join(':');
}

function notification(
  runtimeRunId: string,
  input: MonitorAccumulatorInput,
  type: MonitorNotificationType,
  key: string,
  summary?: string,
): MonitorNotification {
  return {
    notificationId: stableId(runtimeRunId, input, type, key),
    runtimeRunId,
    at: inputAt(input),
    type,
    ...(summary ? { summary } : {}),
  };
}

function compareState(
  previous: AgentMonitorState,
  next: AgentMonitorState,
  input: MonitorAccumulatorInput,
): MonitorNotification[] {
  const runtimeRunId = next.runtimeRunId;
  const result: MonitorNotification[] = [];
  const provisionalInput = input.kind !== 'lease-expired' && input.provisional;
  if (previous.status !== 'blocked' && next.status === 'blocked') {
    result.push(notification(runtimeRunId, input, 'blocked.entered', next.blockers[0]?.id ?? 'blocked'));
  }

  if (!provisionalInput && !previous.compaction.active && next.compaction.active) {
    result.push(notification(runtimeRunId, input, 'compaction:started', `compaction:${next.compaction.count}`));
  } else if (
    !provisionalInput &&
    next.compaction.lastOutcome === 'completed' &&
    ((previous.compaction.active && !next.compaction.active) ||
      (!previous.compaction.active &&
        !next.compaction.active &&
        previous.compaction.lastAt !== next.compaction.lastAt &&
        next.compaction.lastAt !== undefined))
  ) {
    result.push(notification(runtimeRunId, input, 'compaction:completed', `compaction:${next.compaction.count}`));
  }

  if (previous.environment.cwd !== next.environment.cwd) {
    result.push(
      notification(runtimeRunId, input, 'cwd.changed', next.environment.cwd ?? 'cleared', next.environment.cwd),
    );
  }
  const priorWorktrees = new Set(previous.environment.worktrees);
  const nextWorktrees = new Set(next.environment.worktrees);
  for (const worktree of next.environment.worktrees) {
    if (!priorWorktrees.has(worktree)) result.push(notification(runtimeRunId, input, 'worktree.created', worktree));
  }
  for (const worktree of previous.environment.worktrees) {
    if (!nextWorktrees.has(worktree)) result.push(notification(runtimeRunId, input, 'worktree.removed', worktree));
  }

  if (previous.alive && !next.alive) {
    result.push(notification(runtimeRunId, input, 'session.ended', next.session.nativeSessionId ?? 'session'));
  }
  return result;
}

/** Stable transition notifications; bootstrap, correction, resync, and replacement stay silent. */
export function deriveMonitorNotifications(
  previous: MonitorAccumulatorState,
  next: MonitorAccumulatorState,
  input: MonitorAccumulatorInput,
): MonitorNotification[] {
  if (suppressesNotifications(input)) return [];
  const at = inputAt(input);
  const previousState = projectAgentMonitorState(previous, { asOf: at, unboundedCollections: true });
  const nextState = projectAgentMonitorState(next, {
    previous: previousState,
    asOf: at,
    unboundedCollections: true,
  });
  if (nextState === previousState) return [];
  return compareState(previousState, nextState, input);
}
