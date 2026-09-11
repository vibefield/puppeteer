import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  AGENT_MONITOR_SCHEMA_VERSION,
  type AgentMonitorState,
  type MonitorActivityKind,
  type MonitorBlocker,
} from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../../../../protocol.js';
import { AGENT_MARK_PROVIDERS } from '../../../AgentIcon.js';
import type { MonitorAgent, MonitorAgentFacet } from '../../../monitor/types.js';
import type { SwarmBubbleModel } from '../bubble-model.js';
import { USAGE_STEP_COUNT, USAGE_STEP_MS, type UsageHistory } from '../../../monitor/usage-ledger.js';

// Fixture agents for the design lab: every drawn state and every setting worth
// comparing, as the same `MonitorAgent` shape the view receives, so the lab
// draws with the production model and renderer and never with a stand-in.

export interface LabStage {
  id: string;
  title: string;
  note: string;
  agent: MonitorAgent;
  runningSinceMs?: number;
  /** A working body's place among the working sessions by tokens, 0..1; the lab sets it by hand. */
  workingShare?: number;
  unread?: boolean;
  focus?: boolean;
  /** Draw the hold-to-create indicator at this cell instead of a body. */
  hold?: boolean;
  /** This stage's light, for weighing settings side by side. */
  glow?: { reach: number; strength: number; breath: number };
  /** A last word on the model, for readings the model does not produce on its own. */
  patch?: (model: SwarmBubbleModel) => SwarmBubbleModel;
}

/** A project's colour, dealt from its sequence: the lab sets these on its root per theme (`main.ts`). */
const PROJECT = (seq: number): string => `var(--lab-project-${seq})`;
/** A bare terminal belongs to no project and wears the ramp. */
const NEUTRAL = 'var(--text-faint)';
/** The one pane a mounted fixture is shown in. */
const MOUNTED = { primaryPaneId: 'pane', paneIds: ['pane'] } as const;

function session(id: string, activityKind: 'shell-idle' | 'foreground-job', nowMs: number): SessionSummary {
  return {
    id,
    cwd: '/Users/james/Projects/puppeteer',
    title: null,
    activity: {
      kind: activityKind,
      source: 'daemon',
      confidence: 'high',
      rootProcessGroupId: 1,
      foregroundProcessGroupId: activityKind === 'foreground-job' ? 2 : 1,
      observedAtMs: nowMs,
    },
    createdAtMs: nowMs - 60_000,
  } as unknown as SessionSummary;
}

/** The ledger's history for a rate curve over the last ten minutes: one step per bar. */
function usageHistory(shape: BurnShape, total: number | undefined): UsageHistory {
  const steps = Array.from(
    { length: USAGE_STEP_COUNT },
    (_, index) => (BURN_SHAPES[shape](index * 2) * USAGE_STEP_MS) / 60_000,
  );
  // The prompt side carries most of the burn, the completion side a swelling
  // fraction of it, so the two sides of the chart read differently.
  const output = steps.map((tokens, index) => tokens * (0.18 + 0.12 * Math.sin(index / 2)));
  const input = steps.map((tokens, index) => tokens - output[index]!);
  return { ...(total === undefined ? {} : { total }), steps, sides: { output, input }, stepMs: USAGE_STEP_MS };
}

const wobble = (index: number, amount: number): number => 1 + amount * Math.sin(index * 1.7) * Math.cos(index * 0.6);

export const BURN_SHAPES = {
  ember: (index: number): number => 600 * wobble(index, 0.2),
  steady: (index: number): number => 8_000 * wobble(index, 0.12),
  ease: (index: number): number => (12_000 - 10_000 * Math.min(1, index / 30)) * wobble(index, 0.1),
  blaze: (index: number): number => (index < 28 ? 3_000 : 3_000 + ((index - 28) / 11) * 27_000) * wobble(index, 0.08),
} as const;

export type BurnShape = keyof typeof BURN_SHAPES;

