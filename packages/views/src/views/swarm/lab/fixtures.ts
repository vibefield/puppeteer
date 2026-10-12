import {
  AGENT_MONITOR_SCHEMA_VERSION,
  type AgentMonitorState,
  type MonitorActivityKind,
  type MonitorBlocker,
} from '@vibefield/puppeteer-core';
import { AGENT_MARK_PROVIDERS } from '@vibefield/puppeteer-view-sdk/toolkit';
import type { MonitorAgent, MonitorAgentFacet, MonitorSession } from '../../../monitor/types.js';
import type { BubbleModelInput, SwarmBubbleModel } from '../bubble-model.js';
import type { SwarmClearing } from '../gpu/swarm-renderer.js';

// Fixture agents for the design lab: every drawn state and every setting worth
// comparing, as a host's `MonitorAgent` rows plus the cost a backend would have
// computed for each, so the lab draws with the production model and renderer
// and never with a stand-in.

/**
 * The cost a backend would have computed for a fixture body (packages/monitor's usage ledger): the held total and
 * the ten-minute window in twenty 30 s steps, oldest first. Fixture data: no window keeps a usage ledger (L11), so a
 * host's own row has no such field, and the lab's model reads it from here.
 */
export interface LabUsage {
  /** Estimated API-equivalent USD for the work observed. */
  total?: number | undefined;
  coverage?: 'complete' | 'partial' | 'unavailable' | undefined;
  /** USD per step, oldest first. */
  steps: readonly number[];
  stepMs: number;
}

/** A fixture's agent half: a host's facet, with the cost the fixture carries. */
export interface LabAgentFacet extends MonitorAgentFacet {
  usage?: LabUsage | undefined;
}

/** A fixture row: a host's row, its agent half carrying the fixture's cost. */
export interface LabAgent extends MonitorAgent {
  agent?: LabAgentFacet | undefined;
}

/** The backend's window: twenty steps of 30 s. */
const STEP_MS = 30_000;
const STEP_COUNT = 20;

export interface LabStage {
  id: string;
  title: string;
  note: string;
  agent: LabAgent;
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
  /** The Agent Profile a terminal was born under (its profile line). */
  profile?: BubbleModelInput['profile'];
  /** A birth on its way, `agoMs` since the person let go: the pending body. */
  opening?: { agoMs: number; on?: string };
}

/**
 * A stage that is a whole FIELD, drawn by its own renderer: what a frame carries
 * rather than a body — the spawn bloom's veil, its clearings and its hub. Its
 * bodies are the settled field's (`clusterStages`), plus any `extra`. Places
 * are CSS px from the cell's centre.
 */
export interface LabFieldStage {
  id: string;
  title: string;
  note: string;
  /** The field's quiet: every body under it at (1 − veil) but the `lit` ones, and the grid. */
  veil?: number;
  /** Ids of the field's bodies pointed at, drawn above the veil at full weight. */
  lit?: readonly string[];
  clearings?: readonly SwarmClearing[];
  hold?: { x: number; y: number; progress?: number; frozen?: boolean; opacity?: number };
  /** Bodies of the stage's own, at a place; `above`: drawn over the clearings (the body being born). */
  extra?: readonly { stage: LabStage; x: number; y: number; above?: boolean }[];
}

/** A project's colour, dealt from its sequence: the lab sets these on its root per theme (`main.ts`). */
const PROJECT = (seq: number): string => `var(--lab-project-${seq})`;
/** A bare terminal belongs to no project and wears the ramp. */
const NEUTRAL = 'var(--text-faint)';
/** A pane's colour, dealt from its sequence on the pane wheel: the lab sets these on its root per theme (`main.ts`). */
const PANE = (seq: number): string => `var(--lab-pane-${seq})`;
/** The one pane a mounted fixture is shown in, wearing its own colour. */
const mountedIn = (seq: number) => ({ primaryPaneId: 'pane', paneIds: ['pane'], color: PANE(seq) }) as const;

function session(id: string, activityKind: 'shell-idle' | 'foreground-job', nowMs: number): MonitorSession {
  return {
    id,
    cwd: '/Users/james/Projects/puppeteer',
    title: null,
    activity: { kind: activityKind },
    createdAtMs: nowMs - 60_000,
  };
}

