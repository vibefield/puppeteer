import type {
  AgentStatus,
  AgentView,
  MonitorCost,
  MonitorDeviceRef,
  MonitorWait,
  ProjectTint,
} from '@vibecook/puppeteer-view-sdk';
import {
  AGENT_MARK_PROVIDERS,
  DEFAULT_PROJECT_TINT,
  paneColour,
  projectColour,
} from '@vibecook/puppeteer-view-sdk/toolkit';

// The spend lab's afternoon, as a host's replica hands the rows over — runtime
// only: each priced row's `MonitorCost`, its meter (`usd`) and Core's last ten
// minutes (`series`, twenty 30-second buckets, the last the one now is in), and
// nothing older. Eight agents on this desktop with their buckets — three
// rosetta siblings, two waiting on you (a question, a permission), a reply
// nobody opened, one born four minutes ago, one partly priced — one on another
// desktop with a total and no buckets, one on a provider with no price (SV-D5),
// and two terminals, which cost nothing. Every priced response is drawn from a
// generator seeded by the agent's id from where the afternoon was opened, so a
// fold at a later moment reads the same afternoon further on, as the backend's
// ledger at every step boundary would. `crowd` adds ten more agents, for the
// dock (SV-D19). Ported from the prototype's world (`draft/godview-spend/site/
// sv-core.js`), as the held view's lab drew it (`feat/sv-live`), in the model's
// words (MV-7): a row's line is its `detail`, the task each agent works on.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** The backend's ledger: twenty buckets of 30 s (`MonitorCost.series`). */
const STEP_MS = 30 * SEC;
const STEP_COUNT = 20;
/** Responses are drawn from this long before the opening: past what Core's buckets reach. */
const LEAD_MS = 11 * MIN;
/** How long past the opening a working agent keeps working: the lab runs live for an hour. */
const HORIZON_MS = HOUR;

type State = 'working' | 'idle' | 'blocked' | 'unseen';

interface AgentDef {
  id: string;
  project: string;
  model?: string;
  branch?: string;
  /** Another desktop's agent: its row carries the total its owner sent, and no buckets. */
  peer?: string;
  mark: number;
  /** How long before the opening it was born. */
  born: number;
  /** Its state at the opening, how long it had been in it, and what it waits on. */
  now: { state: State; ago: number; blocker?: { kind: 'permission' | 'question' | 'failure'; detail: string } };
  /** What its meter read eleven minutes before the opening, USD; 0 for one born since. */
  spent: number;
  /** Estimated USD a minute while it works, and seconds between priced responses. */
  rate: number;
  gap: number;
  cover: 'complete' | 'partial' | 'none';
  task: string;
  /** The pane it is mounted in, and whether that is the pane you are in. */
  pane?: { seq: number; active: boolean };
}

