/**
 * Deterministic inputs for a view's tests and goldens: agents, models, themes
 * and stages that never read the clock, the document or a random source.
 *
 * The palettes here are FIXTURES, not the design system: a host resolves the
 * real tokens and hands them over (`MonitorPalette`). These only have to be
 * plausible, distinct in the two schemes, and the same on every run.
 */

import type { AgentStatus, MonitorAgentRow, MonitorDeviceRef, MonitorProject } from '../model.js';
import { allAdded } from '../internal/input.js';
import type {
  AgentView,
  MonitorCapabilities,
  MonitorModel,
  MonitorPalette,
  MonitorParameterGroup,
  MonitorParameterValues,
  MonitorTheme,
  MonitorViewInput,
  MonitorViewManifest,
  StageGeometry,
} from '../view.js';

/** 2026-01-01T00:00:00.000Z. Every fixture time counts from it, so a golden never moves. */
export const FIXTURE_EPOCH = Date.UTC(2026, 0, 1);

export type FixtureScheme = MonitorTheme['scheme'];

/** One table for both schemes: a fixture colour only has to tell projects apart. */
const PROJECT_COLOURS: readonly string[] = [
  '#4c8dff',
  '#c46bff',
  '#2bb7a3',
  '#e0a526',
  '#ef5f8b',
  '#6f7dff',
  '#55b84a',
  '#d9734a',
];

const FIXTURE_DEVICE: MonitorDeviceRef = Object.freeze({ id: 'desk', name: 'Desk', os: 'mac', self: true });

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const PALETTES: Readonly<Record<FixtureScheme, MonitorPalette>> = freezeDeep({
  light: {
    tint: { l: 0.62, c: 0.14 },
    neutral: 'rgba(27, 27, 31, 0.4)',
    status: { idle: 'rgba(27, 27, 31, 0.55)', working: '#2f9e44', blocked: '#e8590c' },
    statusRgb: { idle: '27, 27, 31', working: '47, 158, 68', blocked: '232, 89, 12' },
    stage: '#f4f2ee',
    text: { primary: '#1b1b1f', secondary: 'rgba(27, 27, 31, 0.7)', tertiary: 'rgba(27, 27, 31, 0.4)' },
    swarm: {
      surface: '#ebe8e2',
      ink: '#1b1b1f',
      gridLine: 'rgba(27, 27, 31, 0.08)',
      orange: '#e8590c',
      green: '#2f9e44',
      blue: '#1c7ed6',
    },
    rain: {
      stage: '#f4f2ee',
      activeHead: '#1b1b1f',
      hoverTailRgb: '28, 126, 214',
      status: {
        idle: { head: '#5c5c66', tailRgb: '92, 92, 102' },
        working: { head: '#2f9e44', tailRgb: '47, 158, 68', speed: 1 },
        blocked: { head: '#e8590c', tailRgb: '232, 89, 12', speed: 0.5 },
      },
    },
    timeline: { ground: '#f4f2ee', muted: 'rgba(27, 27, 31, 0.7)', border: 'rgba(27, 27, 31, 0.12)' },
  },
  dark: {
    tint: { l: 0.72, c: 0.13 },
    neutral: 'rgba(255, 255, 255, 0.4)',
    status: { idle: 'rgba(255, 255, 255, 0.55)', working: '#40c057', blocked: '#fd7e14' },
    statusRgb: { idle: '255, 255, 255', working: '64, 192, 87', blocked: '253, 126, 20' },
    stage: '#0b0c0f',
    text: {
      primary: 'rgba(255, 255, 255, 1)',
      secondary: 'rgba(255, 255, 255, 0.7)',
      tertiary: 'rgba(255, 255, 255, 0.4)',
    },
    swarm: {
      surface: '#15171c',
      ink: '#f1f3f5',
      gridLine: 'rgba(255, 255, 255, 0.06)',
      orange: '#fd7e14',
      green: '#40c057',
      blue: '#4dabf7',
    },
    rain: {
      stage: '#0b0c0f',
      activeHead: '#ffffff',
      hoverTailRgb: '77, 171, 247',
      status: {
        idle: { head: '#adb5bd', tailRgb: '173, 181, 189' },
        working: { head: '#40c057', tailRgb: '64, 192, 87', speed: 1 },
        blocked: { head: '#fd7e14', tailRgb: '253, 126, 20', speed: 0.5 },
      },
    },
    timeline: { ground: '#0b0c0f', muted: 'rgba(255, 255, 255, 0.7)', border: 'rgba(255, 255, 255, 0.12)' },
  },
});

