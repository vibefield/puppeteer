import {
  presentAgentMonitorHeadline,
  type AgentMonitorState,
  type MonitorActivityKind,
  type MonitorBlocker,
} from '@vibecook/puppeteer-core';
import { DEFAULT_PROJECT_TINT, paneTint, projectTint, type ProjectTint } from '../colour/project-tint.js';
import { formatUsd } from '../monitor/cost-format.js';
import { folderName } from '../monitor/folder-name.js';
import type { MonitorHistoryBook, MonitorHistorySpan, MonitorLaneHistory } from '../monitor/status-history.js';
import type { MonitorAgent, MonitorRemoteFacet } from '../monitor/types.js';
import { agentFixture, terminalFixture, type BurnShape } from '../views/swarm/lab/fixtures.js';

// The seeded world the labs and the goldens share (MV-0): a field of `n` rows
// drawn from twenty archetypes that between them hold every state a view has to
// draw — each status, both waits, a failure, unread, receded, stale, bare
// terminals running and idle, peers, overlong names and missing facets — at a
// fixed clock, so the same `n` and seed are the same rows, byte for byte, on
// every machine and every run. A view's golden is only as good as the input it
// was drawn from, so nothing here reads the wall clock or `Math.random`.

/** The labs' and goldens' clock: every age, span and burn is measured back from it. */
export const LAB_NOW_MS = Date.parse('2026-10-03T15:00:00.000Z');
export const LAB_SEED = 'mv0';
/** The fields MV-0 records: none, one, a working afternoon, a crowd. */
export const LAB_AGENT_COUNTS = [0, 1, 20, 60] as const;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A small seeded generator (FNV-1a into mulberry32): the same text, the same sequence. */
export function seededRandom(text: string): () => number {
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

const PROJECTS = [
  'vibe-field',
  'puppeteer',
  'rosetta',
  'billing-api',
  'refactor-auth',
  'ghosttea',
  'swarm-lab',
  'truffle',
  'design-kit',
  'notes',
] as const;
const LONG_PROJECT = 'an-unusually-long-project-folder-name-that-overflows-every-label';
const MODELS = ['Opus 4.5', 'GPT-5', 'Sonnet 4.5', 'K2', 'Haiku 4.5'] as const;
const BRANCHES = ['main', 'mv/mv0-pu', 'billing/ledger-reader', 'refactor-auth', 'fix/usage-login'] as const;
const TOOL_LINES = [
  'Edit packages/views/src/lab/lab-world.ts +214 −18',
  'Run pnpm verify',
  'Read docs/rfcs/004-layered-agent-runtime.md',
  'Run cargo test -p ledger',
  'Edit src/write.rs +40 −12',
  'Grep "createMonitorBackend" packages/',
] as const;
const PERMISSIONS = ['Bash · pnpm verify', 'Bash · git push origin main', 'Edit · src/write.rs'] as const;
const QUESTIONS = [
  'Should the grant expire with the session, or after an hour?',
  'Keep the old export behind a flag, or drop it?',
  'Squash these four commits before the push?',
] as const;
const REPLIES = [
  'Done — 14 files changed, verify is green.',
  'The migration is written; the rollback needs your eyes before I run it.',
  'Benchmarks are in: the new path is 3.1× faster at n = 60.',
] as const;
const PEERS = [
  { id: 'studio', name: 'studio' },
  { id: 'tower', name: 'tower' },
] as const;

type Archetype =
  | 'working-full'
  | 'blocked-permission'
  | 'blocked-question'
  | 'idle-unread'
  | 'terminal-running'
  | 'peer-working'
  | 'working-blaze'
  | 'idle-plain'
  | 'receded-working'
  | 'blocked-failure'
  | 'starting'
  | 'idle-stale'
  | 'peer-blocked'
  | 'terminal-idle'
  | 'long-names'
  | 'bare-facets'
  | 'receded-idle-unread'
  | 'peer-idle'
  | 'working-delegating'
  | 'working-ingested';

/** One of each, in the order a field of `n` takes them: `n = 1` is the first, `n = 20` holds all. */
const ARCHETYPES: readonly Archetype[] = [
  'working-full',
  'blocked-permission',
  'blocked-question',
  'idle-unread',
  'terminal-running',
  'peer-working',
  'working-blaze',
  'idle-plain',
  'receded-working',
  'blocked-failure',
  'starting',
  'idle-stale',
  'peer-blocked',
  'terminal-idle',
  'long-names',
  'bare-facets',
  'receded-idle-unread',
  'peer-idle',
  'working-delegating',
  'working-ingested',
];

export interface LabWorldOptions {
  readonly n: number;
  readonly nowMs?: number | undefined;
  readonly seed?: string | undefined;
  /** The theme's lightness and chroma (`palette.tint`): project and pane colours are dealt from it as a host deals them. */
  readonly tint?: ProjectTint | undefined;
  /** The ramp a bare terminal wears (`palette.neutral`): a resolved colour, because the rain paints it into a canvas. */
  readonly neutral?: string | undefined;
}

export interface LabWorld {
  readonly nowMs: number;
  /** Agents first, then peers' rows, then bare terminals — the order a host assembles them in. */
  readonly agents: readonly MonitorAgent[];
  /** What each lane did since it was born, and one agent that ended (TL-D6), for the views that draw the past. */
  readonly history: MonitorHistoryBook;
}

interface Row {
  readonly agent: MonitorAgent;
  readonly group: 0 | 1 | 2;
  /** The lane's current state as a book records it (`unseen` for an unread idle). */
  readonly state: MonitorHistorySpan['status'];
  readonly since: number;
  readonly born: number;
  readonly blocker?: MonitorHistorySpan['blocker'];
  readonly did?: string;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length) % items.length]!;
