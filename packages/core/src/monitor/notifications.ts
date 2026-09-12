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

function byId<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const priorSubagents = byId(previous.subagents);
  const nextSubagents = byId(next.subagents);
  for (const subagent of next.subagents) {
    const prior = priorSubagents.get(subagent.id);
    if (provisionalInput) continue;
    if (!prior && !subagent.active) {
      result.push(notification(runtimeRunId, input, 'delegation:subagent-stopped', subagent.id, subagent.type));
    } else if ((!prior || !prior.active) && subagent.active) {
      result.push(notification(runtimeRunId, input, 'delegation:subagent-started', subagent.id, subagent.type));
    } else if (prior?.active && !subagent.active) {
      result.push(notification(runtimeRunId, input, 'delegation:subagent-stopped', subagent.id, subagent.type));
    }
  }
  for (const subagent of previous.subagents) {
    if (!provisionalInput && subagent.active && !nextSubagents.has(subagent.id)) {
      result.push(notification(runtimeRunId, input, 'delegation:subagent-stopped', subagent.id, subagent.type));
    }
  }

  if (!provisionalInput && (!previous.team || (previous.team.provisional && !next.team?.provisional)) && next.team)
    result.push(notification(runtimeRunId, input, 'team.observed', next.team.id ?? 'team', next.team.name));
  const priorMembers = byId(previous.team?.teammates ?? []);
  const nextMembers = byId(next.team?.teammates ?? []);
  for (const member of next.team?.teammates ?? []) {
    const prior = priorMembers.get(member.id);
    if (provisionalInput) continue;
    if (!prior || (prior.provisional && !member.provisional)) {
      result.push(notification(runtimeRunId, input, 'team.member-added', member.id, member.name));
    }
    if (
      member.idle &&
      !member.activityProvisional &&
      (!prior || !prior.idle || (prior.activityProvisional && !member.activityProvisional))
    ) {
      result.push(notification(runtimeRunId, input, 'team.member-idle', member.id, member.name));
    }
  }
  for (const member of previous.team?.teammates ?? []) {
    if (!provisionalInput && !member.provisional && !nextMembers.has(member.id)) {
      result.push(notification(runtimeRunId, input, 'team.member-removed', member.id, member.name));
    }
  }

  const priorWorkflows = byId(previous.workflows);
  for (const workflow of next.workflows) {
    const prior = priorWorkflows.get(workflow.id);
    if (!prior && !workflow.active) {
      result.push(notification(runtimeRunId, input, 'workflow.completed', workflow.id, workflow.name));
    } else if ((!prior || !prior.active) && workflow.active) {
      result.push(notification(runtimeRunId, input, 'workflow.started', workflow.id, workflow.name));
    } else if (prior?.active && !workflow.active) {
      result.push(notification(runtimeRunId, input, 'workflow.completed', workflow.id, workflow.name));
    }
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
