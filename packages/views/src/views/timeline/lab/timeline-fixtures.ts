import type { MonitorBlocker } from '@vibecook/puppeteer-core';
import { DEFAULT_PROJECT_TINT, paneTint, projectTint, type ProjectTint } from '../../../colour/project-tint.js';
import type { MonitorHistoryBook, MonitorHistorySpan, MonitorLaneHistory } from '../../../monitor/status-history.js';
import type { MonitorAgent, MonitorRemoteFacet } from '../../../monitor/types.js';
import { agentFixture, terminalFixture } from '../../swarm/lab/fixtures.js';

// The timeline's example afternoon: the prototype's world
// (`draft/godview-timeline/site/tl-core.js`) as the rows and the book a host
// hands the view. Nine agents across six projects — six on this desktop, three
// on two peers — one of them ended, and two terminals. Every lane's past is
// drawn from a generator seeded by its id, so a reload draws the same afternoon.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

type DeviceId = 'here' | 'studio' | 'tower';
type State = 'working' | 'idle' | 'blocked' | 'unseen';

const DEVICES: Record<Exclude<DeviceId, 'here'>, { name: string }> = {
  studio: { name: 'studio' },
  tower: { name: 'tower' },
};

/** The record's own edges: the host keeps this desktop's from its start, a peer's from when it was first heard. */
const RECORD_FROM: Record<DeviceId, number> = {
  here: 5 * HOUR + 40 * MIN,
  studio: 4 * HOUR + 5 * MIN,
  tower: 2 * HOUR + 20 * MIN,
};

const PROJECT_SEQ: Record<string, number> = {
  'vibe-field': 0,
  rosetta: 1,
  'refactor-auth': 2,
  'billing-api': 3,
  'swarm-lab': 4,
  dotfiles: 5,
  notes: 6,
  changelog: 7,
};

const QUESTIONS = [
  'Should the grant expire with the session, or after an hour?',
  'Keep the old export behind a flag, or drop it?',
  'Name the store ledger, or keep runs?',
  'Squash these four commits before the push?',
];
const PERMISSIONS = [
  'Bash · pnpm verify',
  'Bash · git push origin main',
  'Edit · src/write.rs',
  'Bash · cargo test -p ledger',
];
const FAILURES = ['rate limited · retrying', 'tests failed · 3 of 958'];

interface Persona {
  work: number;
  idle: number;
  unseen: number;
  block: number;
}

interface AgentDef {
  id: string;
  project: string;
  model?: string;
  branch?: string;
  device: DeviceId;
  mark: number;
  born: number;
  now: { state: State; ago: number; blocker?: { kind: MonitorBlocker['kind']; detail: string } };
  endedAgo?: number;
  acts: readonly string[];
  persona: Persona;
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
    acts: ['Edit one-frame/page.css +214 −18', 'Run pnpm verify', 'Read DESIGN.md §2.7', 'Edit godview.css +31 −7'],
    persona: { work: 24 * MIN, idle: 7 * MIN, unseen: 6 * MIN, block: 2 * MIN },
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
      blocker: { kind: 'permission', detail: 'Bash · git push origin billing/ledger-reader' },
    },
    acts: ['Run cargo test -p ledger', 'Edit src/write.rs +40 −12', 'Read packages/ledger/src/read.ts'],
    persona: { work: 9 * MIN, idle: 5 * MIN, unseen: 4 * MIN, block: 3 * MIN },
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
    acts: ['Edit grant.ts +48 −31', 'Run pnpm test auth', 'Read packages/users/src/grant.ts'],
    persona: { work: 26 * MIN, idle: 9 * MIN, unseen: 7 * MIN, block: 3 * MIN },
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
      blocker: { kind: 'question', detail: 'Should the grant expire with the session, or after an hour?' },
    },
    acts: ['Edit grants.rs +120 −8', 'Read crates/server/src/http.rs', 'Run cargo test -p server'],
    persona: { work: 14 * MIN, idle: 8 * MIN, unseen: 0, block: 6 * MIN },
  },
  {
    id: 'rosetta-index',
    project: 'rosetta',
    branch: 'main',
    device: 'studio',
    mark: 0,
    born: 3 * HOUR + 15 * MIN,
    now: { state: 'working', ago: 6 * MIN + 5 * SEC },
    acts: ['Rebuilding the session index', 'Run rosettad reindex --all', 'Edit walk.rs +9 −3'],
    persona: { work: 16 * MIN, idle: 10 * MIN, unseen: 0, block: 2 * MIN },
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
    acts: ['Edit docs/api.md +22 −9', 'Read docs/timeline.md'],
    persona: { work: 8 * MIN, idle: 14 * MIN, unseen: 9 * MIN, block: 1.5 * MIN },
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
    acts: ['Run node lab/bench.mjs', 'Read physics/world.ts', 'Edit world.ts +6 −2'],
    persona: { work: 7 * MIN, idle: 6 * MIN, unseen: 8 * MIN, block: 2 * MIN },
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
    acts: ['Edit .zshrc +3 −1', 'Run zsh -n .zshrc'],
    persona: { work: 6 * MIN, idle: 30 * MIN, unseen: 12 * MIN, block: MIN },
  },
  {
    id: 'notes',
    project: 'notes',
    model: 'haiku',
    device: 'tower',
    mark: 0,
    born: 2 * HOUR + 50 * MIN,
    now: { state: 'idle', ago: 47 * MIN },
    acts: ['Read Tuesday.md', 'Edit inbox.md +12 −30'],
    persona: { work: 5 * MIN, idle: 22 * MIN, unseen: 0, block: MIN },
  },
  {
    id: 'changelog',
    project: 'changelog',
    model: 'haiku',
    branch: 'main',
    device: 'here',
    mark: 0,
    born: 3 * HOUR + 5 * MIN,
    endedAgo: 52 * MIN,
    now: { state: 'idle', ago: 0 },
    acts: ['Read git log --since=monday', 'Edit CHANGELOG.md +41 −0'],
    persona: { work: 6 * MIN, idle: 10 * MIN, unseen: 5 * MIN, block: MIN },
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

/** A small seeded generator (FNV-1a into mulberry32), one per lane. */
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

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length) % items.length]!;
/** Gamma(2): bunched near the mean, a long tail, never under `min`. */
const sample = (mean: number, random: () => number, min = 25 * SEC): number =>
  Math.max(min, (mean * (-Math.log(1 - random()) - Math.log(1 - random()))) / 2);