/** The fixture tokens for a scheme. The same object on every call. */
export function fixturePalette(scheme: FixtureScheme = 'dark'): MonitorPalette {
  return PALETTES[scheme];
}

const THEMES: Readonly<Record<FixtureScheme, MonitorTheme>> = freezeDeep({
  light: { scheme: 'light', tokens: PALETTES.light, reducedMotion: false, animations: true },
  dark: { scheme: 'dark', tokens: PALETTES.dark, reducedMotion: false, animations: true },
});

/** A theme with motion on. Without overrides, the same object on every call, as a host keeps it. */
export function fixtureTheme(scheme: FixtureScheme = 'dark', overrides?: Partial<MonitorTheme>): MonitorTheme {
  const theme = THEMES[scheme];
  return overrides === undefined ? theme : Object.freeze({ ...theme, ...overrides });
}

export type FixtureStageSize = 'compact' | 'default' | 'wide';

/**
 * Three stages, the compact one at the stage's 170 px floor. Each carries the
 * usage column down its left edge as an obstacle and an advisory inset, as both
 * hosts' chrome does.
 */
export const FIXTURE_STAGES: Readonly<Record<FixtureStageSize, StageGeometry>> = freezeDeep({
  compact: {
    width: 480,
    height: 170,
    insets: { top: 0, right: 0, bottom: 0, left: 120 },
    obstacles: [{ x: 0, y: 0, width: 120, height: 170 }],
  },
  default: {
    width: 1280,
    height: 320,
    insets: { top: 0, right: 0, bottom: 0, left: 216 },
    obstacles: [{ x: 0, y: 0, width: 216, height: 320 }],
  },
  wide: {
    width: 2560,
    height: 480,
    insets: { top: 0, right: 0, bottom: 0, left: 216 },
    obstacles: [{ x: 0, y: 0, width: 216, height: 480 }],
  },
});

export function fixtureStage(size: FixtureStageSize = 'default'): StageGeometry {
  return FIXTURE_STAGES[size];
}

export type AgentViewFixturePartial = Partial<Omit<AgentView, 'project' | 'device'>> & {
  readonly project?: Partial<MonitorProject> | undefined;
  readonly device?: Partial<MonitorDeviceRef> | undefined;
};

/** The colour a fixture host gives a project: its sequence's entry in a fixed table, or the scheme's neutral. */
export function fixtureColour(project: MonitorProject, scheme: FixtureScheme = 'dark'): string {
  if (project.name === '' || project.seq === undefined) return PALETTES[scheme].neutral;
  return PROJECT_COLOURS[project.seq % PROJECT_COLOURS.length]!;
}

/**
 * One complete `AgentView`: an idle agent in `project`, born at the epoch, on
 * this desktop, mounted nowhere. Every field can be overridden; `project` and
 * `device` merge into their defaults.
 */
export function agentViewFixture(partial: AgentViewFixturePartial = {}): AgentView {
  const { project: projectPartial, device: devicePartial, ...rest } = partial;
  const project: MonitorProject = { name: 'project', seq: 0, ...projectPartial };
  const device: MonitorDeviceRef =
    devicePartial === undefined ? FIXTURE_DEVICE : { ...FIXTURE_DEVICE, ...devicePartial };
  return {
    id: 'agent-1',
    kind: 'agent',
    createdAt: FIXTURE_EPOCH,
    status: 'idle',
    statusSince: FIXTURE_EPOCH,
    stale: false,
    alive: true,
    detail: '',
    project,
    unread: false,
    device,
    attachable: true,
    colour: fixtureColour(project),
    active: false,
    receded: false,
    ...rest,
  };
}

/** What only a window knows, joined onto a backend row the way a replica does. */
export function toAgentView(row: MonitorAgentRow | AgentView, scheme: FixtureScheme = 'dark'): AgentView {
  if ('colour' in row && typeof row.colour === 'string') return row;
  return { ...row, colour: fixtureColour(row.project, scheme), active: false, receded: false };
}