const between = (low: number, high: number, random: () => number): number => low + (high - low) * random();
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The world at `nowMs` (default `LAB_NOW_MS`): `n` rows, the `i`th taking
 * archetype `i mod 20` with its own seeded ages, burn and words, so `n = 20`
 * holds one of each and `n = 60` three. One row is the active pane's.
 */
export function labWorld(options: LabWorldOptions): LabWorld {
  const nowMs = options.nowMs ?? LAB_NOW_MS;
  const seed = options.seed ?? LAB_SEED;
  const tint = options.tint ?? DEFAULT_PROJECT_TINT.light;
  const neutral = options.neutral ?? 'var(--text-faint)';
  const n = Math.max(0, Math.floor(options.n));
  // The host deals a project its sequence the first time an agent runs in it.
  const sequences = new Map<string, number>();
  const projectColour = (project: string): string => {
    if (!sequences.has(project)) sequences.set(project, sequences.size);
    return projectTint(sequences.get(project)!, tint);
  };
  let panes = 0;
  const mountIn = (count: number, active: boolean): Partial<MonitorAgent> => {
    const ids = Array.from({ length: count }, () => `pane-${panes++}`);
    return { active, attachment: { primaryPaneId: ids[0]!, paneIds: ids, color: paneTint(panes - count, tint) } };
  };

  const rows: Row[] = [];
  for (let index = 0; index < n; index += 1) {
    const archetype = ARCHETYPES[index % ARCHETYPES.length]!;
    const cycle = Math.floor(index / ARCHETYPES.length);
    const id = cycle === 0 ? archetype : `${archetype}-${cycle + 1}`;
    const random = seededRandom(`${seed}:${id}`);
    rows.push(
      buildRow({
        archetype,
        cycle,
        id,
        random,
        nowMs,
        neutral,
        projectColour,
        mountIn,
        project: PROJECTS[index % 10]!,
      }),
    );
  }
  rows.sort((left, right) => left.group - right.group);

  const lanes = new Map<string, MonitorLaneHistory>();
  for (const row of rows) lanes.set(row.agent.id, laneOf(row, nowMs, seed));
  const ended: MonitorAgent[] = [];
  if (n >= ARCHETYPES.length) {
    // One agent that finished an hour ago: the timeline keeps its lane (TL-D6).
    const born = nowMs - 3 * HOUR;
    const endedAt = nowMs - 52 * MIN;
    const base = agentFixture({ id: 'ended', project: 'changelog', status: 'idle', model: 'Sonnet 4.5' }, nowMs);
    const { session, ...rest } = base;
    ended.push({
      ...rest,
      session: { ...session!, createdAtMs: born, cwd: '/Users/james/Projects/changelog' },
      createdAtMs: born,
      color: projectColour('changelog'),
      tier: 'managed',
      detail: detailOf(rest.agent!.monitor!, rest.agent!.usage?.total),
    });
    lanes.set('ended', {
      recordedFromMs: born,
      spans: [
        { status: 'working', fromMs: born, toMs: born + 40 * MIN, did: 'Edit CHANGELOG.md +41 −0' },
        { status: 'idle', fromMs: born + 40 * MIN, toMs: endedAt },
      ],
      endedAtMs: endedAt,
    });
  }
  return { nowMs, agents: rows.map((row) => row.agent), history: { lanes, ended } };
}

