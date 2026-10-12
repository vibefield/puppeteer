import type {
  AgentView,
  MonitorDeviceRef,
  MonitorEndedRow,
  MonitorHistory,
  MonitorLivePast,
  MonitorPastSnapshot,
  MonitorPastSpan,
  MonitorWait,
  ProjectTint,
} from '@vibefield/puppeteer-view-sdk';
import { lendHistory } from '@vibefield/puppeteer-view-sdk/host';
import {
  AGENT_MARK_PROVIDERS,
  DEFAULT_PROJECT_TINT,
  paneColour,
  projectColour,
} from '@vibefield/puppeteer-view-sdk/toolkit';
import { seededRandom } from '../../../lab/lab-world.js';

// The timeline's example afternoon: the prototype's world
// (`draft/godview-timeline/site/tl-core.js`) as the rows a host's replica hands
// the view. Nine agents across six projects, six on this desktop and three on
// two peers, and two terminals: each one born somewhere in the afternoon, in
// its current state since the moment its row says (`statusSince`).
//
// Runtime only (MV-6) there is no book of what each lane did before, so the
// view draws each lane unrecorded from its birth to its current state; and an
// agent that ended is not in the model, so it is not here either. The record's
// past is a host's to lend (`history`); `timelineHistory` below builds one, as a
// host would lend it, for any rows: the lab's and the goldens' history cases.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

type DeviceId = 'here' | 'studio' | 'tower';
type State = 'working' | 'idle' | 'blocked' | 'unseen';

const DEVICES: Record<DeviceId, MonitorDeviceRef> = {
  here: { id: 'here', name: 'here', os: 'mac', self: true },
  studio: { id: 'studio', name: 'studio', self: false },
  tower: { id: 'tower', name: 'tower', self: false },
};

const PROJECT_SEQ: Record<string, number> = {
  'vibe-field': 0,
  rosetta: 1,
  'refactor-auth': 2,
  'billing-api': 3,
  'swarm-lab': 4,
  dotfiles: 5,
  notes: 6,
};

interface AgentDef {
  id: string;
  project: string;
  model?: string;
  branch?: string;
  device: DeviceId;
  /** Which vendor mark it wears, by atlas index: its provider. */
  mark: number;
  /** How long ago it was born. */
  born: number;
  /** Its current state, how long ago that began, and what it waits on. */
  now: { state: State; ago: number; wait?: { kind: 'permission' | 'question' | 'failure'; detail: string } };
}

const AGENTS: readonly AgentDef[] = [
  {
    id: 'vibe-field',
    project: 'vibe-field',
    model: 'opus',
    branch: 'main',
    device: 'here',
    mark: 0,
    born: 5 * HOUR + 10 * MIN,
    now: { state: 'working', ago: 12 * MIN + 41 * SEC },
  },
  {
    id: 'billing-api',
    project: 'billing-api',
    model: 'gpt-5',
    branch: 'billing/ledger-reader',
    device: 'here',
    mark: 1,
    born: HOUR + 32 * MIN,
    now: {
      state: 'blocked',
      ago: 4 * MIN + 12 * SEC,
      wait: { kind: 'permission', detail: 'Bash · git push origin billing/ledger-reader' },
    },
  },
  {
    id: 'refactor-auth',
    project: 'refactor-auth',
    model: 'opus',
    branch: 'refactor-auth',
    device: 'here',
    mark: 0,
    born: 2 * HOUR + 5 * MIN,
    now: { state: 'working', ago: 41 * MIN + 20 * SEC },
  },
  {
    id: 'rosetta-grants',
    project: 'rosetta',
    model: 'gpt-5',
    branch: 'main',
    device: 'studio',
    mark: 1,
    born: 4 * HOUR + 30 * MIN,
    now: {
      state: 'blocked',
      ago: 11 * MIN + 40 * SEC,
      wait: { kind: 'question', detail: 'Should the grant expire with the session, or after an hour?' },
    },
  },
  {
    id: 'rosetta-index',
    project: 'rosetta',
    branch: 'main',
    device: 'studio',
    mark: 0,
    born: 3 * HOUR + 15 * MIN,
    now: { state: 'working', ago: 6 * MIN + 5 * SEC },
  },
  {
    id: 'rosetta-docs',
    project: 'rosetta',
    model: 'sonnet',
    branch: 'docs',
    device: 'here',
    mark: 0,
    born: 3 * HOUR + 40 * MIN,
    now: { state: 'idle', ago: 22 * MIN + 10 * SEC },
  },
  {
    id: 'swarm-lab',
    project: 'swarm-lab',
    model: 'fast-4',
    branch: 'lab',
    device: 'here',
    mark: 2,
    born: 58 * MIN,
    now: { state: 'unseen', ago: 38 * MIN + 2 * SEC },
  },
  {
    id: 'dotfiles',
    project: 'dotfiles',
    model: 'sonnet',
    branch: 'main',
    device: 'here',
    mark: 0,
    born: 6 * HOUR + 20 * MIN,
    now: { state: 'idle', ago: HOUR + 2 * MIN },
  },
  {
    id: 'notes',
    project: 'notes',
    model: 'haiku',
    device: 'tower',
    mark: 0,
    born: 2 * HOUR + 50 * MIN,
    now: { state: 'idle', ago: 47 * MIN },
  },
];

