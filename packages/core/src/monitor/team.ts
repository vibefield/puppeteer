import type { AgentMonitorState, AgentMonitorStatus, RuntimeRunId } from './types.js';
import { isNewerMonitorRevision } from './ordering.js';

export interface AgentMonitorTeamUsageAggregate {
  cumulativeTokens?: number;
  burnRatePerMin?: number;
  cumulativeObservedRuns: number;
  burnRateObservedRuns: number;
  totalRuns: number;
  cumulativeComplete: boolean;
  burnRateComplete: boolean;
}

export interface AgentMonitorTeamAggregate {
  runtimeRunIds: RuntimeRunId[];
  status?: AgentMonitorStatus;
  statusCounts: Record<AgentMonitorStatus, number>;
  aliveRuns: number;
  totalRuns: number;
  usage: AgentMonitorTeamUsageAggregate;
}

function metric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Aggregates separate managed teammate runs exactly once. Root usage already
 * includes in-session subagents, so callers must pass run states rather than
 * concatenating their subagent breakdowns.
 */
export function aggregateAgentMonitorTeam(states: readonly AgentMonitorState[]): AgentMonitorTeamAggregate {
  const latestByRun = new Map<RuntimeRunId, AgentMonitorState>();
  for (const state of states) {
    const current = latestByRun.get(state.runtimeRunId);
    if (current === undefined || isNewerMonitorRevision(state, current)) latestByRun.set(state.runtimeRunId, state);
  }

  const members = [...latestByRun.values()].sort((a, b) => a.runtimeRunId.localeCompare(b.runtimeRunId));
  const statusCounts: Record<AgentMonitorStatus, number> = { idle: 0, working: 0, blocked: 0 };
  let aliveRuns = 0;
  let cumulativeTokens = 0;
  let burnRatePerMin = 0;
  let cumulativeObservedRuns = 0;
  let burnRateObservedRuns = 0;

  for (const member of members) {
    statusCounts[member.status] += 1;
    if (member.alive) aliveRuns += 1;
    const cumulative = metric(member.usage.cumulativeTokens);
    if (cumulative !== undefined) {
      cumulativeTokens += cumulative;
      cumulativeObservedRuns += 1;
    }
    const rate = metric(member.usage.burnRatePerMin);
    if (rate !== undefined) {
      burnRatePerMin += rate;
      burnRateObservedRuns += 1;
    }
  }

  const totalRuns = members.length;
  const status: AgentMonitorStatus | undefined =
    totalRuns === 0 ? undefined : statusCounts.blocked > 0 ? 'blocked' : statusCounts.working > 0 ? 'working' : 'idle';

  return {
    runtimeRunIds: members.map((member) => member.runtimeRunId),
    status,
    statusCounts,
    aliveRuns,
    totalRuns,
    usage: {
      ...(cumulativeObservedRuns > 0 ? { cumulativeTokens } : {}),
      ...(burnRateObservedRuns > 0 ? { burnRatePerMin } : {}),
      cumulativeObservedRuns,
      burnRateObservedRuns,
      totalRuns,
      cumulativeComplete: totalRuns > 0 && cumulativeObservedRuns === totalRuns,
      burnRateComplete: totalRuns > 0 && burnRateObservedRuns === totalRuns,
    },
  };
}

/**
 * Selects a root run plus explicitly referenced or stable-team-id peers, then
 * delegates all revision deduplication and usage math to the shared aggregate.
 * Child rows are intentionally never inputs because root usage already
 * includes in-session subagents.
 */
export function aggregateAffiliatedAgentMonitorTeam(
  root: AgentMonitorState,
  states: readonly AgentMonitorState[],
): AgentMonitorTeamAggregate {
  const runtimeRunIds = new Set<RuntimeRunId>([root.runtimeRunId]);
  for (const teammate of root.team?.teammates ?? []) {
    if (teammate.runtimeRunId) runtimeRunIds.add(teammate.runtimeRunId);
  }
  const teamId = root.team?.id;
  const members = states.filter(
    (state) => runtimeRunIds.has(state.runtimeRunId) || (teamId !== undefined && state.team?.id === teamId),
  );
  // Always include the caller's root revision; the aggregate will deduplicate
  // it against any older snapshot present in the surrounding state list.
  members.push(root);
  return aggregateAgentMonitorTeam(members);
}