interface AgentSpec {
  id: string;
  project: string;
  status: AgentMonitorState['status'];
  model?: string;
  effort?: string;
  effortIntent?: 'configured' | 'observed';
  branch?: string;
  contextPercent?: number;
  burn?: BurnShape;
  activity?: { kind: MonitorActivityKind; line: string };
  blocker?: MonitorBlocker['kind'];
  stale?: boolean;
  active?: boolean;
  mounted?: boolean;
  /** The project's dealt sequence plus one, so the lab's eight projects read 1…8. */
  accent?: number;
  detail?: string;
  /** Which vendor mark to wear, by atlas index; defaults to the accent slot. */
  mark?: number;
  /** The latest reply, for the unread and blocked lines. */
  message?: string;
  /** The session's total tokens, the bottom figure. */
  tokens?: number;
}

function monitorState(spec: AgentSpec, nowMs: number): AgentMonitorState {
  const at = new Date(nowMs - 20_000).toISOString();
  const blockers: MonitorBlocker[] =
    spec.blocker === 'permission'
      ? [{ id: 'b', kind: 'permission', since: at, permission: { requestId: 'r', tool: 'Bash' } }]
      : spec.blocker === 'question'
        ? [{ id: 'b', kind: 'question', since: at, questions: [] }]
        : spec.blocker === 'failure'
          ? [{ id: 'b', kind: 'failure', since: at, failure: { code: 'E_TOOL', recoverable: true } }]
          : [];
  return {
    schemaVersion: AGENT_MONITOR_SCHEMA_VERSION,
    runtimeRunId: `run-${spec.id}`,
    runtimeEpoch: 1,
    revision: 1,
    status: spec.status,
    statusSince: at,
    blockers,
    ...(spec.activity ? { activity: { kind: spec.activity.kind, line: spec.activity.line, since: at } } : {}),
    ...(spec.message ? { lastAssistantMessage: { text: spec.message, at, final: true } } : {}),
    usage: { samples: [], ...(spec.tokens === undefined ? {} : { cumulativeTokens: spec.tokens }) },
    ...(spec.contextPercent === undefined
      ? {}
      : { context: { usedPercent: spec.contextPercent, percentageSource: 'provider', asOf: at } }),
    ...(spec.model ? { model: { id: spec.model.toLowerCase().replace(/\s+/g, '-'), displayName: spec.model } } : {}),
    ...(spec.effort ? { effort: { value: spec.effort, intent: spec.effortIntent ?? 'observed' } } : {}),
    modes: { execution: 'native-tui' },
    tasks: [],
    subagents: [],
    workflows: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: at, level: 'native-hooks', families: {} },
    alive: true,
  };
}

export function agentFixture(spec: AgentSpec, nowMs: number): MonitorAgent {
  const monitor = monitorState(spec, nowMs);
  const providerId =
    AGENT_MARK_PROVIDERS[(spec.mark ?? (spec.accent ?? 1) - 1) % AGENT_MARK_PROVIDERS.length] ?? 'imposter';
  const facet: MonitorAgentFacet = {
    provider: { id: providerId, label: providerId.slice(0, 1).toUpperCase() + providerId.slice(1) },
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.branch ? { branch: spec.branch } : {}),
    ...(monitor.context ? { contextWindow: monitor.context } : {}),
    monitor,
    ...(spec.burn
      ? { usage: usageHistory(spec.burn, spec.tokens) }
      : spec.tokens === undefined
        ? {}
        : { usage: { total: spec.tokens, steps: new Array<number>(USAGE_STEP_COUNT).fill(0), stepMs: USAGE_STEP_MS } }),
    recency: spec.stale ? 'stale' : 'fresh',
    info: {} as AgentSessionInfo,
  };
  return {
    id: spec.id,
    session: session(spec.id, 'foreground-job', nowMs),
    status: spec.status,
    project: spec.project,
    detail: spec.detail ?? spec.activity?.line ?? spec.status,
    color: PROJECT((spec.accent ?? 1) - 1),
    active: spec.active === true,
    ...(spec.stale ? { stale: true } : {}),
    ...(spec.mounted || spec.active ? { attachment: MOUNTED } : {}),
    agent: facet,
  };
}

export function terminalFixture(id: string, project: string, running: boolean, nowMs: number): MonitorAgent {
  return {
    id,
    session: session(id, running ? 'foreground-job' : 'shell-idle', nowMs),
    status: running ? 'working' : 'idle',
    project,
    detail: '/Users/james/Projects/' + project,
    color: NEUTRAL,
    active: false,
  };
}