interface TerminalDef {
  id: string;
  project: string;
  born: number;
  now: { running: boolean; ago: number };
}

const TERMINALS: readonly TerminalDef[] = [
  { id: 'term-vf', project: 'vibe-field', born: 5 * HOUR + 12 * MIN, now: { running: true, ago: 3 * MIN + 2 * SEC } },
  { id: 'term-home', project: '~', born: 2 * HOUR, now: { running: false, ago: 31 * MIN } },
];

/** The deck as it stands: the shell is the pane you are in; billing-api and vibe-field are mounted beside it. */
const PANES: Record<string, { seq: number; active: boolean }> = {
  'term-vf': { seq: 0, active: true },
  'billing-api': { seq: 1, active: false },
  'vibe-field': { seq: 2, active: false },
};

const capitalized = (word: string): string => word.slice(0, 1).toUpperCase() + word.slice(1);

/**
 * The example afternoon at `nowMs`, as rows (in no particular order: the view
 * orders them). `tint` is the theme's (`--tint-l`, `--tint-c`): project and
 * pane colours are dealt from it as a host deals them. `neutral` is the ramp a
 * bare terminal wears (`palette.neutral`).
 */
export function timelineWorld(
  nowMs: number,
  tint: ProjectTint = DEFAULT_PROJECT_TINT.light,
  neutral = 'var(--text-faint)',
): AgentView[] {
  const placed = (id: string): Pick<AgentView, 'active' | 'attachment'> => {
    const pane = PANES[id];
    return pane
      ? { active: pane.active, attachment: { panes: 1, colour: paneColour(pane.seq, tint) } }
      : { active: false };
  };
  const rows: AgentView[] = [];
  for (const def of AGENTS) {
    const since = nowMs - def.now.ago;
    const status = def.now.state === 'unseen' ? 'idle' : def.now.state;
    const provider = AGENT_MARK_PROVIDERS[def.mark % AGENT_MARK_PROVIDERS.length] ?? 'imposter';
    const wait: MonitorWait | undefined = def.now.wait
      ? {
          kind: def.now.wait.kind,
          since,
          detail: def.now.wait.detail,
          ...(def.now.wait.kind === 'question' ? { question: def.now.wait.detail } : {}),
        }
      : undefined;
    const seq = PROJECT_SEQ[def.project] ?? 9;
    rows.push({
      id: def.id,
      kind: 'agent',
      createdAt: nowMs - def.born,
      status,
      statusSince: since,
      stale: false,
      alive: true,
      observed: true,
      detail: def.now.wait?.detail ?? capitalized(status),
      project: { name: def.project, ...(def.branch ? { branch: def.branch } : {}), seq },
      provider: { id: provider, label: capitalized(provider) },
      ...(def.model ? { model: def.model } : {}),
      ...(wait ? { wait } : {}),
      unread: def.now.state === 'unseen',
      device: DEVICES[def.device],
      tier: def.device === 'here' ? 'managed' : 'remote',
      attachable: true,
      writable: true,
      colour: projectColour(seq, tint),
      receded: false,
      ...placed(def.id),
    });
  }
  for (const def of TERMINALS) {
    rows.push({
      id: def.id,
      kind: 'terminal',
      createdAt: nowMs - def.born,
      status: def.now.running ? 'working' : 'idle',
      statusSince: nowMs - def.now.ago,
      stale: false,
      alive: true,
      observed: true,
      detail: def.project === '~' ? '/Users/james' : `/Users/james/Projects/${def.project}`,
      project: { name: def.project },
      unread: false,
      device: DEVICES.here,
      attachable: true,
      writable: true,
      colour: neutral,
      receded: false,
      ...placed(def.id),
    });
  }
  return rows;
}

