import { describe, expect, it } from 'vitest';
import {
  AGENT_MONITOR_SCHEMA_VERSION,
  type AgentMonitorState,
  type AgentMonitorStatus,
  type MonitorArtifactReadResult,
  type RuntimeRunRef,
} from './types.js';

function stateFixture(): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeEpoch: 2,
    revision: 9,
    runtimeRunId: 'run-1',
    status: 'blocked',
    statusSince: '2026-08-16T12:00:00.000Z',
    blockers: [
      {
        id: 'question-1',
        kind: 'question',
        since: '2026-08-16T12:00:00.000Z',
        questions: [
          {
            prompt: 'Choose a database',
            options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'Shared server' }],
            allowFreeForm: true,
          },
        ],
      },
    ],
    usage: {
      cumulativeTokens: 12_345,
      burnRatePerMin: 321,
      burnRateWindowMs: 60_000,
      burnRateBoundary: 'mixed',
      samples: [{ at: '2026-08-16T11:59:45.000Z', cumulativeTokens: 12_000 }],
      asOf: '2026-08-16T12:00:00.000Z',
    },
    context: {
      usedTokens: 40_000,
      capacityTokens: 200_000,
      usedPercent: 20,
      percentageSource: 'provider',
      asOf: '2026-08-16T12:00:00.000Z',
    },
    model: {
      id: 'model-card-v2',
      displayName: 'Model Card V2',
      configured: { id: 'model-alias-v1', displayName: 'Model Alias V1' },
      intent: 'observed',
      asOf: '2026-08-16T12:00:00.000Z',
    },
    effort: { value: 'future-ultra', configured: 'high', asOf: '2026-08-16T12:00:00.000Z' },
    modes: {
      execution: 'native-tui',
      providerSession: {
        raw: 'future-auto',
        normalized: 'auto',
        configured: { raw: 'manual' },
        intent: 'observed',
      },
      providerPermission: { raw: 'accept-edits', configured: { raw: 'manual' }, intent: 'observed' },
      asOf: '2026-08-16T12:00:00.000Z',
    },
    subagents: [
      {
        id: 'child-1',
        actorRunKey: 'actor-child-1',
        active: true,
        cumulativeTokens: 300,
        modelId: 'model-card-v2',
        modelIntent: 'observed',
        effort: 'high',
        effortIntent: 'observed',
      },
    ],
    team: {
      id: 'team-1',
      teammates: [
        {
          id: 'member-1',
          actorRunKey: 'actor-child-1',
          runtimeRunId: 'run-2',
          idle: false,
          activity: 'Reviewing changes',
          cumulativeTokens: 300,
          burnRatePerMin: 25,
          contextPercent: 40,
          modelId: 'model-card-v2',
          modelIntent: 'observed',
          effort: 'high',
          effortIntent: 'observed',
          activityProvisional: true,
        },
      ],
      provisional: true,
    },
    workflows: [
      {
        id: 'workflow-1',
        active: true,
        actorRunKeys: ['actor-child-1'],
        artifactRefs: [
          {
            artifactId: 'artifact-1',
            family: 'workflow-definition',
            mediaType: 'text/markdown',
            availability: 'readable',
          },
        ],
      },
    ],
    omitted: { questionOptions: 2 },
    compaction: { active: false, count: 1, lastAt: '2026-08-16T11:30:00.000Z' },
    environment: { cwd: '/repo', git: null, worktrees: ['/repo-worktree'] },
    session: { nativeSessionId: 'native-1', startedAt: '2026-08-16T11:00:00.000Z' },
    freshness: {
      lastEvidenceAt: '2026-08-16T12:00:00.000Z',
      level: 'native-hooks',
      families: {
        usage: { support: 'supported', asOf: '2026-08-16T12:00:00.000Z' },
        workflow: { support: 'degraded', asOf: '2026-08-16T11:59:00.000Z' },
      },
    },
    alive: true,
  };
}

describe('AgentMonitorState contract', () => {
  it('round-trips as a JSON-plain full replacement', () => {
    const state = stateFixture();
    expect(structuredClone(state)).toEqual(state);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('keeps provider vocabularies open and configured intent separate from observed state', () => {
    const state = stateFixture();
    expect(state.effort?.value).toBe('future-ultra');
    expect(state.model).toMatchObject({
      id: 'model-card-v2',
      configured: { id: 'model-alias-v1' },
      intent: 'observed',
    });
    expect(state.modes.providerSession?.raw).toBe('future-auto');
    expect(state.modes.providerSession?.configured?.raw).toBe('manual');
  });

  it('keeps runtime, terminal, and native identities distinct', () => {
    const ref: RuntimeRunRef = {
      runtimeRunId: 'run-1',
      runtimeEpoch: 1,
      providerId: 'claude',
      executionMode: 'native-tui',
      terminalSessionId: 'terminal-1',
      nativeSession: { namespace: 'claude', id: 'native-1', basis: 'observed', quality: 'exact' },
      externalRefs: [{ namespace: 'vibefield', kind: 'project', id: 'project-1' }],
    };
    expect(new Set([ref.runtimeRunId, ref.terminalSessionId, ref.nativeSession?.id]).size).toBe(3);
  });

  it('represents bounded artifact reads without exposing a path', () => {
    const result: MonitorArtifactReadResult = {
      status: 'ok',
      artifact: {
        artifactId: 'artifact-1',
        family: 'workflow-definition',
        mediaType: 'text/plain',
        availability: 'readable',
      },
      encoding: 'utf8',
      content: 'name: workflow',
    };
    expect(result.artifact).not.toHaveProperty('path');
  });

  it('has exactly the three product status values at the type boundary', () => {
    const statuses = ['idle', 'working', 'blocked'] satisfies AgentMonitorStatus[];
    expect(statuses).toEqual(['idle', 'working', 'blocked']);
    if (false) {
      // @ts-expect-error waiting is deliberately not a fourth product status
      const invalid: AgentMonitorStatus = 'waiting';
      void invalid;
    }
  });
});
