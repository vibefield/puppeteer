import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState, MonitorBlocker } from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../../../protocol.js';
import type { DifferentialEvent, DifferentialFrame, DifferentialScenario, WindowState } from './harness.js';

/**
 * Synthesized, deterministic scenarios for the MV-2 differential: every event
 * the old seam and the backend read, at fixed times, covering what Godview's
 * rows go through — a launch from a fresh pane, the first state, work, both
 * blocker kinds the swarm words, replies, cost, unread, staleness, a crash kept
 * until acknowledged, a handoff to a shell, bare terminals in their lives,
 * promotion of a shell to an agent, a resumed conversation, project folding and
 * accounts, and seeded churn at n = 10 and 20.
 */

export const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Core's git facts for a directory: a branch, or a detached HEAD (`null`). */
function git(branch: string | null): NonNullable<AgentMonitorState['environment']['git']> {
  return { root: '/repos', branch, headSha: null, detached: branch === null };
}

function activity(
  kind: NonNullable<AgentMonitorState['activity']>['kind'],
  at: number,
  line = '',
): NonNullable<AgentMonitorState['activity']> {
  return { kind, line, since: iso(at) };
}

function context(usedPercent: number, at = T0): NonNullable<AgentMonitorState['context']> {
  return { usedPercent, percentageSource: 'provider', asOf: iso(at) };
}

export function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    exited: false,
    createdAtMs: T0 - 60_000,
    cwd: '/repos/app',
    activity: { kind: 'idle' },
    cols: 80,
    rows: 24,
    ...overrides,
  } as SessionSummary;
}

export interface InfoOptions {
  readonly runtimeRunId?: string;
  readonly epoch?: number;
  readonly provider?: { id: string; label: string };
  readonly createdAt?: number;
  readonly cwd?: string;
  readonly workspace?: { root: string; sourcePath?: string; branch?: string };
  readonly project?: { key: string; name: string; seq: number };
  readonly profileId?: string;
  readonly nativeSessionId?: string;
}

export function info(sessionId: string, options: InfoOptions = {}): AgentSessionInfo {
  const runtimeRunId = options.runtimeRunId ?? `run-${sessionId}`;
  const workspace = options.workspace ?? { root: '/repos/app', sourcePath: '/repos/app' };
  return {
    provider: options.provider ?? { id: 'codex', label: 'Codex' },
    agent: (options.provider ?? { id: 'codex' }).id,
    runtimeRunId,
    runtimeEpoch: options.epoch ?? 1,
    terminalSessionId: sessionId,
    runtimeSessionId: sessionId,
    nativeSession: { id: options.nativeSessionId ?? '' },
    nativeSessionRevision: 0,
    continuation: {},
    externalRefs: [],
    sessionId: options.nativeSessionId ?? '',
    workspace: { mode: 'direct', ...workspace },
    ...(options.profileId ? { profileId: options.profileId } : {}),
    session: session(sessionId, {
      createdAtMs: options.createdAt ?? T0,
      cwd: options.cwd ?? workspace.root,
    }),
    ...(options.project ? { project: options.project } : {}),
  } as unknown as AgentSessionInfo;
}

export interface StateOptions extends Partial<Omit<AgentMonitorState, 'statusSince' | 'freshness'>> {
  readonly at: number;
  /** When the status began; default `at`. */
  readonly since?: number;
  /** The last evidence; default `at`. */
  readonly evidence?: number;
}

export function state(runtimeRunId: string, options: StateOptions): AgentMonitorState {
  const { at, since, evidence, ...rest } = options;
  return {
    schemaVersion: 3,
    runtimeEpoch: 1,
    revision: 1,
    runtimeRunId,
    status: 'working',
    statusSince: iso(since ?? at),
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(evidence ?? at) },
    alive: true,
    ...rest,
  };
}

const ev = {
  remember: (value: AgentSessionInfo): DifferentialEvent => ({ type: 'remember', info: value }),
  info: (value: AgentSessionInfo): DifferentialEvent => ({ type: 'info', info: value }),
  state: (value: AgentMonitorState): DifferentialEvent => ({ type: 'state', state: value }),
  removed: (runtimeRunId: string): DifferentialEvent => ({ type: 'removed', runtimeRunId }),
  exited: (sessionId: string): DifferentialEvent => ({ type: 'process-exited', sessionId }),
  handoff: (previousSessionId: string, next: SessionSummary): DifferentialEvent => ({
    type: 'handoff',
    previousSessionId,
    session: next,
  }),
  window: (patch: (window: WindowState) => void): DifferentialEvent => ({ type: 'window', patch }),
  labels: (labels: ReadonlyArray<readonly [string, string]>): DifferentialEvent => ({ type: 'labels', labels }),
};