/** Part I: the states, one body each. */
export function stateStages(nowMs: number): LabStage[] {
  return [
    {
      id: 'terminal-empty',
      title: 'Terminal, empty',
      note: 'Dashed rim, the folder, "empty".',
      agent: terminalFixture('t1', 'voyager', false, nowMs),
    },
    {
      id: 'terminal-running',
      title: 'Terminal, running',
      note: 'Solid faint rim, the comet, the clock since the job began.',
      agent: terminalFixture('t2', 'study', true, nowMs),
      runningSinceMs: nowMs - 83_000,
    },
    {
      id: 'idle',
      title: 'Agent, idle',
      note: 'Name, model · effort on one line. The ring in the ink when context is known.',
      agent: agentFixture(
        {
          id: 'a1',
          project: 'ref',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 31,
          accent: 3,
        },
        nowMs,
      ),
    },
    {
      id: 'idle-unread',
      title: 'Idle, unread',
      note: 'The latest reply on one line with a blue dot: it arrived while another pane was active.',
      agent: agentFixture(
        {
          id: 'a2',
          project: 'jabali',
          status: 'idle',
          model: 'Fable 5.1',
          effort: 'high',
          contextPercent: 44,
          message: 'Done: the editor now saves on blur and the three failing tests pass.',
          accent: 2,
        },
        nowMs,
      ),
      unread: true,
    },
    {
      id: 'idle-configured',
      title: 'Idle, effort configured',
      note: 'Launch intent, no provider evidence yet: the effort is set in italics.',
      agent: agentFixture(
        {
          id: 'a3',
          project: 'duke',
          status: 'idle',
          model: 'Haiku 4.5',
          effort: 'low',
          effortIntent: 'configured',
          accent: 6,
        },
        nowMs,
      ),
    },
    {
      id: 'idle-stale',
      title: 'Idle, stale evidence',
      note: 'Dimmed and desaturated, never recoloured.',
      agent: agentFixture(
        {
          id: 'a4',
          project: 'ref',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 31,
          stale: true,
          accent: 3,
        },
        nowMs,
      ),
    },
    {
      id: 'idle-mounted',
      title: 'Idle, mounted in a pane',
      note: 'The project colour as a band a thirtieth of the radius wide outside the rim, the gutter, and nothing beyond it; the gauge a twelfth of the radius wide, in the ink. At 60 that is 2px and 5px.',
      agent: agentFixture(
        {
          id: 'a5',
          project: 'voyager',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 12,
          mounted: true,
          accent: 5,
        },
        nowMs,
      ),
    },
    {
      id: 'idle-selected',
      title: 'Idle, in the selected pane',
      note: 'The same band, and the outer light beyond it: the one body whose pane is the selected one.',
      agent: agentFixture(
        {
          id: 'a5s',
          project: 'voyager',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 12,
          active: true,
          accent: 5,
        },
        nowMs,
      ),
    },
    {
      id: 'working',
      title: 'Agent, working',
      note: 'Branch, name, model · effort; context at the top; the burn bars in the ink, output up and input down about a baseline, with the total below; the mark and the centre light in the accent. The least tokens among the working sessions: 60.',
      agent: agentFixture(
        {
          id: 'w1',
          project: 'puppeteer',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'high',
          branch: 'swarm',
          contextPercent: 62,
          burn: 'steady',
          activity: { kind: 'tool', line: 'Editing tokens.css' },
          accent: 1,
          tokens: 384_000,
        },
        nowMs,
      ),
    },
    {
      id: 'working-hot',
      title: 'Working, hot',
      note: 'A burn climbing to its tallest column and the context past 80%: only the context turns orange; the newest column is the ink.',
      agent: agentFixture(
        {
          id: 'w2',
          project: 'puppeteer',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'high',
          branch: 'swarm',
          contextPercent: 88,
          burn: 'blaze',
          activity: { kind: 'delegating', line: 'Delegating to Explore' },
          accent: 1,
        },
        nowMs,
      ),
    },
    {
      id: 'working-ease',
      title: 'Working, easing',
      note: 'A burn that is falling; reasoning.',
      agent: agentFixture(
        {
          id: 'w3',
          project: 'duke',
          status: 'working',
          model: 'Haiku 4.5',
          effort: 'low',
          branch: 'hw3',
          contextPercent: 55,
          burn: 'ease',
          activity: { kind: 'reasoning', line: 'Thinking' },
          accent: 6,
        },
        nowMs,
      ),
    },
    {
      id: 'working-quiet',
      title: 'Working, no evidence yet',
      note: 'No usage, no context: the graph rests and both figures read "--".',
      agent: agentFixture({ id: 'w4', project: 'study', status: 'working', model: 'Sonnet 5', accent: 8 }, nowMs),
    },
    {
      id: 'working-active',
      title: 'Working, the active pane',
      note: 'Mounted and in front: the pane light and the same body.',
      agent: agentFixture(
        {
          id: 'w5',
          project: 'jabali',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'max',
          branch: 'editor',
          contextPercent: 27,
          burn: 'steady',
          activity: { kind: 'responding', line: 'Writing the reply' },
          active: true,
          accent: 2,
        },
        nowMs,
      ),
    },
    {
      id: 'working-largest',
      title: 'Working, the most tokens',
      note: 'The most tokens among the working sessions: 80, with the gauge and the gutter thicker in proportion. The rest fall between 60 and 80.',
      agent: agentFixture(
        {
          id: 'w6',
          project: 'puppeteer',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'high',
          branch: 'swarm',
          contextPercent: 62,
          burn: 'steady',
          activity: { kind: 'tool', line: 'Editing tokens.css' },
          accent: 1,
          tokens: 2_400_000,
        },
        nowMs,
      ),
      workingShare: 1,
    },
    {
      id: 'working-middle',
      title: 'Working, halfway',
      note: 'Halfway between the least and the most: 70.',
      agent: agentFixture(
        {
          id: 'w7',
          project: 'duke',
          status: 'working',
          model: 'Haiku 4.5',
          effort: 'low',
          branch: 'hw3',
          contextPercent: 55,
          burn: 'ease',
          activity: { kind: 'reasoning', line: 'Thinking' },
          accent: 6,
          tokens: 1_200_000,
        },
        nowMs,
      ),
      workingShare: 0.5,
    },
    {
      id: 'blocked-permission',
      title: 'Blocked, permission',
      note: 'Held at the idle size, inverted, the light outside the rim in the accent, the latest reply with an orange dot.',
      agent: agentFixture(
        {
          id: 'b1',
          project: 'duke',
          status: 'blocked',
          model: 'Haiku 4.5',
          effort: 'low',
          contextPercent: 40,
          blocker: 'permission',
          message: 'May I run pnpm test to check the fix?',
          accent: 6,
        },
        nowMs,
      ),
    },
    {
      id: 'blocked-question',
      title: 'Blocked, question',
      note: 'Same body; the question it asked.',
      agent: agentFixture(
        {
          id: 'b2',
          project: 'voyager',
          status: 'blocked',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 70,
          blocker: 'question',
          message: 'Which key should the export use, the artist or the album?',
          accent: 5,
        },
        nowMs,
      ),
    },
    {
      id: 'blocked-failure',
      title: 'Blocked, failed',
      note: 'A failure with no reply to show: the blocker is named instead.',
      agent: agentFixture(
        {
          id: 'b3',
          project: 'ref',
          status: 'blocked',
          model: 'Sonnet 5',
          contextPercent: 91,
          blocker: 'failure',
          accent: 3,
        },
        nowMs,
      ),
    },
    {
      id: 'blocked-mounted',
      title: 'Blocked, mounted',
      note: 'The flood inside and the band outside, both the project colour; the light joins only while its pane is selected.',
      agent: agentFixture(
        {
          id: 'b4',
          project: 'jabali',
          status: 'blocked',
          model: 'Fable 5.1',
          effort: 'high',
          contextPercent: 52,
          blocker: 'permission',
          message: 'May I delete the stale build folder?',
          mounted: true,
          accent: 2,
        },
        nowMs,
      ),
    },
    {
      id: 'hold',
      title: 'Hold to create',
      note: 'The indicator at the end of a 520ms hold on empty field.',
      agent: terminalFixture('t3', 'x', false, nowMs),
      hold: true,
    },
    {
      id: 'focus',
      title: 'Keyboard focus',
      note: 'A 2px ink ring, 4px off the rim, when the hidden button has focus.',
      agent: agentFixture(
        {
          id: 'a6',
          project: 'study',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 20,
          accent: 8,
        },
        nowMs,
      ),
      focus: true,
    },
  ];
}