const AGENTS: readonly AgentDef[] = [
  {
    id: 'vibe-field',
    project: 'vibe-field',
    model: 'opus',
    branch: 'main',
    mark: 0,
    born: 5 * HOUR + 10 * MIN,
    now: { state: 'working', ago: 12 * MIN + 41 * SEC },
    spent: 48.2,
    rate: 0.3,
    gap: 24,
    cover: 'complete',
    task: 'port the History view into the frame',
    pane: { seq: 2, active: false },
  },
  {
    id: 'refactor-auth',
    project: 'refactor-auth',
    model: 'opus',
    branch: 'refactor-auth',
    mark: 0,
    born: 2 * HOUR + 5 * MIN,
    now: { state: 'working', ago: 41 * MIN + 20 * SEC },
    spent: 26.4,
    rate: 0.24,
    gap: 20,
    cover: 'complete',
    task: 'move the token store behind the grant',
  },
  {
    id: 'rosetta-grants',
    project: 'rosetta',
    model: 'gpt-5',
    branch: 'main',
    mark: 1,
    born: 4 * HOUR + 30 * MIN,
    now: {
      state: 'blocked',
      ago: 3 * MIN + 40 * SEC,
      blocker: { kind: 'question', detail: 'Should the grant expire with the session, or after an hour?' },
    },
    spent: 16.1,
    rate: 0.14,
    gap: 16,
    cover: 'complete',
    task: 'direct-plane grants',
  },
  {
    id: 'rosetta-index',
    project: 'rosetta',
    branch: 'main',
    mark: 0,
    born: 3 * HOUR + 15 * MIN,
    now: { state: 'working', ago: 6 * MIN + 5 * SEC },
    spent: 15.2,
    rate: 0.16,
    gap: 18,
    cover: 'complete',
    task: 'rebuild the session index',
  },
  {
    id: 'rosetta-docs',
    project: 'rosetta',
    model: 'sonnet',
    branch: 'docs',
    mark: 0,
    born: 3 * HOUR + 40 * MIN,
    now: { state: 'unseen', ago: 5 * MIN + 10 * SEC },
    spent: 3.7,
    rate: 0.06,
    gap: 12,
    cover: 'complete',
    task: 'tidy the timeline route docs',
  },
  {
    id: 'billing-api',
    project: 'billing-api',
    model: 'gpt-5',
    branch: 'billing/ledger-reader',
    mark: 1,
    born: HOUR + 32 * MIN,
    now: {
      state: 'blocked',
      ago: 4 * MIN + 12 * SEC,
      blocker: { kind: 'permission', detail: 'Bash · git push origin billing/ledger-reader' },
    },
    spent: 3.9,
    rate: 0.09,
    gap: 14,
    cover: 'partial',
    task: 'tighten the ledger reader',
    pane: { seq: 1, active: false },
  },
  {
    id: 'dotfiles',
    project: 'dotfiles',
    model: 'sonnet',
    branch: 'main',
    mark: 0,
    born: 6 * HOUR + 20 * MIN,
    now: { state: 'idle', ago: HOUR + 2 * MIN },
    spent: 4.73,
    rate: 0.035,
    gap: 10,
    cover: 'complete',
    task: 'zsh: stop the colon modifier eating revision paths',
  },
  {
    id: 'notes',
    project: 'notes',
    model: 'haiku',
    peer: 'tower',
    mark: 0,
    born: 2 * HOUR + 50 * MIN,
    now: { state: 'working', ago: 2 * MIN + 30 * SEC },
    spent: 1.22,
    rate: 0.05,
    gap: 8,
    cover: 'complete',
    task: "sort Tuesday's notes by project",
  },
  {
    id: 'swarm-lab',
    project: 'swarm-lab',
    model: 'fast-4',
    branch: 'lab',
    mark: 2,
    born: 58 * MIN,
    now: { state: 'unseen', ago: 38 * MIN + 2 * SEC },
    spent: 0,
    rate: 0,
    gap: 20,
    cover: 'none',
    task: 'why do bodies jam top-left after release?',
  },
  {
    id: 'changelog',
    project: 'changelog',
    model: 'haiku',
    branch: 'main',
    mark: 0,
    born: 4 * MIN + 30 * SEC,
    now: { state: 'working', ago: 4 * MIN + 30 * SEC },
    spent: 0,
    rate: 0.06,
    gap: 9,
    cover: 'complete',
    task: "write this week's changelog",
  },
];

const PROJECT_SEQ: Record<string, number> = {
  'vibe-field': 0,
  rosetta: 1,
  'refactor-auth': 2,
  'billing-api': 3,
  'swarm-lab': 4,
  dotfiles: 5,
  notes: 6,
  changelog: 7,
  ice: 9,
  truffle: 10,
  ghosttea: 11,
  puppeteer: 12,
  jabali: 13,
  voyager: 14,
  study: 15,
};

/** Ten more agents across other projects: id, project, model, hours old, $/min, state now, its length, task. */
const CROWD: readonly [string, string, string, number, number, 'working' | 'idle' | 'blocked', number, string][] = [
  ['ice-render', 'ice', 'opus', 4.2, 0.22, 'working', 6, 'batch the card shadows'],
  ['ice-bench', 'ice', 'gpt-5', 2.6, 0.1, 'blocked', 9, 'profile the ground at n=96'],
  ['truffle', 'truffle', 'sonnet', 3.4, 0.07, 'idle', 14, 'sidecar reconnect backoff'],
  ['ghosttea-gpu', 'ghosttea', 'opus', 1.9, 0.26, 'working', 3, 'glyph atlas on the GPU'],
  ['ghosttea-docs', 'ghosttea', 'sonnet', 1.2, 0.04, 'blocked', 2, 'theme pages for the docs'],
  ['puppeteer-core', 'puppeteer', 'opus', 5.4, 0.18, 'idle', 21, 'status ledger types'],
  ['puppeteer-views', 'puppeteer', 'gpt-5', 2.2, 0.09, 'working', 11, 'list view keyboard focus'],
  ['jabali', 'jabali', 'haiku', 4.8, 0.015, 'idle', 33, 'tilemap import'],
  ['voyager', 'voyager', 'sonnet', 0.7, 0.06, 'blocked', 5, 'chord detection accuracy'],
  ['study', 'study', 'gpt-5', 3.1, 0.03, 'idle', 8, 'shader study notes'],
];