interface BuildInput {
  archetype: Archetype;
  cycle: number;
  id: string;
  project: string;
  random: () => number;
  nowMs: number;
  neutral: string;
  projectColour(project: string): string;
  mountIn(count: number, active: boolean): Partial<MonitorAgent>;
}

interface AgentShape {
  status: 'working' | 'blocked' | 'idle';
  model?: string | undefined;
  branch?: string | undefined;
  activity?: { kind: MonitorActivityKind; line: string } | undefined;
  blocker?: MonitorBlocker['kind'] | undefined;
  blockerDetail?: string | undefined;
  question?: string | undefined;
  message?: string | undefined;
  contextPercent?: number | undefined;
  burn?: BurnShape | undefined;
  tokens?: number | undefined;
  ratePerMin?: number | undefined;
  unpriced?: boolean | undefined;
  effort?: string | undefined;
  stale?: boolean | undefined;
}

function buildRow(input: BuildInput): Row {
  const { archetype, cycle, id, random, nowMs } = input;
  const born = nowMs - Math.round(between(25 * MIN, 5 * HOUR, random));
  const working = (): AgentShape => ({
    status: 'working',
    model: pick(MODELS, random),
    branch: pick(BRANCHES, random),
    activity: { kind: 'tool', line: pick(TOOL_LINES, random) },
    contextPercent: Math.round(between(8, 70, random)),
    burn: pick(['steady', 'ease', 'ember'] as const, random),
    tokens: Math.round(between(0.2, 4, random) * 1_000_000),
    ratePerMin: Number(between(0.02, 0.4, random).toFixed(3)),
  });
  const idle = (): AgentShape => ({
    status: 'idle',
    model: pick(MODELS, random),
    branch: pick(BRANCHES, random),
    contextPercent: Math.round(between(10, 60, random)),
    burn: 'ember',
    tokens: Math.round(between(0.1, 2, random) * 1_000_000),
    ratePerMin: 0,
  });
  const blocked = (kind: MonitorBlocker['kind']): AgentShape => {
    // A question's line is the question as asked; a permission's, the tool and its input.
    const words =
      kind === 'permission' ? pick(PERMISSIONS, random) : kind === 'question' ? pick(QUESTIONS, random) : undefined;
    return {
      ...working(),
      status: 'blocked',
      activity: undefined,
      blocker: kind,
      blockerDetail: words ?? 'rate limited · retrying',
      ...(kind === 'question' ? { question: words } : {}),
      message: pick(REPLIES, random),
    };
  };
  const agent = (shape: AgentShape, since: number, extra: Partial<MonitorAgent> = {}, project = input.project): Row => {
    const base = agentFixture(
      {
        id,
        project,
        status: shape.status,
        mark: Math.floor(random() * 8),
        ...(shape.model ? { model: shape.model } : {}),
        ...(shape.branch ? { branch: shape.branch } : {}),
        ...(shape.activity ? { activity: shape.activity } : {}),
        ...(shape.blocker ? { blocker: shape.blocker, blockerDetail: shape.blockerDetail ?? '' } : {}),
        ...(shape.question ? { question: shape.question } : {}),
        ...(shape.message ? { message: shape.message } : {}),
        ...(shape.contextPercent === undefined ? {} : { contextPercent: shape.contextPercent }),
        ...(shape.burn ? { burn: shape.burn } : {}),
        ...(shape.tokens === undefined ? {} : { tokens: shape.tokens }),
        ...(shape.ratePerMin === undefined ? {} : { ratePerMin: shape.ratePerMin }),
        ...(shape.unpriced ? { unpriced: true } : {}),
        ...(shape.effort ? { effort: shape.effort } : {}),
        ...(shape.stale ? { stale: true } : {}),
      },
      nowMs,
    );
    const facet = base.agent!;
    const evidence = shape.stale ? nowMs - 14 * MIN : nowMs - Math.round(between(2, 40, random)) * SEC;
    const monitor = {
      ...facet.monitor!,
      statusSince: iso(since),
      freshness: { ...facet.monitor!.freshness, lastEvidenceAt: iso(evidence) },
    };
    const cwd = `/Users/james/Projects/${project}`;
    const row: MonitorAgent = {
      ...base,
      session: { ...base.session!, createdAtMs: born, cwd },
      createdAtMs: born,
      cwd,
      color: input.projectColour(project),
      tier: 'managed',
      detail: detailOf(monitor, facet.usage?.total),
      agent: { ...facet, monitor },
      ...extra,
    };
    return {
      agent: row,
      group: row.remote ? 1 : 0,
      state: shape.status === 'idle' && row.unread ? 'unseen' : shape.status,
      since,
      born,
      ...(shape.blocker ? { blocker: { kind: shape.blocker, detail: shape.blockerDetail } } : {}),
      ...(shape.activity ? { did: shape.activity.line } : {}),
    };
  };
  const peer = (shape: AgentShape, since: number, overrides: Partial<MonitorRemoteFacet> = {}): Row => {
    const device = PEERS[(cycle + id.length) % PEERS.length]!;
    const built = agent(shape, since);
    // A peer's row has no terminal here and no path to resolve: only the peer's own label.
    const { session: _session, cwd: _cwd, ...rest } = built.agent;
    const remote: MonitorRemoteFacet = {
      deviceId: device.id,
      deviceName: device.name,
      remoteSessionId: `${device.id}-${id}`,
      attachable: true,
      hostWritable: true,
      cwdLabel: input.project,
      ...overrides,
    };
    return { ...built, agent: { ...rest, remote, tier: 'remote' }, group: 1 };
  };
  const terminal = (running: boolean, project: string, since: number): Row => {
    const base = terminalFixture(id, project, running, nowMs);
    const cwd = project === '~' ? '/Users/james' : `/Users/james/Projects/${project}`;
    return {
      agent: {
        ...base,
        session: { ...base.session!, createdAtMs: born, cwd },
        createdAtMs: born,
        project: folderName(cwd, 'terminal'),
        cwd,
        detail: cwd,
        color: input.neutral,
      },
      group: 2,
      state: running ? 'working' : 'idle',
      since,
      born,
    };
  };
  const ago = (low: number, high: number): number => nowMs - Math.round(between(low, high, random));

  switch (archetype) {
    case 'working-full':
      return agent({ ...working(), contextPercent: 41, burn: 'steady' }, ago(4 * MIN, 30 * MIN), {
        ...input.mountIn(1, cycle === 0),
      });
    case 'blocked-permission':
      return agent(blocked('permission'), ago(MIN, 9 * MIN), input.mountIn(1, false));
    case 'blocked-question':
      return agent(blocked('question'), ago(2 * MIN, 14 * MIN));
    case 'idle-unread':
      return agent({ ...idle(), burn: 'ease', message: pick(REPLIES, random) }, ago(30 * SEC, 6 * MIN), {
        unread: true,
      });
    case 'terminal-running':
      return terminal(true, input.project, ago(20 * SEC, 4 * MIN));
    case 'peer-working':
      return peer(working(), ago(3 * MIN, 25 * MIN));
    case 'working-blaze':
      return agent(
        { ...working(), burn: 'blaze', contextPercent: 92, tokens: 12_400_000, ratePerMin: 1.42, effort: 'high' },
        ago(10 * MIN, 50 * MIN),
      );
    case 'idle-plain':
      return agent(idle(), ago(8 * MIN, 50 * MIN));
    case 'receded-working':
      return agent(working(), ago(2 * MIN, 20 * MIN), { receded: true, profileSet: 'work' });
    case 'blocked-failure':
      return agent(blocked('failure'), ago(MIN, 5 * MIN));
    case 'starting': {
      // Spawned, and not heard from yet: the host shows a row before the first state.
      const built = agent({ status: 'idle', model: pick(MODELS, random) }, ago(2 * SEC, 9 * SEC));
      const { monitor: _monitor, contextWindow: _context, usage: _usage, ...facet } = built.agent.agent!;
      const session = { ...built.agent.session!, createdAtMs: built.since };
      return {
        ...built,
        born: built.since,
        agent: { ...built.agent, session, createdAtMs: built.since, detail: 'starting', agent: facet },
      };
    }
    case 'idle-stale':
      return agent({ ...idle(), stale: true }, ago(20 * MIN, 70 * MIN));
    case 'peer-blocked':
      return peer(blocked('permission'), ago(MIN, 12 * MIN), { hostWritable: false });
    case 'terminal-idle':
      return terminal(false, '~', ago(5 * MIN, 40 * MIN));
    case 'long-names':
      return agent(
        {
          ...working(),
          model: 'opus-4-5-20251101 (extended thinking, a million tokens of context)',
          branch: 'feature/mv-0-a-branch-name-long-enough-to-overflow-any-column',
          activity: {
            kind: 'tool',
            line: 'Edit packages/views/src/views/timeline/lab/a-path-that-goes-on-for-a-very-long-way/main.ts +1024 −512',
          },
        },
        ago(MIN, 15 * MIN),
        {},
        LONG_PROJECT,
      );
    case 'bare-facets':
      // A provider that reports no model, no branch, no context and no prices.
      return agent({ status: 'working', unpriced: true }, ago(MIN, 10 * MIN));
    case 'receded-idle-unread':
      return agent({ ...idle(), message: pick(REPLIES, random) }, ago(MIN, 8 * MIN), {
        receded: true,
        unread: true,
        profileSet: 'work',
      });
    case 'peer-idle':
      return peer(idle(), ago(10 * MIN, 60 * MIN), { attachable: false, cwdLabel: null });
    case 'working-delegating':
      return agent(
        { ...working(), activity: { kind: 'delegating', line: 'Delegating to 3 subagents' } },
        ago(3 * MIN, 18 * MIN),
        { profileSet: 'native' },
      );
    case 'working-ingested':
      return agent(
        { ...working(), activity: { kind: 'reasoning', line: 'Thinking' } },
        ago(MIN, 12 * MIN),
        // Shown in two panes, primary first: the second draws as a mirror stripe.
        { tier: 'ingested', ...input.mountIn(2, false) },
      );
  }
}