const frame = (offset: number, ...events: DifferentialEvent[]): DifferentialFrame => ({ at: T0 + offset, events });

function setPanes(window: WindowState, panes: Array<[string, SessionSummary]>, active?: string): void {
  window.panes = panes.map(([id, value]) => ({ id, session: value }));
  for (const [id] of panes)
    if (!window.paneColours.has(id)) window.paneColours.set(id, `#c0${window.paneColours.size}`);
  window.activePaneId = active ?? window.activePaneId;
}

const permission = (at: number, tool: string, detail?: string): MonitorBlocker =>
  ({
    id: `perm-${at}`,
    kind: 'permission',
    since: iso(at),
    permission: { tool },
    ...(detail ? { detail } : {}),
  }) as MonitorBlocker;

const question = (at: number, header: string | undefined, prompt: string): MonitorBlocker =>
  ({
    id: `q-${at}`,
    kind: 'question',
    since: iso(at),
    questions: [{ ...(header ? { header } : {}), prompt, options: [] }],
  }) as unknown as MonitorBlocker;

const failure = (at: number, code: string, detail: string): MonitorBlocker =>
  ({ id: 'run:runtime', kind: 'failure', since: iso(at), failure: { code }, detail }) as MonitorBlocker;

const priced = (
  at: number,
  usd: number,
  rate: number,
  buckets: Array<[number, number]>,
): AgentMonitorState['usage'] => ({
  samples: [],
  costUsd: usd,
  costCoverage: 'complete',
  costRatePerMin: rate,
  cumulativeTokens: Math.round(usd * 100_000),
  costHistory: buckets.map(([offset, value]) => ({ at: iso(T0 + offset), costUsd: value })),
});