const STATUSES: readonly AgentStatus[] = ['working', 'blocked', 'idle'];
const PROJECTS: readonly string[] = ['billing-api', 'vibe-field', 'rosetta', 'puppeteer', 'ghosttea'];
const DETAILS: readonly string[] = [
  'Running the test suite',
  'Waiting for permission to run Bash',
  'Finished the refactor',
  'Reading the design notes',
  'Editing src/view.ts',
];

/** mulberry32: a seeded stream, so a "random-looking" model is the same model on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AgentViewsFixtureOptions {
  /** Varies the costs and the order of details; the same seed is the same model. */
  readonly seed?: number | undefined;
  /** Every seventh row is a bare terminal unless this is false. */
  readonly terminals?: boolean | undefined;
}

/**
 * `count` agents spread over every status, five projects and a few bare
 * terminals, born a minute apart: a crowded stage that is the same on every run.
 */
export function agentViewsFixture(count: number, options: AgentViewsFixtureOptions = {}): AgentView[] {
  const random = seeded(options.seed ?? 1);
  const terminals = options.terminals ?? true;
  const agents: AgentView[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `agent-${String(index + 1).padStart(2, '0')}`;
    const createdAt = FIXTURE_EPOCH + index * 60_000;
    if (terminals && index % 7 === 6) {
      agents.push(
        agentViewFixture({
          id,
          kind: 'terminal',
          createdAt,
          statusSince: createdAt,
          project: { name: '', seq: undefined },
          activity: 'zsh',
          attachable: true,
        }),
      );
      continue;
    }
    const status = STATUSES[index % STATUSES.length]!;
    const seq = index % PROJECTS.length;
    const since = createdAt + 30_000;
    const usd = Math.round(random() * 2_000) / 100;
    agents.push(
      agentViewFixture({
        id,
        createdAt,
        status,
        statusSince: since,
        detail: DETAILS[Math.floor(random() * DETAILS.length)]!,
        project: { name: PROJECTS[seq]!, seq, branch: 'main' },
        provider: { id: 'claude', label: 'Claude' },
        model: 'fixture-model',
        unread: status === 'idle' && index % 2 === 0,
        ...(status === 'blocked' ? { wait: { kind: 'permission', since, tool: 'Bash' } } : {}),
        ...(status === 'working'
          ? {
              cost: {
                usd,
                coverage: 'complete' as const,
                burnPerHour: Math.round(random() * 600) / 100,
                series: {
                  stepMs: 30_000,
                  steps: Array.from({ length: 20 }, () => Math.round(random() * 10) / 100),
                  lastStepAt: since,
                },
              },
            }
          : {}),
        active: index === 0,
      }),
    );
  }
  return agents;
}

/** A model over `agents`, in their order, indexed by id. */
export function fixtureModel(agents: readonly AgentView[], revision = 1): MonitorModel {
  return { revision, agents, byId: new Map(agents.map((agent) => [agent.id, agent])) };
}

export const NO_CAPABILITIES: MonitorCapabilities = Object.freeze({});

/** The defaults a host would store for a view's parameters. */
export function parameterDefaults(
  source: Pick<MonitorViewManifest, 'parameters'> | readonly MonitorParameterGroup[],
): MonitorParameterValues {
  const groups = 'parameters' in source ? source.parameters : source;
  const values: Record<string, number> = {};
  for (const group of groups) {
    for (const control of group.controls) values[control.key] = control.defaultValue;
  }
  return Object.freeze(values);
}

export interface FixtureInputPartial extends Partial<Omit<MonitorViewInput, 'model'>> {
  readonly model?: MonitorModel | undefined;
  /** Shorthand for a model over these agents. */
  readonly agents?: readonly AgentView[] | undefined;
}

/** A whole input: no agents on the default stage in the dark theme, unless told otherwise. */
export function fixtureInput(partial: FixtureInputPartial = {}): MonitorViewInput {
  const model = partial.model ?? fixtureModel(partial.agents ?? []);
  return {
    model,
    changes: partial.changes ?? allAdded(model),
    stage: partial.stage ?? fixtureStage('default'),
    theme: partial.theme ?? fixtureTheme('dark'),
    parameters: partial.parameters ?? Object.freeze({}),
    capabilities: partial.capabilities ?? NO_CAPABILITIES,
  };
}