/** The cost of a rate curve over the last ten minutes: one step per bar. */
function usageOf(shape: BurnShape, total: number | undefined): LabUsage {
  const steps = Array.from(
    { length: STEP_COUNT },
    (_, index) => (BURN_SHAPES[shape](index * 2) * STEP_MS) / 60_000 / 1_000_000,
  );
  return {
    ...(total === undefined ? {} : { total: total / 1_000_000 }),
    coverage: 'complete',
    steps,
    stepMs: STEP_MS,
  };
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
  /** An adapter's human-readable line for the blocker: what the body says first. */
  blockerDetail?: string;
  /** The question as asked, for a question blocker. */
  question?: string;
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
  /** Estimated USD per minute: what the burn ladder reads. */
  ratePerMin?: number;
  /** The provider has no pricing lane, so the ladder is drawn unread. */
  unpriced?: boolean;
}

function monitorState(spec: AgentSpec, nowMs: number): AgentMonitorState {
  const at = new Date(nowMs - 20_000).toISOString();
  const detail = spec.blockerDetail ? { detail: spec.blockerDetail } : {};
  const blockers: MonitorBlocker[] =
    spec.blocker === 'permission'
      ? [{ id: 'b', kind: 'permission', since: at, ...detail, permission: { requestId: 'r', tool: 'Bash' } }]
      : spec.blocker === 'question'
        ? [
            {
              id: 'b',
              kind: 'question',
              since: at,
              ...detail,
              questions: spec.question ? [{ prompt: spec.question }] : [],
            },
          ]
        : spec.blocker === 'failure'
          ? [{ id: 'b', kind: 'failure', since: at, ...detail, failure: { code: 'E_TOOL', recoverable: true } }]
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
    usage: {
      samples: [],
      ...(spec.tokens === undefined ? {} : { cumulativeTokens: spec.tokens }),
      // What the burn ladder reads. An unpriced provider has the lane missing
      // altogether, which is not the same as a rate of zero.
      costCoverage: spec.unpriced ? 'unavailable' : 'complete',
      ...(spec.unpriced ? {} : { costRatePerMin: spec.ratePerMin ?? 0 }),
    },
    ...(spec.contextPercent === undefined
      ? {}
      : { context: { usedPercent: spec.contextPercent, percentageSource: 'provider', asOf: at } }),
    ...(spec.model ? { model: { id: spec.model.toLowerCase().replace(/\s+/g, '-'), displayName: spec.model } } : {}),
    ...(spec.effort ? { effort: { value: spec.effort, intent: spec.effortIntent ?? 'observed' } } : {}),
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { lastEvidenceAt: at, level: 'native-hooks', families: {} },
    alive: true,
  };
}

export function agentFixture(spec: AgentSpec, nowMs: number): LabAgent {
  const monitor = monitorState(spec, nowMs);
  const providerId =
    AGENT_MARK_PROVIDERS[(spec.mark ?? (spec.accent ?? 1) - 1) % AGENT_MARK_PROVIDERS.length] ?? 'imposter';
  const facet: LabAgentFacet = {
    provider: { id: providerId, label: providerId.slice(0, 1).toUpperCase() + providerId.slice(1) },
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.branch ? { branch: spec.branch } : {}),
    ...(monitor.context ? { contextWindow: monitor.context } : {}),
    monitor,
    // A provider with no pricing lane has no cost either: no total, no rate.
    ...(spec.unpriced
      ? {}
      : spec.burn
        ? { usage: usageOf(spec.burn, spec.tokens) }
        : spec.tokens === undefined
          ? {}
          : {
              usage: {
                total: spec.tokens / 1_000_000,
                coverage: 'complete',
                steps: new Array<number>(STEP_COUNT).fill(0),
                stepMs: STEP_MS,
              },
            }),
    recency: spec.stale ? 'stale' : 'fresh',
  };
  return {
    id: spec.id,
    session: session(spec.id, 'foreground-job', nowMs),
    createdAtMs: nowMs - 60_000,
    status: spec.status,
    project: spec.project,
    detail: spec.detail ?? spec.activity?.line ?? spec.status,
    color: PROJECT((spec.accent ?? 1) - 1),
    active: spec.active === true,
    ...(spec.stale ? { stale: true } : {}),
    ...(spec.mounted || spec.active ? { attachment: mountedIn((spec.accent ?? 1) - 1) } : {}),
    agent: facet,
  };
}

