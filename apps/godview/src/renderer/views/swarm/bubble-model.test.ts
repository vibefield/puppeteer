import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../../../protocol.js';
import type { MonitorAgent, MonitorAgentFacet } from '../../monitor/types.js';
import { USAGE_STEP_COUNT, USAGE_STEP_MS, type UsageHistory } from '../../monitor/usage-ledger.js';
import { bubbleModel, formatTokens, workingShares } from './bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';

/** A ledger history with the given total and a burn on both sides, its newest step the tallest. */
function usageHistory(total: number): UsageHistory {
  const steps = Array.from({ length: USAGE_STEP_COUNT }, (_, index) => (index + 1) * 100);
  return {
    total,
    steps,
    sides: { output: steps.map((step) => step / 4), input: steps.map((step) => (step * 3) / 4) },
    stepMs: USAGE_STEP_MS,
  };
}

const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const AT = new Date(NOW - 5_000).toISOString();

function monitorState(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    revision: 1,
    status: 'idle',
    statusSince: AT,
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    tasks: [],
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: AT, level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

function session(id: string, activityKind: 'shell-idle' | 'foreground-job' = 'shell-idle'): MonitorAgent['session'] {
  return {
    id,
    cwd: '/Users/james/Projects/puppeteer',
    title: null,
    activity: {
      kind: activityKind,
      source: 'daemon',
      confidence: 'high',
      rootProcessGroupId: 1,
      foregroundProcessGroupId: 1,
      observedAtMs: NOW,
    },
    createdAtMs: NOW,
  } as unknown as MonitorAgent['session'];
}

function agent(overrides: Partial<MonitorAgent> = {}, facet?: Partial<MonitorAgentFacet>): MonitorAgent {
  const monitor = facet?.monitor ?? monitorState();
  return {
    id: 'a',
    session: session('a'),
    status: monitor.status,
    project: 'puppeteer',
    detail: 'Editing tokens.css',
    color: '#6366f1',
    active: false,
    ...(facet
      ? {
          agent: {
            provider: { id: 'imposter', label: 'Imposter' },
            monitor,
            recency: 'fresh',
            info: {} as AgentSessionInfo,
            model: 'Fable 5.1',
            ...facet,
          } as MonitorAgentFacet,
        }
      : {}),
    ...overrides,
  };
}

const parameters = DEFAULT_SWARM_PARAMETERS;

describe('formatBurn', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(820)).toBe('820');
    expect(formatTokens(8_100)).toBe('8.1k');
    expect(formatTokens(24_000)).toBe('24k');
    expect(formatTokens(384_000)).toBe('384k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(formatTokens(24_000_000)).toBe('24M');
  });
});

