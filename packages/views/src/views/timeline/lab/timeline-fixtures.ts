import type { AgentView, MonitorDeviceRef, MonitorWait, ProjectTint } from '@vibecook/puppeteer-view-sdk';
import {
  AGENT_MARK_PROVIDERS,
  DEFAULT_PROJECT_TINT,
  paneColour,
  projectColour,
} from '@vibecook/puppeteer-view-sdk/toolkit';

// The timeline's example afternoon: the prototype's world
// (`draft/godview-timeline/site/tl-core.js`) as the rows a host's replica hands
// the view. Nine agents across six projects, six on this desktop and three on
// two peers, and two terminals: each one born somewhere in the afternoon, in
// its current state since the moment its row says (`statusSince`).
//
// Runtime only (MV-6): there is no book of what each lane did before, so the
// view draws each lane unrecorded from its birth to its current state; and an
// agent that ended is not in the model, so it is not here either.

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