/**
 * The lab's history cases (T1, T5, the states): the record's turns; the floor, where each ended run is one band from
 * its start to its last activity and rows have no past; and the two states that print the backend's sentence —
 * `partial` (turns, some of the record missing) and `unavailable` (nothing could be read: today's floor).
 */
export type TimelineHistoryCase = 'turns' | 'bounds' | 'partial' | 'unavailable';

export const TIMELINE_HISTORY_CASES: readonly TimelineHistoryCase[] = ['turns', 'bounds', 'partial', 'unavailable'];

/** The backend's one honest sentence for each degraded case (fixtures: a real backend says its own). */
export const TIMELINE_HISTORY_DETAIL: Readonly<Partial<Record<TimelineHistoryCase, string>>> = {
  partial: 'tower is asleep; its runs are not in this record.',
  unavailable: 'The record index is starting.',
};

export interface TimelineHistoryOptions {
  readonly case?: TimelineHistoryCase | undefined;
  /** How many runs ended today (default 6): every third inside the last hour, so they show until they scroll out. */
  readonly ended?: number | undefined;
  /** The ramp a run with no project wears (`palette.neutral`). */
  readonly neutral?: string | undefined;
}

const DAY = 24 * HOUR;
const RUN_TITLES = [
  'Split the invoice writer',
  'Port the grants table to the new index',
  'Why does the swarm stall at n = 60?',
  'Tidy the release notes',
];
const PEER: MonitorDeviceRef = { id: 'tower', name: 'tower', self: false };
const HERE: MonitorDeviceRef = { id: 'here', name: 'here', os: 'mac', self: true };

/**
 * A run of turns from `from` up to `to`, as the record reads them (T1): worked inside a turn, quiet between turns, now
 * and then a silence over 15 minutes inside a turn (unrecorded), and now and then time no span covers at all (the gap
 * rule draws both dotted). The last stretch runs up to `to`: a row's seam, or a run's last activity.
 */
function recordedTurns(random: () => number, from: number, to: number): MonitorPastSpan[] {
  const spans: MonitorPastSpan[] = [];
  let t = from;
  let working = true;
  while (t < to) {
    const room = to - t;
    if (!working && room > 30 * MIN && random() < 0.12) {
      t += Math.round((8 + random() * 18) * MIN);
      working = true;
      continue;
    }
    let length = Math.min(room, Math.round((working ? 4 + random() * 26 : 2 + random() * 16) * MIN));
    if (room - length < 2 * MIN) length = room;
    if (working && length > 14 * MIN && random() < 0.3) {
      const head = Math.round(length * 0.3);
      const silence = Math.min(length - head - 2 * MIN, Math.round((16 + random() * 14) * MIN));
      if (silence > 15 * MIN) {
        spans.push(
          { kind: 'worked', from: t, to: t + head },
          { kind: 'unrecorded', from: t + head, to: t + head + silence },
          { kind: 'worked', from: t + head + silence, to: t + length },
        );
        t += length;
        working = false;
        continue;
      }
    }
    spans.push({ kind: working ? 'worked' : 'quiet', from: t, to: t + length });
    t += length;
    working = !working;
  }
  return spans;
}

