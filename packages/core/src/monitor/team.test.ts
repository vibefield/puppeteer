import { describe, expect, it } from 'vitest';
import type { AgentMonitorState, AgentMonitorStatus } from './types.js';
import { aggregateAffiliatedAgentMonitorTeam, aggregateAgentMonitorTeam } from './team.js';

function state(
  runtimeRunId: string,
  status: AgentMonitorStatus,
  options: {
    epoch?: number;
    revision?: number;
    cumulativeTokens?: number;
    burnRatePerMin?: number;
    alive?: boolean;
  } = {},
): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeRunId,
    runtimeEpoch: options.epoch ?? 1,
    revision: options.revision ?? 1,
    status,
    statusSince: '2026-08-16T12:00:00.000Z',
    blockers: [],
    usage: {
      ...(options.cumulativeTokens !== undefined ? { cumulativeTokens: options.cumulativeTokens } : {}),
      ...(options.burnRatePerMin !== undefined ? { burnRatePerMin: options.burnRatePerMin } : {}),
      samples: [],
    },
    modes: { execution: 'native-tui' },
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {} },
    alive: options.alive ?? true,
  };
}

describe('aggregateAgentMonitorTeam', () => {
  it('deduplicates runs at their newest epoch/revision and applies status priority', () => {
    const aggregate = aggregateAgentMonitorTeam([
      state('run-b', 'working', { cumulativeTokens: 20, burnRatePerMin: 2 }),
      state('run-a', 'idle', { revision: 1, cumulativeTokens: 10, burnRatePerMin: 1 }),
      state('run-a', 'blocked', { revision: 2, cumulativeTokens: 15, burnRatePerMin: 3 }),
    ]);
    expect(aggregate).toMatchObject({
      runtimeRunIds: ['run-a', 'run-b'],
      status: 'blocked',
      statusCounts: { idle: 0, working: 1, blocked: 1 },
      aliveRuns: 2,
      totalRuns: 2,
      usage: {
        cumulativeTokens: 35,
        burnRatePerMin: 5,
        cumulativeObservedRuns: 2,
        burnRateObservedRuns: 2,
        cumulativeComplete: true,
        burnRateComplete: true,
      },
    });
  });

  it('does not turn unknown usage into zero or claim a complete sum', () => {
    const aggregate = aggregateAgentMonitorTeam([
      state('run-a', 'idle', { cumulativeTokens: 0 }),
      state('run-b', 'idle'),
    ]);
    expect(aggregate.usage).toEqual({
      cumulativeTokens: 0,
      cumulativeObservedRuns: 1,
      burnRateObservedRuns: 0,
      totalRuns: 2,
      cumulativeComplete: false,
      burnRateComplete: false,
    });
  });

  it('represents an empty team without manufacturing idle or zero usage', () => {
    expect(aggregateAgentMonitorTeam([])).toEqual({
      runtimeRunIds: [],
      status: undefined,
      statusCounts: { idle: 0, working: 0, blocked: 0 },
      aliveRuns: 0,
      totalRuns: 0,
      usage: {
        cumulativeObservedRuns: 0,
        burnRateObservedRuns: 0,
        totalRuns: 0,
        cumulativeComplete: false,
        burnRateComplete: false,
      },
    });
  });
});

describe('aggregateAffiliatedAgentMonitorTeam', () => {
  it('includes stable team peers exactly once and excludes unrelated runs', () => {
    const root = {
      ...state('run-root', 'working', { cumulativeTokens: 100, burnRatePerMin: 10 }),
      team: {
        id: 'team-1',
        teammates: [{ id: 'member-1', runtimeRunId: 'run-member' }],
      },
    };
    const member = {
      ...state('run-member', 'blocked', { cumulativeTokens: 20, burnRatePerMin: 2 }),
      team: { id: 'team-1', teammates: [] },
    };
    const latePeer = {
      ...state('run-late', 'idle', { cumulativeTokens: 5, burnRatePerMin: 1 }),
      team: { id: 'team-1', teammates: [] },
    };
    const aggregate = aggregateAffiliatedAgentMonitorTeam(root, [
      root,
      member,
      state('run-unrelated', 'blocked', { cumulativeTokens: 999 }),
      latePeer,
      state('run-member', 'idle', { revision: 0, cumulativeTokens: 1 }),
      state('run-root', 'idle', { revision: 0, cumulativeTokens: 1 }),
    ]);
    expect(aggregate).toMatchObject({
      runtimeRunIds: ['run-late', 'run-member', 'run-root'],
      status: 'blocked',
      totalRuns: 3,
      usage: { cumulativeTokens: 125, burnRatePerMin: 13 },
    });
  });
});