export function terminalFixture(id: string, project: string, running: boolean, nowMs: number): LabAgent {
  return {
    id,
    session: session(id, running ? 'foreground-job' : 'shell-idle', nowMs),
    createdAtMs: nowMs - 60_000,
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
      note: 'The folder in the project’s colour, the name at the title’s weight, model · effort stepped back from it. The gauge climbs from the track’s weight as the context fills.',
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
      note: 'A reply arrived while another pane was active. The reply itself takes the name’s place behind the chat mark, the name moves above it, and the body glows blue in the same carried waves. Nothing follows the model line.',
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
      id: 'idle-unread-silent',
      title: 'Idle, unread, no reply text',
      note: 'Nothing was captured to quote, so the line falls back to the words “new message”.',
      agent: agentFixture(
        {
          id: 'a2b',
          project: 'ref',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 18,
          accent: 3,
        },
        nowMs,
      ),
      unread: true,
    },
    {
      id: 'idle-context-low',
      title: 'Idle, context barely touched',
      note: 'Twelve per cent: the gauge is only just above its track, because it is not yet worth your attention.',
      agent: agentFixture(
        {
          id: 'a1b',
          project: 'voyager',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 12,
          accent: 5,
        },
        nowMs,
      ),
    },
    {
      id: 'idle-context-high',
      title: 'Idle, context nearly spent',
      note: 'Ninety-four per cent: the same gauge, at the top of its climb, now the strongest mark on the body.',
      agent: agentFixture(
        {
          id: 'a1c',
          project: 'voyager',
          status: 'idle',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 94,
          accent: 5,
        },
        nowMs,
      ),
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
      note: 'The pane’s own colour as a band a thirtieth of the radius wide outside the rim, the gutter, and nothing beyond it; the project’s colour stays the folder before the name. The gauge a twelfth of the radius wide, in the ink. At 60 that is 2px and 5px.',
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
      note: 'Branch, the folder and name, model · effort; context at the top; the burn ladder in the ink, with the estimated total below; the centre light is the theme’s own ink. The least spend among the working sessions: 60.',
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
          ratePerMin: 0.22,
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
      note: 'Burning $72/hr and the context past 80%: four flames, the last at full weight, and the gauge at the top of its climb. Nothing turns a colour — the count and the weight are the alarm.',
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
          ratePerMin: 1.2,
          activity: { kind: 'delegating', line: 'Delegating to Explore' },
          accent: 1,
        },
        nowMs,
      ),
    },
    {
      id: 'working-ease',
      title: 'Working, easing',
      note: 'A quiet loop at $4.80/hr: one flame, and nothing beside it.',
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
          ratePerMin: 0.08,
          activity: { kind: 'reasoning', line: 'Thinking' },
          accent: 6,
        },
        nowMs,
      ),
    },
    {
      id: 'working-quiet',
      title: 'Working, no evidence yet',
      note: 'No usage, no context, no price: one hollow flame — unread, which is not the same as calm — and both figures rest.',
      agent: agentFixture(
        { id: 'w4', project: 'study', status: 'working', model: 'Sonnet 5', accent: 8, unpriced: true },
        nowMs,
      ),
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
          ratePerMin: 0.08,
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
      note: 'The state’s own light. Its ground is that orange carried to the theme’s calm end — down toward black on a dark theme, up toward white on a light one — so the words keep the middle and the hue never turns to mud; the light itself rides the annulus at full chroma, in waves carried outward without a pause. Turn MOTION off above and they hold at mid-crest. What it waits on takes the name’s place behind the key: a permission says the tool it wants, its own evidence before any reply’s.',
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
      note: 'A question says the question, as it was asked, ellipsised to the chord.',
      agent: agentFixture(
        {
          id: 'b2',
          project: 'voyager',
          status: 'blocked',
          model: 'Sonnet 5',
          effort: 'medium',
          contextPercent: 70,
          blocker: 'question',
          question: 'Which key should the export use, the artist or the album?',
          accent: 5,
        },
        nowMs,
      ),
    },
    {
      id: 'blocked-failure',
      title: 'Blocked, failed',
      note: 'A failure with nothing else to go on falls back to its code.',
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
      note: 'An adapter’s own line for the blocker, which beats both the tool and the reply. The light inside is the state’s orange, the band outside is the pane’s colour, the folder is the project’s: three colours, three owners. The outer light joins only while its pane is selected.',
      agent: agentFixture(
        {
          id: 'b4',
          project: 'jabali',
          status: 'blocked',
          model: 'Fable 5.1',
          effort: 'high',
          contextPercent: 52,
          blocker: 'permission',
          blockerDetail: 'Delete the stale build folder',
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
/** Part: the burn ladder, one body per reading, so the steps can be compared. */
export function burnStages(nowMs: number): LabStage[] {
  const step = (
    id: string,
    title: string,
    note: string,
    ratePerMin: number | undefined,
    project: string,
    accent: number,
  ): LabStage => ({
    id,
    title,
    note,
    agent: agentFixture(
      {
        id,
        project,
        status: 'working',
        model: 'Fable 5.1',
        effort: 'high',
        branch: 'main',
        contextPercent: 44,
        burn: 'steady',
        activity: { kind: 'tool', line: 'Working' },
        accent,
        tokens: 620_000,
        ...(ratePerMin === undefined ? { unpriced: true } : { ratePerMin }),
      },
      nowMs,
    ),
  });
  return [
    step(
      'burn-calm',
      'Calm',
      'Under five cents a minute: no flames at all. A body with nothing to say says nothing.',
      0.02,
      'ref',
      3,
    ),
    step(
      'burn-one',
      'One flame',
      'Five cents a minute, $3/hr: one flame, low on its own climb. A working loop on a mid-tier model.',
      0.07,
      'duke',
      6,
    ),
    step('burn-two', 'Two flames', 'Fifteen cents a minute, $9/hr. Steady work.', 0.24, 'voyager', 5),
    step('burn-three', 'Three flames', 'Forty cents a minute, $24/hr. Long context or high effort.', 0.52, 'jabali', 2),
    step('burn-four', 'Four flames', 'A dollar a minute, $60/hr. A fan-out worth knowing about.', 1.6, 'puppeteer', 1),
    step(
      'burn-unpriced',
      'No price to read',
      'A provider with no pricing lane: ONE hollow flame. Not four, and not nothing — an absent reading must never look like a calm one.',
      undefined,
      'study',
      8,
    ),
  ];
}

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
/** Part: a settled field, the swarm as it actually rests. */
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
          ratePerMin: 0.62,
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
          ratePerMin: 1.4,
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
          ratePerMin: 0.09,
        },
        nowMs,
      ),
      workingShare: 0.5,
    },
  ];
}