/** One agent's life: a launch from a fresh pane to its acknowledged crash, its pane handed to a shell. */
export function lifecycleScenario(): DifferentialScenario {
  const shell = session('sh-1', { createdAtMs: T0 - 60_000 });
  const agentSession = session('ag-1', { createdAtMs: T0 + 2_000, cwd: '/repos/app' });
  const handedShell = session('sh-3', { createdAtMs: T0 + 101_000, cwd: '/repos/app' });
  const run = 'run-ag-1';
  const base = { provider: { id: 'codex', label: 'Codex' }, createdAt: T0 + 2_000, nativeSessionId: 'n-1' } as const;
  const folded = { ...base, project: { key: '/repos/app', name: 'app', seq: 0 } };
  const environment: AgentMonitorState['environment'] = { cwd: '/repos/app/pkg', git: git('main'), worktrees: [] };
  const common = {
    model: { id: 'gpt-5', displayName: 'GPT-5' },
    effort: { value: 'high', intent: 'configured' },
    context: context(12),
    environment,
    session: { nativeSessionId: 'n-1' },
  } as Partial<AgentMonitorState>;
  return {
    name: 'lifecycle',
    start: T0,
    projects: [['/repos/app', 0]],
    frames: [
      frame(
        0,
        ev.window((w) => setPanes(w, [['p1', shell]], 'p1')),
      ),
      // The launcher starts an agent from the fresh pane and hands it the shell's body.
      frame(
        2_000,
        ev.remember(info('ag-1', base)),
        ev.window((w) => {
          w.visualIds.set('ag-1', w.visualIds.get('sh-1') ?? 'sh-1');
          setPanes(w, [['p1', agentSession]]);
          w.closing.add('sh-1');
        }),
      ),
      frame(3_000, ev.info(info('ag-1', folded))),
      frame(
        4_000,
        ev.state(
          state(run, {
            at: T0 + 4_000,
            revision: 1,
            activity: activity('tool', T0 + 4_000, 'Edit · src/a.ts'),
            usage: priced(4_000, 0.12, 0.03, [[0, 0.12]]),
            ...common,
          }),
        ),
      ),
      frame(
        20_000,
        ev.state(
          state(run, {
            at: T0 + 20_000,
            revision: 2,
            status: 'blocked',
            blockers: [permission(T0 + 20_000, 'Bash', 'rm -rf build')],
            usage: priced(20_000, 0.2, 0.04, [
              [0, 0.12],
              [0, 0.08],
            ]),
            ...common,
          }),
        ),
      ),
      frame(
        26_000,
        ev.state(
          state(run, {
            at: T0 + 26_000,
            revision: 3,
            status: 'blocked',
            blockers: [question(T0 + 26_000, 'Pick one', 'Which build?'), permission(T0 + 26_000, 'Edit')],
            usage: priced(26_000, 0.2, 0.04, [
              [0, 0.12],
              [0, 0.08],
            ]),
            ...common,
          }),
        ),
      ),
      frame(
        31_000,
        ev.state(
          state(run, {
            at: T0 + 31_000,
            revision: 4,
            status: 'idle',
            lastAssistantMessage: { text: '  Done. All tests pass.\nSee the log.', at: iso(T0 + 31_000), final: true },
            usage: priced(31_000, 0.45, 0.05, [
              [0, 0.2],
              [30_000, 0.25],
            ]),
            ...common,
          }),
        ),
      ),
      frame(
        35_000,
        ev.window((w) =>
          setPanes(
            w,
            [
              ['p1', agentSession],
              ['p2', session('sh-2', { createdAtMs: T0 + 35_000 })],
            ],
            'p2',
          ),
        ),
      ),
      frame(
        40_000,
        ev.state(
          state(run, {
            at: T0 + 40_000,
            revision: 5,
            activity: activity('responding', T0 + 40_000),
            usage: priced(40_000, 0.5, 0.06, [
              [0, 0.2],
              [30_000, 0.3],
            ]),
            ...common,
          }),
        ),
      ),
      // The turn finishes while the person works in the other pane: unread.
      frame(
        52_000,
        ev.state(
          state(run, {
            at: T0 + 52_000,
            revision: 6,
            status: 'idle',
            lastAssistantMessage: { text: 'Pushed the fix.', at: iso(T0 + 52_000), final: true },
            usage: priced(52_000, 0.6, 0.06, [
              [0, 0.2],
              [30_000, 0.4],
            ]),
            ...common,
          }),
        ),
      ),
      frame(
        60_000,
        ev.window((w) => (w.activePaneId = 'p1')),
      ),
      // Quiet long enough to be stale, on and between the 10 s ticks.
      frame(83_000),
      frame(90_000),
      frame(95_000),
      // The agent crashes: the row stays, blocked by its failure, until acknowledged.
      frame(
        100_000,
        ev.state(
          state(run, {
            at: T0 + 100_000,
            revision: 7,
            status: 'blocked',
            alive: false,
            blockers: [failure(T0 + 100_000, 'crash', 'exit 1')],
            usage: priced(100_000, 0.6, 0, [
              [0, 0.2],
              [30_000, 0.4],
            ]),
            ...common,
          }),
        ),
        ev.exited('ag-1'),
      ),
      frame(101_000, ev.handoff('ag-1', handedShell)),
      frame(110_000, ev.removed(run)),
      frame(111_000),
    ],
  };
}

