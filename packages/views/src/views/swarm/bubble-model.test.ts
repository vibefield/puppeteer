import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_SCHEMA_VERSION, type AgentMonitorState } from '@vibecook/puppeteer-core';
import type { MonitorAgent, MonitorAgentFacet, MonitorSession } from '../../monitor/types.js';
import { USAGE_STEP_COUNT, USAGE_STEP_MS, type UsageHistory } from '../../monitor/usage-ledger.js';
import { bubbleModel, formatTokens, workingShares } from './bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';
import { SWARM_WEIGHT } from './weight.js';

/** A ledger history with the given corrected total, its newest step the tallest. */
function usageHistory(total: number): UsageHistory {
  const steps = Array.from({ length: USAGE_STEP_COUNT }, (_, index) => (index + 1) * 100);
  return { total, steps, stepMs: USAGE_STEP_MS };
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
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: AT, level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

function session(id: string, activityKind: 'shell-idle' | 'foreground-job' = 'shell-idle'): MonitorSession {
  return {
    id,
    cwd: '/Users/james/Projects/puppeteer',
    title: null,
    activity: { kind: activityKind },
    createdAtMs: NOW,
  };
}

function agent(overrides: Partial<MonitorAgent> = {}, facet?: Partial<MonitorAgentFacet>): MonitorAgent {
  const monitor = facet?.monitor ?? monitorState();
  return {
    id: 'a',
    session: session('a'),
    createdAtMs: NOW,
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
    // One line, the folder then the name, as every other body reads it; a
    // terminal has no project, so its folder wears the ink.
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'sub']);
    expect(model.copy[0]!.tone).toBe('ink');
    expect(model.copy[0]!.lead).toMatchObject({ kind: 'icon', icon: 'folder', tone: 'ink' });
    expect(model.copy[1]!.text).toBe('empty');
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
    expect(model.copy.map((line) => line.text)).toEqual(['puppeteer', 'running', '1:23']);
  });

  it('never marks a terminal unread', () => {
    const model = bubbleModel({ agent: agent(), parameters, nowMs: NOW, unread: true });
    expect(model.unread).toBe(false);
  });

  it('puts an unread reply itself in the name’s place, and fills the body blue behind it', () => {
    const monitor = monitorState({
      effort: { value: 'high', configured: 'high', intent: 'configured' },
      lastAssistantMessage: { text: 'Done: two tests fixed.\nDetails below.', at: AT, final: true },
    });
    const model = bubbleModel({ agent: agent({}, { monitor }), parameters, nowMs: NOW, unread: true });
    expect(model.state).toBe('idle');
    expect(model.radius).toBe(50);
    // Three lines: the project above, what arrived, the model. Nothing after it.
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    // The project moves above in label type: its folder turns solid and keeps
    // full strength, while its NAME steps back to a supporting rung, because the
    // name is no longer what the body is telling you.
    expect(model.copy[0]!.text).toBe('puppeteer');
    expect(model.copy[0]!.style.size).toBe(7.5);
    expect(model.copy[0]!.opacity).toBe(SWARM_WEIGHT.supporting);
    expect(model.copy[0]!.lead).toMatchObject({
      kind: 'icon',
      icon: 'folder-solid',
      tone: 'accent',
      opacity: SWARM_WEIGHT.title,
    });
    // The reply's own words behind the chat mark. The state's colour is the
    // body's GROUND now, so the words are the theme's ink like every other
    // body's — light on a dark theme, dark on a light one.
    expect(model.copy[1]!.text).toBe('Done: two tests fixed.');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[1]!.lead).toMatchObject({ kind: 'icon', icon: 'message' });
    expect(model.copy[1]!.lead?.tone).toBeUndefined();
    expect(model.copy[2]!.text).toBe('Fable 5.1 · high');
    // Launch intent, no provider evidence yet: italic.
    expect(model.copy[2]!.style.italic).toBe(true);
    expect(model.unread).toBe(true);
    expect(model.light).toBe('blue');
    expect(model.ariaLabel.endsWith(', new message: Done: two tests fixed.')).toBe(true);
  });

  it('falls back to the words “new message” with no reply to show, and says nothing once read', () => {
    const model = bubbleModel({ agent: agent({}, {}), parameters, nowMs: NOW, unread: true });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    expect(model.copy[1]!.text).toBe('new message');
    const read = bubbleModel({ agent: agent({}, {}), parameters, nowMs: NOW, unread: false });
    expect(read.copy.map((line) => line.key)).toEqual(['name', 'model']);
    // Read and idle: the name keeps the full size, the outlined folder, and no light.
    expect(read.copy[0]!.style.size).toBe(12);
    expect(read.copy[0]!.opacity).toBe(SWARM_WEIGHT.title);
    expect(read.copy[0]!.lead).toMatchObject({ kind: 'icon', icon: 'folder', tone: 'accent' });
    expect(read.light).toBeUndefined();
  });

  it('gives a working agent the larger body, branch, name, model · effort, the burn, the ring, and both figures', () => {
    const monitor = monitorState({
      status: 'working',
      activity: { kind: 'tool', line: 'Editing tokens.css', since: AT },
      context: { usedPercent: 62.7, percentageSource: 'provider', asOf: AT },
      usage: {
        samples: [],
        burnRatePerMin: 20_000,
        cumulativeTokens: 999,
        costRatePerMin: 0.52,
        costCoverage: 'complete',
      },
      effort: { value: 'high', intent: 'observed' },
      environment: {
        worktrees: [],
        git: { root: '/Users/james/Projects/puppeteer', branch: 'swarm', headSha: null, detached: false },
      },
    });
    const model = bubbleModel({
      agent: agent(
        { status: 'working' },
        { monitor, branch: 'swarm', contextWindow: monitor.context, usage: usageHistory(1.24) },
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
      bottom: { text: '~$1.24', hot: false, none: false },
    });
    // The bottom figure is the ledger's corrected total; the burn is Core's own
    // live rate on the fixed ladder — $0.52/min is the third step.
    expect(model.burn).toEqual({ lit: 3, priced: true });
    expect(model.title.endsWith('· $31/hr')).toBe(true);
    expect(model.ariaLabel.endsWith(', burning $31/hr')).toBe(true);
    expect(model.watermark?.sprite).toBe('imposter');
  });

  it('lights the burn ladder by the rate, and leaves it unread where nothing prices the work', () => {
    const working = (usage: Record<string, unknown>) =>
      bubbleModel({
        agent: agent(
          { status: 'working' },
          { monitor: monitorState({ status: 'working', usage: { samples: [], ...usage } }) },
        ),
        parameters,
        nowMs: NOW,
        unread: false,
      });
    // The steps: under 5c calm, then 5c, 15c, 40c and a dollar a minute.
    expect(working({ costCoverage: 'complete', costRatePerMin: 0.04 }).burn).toEqual({ lit: 0, priced: true });
    expect(working({ costCoverage: 'complete', costRatePerMin: 0.05 }).burn).toEqual({ lit: 1, priced: true });
    expect(working({ costCoverage: 'complete', costRatePerMin: 0.39 }).burn).toEqual({ lit: 2, priced: true });
    expect(working({ costCoverage: 'complete', costRatePerMin: 0.4 }).burn).toEqual({ lit: 3, priced: true });
    expect(working({ costCoverage: 'complete', costRatePerMin: 12 }).burn).toEqual({ lit: 4, priced: true });
    // A priced session that has not spent lately is calm; one with no pricing
    // lane at all is unread, and never reads as calm.
    expect(working({ costCoverage: 'complete' }).burn).toEqual({ lit: 0, priced: true });
    const unpriced = working({ costCoverage: 'unavailable', costRatePerMin: 9 });
    expect(unpriced.burn).toEqual({ lit: 0, priced: false });
    expect(unpriced.title.endsWith('· —/hr')).toBe(true);
    // Partial coverage still prices what it saw.
    expect(working({ costCoverage: 'partial', costRatePerMin: 0.2 }).burn).toEqual({ lit: 2, priced: true });
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

  it('holds a blocked agent at the idle size, lights it orange, and says what it waits on', () => {
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
    expect(model.light).toBe('orange');
    expect(model.blockerKind).toBe('permission');
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    // The permission's own evidence — the tool it wants — before the reply's words.
    expect(model.copy[1]!.text).toBe('Bash');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[1]!.lead).toMatchObject({ kind: 'icon', icon: 'permission' });
    expect(model.copy[1]!.lead?.tone).toBeUndefined();
    expect(model.ariaLabel.endsWith(', permission: Bash')).toBe(true);
    expect(model.ring).toEqual({ percent: 88, hot: true });
    expect(model.figures).toBeUndefined();
  });

  it('asks the question as it was asked, and names the blocker when there is nothing to quote', () => {
    const asked = monitorState({
      status: 'blocked',
      blockers: [{ id: 'b', kind: 'question', since: AT, questions: [{ prompt: 'Which key should the export use?' }] }],
    });
    const model = bubbleModel({
      agent: agent({ status: 'blocked' }, { monitor: asked }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    const state = model.copy.find((line) => line.key === 'state');
    expect(state?.text).toBe('Which key should the export use?');
    expect(state?.tone).toBe('ink');
    expect(state?.lead).toMatchObject({ kind: 'icon', icon: 'question' });

    const bare = monitorState({
      status: 'blocked',
      blockers: [{ id: 'b', kind: 'question', since: AT, questions: [] }],
    });
    const unnamed = bubbleModel({
      agent: agent({ status: 'blocked' }, { monitor: bare }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(unnamed.copy.find((line) => line.key === 'state')?.text).toBe('question');
  });

  it('carries the pane link, the stale flag, and the accessible copy', () => {
    const model = bubbleModel({
      agent: agent(
        { stale: true, color: '#ec4899', attachment: { primaryPaneId: 'pane', paneIds: ['pane'], color: '#22cc88' } },
        {},
      ),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.stale).toBe(true);
    // The band is the pane's colour; the project's colour reaches the body in one
    // place only, the folder before its name.
    expect(model.linked).toBe('#22cc88');
    expect(model.accent).toBe('#ec4899');
    expect(model.copy.find((line) => line.key === 'name')?.lead).toMatchObject({
      kind: 'icon',
      icon: 'folder',
      tone: 'accent',
    });
    expect(model.copy.flatMap((line) => (line.lead?.tone === 'accent' ? [line.key] : []))).toEqual(['name']);
    expect(
      bubbleModel({ agent: agent({ color: '#ec4899' }, {}), parameters, nowMs: NOW, unread: false }).linked,
    ).toBeUndefined();
    expect(model.ariaLabel).toBe('puppeteer, Fable 5.1, idle: Editing tokens.css, CTX:--%');
    expect(model.title).toBe('puppeteer · Fable 5.1 · Editing tokens.css');
  });
});

describe("a peer's session (the remote facet)", () => {
  const remoteRow = (hostWritable: boolean): MonitorAgent => ({
    id: 'r1',
    createdAtMs: 0,
    status: 'idle',
    project: 'mesh-console',
    detail: 'studio-mini · /Projects/mesh-console',
    color: '#6366f1',
    active: false,
    remote: {
      deviceId: 'mini',
      deviceName: 'studio-mini',
      remoteSessionId: 's1',
      attachable: true,
      hostWritable,
      cwdLabel: '/Projects/mesh-console',
    },
  });
  const model = (hostWritable: boolean) =>
    bubbleModel({
      agent: remoteRow(hostWritable),
      parameters: DEFAULT_SWARM_PARAMETERS,
      nowMs: NOW,
      unread: false,
      workingShare: 0,
    });

  it('names the peer FIRST in the accessible name, then the host write policy', () => {
    expect(model(false).ariaLabel).toBe('on studio-mini, mesh-console, remote session, idle, read-only host');
    expect(model(true).ariaLabel).toBe('on studio-mini, mesh-console, remote session, idle, writable host');
  });

  it('wears the host on the body, in both directions, so it cannot read as a local terminal', () => {
    const refusing = model(false).copy.find((line) => line.key === 'host');
    const permitting = model(true).copy.find((line) => line.key === 'host');
    expect(refusing?.text).toBe('studio-mini · read-only host');
    expect(permitting?.text).toBe('studio-mini · writable host');
    // …and a host property is never upgraded into a promise to the viewer.
    expect(permitting?.text).not.toContain('you');
    expect(model(true).title).toContain('decided when you attach');
  });
});