/** Part: the field under the spawn bloom — the veil, the clearings and the hub, each a
 * frame over the settled field (`clusterStages`), drawn by its own renderer. The
 * geometry is the bloom's own: ring one's clearing is 92 + 24 + a label + 16 px
 * of pad, feathered 44; the words' is their box padded 18 × 14, feathered 64. */
export function bloomStages(nowMs: number): LabFieldStage[] {
  const ring: SwarmClearing = { kind: 'circle', x: -300, y: 0, radius: 150, feather: 44 };
  const words: SwarmClearing = { kind: 'rect', x: 150, y: -74, width: 330, height: 120, feather: 64 };
  return [
    {
      id: 'bloom-veil',
      title: 'The veil',
      note: 'The bloom is open: the field goes quiet under its own ground at 80% — the grid and every body — except what the person points at, which stays above it.',
      veil: 0.8,
      lit: ['c4'],
    },
    {
      id: 'bloom-ring',
      title: 'A ring’s clearing',
      note: 'Solid ground to the ring’s edge, then the gradient’s stops: .62 at 45% of the 44 px feather, nothing at its end. It erases the grid, the bodies and their type alike.',
      clearings: [{ ...ring, x: -160 }],
    },
    {
      id: 'bloom-words',
      title: 'The words’ clearing',
      note: 'Solid under the words’ box, falling smoothly to nothing over 64 px, so no box edge shows and nothing is cut in half.',
      clearings: [{ ...words, x: 20 }],
    },
    {
      id: 'bloom-hub',
      title: 'The hub, frozen',
      note: 'The whole field under an open bloom: the veil, a lit body, the ring’s and the words’ clearings, and the hold ring kept at full size above everything, drawn heavier (a 1.5 px rim, a 2.5 px dot) — the hub.',
      veil: 0.8,
      lit: ['c4'],
      clearings: [ring, words],
      hold: { x: -300, y: 0, frozen: true },
    },
    {
      id: 'bloom-born',
      title: 'Born above the clearing',
      note: 'Let go: the hub fades, and the body being born stands where the bud was, drawn over the clearing that is still lifting.',
      veil: 0.4,
      clearings: [{ ...ring, opacity: 0.6 }],
      hold: { x: -300, y: 0, frozen: true, opacity: 0.5 },
      extra: [
        {
          stage: {
            id: 'born',
            title: '',
            note: '',
            agent: terminalFixture('born-t', '~', false, nowMs),
            opening: { agoMs: 900 },
          },
          x: -300 + 65,
          y: -65,
          above: true,
        },
      ],
    },
  ];
}