/** Bare terminals in their lives: created where asked, busy and quiet, moved, mirrored, exited, closed. */
export function terminalsScenario(): DifferentialScenario {
  const a = session('sh-a', { cwd: '/notes', createdAtMs: T0 - 120_000 });
  const b = session('sh-b', { cwd: undefined, createdAtMs: T0 - 90_000 } as unknown as Partial<SessionSummary>);
  const c = session('sh-c', { cwd: undefined, createdAtMs: T0 + 2_000 } as unknown as Partial<SessionSummary>);
  return {
    name: 'terminals',
    start: T0,
    projects: [],
    frames: [
      frame(
        0,
        ev.window((w) =>
          setPanes(
            w,
            [
              ['p1', a],
              ['p2', b],
            ],
            'p1',
          ),
        ),
      ),
      // createAt: a shell born in the active pane, remembered with the folder it was asked in and where.
      frame(
        2_000,
        ev.window((w) => {
          w.explicit.push({ session: c, cwd: '/notes', spawnHint: { x: 120, y: 40 } });
          setPanes(w, [
            ['p1', c],
            ['p2', b],
          ]);
        }),
      ),
      frame(
        5_000,
        ev.window((w) =>
          setPanes(w, [
            ['p1', c],
            ['p2', { ...b, activity: { kind: 'foreground-job' } } as SessionSummary],
          ]),
        ),
      ),
      frame(
        8_000,
        ev.window((w) =>
          setPanes(w, [
            ['p1', c],
            ['p2', { ...b, cwd: '/repos/x', activity: { kind: 'foreground-job' } } as SessionSummary],
          ]),
        ),
      ),
      frame(
        10_000,
        ev.window((w) =>
          setPanes(w, [
            ['p1', c],
            ['p2', w.panes[1]!.session],
            ['p3', c],
          ]),
        ),
      ),
      frame(
        12_000,
        ev.window((w) => (w.activePaneId = 'p3')),
      ),
      frame(
        15_000,
        ev.window((w) => {
          w.exited.add('sh-b');
          setPanes(w, [
            ['p1', c],
            ['p2', { ...w.panes[1]!.session, exited: true } as SessionSummary],
            ['p3', c],
          ]);
        }),
      ),
      frame(
        18_000,
        ev.window((w) => {
          w.closing.add('sh-c');
          setPanes(w, [['p2', w.panes[1]!.session]], 'p2');
        }),
      ),
      frame(
        20_000,
        ev.window((w) => {
          w.explicit = w.explicit.filter((terminal) => terminal.session.id !== 'sh-c');
          w.exited.add('sh-c');
        }),
      ),
    ],
  };
}

/** A shell an agent is adopted in (no row before the first state, then promoted in place), resumed, then a new conversation. */
export function promotionScenario(): DifferentialScenario {
  const shell = session('sh-p', { cwd: '/repos/app', createdAtMs: T0 - 30_000 });
  const run = 'run-p';
  const project = { key: '/repos/app', name: 'app', seq: 3 };
  const adopted = (nativeSessionId: string, epoch = 1) =>
    info('sh-p', { runtimeRunId: run, epoch, createdAt: T0 - 30_000, project, nativeSessionId, profileId: 'p-1' });
  const common = { environment: { cwd: '/repos/app', worktrees: [] } } as Partial<AgentMonitorState>;
  return {
    name: 'promotion and resume',
    start: T0,
    projects: [['/repos/app', 3]],
    frames: [
      frame(
        0,
        ev.window((w) => setPanes(w, [['p1', shell]], 'p1')),
        ev.labels([['p-1', 'me@work']]),
      ),
      frame(3_000, ev.remember(adopted(''))),
      frame(5_000, ev.state(state(run, { at: T0 + 5_000, activity: activity('starting', T0 + 5_000), ...common }))),
      frame(
        10_000,
        ev.info(adopted('n-p')),
        ev.state(
          state(run, {
            at: T0 + 10_000,
            revision: 2,
            activity: activity('reasoning', T0 + 10_000),
            session: { nativeSessionId: 'n-p' },
            usage: priced(10_000, 0.3, 0.02, [[0, 0.3]]),
            ...common,
          }),
        ),
      ),
      frame(
        40_000,
        ev.state(
          state(run, {
            at: T0 + 40_000,
            revision: 3,
            status: 'idle',
            session: { nativeSessionId: 'n-p' },
            usage: priced(40_000, 0.5, 0, [
              [0, 0.3],
              [30_000, 0.2],
            ]),
            ...common,
          }),
        ),
      ),
      // Resumed: a new epoch of the same conversation adds up (M15, accumulate).
      frame(
        45_000,
        ev.info(adopted('n-p', 2)),
        ev.state(
          state(run, {
            at: T0 + 45_000,
            runtimeEpoch: 2,
            revision: 1,
            session: { nativeSessionId: 'n-p' },
            usage: priced(45_000, 0.1, 0.03, [[30_000, 0.1]]),
            ...common,
          }),
        ),
      ),
      frame(60_000, ev.labels([['p-1', 'me@home']])),
      // A different conversation in the same run resets the total.
      frame(
        70_000,
        ev.info(adopted('n-q', 3)),
        ev.state(
          state(run, {
            at: T0 + 70_000,
            runtimeEpoch: 3,
            revision: 1,
            session: { nativeSessionId: 'n-q' },
            usage: priced(70_000, 0.05, 0.01, [[60_000, 0.05]]),
            ...common,
          }),
        ),
      ),
      frame(80_000, ev.removed(run)),
      frame(81_000),
    ],
  };
}

