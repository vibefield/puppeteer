import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibecook/chopsticks-core';
import { AgentMonitorInspector } from './AgentMonitorInspector.js';

const OBSERVED_AT = '2026-08-17T00:00:00.000Z';

function monitorState(runtimeRunId: string, overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId,
    runtimeEpoch: 1,
    revision: 1,
    status: 'idle',
    statusSince: OBSERVED_AT,
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    tasks: [],
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: OBSERVED_AT, level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

function plainText(markup: string): string {
  return markup
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('AgentMonitorInspector', () => {
  it('renders the complete fleet-observation checklist from monitor state', () => {
    const root = monitorState('run-root', {
      status: 'blocked',
      alive: false,
      blockers: [
        {
          id: 'question-1',
          kind: 'question',
          since: OBSERVED_AT,
          questions: [
            {
              header: 'Database',
              prompt: 'Choose a database',
              options: [{ label: 'SQLite', description: 'Local and simple' }],
              allowFreeForm: true,
            },
          ],
        },
        {
          id: 'permission-1',
          kind: 'permission',
          since: OBSERVED_AT,
          permission: { requestId: 'permission-1', tool: 'Bash' },
        },
        {
          id: 'failure-1',
          kind: 'failure',
          since: OBSERVED_AT,
          failure: { code: 'crash' },
        },
      ],
      usage: {
        cumulativeTokens: 12_345,
        burnRatePerMin: 321,
        burnRateWindowMs: 60_000,
        rootActor: { cumulativeTokens: 10_345, burnRatePerMin: 271 },
        samples: [],
      },
      context: { usedPercent: 67.5, percentageSource: 'provider', asOf: OBSERVED_AT },
      model: {
        id: 'claude-opus-5',
        displayName: 'Opus 5',
        configured: { id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
        intent: 'observed',
        asOf: OBSERVED_AT,
      },
      effort: { value: 'high', configured: 'high', intent: 'configured', asOf: OBSERVED_AT },
      modes: {
        execution: 'native-tui',
        providerSession: { raw: 'plan', configured: { raw: 'plan' }, intent: 'configured' },
        providerPermission: {
          raw: 'acceptEdits',
          normalized: 'Accept Edits',
          configured: { raw: 'manual' },
          intent: 'observed',
        },
      },
      plan: { updatedAt: OBSERVED_AT, steps: [{ text: 'Implement monitor', status: 'in_progress' }] },
      tasks: [{ id: 'task-1', description: 'Verify adapter', status: 'working' }],
      subagents: [
        {
          id: 'child-1',
          actorRunKey: 'actor-child-1',
          type: 'reviewer',
          active: true,
          activity: 'Reviewing runtime code',
          cumulativeTokens: 2_000,
          burnRatePerMin: 50,
          contextPercent: 20,
          modelId: 'claude-sonnet-5',
          modelIntent: 'observed',
          effort: 'medium',
          effortIntent: 'observed',
        },
      ],
      team: {
        id: 'team-1',
        name: 'Runtime team',
        teammates: [
          { id: 'member-1', name: 'Peer', runtimeRunId: 'run-peer', idle: true },
          {
            id: 'member-2',
            name: 'Local reviewer',
            actorRunKey: 'actor-child-1',
            idle: false,
            activity: 'Reviewing runtime code',
            cumulativeTokens: 2_000,
            burnRatePerMin: 50,
            contextPercent: 20,
            modelId: 'claude-sonnet-5',
            modelIntent: 'observed',
            effort: 'medium',
            effortIntent: 'observed',
          },
        ],
      },
      workflows: [
        {
          id: 'workflow-1',
          name: 'Observation audit',
          active: true,
          actorRunKeys: ['actor-child-1'],
          artifactRefs: [
            {
              artifactId: 'opaque:workflow-1',
              family: 'workflow-definition',
              availability: 'readable',
            },
          ],
        },
      ],
      compaction: { active: true, count: 2 },
      environment: { cwd: '/project/chopsticks', worktrees: ['/project/worktree-1'] },
      freshness: {
        lastEvidenceAt: OBSERVED_AT,
        level: 'native-hooks',
        families: {
          status: { support: 'supported', availability: 'loading' },
          usage: { support: 'supported', availability: 'available', asOf: OBSERVED_AT },
          context: { support: 'degraded', availability: 'partial', asOf: OBSERVED_AT },
          workflow: { support: 'unsupported', availability: 'unavailable' },
        },
      },
      omitted: { tasks: 3 },
    });
    const peer = monitorState('run-peer', {
      status: 'working',
      activity: { kind: 'tool', line: 'Running peer tests', since: OBSERVED_AT },
      usage: { cumulativeTokens: 100, burnRatePerMin: 2, samples: [] },
      context: { usedPercent: 10, percentageSource: 'provider', asOf: OBSERVED_AT },
      model: { id: 'claude-haiku-5', displayName: 'Haiku 5', asOf: OBSERVED_AT },
      effort: { value: 'low', asOf: OBSERVED_AT },
      team: { id: 'team-1', teammates: [] },
    });

    const markup = renderToStaticMarkup(
      <AgentMonitorInspector state={root} allStates={[root, peer]} nowMs={Date.parse(OBSERVED_AT)} />,
    );
    const content = plainText(markup);

    expect(content).toContain(
      'run tokens 12,345 60s run burn/min 321 context 67.5% model Opus 5 (configured Sonnet 5) effort high (configured)',
    );
    expect(content).toContain(
      'execution native-tui session mode plan (configured) permission Accept Edits (configured manual) observation native-hooks',
    );
    expect(content).toContain('Database Choose a database SQLite Local and simple');
    expect(content).toContain('permission · Bash');
    expect(content).toContain('failure · crash ACKNOWLEDGE');
    expect(content).toContain('Implement monitor in_progress Verify adapter working');
    expect(content).toContain('run total · blocked 12,345 tokens · 321 tok/min');
    expect(content).toContain('root agent 10,345 tokens · 271 tok/min');
    expect(content).toContain(
      'reviewer · active · Reviewing runtime code 2,000 tokens · 50 tok/min · 20% ctx · claude-sonnet-5 · effort medium',
    );
    expect(content).toContain('Runtime team 2 runs · 12,445 tokens · 323 tok/min');
    expect(content).toContain('Peer Running peer tests · 100 tokens · 2 tok/min · 10% ctx · Haiku 5 · effort low');
    expect(content).toContain(
      'Local reviewer active · Reviewing runtime code · 2,000 tokens · 50 tok/min · 20% ctx · claude-sonnet-5 · effort medium',
    );
    expect(content).toContain('Observation audit · active actor-child-1 READ workflow-definition');
    expect(content).toContain('compaction active · 2 cwd /project/chopsticks worktrees /project/worktree-1');
    expect(content).toContain('status loading');
    expect(content).toContain('context partial');
    expect(content).toContain('workflow unsupported');
    expect(content).toContain('tasks: 3 omitted');
  });

  it('keeps unavailable usage unknown instead of presenting zero', () => {
    const empty = monitorState('run-empty');
    const content = plainText(
      renderToStaticMarkup(<AgentMonitorInspector state={empty} allStates={[empty]} nowMs={Date.parse(OBSERVED_AT)} />),
    );

    expect(content).toContain('run total · idle usage unavailable');
    expect(content).not.toContain('0 tokens');
  });
});