/** Part: the body being born — the spawn bloom's pending body, where the person let go, until the host's row arrives. */
export function pendingStages(nowMs: number): LabStage[] {
  return [
    {
      id: 'pending-quiet',
      title: 'A birth, before 320 ms',
      note: 'Hollow and dashed like an empty terminal, its rim heavier (1.2 × the rim’s weight against .52). It reads EMPTY and holds still: a wait drawn inside 320 ms shows no indicator at all.',
      agent: terminalFixture('p1', '~', false, nowMs),
      opening: { agoMs: 100 },
    },
    {
      id: 'pending-opening',
      title: 'A birth, after 320 ms',
      note: 'Past the quiet it reads OPENING and its dashes turn — a radian every 0.9 s, clockwise — until the host’s row takes its place. Still with the motion off.',
      agent: terminalFixture('p2', '~', false, nowMs),
      opening: { agoMs: 900 },
    },
    {
      id: 'pending-peer',
      title: 'A birth on a peer',
      note: 'Opening on another desktop: the peer’s name after OPENING.',
      agent: terminalFixture('p3', '~', false, nowMs),
      opening: { agoMs: 900, on: 'mini' },
    },
  ];
}

/** Part: terminals born under an Agent Profile — the profile line, its glyph from ProfileGlyph's own shapes. */
export function profileStages(nowMs: number): LabStage[] {
  const peer: MonitorAgent = {
    ...terminalFixture('pr5', '~', false, nowMs),
    remote: {
      deviceId: 'mini',
      deviceName: 'mini',
      remoteSessionId: 'pr5',
      attachable: true,
      hostWritable: true,
      cwdLabel: '~',
    },
  };
  return [
    {
      id: 'profile-default',
      title: 'Under the default profile',
      note: 'One line in the terminal’s label style: the profile’s glyph leading its name, drawn filled because it is the desktop’s default.',
      agent: terminalFixture('pr1', '~', false, nowMs),
      profile: { label: 'Work', glyph: 'briefcase', kind: 'managed', isDefault: true },
    },
    {
      id: 'profile-managed',
      title: 'Under another profile',
      note: 'A managed profile that is not the default: the glyph outlined.',
      agent: terminalFixture('pr2', '~', false, nowMs),
      profile: { label: 'Personal', glyph: 'house', kind: 'managed' },
    },
    {
      id: 'profile-native',
      title: 'Under the machine’s own',
      note: 'The native set is always the laptop, whatever glyph it carries.',
      agent: terminalFixture('pr3', '~', false, nowMs),
      profile: { label: 'This Mac', glyph: 'rocket', kind: 'native' },
    },
    {
      id: 'profile-running',
      title: 'Running, under a profile',
      note: 'The profile line follows the running line and its clock.',
      agent: terminalFixture('pr4', 'study', true, nowMs),
      runningSinceMs: nowMs - 83_000,
      profile: { label: 'Work', glyph: 'briefcase', kind: 'managed', isDefault: true },
    },
    {
      id: 'profile-peer',
      title: 'A peer’s terminal, under a profile',
      note: 'Before the host line, which a peer’s body always keeps.',
      agent: peer,
      profile: { label: 'Default', kind: 'native', isDefault: true },
    },
  ];
}