/** Projects folded late, accounts, the branch from observation or the workspace, and a reply as long as Core keeps. */
export function projectsScenario(): DifferentialScenario {
  const panes: Array<[string, SessionSummary]> = [1, 2, 3, 4, 5].map((n) => [
    `p${n}`,
    session(`ag-${n}`, { createdAtMs: T0 + n * 1_000 }),
  ]);
  const longReply = `${'The migration touched every table; '.repeat(11)}…`.slice(0, 401);
  const late = info('ag-2', { createdAt: T0 + 2_000, workspace: { root: '/repos/site', branch: 'dev' } });
  return {
    name: 'projects, accounts, branches',
    start: T0,
    projects: [
      ['/repos/app', 0],
      ['/repos/site', 1],
    ],
    frames: [
      frame(
        0,
        ev.labels([['p-1', 'work account']]),
        ev.window((w) => setPanes(w, panes, 'p5')),
        ev.remember(
          info('ag-1', {
            createdAt: T0 + 1_000,
            profileId: 'p-1',
            project: { key: '/repos/app', name: 'app', seq: 0 },
          }),
        ),
        ev.remember(late),
        ev.remember(info('ag-3', { createdAt: T0 + 3_000, workspace: { root: '/tmp/scratch', branch: 'wip' } })),
        ev.remember(
          info('ag-4', {
            createdAt: T0 + 4_000,
            workspace: { root: '/repos/app', branch: 'feat' },
            project: { key: '/repos/app', name: 'app', seq: 0 },
          }),
        ),
        ev.remember(
          info('ag-5', {
            createdAt: T0 + 5_000,
            provider: { id: 'claude', label: 'Claude Code' },
            project: { key: '/repos/app', name: 'app', seq: 0 },
          }),
        ),
      ),
      frame(
        2_000,
        ev.state(
          state('run-ag-1', {
            at: T0 + 2_000,
            environment: { cwd: '/repos/app/web', git: git('main'), worktrees: [] },
          }),
        ),
        ev.state(state('run-ag-2', { at: T0 + 2_000, environment: { cwd: '/repos/site', worktrees: [] } })),
        ev.state(state('run-ag-3', { at: T0 + 2_000, environment: { cwd: '/tmp/scratch', git: null, worktrees: [] } })),
        ev.state(state('run-ag-4', { at: T0 + 2_000, usage: { samples: [], costCoverage: 'unavailable' } })),
        ev.state(
          state('run-ag-5', {
            at: T0 + 2_000,
            status: 'idle',
            lastAssistantMessage: { text: longReply, at: iso(T0 + 2_000), final: true },
            model: { id: 'opus' },
            context: context(63.5),
          }),
        ),
      ),
      // ag-2's project is folded only now (main's registry answers late): until then it wore the ramp.
      frame(4_000, ev.info({ ...late, project: { key: '/repos/site', name: 'site', seq: 1 } } as AgentSessionInfo)),
      frame(
        6_000,
        ev.labels([['p-1', 'renamed account']]),
        // A detached HEAD: the observation names no branch, so Godview shows its workspace's (M26).
        ev.state(
          state('run-ag-4', {
            at: T0 + 6_000,
            revision: 2,
            environment: { cwd: '/repos/app', git: git(null), worktrees: [] },
          }),
        ),
      ),
      frame(
        9_000,
        ev.state(
          state('run-ag-1', {
            at: T0 + 9_000,
            revision: 2,
            status: 'blocked',
            blockers: [question(T0 + 9_000, undefined, '  Deploy to production?  ')],
            environment: { cwd: '/repos/app/web', git: git('main'), worktrees: [] },
          }),
        ),
      ),
    ],
  };
}

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded churn: `n` agents launched over a minute, each moving between work, waits and rest with cost, replies and blockers. */
export function churnScenario(n: number, seed: number): DifferentialScenario {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const projects: Array<readonly [string, number]> = [0, 1, 2, 3].map((index) => [`/repos/p${index}`, index] as const);
  const frames: DifferentialFrame[] = [];
  const agents = Array.from({ length: n }, (_, index) => ({
    sessionId: `ag-${index}`,
    run: `run-ag-${index}`,
    project: projects[index % projects.length]!,
    revision: 0,
    usd: 0,
    alive: true,
    removed: false,
    born: index * 2_000,
  }));
  const panes = agents
    .slice(0, Math.min(6, n))
    .map(
      (agent, index) =>
        [`p${index}`, session(agent.sessionId, { createdAtMs: T0 + agent.born })] as [string, SessionSummary],
    );
  frames.push(
    frame(
      0,
      ev.window((w) => setPanes(w, panes, 'p0')),
    ),
  );
  for (let offset = 1_000; offset <= 150_000; offset += 1_000 + Math.floor(next() * 2_500)) {
    const events: DifferentialEvent[] = [];
    for (const agent of agents) {
      if (agent.removed) continue;
      const [key, seq] = agent.project;
      if (agent.revision === 0 && offset >= agent.born) {
        const late = next() < 0.3;
        events.push(
          ev.remember(
            info(agent.sessionId, {
              createdAt: T0 + agent.born,
              workspace: { root: key, sourcePath: key },
              nativeSessionId: `n-${agent.sessionId}`,
              ...(late ? {} : { project: { key, name: key.split('/').pop()!, seq } }),
              ...(next() < 0.5 ? { profileId: 'p-1' } : {}),
            }),
          ),
        );
        agent.revision = 0.5;
        continue;
      }
      if (agent.revision === 0 || next() > 0.35) continue;
      if (agent.revision === 0.5) {
        events.push(
          ev.info(
            info(agent.sessionId, {
              createdAt: T0 + agent.born,
              workspace: { root: key, sourcePath: key },
              nativeSessionId: `n-${agent.sessionId}`,
              project: { key, name: key.split('/').pop()!, seq },
            }),
          ),
        );
        agent.revision = 0;
      }
      if (!agent.alive) {
        if (next() < 0.5) {
          events.push(ev.removed(agent.run));
          agent.removed = true;
        }
        continue;
      }
      agent.revision += 1;
      agent.usd = Math.round((agent.usd + next() * 0.2) * 1000) / 1000;
      const at = T0 + offset;
      const status = pick(['working', 'working', 'blocked', 'idle'] as const);
      const crash = next() < 0.04;
      const blocker = crash
        ? failure(at, 'crash', 'exit 1')
        : status === 'blocked'
          ? pick([
              permission(at, pick(['Bash', 'Edit', 'Write']), next() < 0.5 ? 'npm test' : undefined),
              question(at, next() < 0.5 ? 'Choose' : undefined, 'Which one?'),
            ])
          : undefined;
      events.push(
        ev.state(
          state(agent.run, {
            at,
            revision: Math.ceil(agent.revision),
            status: crash ? 'blocked' : status,
            alive: !crash,
            blockers: blocker ? [blocker] : [],
            ...(status === 'working' && !crash
              ? { activity: activity(pick(['tool', 'responding', 'reasoning'] as const), at, `step ${agent.revision}`) }
              : {}),
            ...(status === 'idle'
              ? { lastAssistantMessage: { text: `Reply ${agent.revision}.`, at: iso(at), final: true } }
              : {}),
            session: { nativeSessionId: `n-${agent.sessionId}` },
            environment: { cwd: key, worktrees: [] },
            model: { id: pick(['gpt-5', 'opus', 'kimi-k2']) },
            ...(next() < 0.6 ? { context: context(Math.round(next() * 1000) / 10, at) } : {}),
            usage: priced(offset, agent.usd, Math.round(next() * 100) / 1000, [
              [Math.floor(offset / 30_000) * 30_000, agent.usd],
            ]),
            evidence: next() < 0.1 ? at - 40_000 : at,
          }),
        ),
      );
      if (crash) {
        agent.alive = false;
        events.push(ev.exited(agent.sessionId));
      }
    }
    if (next() < 0.15) {
      const target = `p${Math.floor(next() * panes.length)}`;
      events.push(ev.window((w) => (w.activePaneId = target)));
    }
    if (next() < 0.05) events.push(ev.labels([['p-1', `account ${offset}`]]));
    frames.push(frame(offset, ...events));
  }
  return { name: `churn n=${n} seed=${seed}`, start: T0, projects, frames };
}