/**
 * The record's past for `rows` at `nowMs`, as a host lends it (`lendHistory`): each agent row's turns up to its
 * `statusSince` (about a third of them resumed sessions, whose record starts before the row), and `ended` runs across
 * the day in the rows' projects, wearing the rows' colours. The same rows and case give the same history, every run.
 */
export function timelineHistory(
  rows: readonly AgentView[],
  nowMs: number,
  options: TimelineHistoryOptions = {},
): MonitorHistory {
  const which = options.case ?? 'turns';
  const sinceMs = nowMs - DAY;
  const fine = which !== 'bounds';
  const read = which !== 'unavailable';
  // The rows' projects, each with its colour: an ended run in a project wears the ink its live lanes wear.
  const colourBySeq = new Map<number, string>();
  const projects: { name: string; seq: number; branch?: string }[] = [];
  for (const row of rows) {
    if (row.kind !== 'agent' || projects.some((project) => project.name === row.project.name)) continue;
    const seq = row.project.seq ?? 1000 + projects.length;
    colourBySeq.set(seq, row.colour);
    projects.push({ name: row.project.name, seq, ...(row.project.branch ? { branch: row.project.branch } : {}) });
  }
  const live: MonitorLivePast[] = [];
  if (fine && read) {
    for (const row of rows) {
      if (row.kind !== 'agent') continue;
      const random = seededRandom(`past:${row.id}`);
      const resumed = random() < 0.35;
      const from = Math.max(sinceMs, row.createdAt - (resumed ? Math.round((15 + random() * 45) * MIN) : 0));
      if (row.statusSince - from < 3 * MIN) continue;
      live.push({ id: row.id, seamAt: row.statusSince, spans: recordedTurns(random, from, row.statusSince) });
    }
  }
  const ended: MonitorEndedRow[] = [];
  const count = read && projects.length > 0 ? (options.ended ?? 6) : 0;
  for (let index = 0; index < count; index += 1) {
    const random = seededRandom(`ended:${index}`);
    const project = projects[index % projects.length]!;
    // What ran it, as the afternoon deals its marks: the toolkit's providers, never a name spelled here.
    const id = AGENT_MARK_PROVIDERS[index % 4 === 1 ? 1 : 0] ?? 'imposter';
    const provider = { id, label: capitalized(id) };
    const endedAt = nowMs - Math.round((index % 3 === 0 ? 4 + random() * 48 : 65 + random() * 15 * 60) * MIN);
    const startedAt = Math.max(sinceMs, endedAt - Math.round((20 + random() * 280) * MIN));
    ended.push({
      id: `past:${provider.id}:lab-${index}`,
      provider,
      ...(index % 3 === 0 ? { title: RUN_TITLES[(index / 3) % RUN_TITLES.length]! } : {}),
      project,
      device: index % 5 === 3 ? PEER : HERE,
      startedAt,
      endedAt,
      spans: fine ? recordedTurns(random, startedAt, endedAt) : [{ kind: 'bounds', from: startedAt, to: endedAt }],
    });
  }
  ended.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const detail = TIMELINE_HISTORY_DETAIL[which];
  const snapshot: MonitorPastSnapshot = {
    sinceMs,
    untilMs: nowMs,
    readAt: nowMs,
    fidelity: fine ? 'turns' : 'bounds',
    state: which === 'partial' ? 'partial' : which === 'unavailable' ? 'unavailable' : 'complete',
    ...(detail === undefined ? {} : { detail }),
    live,
    ended,
  };
  const neutral = options.neutral ?? 'var(--text-faint)';
  return lendHistory(snapshot, {
    colourFor: (seq) => (seq === undefined ? neutral : (colourBySeq.get(seq) ?? neutral)),
    receded: () => false,
  });
}