function detail(state: State, def: AgentDef, random: () => number): Partial<MonitorHistorySpan> {
  if (state === 'working') return { did: pick(def.acts, random) };
  if (state === 'blocked') {
    const roll = random();
    if (roll < 0.62) return { blocker: { kind: 'permission', detail: pick(PERMISSIONS, random) } };
    if (roll < 0.92) return { blocker: { kind: 'question', detail: pick(QUESTIONS, random) } };
    return { blocker: { kind: 'failure', detail: pick(FAILURES, random) } };
  }
  return {};
}

/** What came before `state`, walking back from now. A peer's agent is never unseen here (its replies are seen there). */
function before(state: State, remote: boolean, random: () => number): State {
  if (state === 'blocked' || state === 'unseen') return 'working';
  if (state === 'working') {
    const roll = random();
    if (roll < 0.3) return 'blocked';
    if (roll < 0.66 && !remote) return 'unseen';
    return 'idle';
  }
  if (!remote && random() < 0.72) return 'unseen';
  return 'working';
}

interface Built {
  spans: MonitorHistorySpan[];
  born: number;
  ended?: number;
}

function buildSpans(def: AgentDef, nowMs: number): Built {
  const random = seeded(def.id);
  const remote = def.device !== 'here';
  const born = nowMs - def.born;
  const ended = def.endedAgo === undefined ? undefined : nowMs - def.endedAgo;
  type Draft = { state: State; from: number; to?: number; extra: Partial<MonitorHistorySpan> };
  const drafts: Draft[] = [];
  let state = def.now.state;
  let from = ended !== undefined ? ended - sample(def.persona.idle, random) : nowMs - def.now.ago;
  drafts.unshift({
    state,
    from,
    ...(ended === undefined ? {} : { to: ended }),
    extra: def.now.blocker ? { blocker: def.now.blocker } : state === 'working' ? detail('working', def, random) : {},
  });
  let end = from;
  while (end > born) {
    state = before(state, remote, random);
    const mean = {
      working: def.persona.work,
      idle: def.persona.idle,
      unseen: def.persona.unseen,
      blocked: def.persona.block,
    }[state];
    from = Math.max(born, end - sample(mean, random));
    drafts.unshift({ state, from, to: end, extra: detail(state, def, random) });
    end = from;
  }
  // It was launched with a prompt: the first thing it did was work.
  const first = drafts[0]!;
  if (first.state !== 'working') {
    drafts[0] = { ...first, state: 'working', extra: detail('working', def, random) };
    const second = drafts[1];
    if (second?.state === 'working') {
      second.from = first.from;
      drafts.shift();
    }
  }
  const spans = drafts.map((draft) => ({
    status: draft.state,
    fromMs: draft.from,
    ...(draft.to === undefined ? {} : { toMs: draft.to }),
    ...draft.extra,
  }));
  return { spans, born, ...(ended === undefined ? {} : { ended }) };
}

