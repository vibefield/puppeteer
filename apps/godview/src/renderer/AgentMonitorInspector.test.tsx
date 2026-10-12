import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibefield/puppeteer-core';
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
    subagentCount: 0,
    subagents: [],

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
  it('renders run details and the narrow subagent view', () => {
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
        costUsd: 1.23,
        costRatePerMin: 0.32,
        costCoverage: 'partial',
        burnRatePerMin: 321,
        burnRateWindowMs: 60_000,
        rootActor: { cumulativeTokens: 10_345, burnRatePerMin: 271, costUsd: 1.03, costRatePerMin: 0.27 },
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
      subagentCount: 4,
      subagents: [
        {
          id: 'child-1',
          working: true,
          activity: 'Reviewing runtime code',
          cumulativeTokens: 2_000,
          burnRatePerMin: 50,
          costUsd: 0.2,
          costRatePerMin: 0.05,
          modelId: 'claude-sonnet-5',
          effort: 'medium',
        },
      ],
      compaction: { active: true, count: 2 },
      environment: { cwd: '/project/puppeteer', worktrees: ['/project/worktree-1'] },
      freshness: {
        lastEvidenceAt: OBSERVED_AT,
        level: 'native-hooks',
        families: {
          status: { support: 'supported', availability: 'loading' },
          usage: { support: 'supported', availability: 'available', asOf: OBSERVED_AT },
          context: { support: 'degraded', availability: 'partial', asOf: OBSERVED_AT },
        },
      },
      omitted: { subagents: 3 },
    });
    const markup = renderToStaticMarkup(
      <AgentMonitorInspector state={root} nowMs={Date.parse(OBSERVED_AT)} onAcknowledge={() => undefined} />,
    );
    const content = plainText(markup);

    expect(content).toContain(
      'estimated API USD (this run) $1.23 cost coverage partial run tokens 12,345 60s run burn/min $0.32/min context 67.5% model Opus 5 (configured Sonnet 5) effort high (configured)',
    );
    expect(content).toContain(
      'execution native-tui session mode plan (configured) permission Accept Edits (configured manual) observation native-hooks',
    );
    expect(content).toContain('Database Choose a database SQLite Local and simple');
    expect(content).toContain('permission · Bash');
    expect(content).toContain('failure · crash ACKNOWLEDGE');
    expect(content).not.toContain('Plan & tasks');
    expect(content).not.toContain('No plan observed');
    expect(content).toContain('run total · blocked ~$1.23 · $0.32/min');
    expect(content).toContain('root agent ~$1.03 · $0.27/min');
    expect(content).toContain(
      'child-1 · working · Reviewing runtime code ~$0.20 · $0.05/min · claude-sonnet-5 · effort medium',
    );
    expect(content).toContain('Subagents · 4');
    expect(content).not.toContain('Workflows');
    expect(content).not.toContain('READ workflow');
    expect(content).toContain('compaction active · 2 cwd /project/puppeteer worktrees /project/worktree-1');
    expect(content).toContain('status loading');
    expect(content).toContain('context partial');
    expect(content).toContain('subagents: 3 omitted');
  });

  it('keeps unavailable usage unknown instead of presenting zero', () => {
    const empty = monitorState('run-empty');
    const content = plainText(
      renderToStaticMarkup(
        <AgentMonitorInspector state={empty} nowMs={Date.parse(OBSERVED_AT)} onAcknowledge={() => undefined} />,
      ),
    );

    expect(content).toContain('run total · idle usage unavailable');
    expect(content).not.toContain('0 tokens');
  });
});