/** A small seeded generator (FNV-1a into mulberry32). */
function seeded(text: string): () => number {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-normal with mean 1: most responses cost about the average, a few cost much more. */
function lognormal(random: () => number, sigma = 0.6): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) - (sigma * sigma) / 2);
}

/** The priced responses from LEAD_MS before the opening on, oldest first. */
interface Responses {
  readonly at: readonly number[];
  readonly usd: readonly number[];
}

/** One priced response at a time while it works: a working agent from when it started on, a waiting or idle one until it stopped. */
function responsesOf(def: AgentDef, originMs: number): Responses {
  const at: number[] = [];
  const usd: number[] = [];
  if (def.cover === 'none') return { at, usd };
  const random = seeded(`${def.id}:spend`);
  const stateFrom = originMs - def.now.ago;
  const from = Math.max(originMs - LEAD_MS, originMs - def.born, def.now.state === 'working' ? stateFrom : -Infinity);
  const to = def.now.state === 'working' ? originMs + HORIZON_MS : stateFrom;
  const gap = def.gap * SEC;
  const pace = 0.6 + random() * 0.8;
  for (let t = from + gap * (0.2 + random() * 0.8); t < to; t += gap * (0.35 + random() * 1.3)) {
    let amount = def.rate * pace * (gap / MIN) * lognormal(random);
    // Now and then a compaction or a long read costs several responses' worth at once.
    if (random() < 0.025) amount *= 4 + random() * 4;
    at.push(t);
    usd.push(amount);
  }
  return { at, usd };
}

/** The row's cost at `nowMs`, bucketed as the backend's usage ledger buckets it (`MonitorCost`). */
function costAt(def: AgentDef, responses: Responses, nowMs: number): MonitorCost {
  const boundary = Math.floor(nowMs / STEP_MS);
  const steps = new Array<number>(STEP_COUNT).fill(0);
  let total = def.spent;
  for (let index = 0; index < responses.at.length && responses.at[index]! <= nowMs; index += 1) {
    const cost = responses.usd[index]!;
    total += cost;
    const step = STEP_COUNT - 1 - (boundary - Math.floor(responses.at[index]! / STEP_MS));
    if (step >= 0) steps[step]! += cost;
  }
  return {
    usd: total,
    coverage: def.cover === 'partial' ? 'partial' : 'complete',
    // Another desktop's row carries its owner's total and no buckets: none cross desktops.
    ...(def.peer ? {} : { series: { stepMs: STEP_MS, steps, lastStepAt: boundary * STEP_MS } }),
  };
}

const HERE: MonitorDeviceRef = { id: 'here', name: 'here', os: 'mac', self: true };

function providerOf(mark: number): { id: string; label: string } {
  const id = AGENT_MARK_PROVIDERS[mark % AGENT_MARK_PROVIDERS.length] ?? 'imposter';
  return { id, label: id.slice(0, 1).toUpperCase() + id.slice(1) };
}

function waitOf(def: AgentDef, since: number): MonitorWait | undefined {
  const blocker = def.now.blocker;
  if (!blocker) return undefined;
  return {
    kind: blocker.kind,
    since,
    detail: blocker.detail,
    ...(blocker.kind === 'permission' ? { tool: 'Bash' } : {}),
    ...(blocker.kind === 'question' ? { question: blocker.detail } : {}),
  };
}

/** The row at the opening, before any cost is read into it. */
function rowOf(def: AgentDef, originMs: number, tint: ProjectTint): AgentView {
  const status: AgentStatus = def.now.state === 'unseen' ? 'idle' : def.now.state;
  const born = originMs - def.born;
  const since = originMs - def.now.ago;
  const seq = PROJECT_SEQ[def.project] ?? 9;
  const wait = waitOf(def, since);
  const device: MonitorDeviceRef = def.peer ? { id: def.peer, name: def.peer, self: false } : HERE;
  return {
    id: def.id,
    kind: 'agent',
    createdAt: born,
    status,
    statusSince: since,
    stale: false,
    alive: true,
    observed: true,
    detail: def.task,
    ...(status === 'working' ? { activity: { kind: 'tool', line: def.task, since } } : {}),
    project: { name: def.project, ...(def.branch ? { branch: def.branch } : {}), seq },
    provider: providerOf(def.mark),
    ...(def.model ? { model: def.model } : {}),
    ...(wait ? { wait } : {}),
    unread: def.now.state === 'unseen',
    device,
    tier: def.peer ? 'remote' : 'managed',
    profileSet: 'native',
    attachable: true,
    writable: true,
    colour: projectColour(seq, tint),
    active: def.pane?.active ?? false,
    receded: false,
    ...(def.pane ? { attachment: { panes: 1, colour: paneColour(def.pane.seq, tint) } } : {}),
  };
}