/** The detail line as Godview's host composes it: the headline, more blockers, the cost and the burn. */
function detailOf(monitor: AgentMonitorState, total?: number): string {
  const headline = presentAgentMonitorHeadline(monitor);
  const cost = total ?? monitor.usage.costUsd;
  const coverage = monitor.usage.costCoverage;
  const burn = monitor.usage.costRatePerMin;
  return [
    headline.detail,
    headline.blockerCount > 1 ? `+${headline.blockerCount - 1} blockers` : undefined,
    cost === undefined
      ? 'cost unavailable'
      : `~${formatUsd(cost)} estimated API cost${coverage === 'partial' ? ' (partial)' : ''}`,
    burn === undefined ? undefined : `${formatUsd(burn)}/min`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

/** A lane's past, walked back from its current state to its birth: work, then a wait or a rest, then work again. */
function laneOf(row: Row, nowMs: number, seed: string): MonitorLaneHistory {
  const random = seededRandom(`${seed}:lane:${row.agent.id}`);
  const terminal = !row.agent.agent;
  const spans: MonitorHistorySpan[] = [
    {
      status: row.state,
      fromMs: row.since,
      ...(row.blocker ? { blocker: row.blocker } : {}),
      ...(row.did ? { did: row.did } : {}),
    },
  ];
  let state = row.state;
  let end = row.since;
  while (end > row.born) {
    state =
      state === 'working'
        ? terminal
          ? 'idle'
          : pick(['idle', 'blocked', 'unseen', 'idle'] as const, random)
        : 'working';
    const mean = state === 'working' ? (terminal ? 3 * MIN : 16 * MIN) : state === 'blocked' ? 3 * MIN : 8 * MIN;
    const from = Math.max(row.born, end - Math.round(between(0.4, 1.8, random) * mean));
    spans.unshift({
      status: state,
      fromMs: from,
      toMs: end,
      ...(state === 'working' && !terminal ? { did: pick(TOOL_LINES, random) } : {}),
      ...(state === 'blocked' ? { blocker: { kind: 'permission', detail: pick(PERMISSIONS, random) } } : {}),
    });
    end = from;
  }
  // A local lane is kept from when the host started; a peer's from when it was first heard.
  const horizon = row.agent.remote ? 2 * HOUR + 20 * MIN : 5 * HOUR + 40 * MIN;
  return { recordedFromMs: Math.max(row.born, nowMs - horizon), spans };
}