function buildTerminalSpans(def: TerminalDef, nowMs: number): MonitorHistorySpan[] {
  const random = seeded(def.id);
  const born = nowMs - def.born;
  const spans: MonitorHistorySpan[] = [{ status: def.now.running ? 'working' : 'idle', fromMs: nowMs - def.now.ago }];
  let end = nowMs - def.now.ago;
  let running = def.now.running;
  while (end > born) {
    running = !running;
    const length = running ? sample(3 * MIN, random, 20 * SEC) : sample(16 * MIN, random);
    const from = Math.max(born, end - length);
    spans.unshift({ status: running ? 'working' : 'idle', fromMs: from, toMs: end });
    end = from;
  }
  return spans;
}

function remoteFacet(id: string, device: Exclude<DeviceId, 'here'>, project: string): MonitorRemoteFacet {
  return {
    deviceId: device,
    deviceName: DEVICES[device].name,
    remoteSessionId: `${device}-${id}`,
    attachable: true,
    hostWritable: true,
    cwdLabel: project,
  };
}

export interface TimelineWorld {
  readonly agents: MonitorAgent[];
  readonly history: MonitorHistoryBook;
}

/**
 * The example afternoon at `nowMs`: the rows (in no particular order — the view
 * orders them) and the book of what each did. `tint` is the theme's (`--tint-l`,
 * `--tint-c`); the project and pane colours are dealt from it as a host deals them.
 */
export function timelineWorld(nowMs: number, tint: ProjectTint = DEFAULT_PROJECT_TINT.light): TimelineWorld {
  const agents: MonitorAgent[] = [];
  const ended: MonitorAgent[] = [];
  const lanes = new Map<string, MonitorLaneHistory>();
  const mounted = (id: string): Partial<MonitorAgent> => {
    const pane = PANES[id];
    if (!pane) return {};
    return {
      active: pane.active,
      attachment: { primaryPaneId: `pane-${pane.seq}`, paneIds: [`pane-${pane.seq}`], color: paneTint(pane.seq, tint) },
    };
  };

  for (const def of AGENTS) {
    const built = buildSpans(def, nowMs);
    const open = built.spans[built.spans.length - 1]!;
    const status = open.status === 'unseen' ? 'idle' : open.status;
    const base = agentFixture(
      {
        id: def.id,
        project: def.project,
        status,
        mark: def.mark,
        ...(def.model ? { model: def.model } : {}),
        ...(def.branch ? { branch: def.branch } : {}),
        ...(status === 'working' && open.did ? { activity: { kind: 'tool', line: open.did } } : {}),
        ...(open.blocker
          ? { blocker: open.blocker.kind as MonitorBlocker['kind'], blockerDetail: open.blocker.detail ?? '' }
          : {}),
        ...(open.blocker?.kind === 'question' && open.blocker.detail ? { question: open.blocker.detail } : {}),
      },
      nowMs,
    );
    const { session, ...rest } = base;
    const facet = base.agent!;
    const row: MonitorAgent = {
      ...rest,
      ...(def.device === 'here' ? { session: { ...session!, createdAtMs: built.born } } : {}),
      ...(def.device === 'here' ? {} : { remote: remoteFacet(def.id, def.device, def.project) }),
      tier: def.device === 'here' ? 'managed' : 'remote',
      createdAtMs: built.born,
      color: projectTint(PROJECT_SEQ[def.project] ?? 9, tint),
      ...(open.status === 'unseen' ? { unread: true } : {}),
      ...mounted(def.id),
      agent: { ...facet, monitor: { ...facet.monitor!, statusSince: new Date(open.fromMs).toISOString() } },
    };
    lanes.set(def.id, {
      recordedFromMs: Math.max(built.born, nowMs - RECORD_FROM[def.device]),
      spans: built.spans,
      ...(built.ended === undefined ? {} : { endedAtMs: built.ended }),
    });
    if (built.ended === undefined) agents.push(row);
    else ended.push(row);
  }

  for (const def of TERMINALS) {
    const spans = buildTerminalSpans(def, nowMs);
    const born = nowMs - def.born;
    const base = terminalFixture(def.id, def.project, def.now.running, nowMs);
    agents.push({
      ...base,
      createdAtMs: born,
      session: { ...base.session!, createdAtMs: born },
      ...mounted(def.id),
    });
    lanes.set(def.id, { recordedFromMs: Math.max(born, nowMs - RECORD_FROM.here), spans });
  }

  return { agents, history: { lanes, ended } };
}