function crowdDefs(): AgentDef[] {
  return CROWD.map(([id, project, model, hours, rate, state, minutes, task]) => {
    const random = seeded(id);
    const kind = random() < 0.6 ? 'permission' : 'question';
    return {
      id,
      project,
      model,
      mark: Math.floor(random() * 3),
      born: hours * HOUR,
      now: {
        state,
        ago: minutes * MIN,
        ...(state === 'blocked' ? { blocker: { kind, detail: 'Bash · pnpm test' } } : {}),
      },
      // About a third of its life at work, at its own price.
      spent: Math.round(rate * hours * 60 * (0.25 + random() * 0.2) * 100) / 100,
      rate,
      gap: 12 + Math.round(random() * 14),
      cover: 'complete',
      task,
    } satisfies AgentDef;
  });
}

interface AfternoonEntry {
  readonly def: AgentDef;
  readonly row: AgentView;
  readonly responses: Responses;
}

/** The afternoon as it was opened: each row, and each priced agent's responses from just before then on. */
export interface SpendAfternoon {
  readonly originMs: number;
  readonly entries: readonly AfternoonEntry[];
  readonly terminals: readonly AgentView[];
}

/** A bare terminal: no project's colour, the ramp, nothing it costs. */
function terminalOf(
  id: string,
  folder: string,
  running: boolean,
  born: number,
  neutral: string,
  tint: ProjectTint,
  pane?: number,
): AgentView {
  return {
    id,
    kind: 'terminal',
    createdAt: born,
    status: running ? 'working' : 'idle',
    statusSince: born,
    stale: false,
    alive: true,
    observed: true,
    detail: `/Users/james/Projects/${folder}`,
    activity: { kind: running ? 'foreground-job' : 'shell-idle' },
    // A terminal is named by its folder, as the backend names one (`deriveTerminalRow`).
    project: { name: folder },
    unread: false,
    device: HERE,
    attachable: true,
    writable: true,
    colour: neutral,
    active: pane !== undefined,
    receded: false,
    ...(pane === undefined ? {} : { attachment: { panes: 1, colour: paneColour(pane, tint) } }),
  };
}

/**
 * The afternoon opened at `originMs`; `tint` is the theme's, and the project and pane colours are dealt from it.
 * `neutral` is the ramp a bare terminal wears.
 */
export function spendAfternoon(
  originMs: number,
  tint: ProjectTint = DEFAULT_PROJECT_TINT.light,
  options: { crowd?: boolean; neutral?: string } = {},
): SpendAfternoon {
  const defs = options.crowd ? [...AGENTS, ...crowdDefs()] : AGENTS;
  const neutral = options.neutral ?? 'rgba(127, 127, 127, 0.4)';
  return {
    originMs,
    entries: defs.map((def) => ({ def, row: rowOf(def, originMs, tint), responses: responsesOf(def, originMs) })),
    // The shell is the pane you are in.
    terminals: [
      terminalOf('term-vf', 'vibe-field', true, originMs - (5 * HOUR + 12 * MIN), neutral, tint, 0),
      terminalOf('term-home', '~', false, originMs - 2 * HOUR, neutral, tint),
    ],
  };
}

/** The rows a replica hands over at `nowMs` (at or after the opening): each priced row's cost then. */
export function spendRows(afternoon: SpendAfternoon, nowMs: number): AgentView[] {
  const rows = afternoon.entries.map(({ def, row, responses }) =>
    def.cover === 'none' ? row : { ...row, cost: costAt(def, responses, nowMs) },
  );
  return [...rows, ...afternoon.terminals];
}

/** The afternoon opened at `nowMs` and read then: the rows a replica hands the view. */
export function spendWorld(
  nowMs: number,
  tint: ProjectTint = DEFAULT_PROJECT_TINT.light,
  options: { crowd?: boolean; neutral?: string } = {},
): AgentView[] {
  return spendRows(spendAfternoon(nowMs, tint, options), nowMs);
}