/** Part II: the pane light, three weights, on the same idle body in the selected pane. */
export function lightStages(nowMs: number): LabStage[] {
  const mounted = (id: string): MonitorAgent =>
    agentFixture(
      {
        id,
        project: 'voyager',
        status: 'idle',
        model: 'Sonnet 5',
        effort: 'medium',
        contextPercent: 31,
        active: true,
        accent: 5,
      },
      nowMs,
    );
  return [
    {
      id: 'lamp',
      title: 'The lamp',
      note: 'Steady. Reach 34, strength 0.8, no breath — the default.',
      agent: mounted('g1'),
      glow: { reach: 34, strength: 0.8, breath: 0 },
    },
    {
      id: 'beacon',
      title: 'The beacon',
      note: 'Reach 48, strength 0.9, breathing to 38% every 1.2s.',
      agent: mounted('g2'),
      glow: { reach: 48, strength: 0.9, breath: 1 },
    },
    {
      id: 'wide',
      title: 'The wide lamp',
      note: 'Reach 70, strength 0.6: softer and further.',
      agent: mounted('g3'),
      glow: { reach: 70, strength: 0.6, breath: 0 },
    },
  ];
}

/** Part III: a settled cluster, the field as it actually looks. */
export function clusterStages(nowMs: number): LabStage[] {
  return [
    { id: 'c1', title: '', note: '', agent: terminalFixture('c-t1', 'voyager', false, nowMs) },
    {
      id: 'c2',
      title: '',
      note: '',
      agent: terminalFixture('c-t2', 'study', true, nowMs),
      runningSinceMs: nowMs - 341_000,
    },
    {
      id: 'c3',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-a1',
          project: 'jabali',
          status: 'idle',
          model: 'Fable 5.1',
          effort: 'high',
          contextPercent: 44,
          message: 'Done: the editor now saves on blur.',
          accent: 2,
        },
        nowMs,
      ),
      unread: true,
    },
    {
      id: 'c4',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-w1',
          project: 'puppeteer',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'high',
          branch: 'swarm',
          contextPercent: 62,
          burn: 'steady',
          activity: { kind: 'tool', line: 'Editing tokens.css' },
          active: true,
          accent: 1,
          tokens: 2400000,
        },
        nowMs,
      ),
      workingShare: 1,
    },
    {
      id: 'c5',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-b1',
          project: 'duke',
          status: 'blocked',
          model: 'Haiku 4.5',
          effort: 'low',
          contextPercent: 40,
          blocker: 'permission',
          message: 'May I run pnpm test?',
          accent: 6,
        },
        nowMs,
      ),
    },
    {
      id: 'c6',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-w2',
          project: 'puppeteer',
          status: 'working',
          model: 'Fable 5.1',
          effort: 'high',
          branch: 'swarm',
          contextPercent: 27,
          burn: 'blaze',
          activity: { kind: 'delegating', line: 'Delegating' },
          accent: 1,
          tokens: 384000,
        },
        nowMs,
      ),
      workingShare: 0.15,
    },
    {
      id: 'c7',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-a2',
          project: 'ref',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 31,
          accent: 3,
        },
        nowMs,
      ),
    },
    {
      id: 'c8',
      title: '',
      note: '',
      agent: agentFixture(
        {
          id: 'c-w3',
          project: 'duke',
          status: 'working',
          model: 'Haiku 4.5',
          effort: 'low',
          branch: 'hw3',
          contextPercent: 55,
          burn: 'ease',
          activity: { kind: 'responding', line: 'Writing the reply' },
          accent: 6,
          tokens: 1200000,
        },
        nowMs,
      ),
      workingShare: 0.5,
    },
  ];
}