describe('bubbleModel', () => {
  it('draws an unclaimed idle terminal as a hollow with the folder and "empty"', () => {
    const model = bubbleModel({ agent: agent({ status: 'idle' }), parameters, nowMs: NOW, unread: false });
    expect(model.state).toBe('terminal-empty');
    expect(model.hollow).toBe(true);
    expect(model.running).toBe(false);
    expect(model.radius).toBe(50);
    expect(model.copy.map((line) => line.key)).toEqual(['folder', 'name', 'sub']);
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[2]!.text).toBe('empty');
    expect(model.ring).toBeUndefined();
    expect(model.watermark).toBeUndefined();
  });

  it('draws a terminal running a job with the comet, "running", and the elapsed time', () => {
    const model = bubbleModel({
      agent: agent({ status: 'working', session: session('a', 'foreground-job') }),
      parameters,
      nowMs: NOW,
      unread: false,
      runningSinceMs: NOW - 83_000,
    });
    expect(model.state).toBe('terminal-running');
    expect(model.running).toBe(true);
    expect(model.copy.map((line) => line.text)).toEqual(['', 'puppeteer', 'running', '1:23']);
  });

  it('never marks a terminal unread', () => {
    const model = bubbleModel({ agent: agent(), parameters, nowMs: NOW, unread: true });
    expect(model.unread).toBe(false);
  });

  it('shows name and model · effort on an idle agent, and the unread reply with a blue dot', () => {
    const monitor = monitorState({
      effort: { value: 'high', configured: 'high', intent: 'configured' },
      lastAssistantMessage: { text: 'Done: two tests fixed.\nDetails below.', at: AT, final: true },
    });
    const model = bubbleModel({ agent: agent({}, { monitor }), parameters, nowMs: NOW, unread: true });
    expect(model.state).toBe('idle');
    expect(model.radius).toBe(50);
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'model', 'message']);
    expect(model.copy[0]!.tone).toBe('ink');
    expect(model.copy[0]!.lead).toBeUndefined();
    expect(model.copy[1]!.text).toBe('Fable 5.1 · high');
    // Launch intent, no provider evidence yet: italic.
    expect(model.copy[1]!.style.italic).toBe(true);
    expect(model.copy[2]!.text).toBe('Done: two tests fixed.');
    expect(model.copy[2]!.lead).toEqual({ kind: 'dot', size: 5, gap: 4, tone: 'blue' });
    expect(model.unread).toBe(true);
    expect(model.flood).toBe(false);
  });

  it('falls back to the dot before the name when an unread agent has no reply text', () => {
    const model = bubbleModel({ agent: agent({}, {}), parameters, nowMs: NOW, unread: true });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'model']);
    expect(model.copy[0]!.lead).toEqual({ kind: 'dot', size: 5, gap: 4, tone: 'blue' });
    const read = bubbleModel({ agent: agent({}, {}), parameters, nowMs: NOW, unread: false });
    expect(read.copy[0]!.lead).toBeUndefined();
    expect(read.copy.map((line) => line.key)).toEqual(['name', 'model']);
  });

  it('gives a working agent the larger body, branch, name, model · effort, the graph, the ring, and both figures', () => {
    const monitor = monitorState({
      status: 'working',
      activity: { kind: 'tool', line: 'Editing tokens.css', since: AT },
      context: { usedPercent: 62.7, percentageSource: 'provider', asOf: AT },
      usage: { samples: [], burnRatePerMin: 20_000, cumulativeTokens: 999 },
      effort: { value: 'high', intent: 'observed' },
      environment: {
        worktrees: [],
        git: { root: '/Users/james/Projects/puppeteer', branch: 'swarm', headSha: null, detached: false },
      },
    });
    const model = bubbleModel({
      agent: agent(
        { status: 'working' },
        { monitor, branch: 'swarm', contextWindow: monitor.context, usage: usageHistory(1_240_000) },
      ),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.state).toBe('working');
    expect(model.radius).toBe(60);
    expect(model.copy.map((line) => line.key)).toEqual(['branch', 'name', 'model']);
    expect(model.copy[0]!.lead?.tone).toBe('green');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[2]!.text).toBe('Fable 5.1 · high');
    expect(model.ring).toEqual({ percent: 62, hot: false });
    expect(model.figures).toEqual({
      top: { text: '62%', hot: false, none: false },
      bottom: { text: '1.2M', hot: false, none: false },
    });
    // The ledger's figure, not Core's estimate, and the bars scaled to the tallest step.
    expect(model.graph?.up).toHaveLength(USAGE_STEP_COUNT);
    expect(model.graph?.down).toHaveLength(USAGE_STEP_COUNT);
    expect(model.graph?.split).toBe(true);
    expect(model.graph?.up[USAGE_STEP_COUNT - 1]).toBe(1);
    expect(model.graph?.up[0]).toBeCloseTo(1 / USAGE_STEP_COUNT, 6);
    expect(model.watermark?.sprite).toBe('imposter');
  });

  it('grows a working body from the working size to the largest by its share of the working sessions', () => {
    const monitor = monitorState({ status: 'working', usage: { samples: [], cumulativeTokens: 500 } });
    const input = { agent: agent({ status: 'working' }, { monitor }), parameters, nowMs: NOW, unread: false };
    expect(bubbleModel(input).radius).toBe(60);
    expect(bubbleModel({ ...input, workingShare: 0.5 }).radius).toBe(70);
    expect(bubbleModel({ ...input, workingShare: 1 }).radius).toBe(80);
  });

  it('places working sessions by total tokens, least 0 and most 1, and leaves a lone session at 0', () => {
    const working = (id: string, total: number): MonitorAgent => ({
      ...agent({ status: 'working' }, { monitor: monitorState({ status: 'working' }), usage: usageHistory(total) }),
      id,
    });
    const shares = workingShares([
      working('a', 100),
      working('b', 400),
      working('c', 1300),
      { ...working('d', 9000), status: 'idle' },
    ]);
    expect([...shares.entries()]).toEqual([
      ['a', 0],
      ['b', 0.25],
      ['c', 1],
    ]);
    expect([...workingShares([working('a', 100)]).values()]).toEqual([0]);
  });

  it('holds a blocked agent at the idle size, lights it, and shows its latest reply with an orange dot', () => {
    const monitor = monitorState({
      status: 'blocked',
      blockers: [{ id: 'b', kind: 'permission', since: AT, permission: { requestId: 'r', tool: 'Bash' } }],
      context: { usedPercent: 88, percentageSource: 'derived', asOf: AT },
      lastAssistantMessage: { text: 'May I run pnpm test?', at: AT, final: true },
    });
    const model = bubbleModel({
      agent: agent({ status: 'blocked' }, { monitor, contextWindow: monitor.context }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.state).toBe('blocked');
    expect(model.radius).toBe(50);
    expect(model.flood).toBe(true);
    expect(model.blockerKind).toBe('permission');
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'model', 'message']);
    expect(model.copy[2]!.text).toBe('May I run pnpm test?');
    expect(model.copy[2]!.lead).toEqual({ kind: 'dot', size: 5, gap: 4, tone: 'orange' });
    expect(model.ring).toEqual({ percent: 88, hot: true });
    expect(model.figures).toBeUndefined();
  });

  it('names the blocker when a blocked agent has no reply text', () => {
    const monitor = monitorState({
      status: 'blocked',
      blockers: [{ id: 'b', kind: 'question', since: AT, questions: [] }],
    });
    const model = bubbleModel({
      agent: agent({ status: 'blocked' }, { monitor }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    const kind = model.copy.find((line) => line.key === 'kind');
    expect(kind?.text).toBe('question');
    expect(kind?.tone).toBe('orange');
    expect(kind?.lead).toBeUndefined();
  });

  it('carries the pane link, the stale flag, and the accessible copy', () => {
    const model = bubbleModel({
      agent: agent({ stale: true, color: '#ec4899', attachment: { primaryPaneId: 'pane', paneIds: ['pane'] } }, {}),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.stale).toBe(true);
    // The pane light is the body's own colour: a pane wears the session's, never one of its own.
    expect(model.linked).toBe('#ec4899');
    expect(model.accent).toBe('#ec4899');
    expect(
      bubbleModel({ agent: agent({ color: '#ec4899' }, {}), parameters, nowMs: NOW, unread: false }).linked,
    ).toBeUndefined();
    expect(model.ariaLabel).toBe('puppeteer, Fable 5.1, idle: Editing tokens.css, CTX:--%');
    expect(model.title).toBe('puppeteer · Fable 5.1 · Editing tokens.css');
  });
});
