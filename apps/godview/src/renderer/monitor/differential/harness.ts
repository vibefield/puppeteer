import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import {
  createMemoryProjectIdentityStore,
  createMonitorBackend,
  type AgentMonitorRemoval,
  type MonitorBackend,
  type MonitorClock,
  type MonitorRunSource,
} from '@vibecook/puppeteer-monitor';
import { createMonitorReplica, type MonitorReplica } from '@vibecook/puppeteer-monitor/replica';
import { createFrameScheduler } from '@vibecook/puppeteer-view-sdk/host';
import type { MonitorAgentRow } from '@vibecook/puppeteer-view-sdk/model';
import { projectColourFor } from '@vibecook/puppeteer-view-sdk/toolkit';
import type { MonitorAgent as ViewsMonitorAgent, ProjectTint } from '@vibecook/puppeteer-views';
import { MonitorIpcRelay } from '../../../main/monitor-ipc.js';
import { createGodviewMonitorHost, type GodviewMonitorHost } from '../../../main/monitor-host.js';
import type { AgentSessionInfo } from '../../../protocol.js';
import { buildPaneAttachments } from '../../pane-attachments.js';
import { createLegacyRows, type LegacyRows } from '../legacy-rows.js';
import type { MonitorAgent } from '../types.js';
import {
  agentSessionsByRow,
  mergeMonitorTerminals,
  terminalReport,
  windowLocal,
  windowTerminalIds,
  type MonitorTerminalRecord,
} from '../window-facts.js';
import { OldSeam } from './old-seam.js';

/**
 * The MV-2 differential: ONE scenario of runtime, host and window events drives
 * BOTH paths, and the rows each hands the views are compared frame by frame.
 *
 * - OLD (puppeteer 1afaff7): main's relay -> the renderer seam (`old-seam.ts`,
 *   frozen) -> `MonitorAgent[]`.
 * - NEW (this branch): the backend beside the runtime (`createMonitorBackend`
 *   with Godview's host port and options) -> its changes -> the window's replica
 *   (`setLocal` from `window-facts.ts`, the theme from the toolkit) -> the shim
 *   (`legacy-rows.ts`) -> `MonitorAgent[]`.
 *
 * Time is the scenario's: the old seam's `Date.now()` and its 10 s clock, the
 * backend's clock, are all the frame's `at`. Main's own side effects (its agent
 * records, the identities its handoffs deal) are shared, as in the app.
 */

export interface WindowState {
  /** This window's panes and the session each shows. */
  panes: Array<{ id: string; session: SessionSummary }>;
  activePaneId?: string | undefined;
  /** Terminals the window created itself (`createAt`), with where it was asked for them. */
  explicit: MonitorTerminalRecord[];
  exited: Set<string>;
  closing: Set<string>;
  /** Live terminal id -> stable monitor identity (handoffs). */
  identities: Map<string, string>;
  /** The swarm's carried bodies, by session (handoffs, launcher replacements). */
  visualIds: Map<string, string>;
  paneColours: Map<string, string>;
}

export type DifferentialEvent =
  /** Main remembers an agent (its record, the relay's terminal binding, the broadcast). */
  | { readonly type: 'remember'; readonly info: AgentSessionInfo }
  /** Main re-broadcasts an agent's record (its project folded, a native session announced). */
  | { readonly type: 'info'; readonly info: AgentSessionInfo }
  | { readonly type: 'state'; readonly state: AgentMonitorState }
  | { readonly type: 'removed'; readonly runtimeRunId: string }
  /** The adopted agent's process exited; the terminal may live on. */
  | { readonly type: 'process-exited'; readonly sessionId: string }
  /** Main hands a dead agent's panes to a fresh shell, which wears the agent's identity. */
  | { readonly type: 'handoff'; readonly previousSessionId: string; readonly session: SessionSummary }
  | { readonly type: 'window'; readonly patch: (window: WindowState) => void }
  | { readonly type: 'labels'; readonly labels: ReadonlyArray<readonly [string, string]> };

export interface DifferentialFrame {
  readonly at: number;
  readonly events: readonly DifferentialEvent[];
}

export interface DifferentialScenario {
  readonly name: string;
  readonly start: number;
  /** Canonical project roots and the sequences the registry dealt them (L4). */
  readonly projects: ReadonlyArray<readonly [string, number]>;
  readonly frames: readonly DifferentialFrame[];
}

export interface FrameRows {
  readonly at: number;
  readonly old: readonly MonitorAgent[];
  readonly next: readonly ViewsMonitorAgent[];
  /** The old seam's 10 s clock at this frame. */
  readonly oldNowMs: number;
  /** The runs a state arrived for in this frame. */
  readonly statesFor: ReadonlySet<string>;
  /** The pane the person works in moved to another session in this frame. */
  readonly activeChanged: boolean;
}

const TINT: ProjectTint = { l: 0.62, c: 0.14 };
const NEUTRAL = '#8a8f98';
const DEVICE = { id: 'mac', name: 'Mac', os: 'mac' as const, self: true };
const RECENCY_TICK_MS = 10_000;

function manualClock(start: number): MonitorClock & { advanceTo(at: number): void } {
  let now = start;
  const tasks: Array<{ at: number; task: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    schedule(delayMs, task) {
      const entry = { at: now + delayMs, task, cancelled: false };
      tasks.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    advanceTo(at) {
      for (;;) {
        const due = tasks
          .filter((entry) => !entry.cancelled && entry.at <= at)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        tasks.splice(tasks.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.task();
      }
      now = Math.max(now, at);
    },
  };
}

function manualQueue(): { run: (task: () => void) => () => void; flush(): void } {
  const queue: Array<{ task: () => void; cancelled: boolean }> = [];
  return {
    run(task) {
      const entry = { task, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    flush() {
      for (let guard = 0; queue.length > 0 && guard < 1000; guard += 1) {
        const entry = queue.shift();
        if (entry && !entry.cancelled) entry.task();
      }
    },
  };
}

class Harness {
  readonly window: WindowState = {
    panes: [],
    explicit: [],
    exited: new Set(),
    closing: new Set(),
    identities: new Map(),
    visualIds: new Map(),
    paneColours: new Map(),
  };
  private labels = new Map<string, string>();
  // Main.
  private readonly mainRecords = new Map<string, { info: AgentSessionInfo; agentProcessAlive: boolean }>();
  private readonly mainIdentities = new Map<string, string>();
  // The old path.
  private readonly old = new OldSeam();
  private readonly relay: MonitorIpcRelay;
  // The new path.
  private readonly windowRecords = new Map<string, AgentSessionInfo>();
  private readonly stateListeners = new Set<(state: AgentMonitorState) => void>();
  private readonly removedListeners = new Set<(removal: AgentMonitorRemoval) => void>();
  private readonly clock: ReturnType<typeof manualClock>;
  private readonly ticks = manualQueue();
  private readonly frames = manualQueue();
  private readonly host: GodviewMonitorHost;
  private readonly backend: MonitorBackend;
  private readonly replica: MonitorReplica;
  private readonly legacy: LegacyRows = createLegacyRows();
  private readonly start: number;
  /** What crossed main -> window and window -> main, for M19's feed measurement. */
  readonly traffic: FeedTraffic = {
    chromeMessages: 0,
    chromeBytes: 0,
    modelChanges: 0,
    modelBytes: 0,
    terminalReports: 0,
    shownReports: 0,
  };
  private lastTerminalReport = '';
  private lastShownReport = '';

  constructor(scenario: DifferentialScenario) {
    this.start = scenario.start;
    this.clock = manualClock(scenario.start);
    this.relay = new MonitorIpcRelay({
      onState: (message) => {
        this.traffic.chromeMessages += 1;
        this.traffic.chromeBytes += JSON.stringify(message).length;
        this.old.updateMonitor(message);
      },
      onRemoved: (message) => {
        this.traffic.chromeMessages += 1;
        this.traffic.chromeBytes += JSON.stringify(message).length;
        this.old.removeMonitor(message);
        // Main's own side effect of a removal: the record goes (the new window's chrome feed forgets it too).
        if (message.terminalSessionId) {
          this.mainRecords.delete(message.terminalSessionId);
          this.host.runsChanged();
          this.windowRecords.delete(message.terminalSessionId);
        }
      },
    });
    const runs: MonitorRunSource = {
      listStates: () => Promise.resolve([]),
      onState: (listener) => {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
      },
      onNotification: () => () => undefined,
      onRemoved: (listener) => {
        this.removedListeners.add(listener);
        return () => this.removedListeners.delete(listener);
      },
    };
    this.host = createGodviewMonitorHost({
      device: DEVICE,
      records: () => this.mainRecords.values(),
      identityOf: (sessionId) => this.mainIdentities.get(sessionId),
      accountLabel: (profileId) => this.labels.get(profileId),
    });
    this.backend = createMonitorBackend({
      runs,
      host: this.host.port,
      identity: createMemoryProjectIdentityStore(scenario.projects),
      sink: { select: () => undefined, create: () => undefined },
      cost: { acrossEpochs: 'accumulate' },
      unobservedAgents: 'terminal',
      clock: this.clock,
      scheduler: this.ticks.run,
    });
    const frameRequests: Array<() => void> = [];
    this.frameRun = (): void => {
      for (let guard = 0; frameRequests.length > 0 && guard < 100; guard += 1) frameRequests.shift()?.();
    };
    this.replica = createMonitorReplica({ scheduler: createFrameScheduler((run) => frameRequests.push(run)) });
    this.replica.setTheme({ key: 'differential', colourFor: projectColourFor({ tint: TINT, neutral: NEUTRAL }) });
    this.replica.apply(this.backend.getSnapshot());
    this.backend.subscribe((change) => {
      this.traffic.modelChanges += 1;
      this.traffic.modelBytes += JSON.stringify(change).length;
      this.replica.apply(change);
    });
  }

  private readonly frameRun: () => void;

  private apply(event: DifferentialEvent): void {
    switch (event.type) {
      case 'remember': {
        const { info } = event;
        this.old.remember(info);
        this.relay.bindTerminal(info.runtimeRunId, info.session.id);
        this.mainRecords.set(info.session.id, { info, agentProcessAlive: true });
        this.host.runsChanged();
        this.windowRecords.set(info.session.id, info);
        return;
      }
      case 'info': {
        const { info } = event;
        this.old.remember(info);
        const record = this.mainRecords.get(info.session.id);
        if (record) record.info = info;
        this.host.runsChanged();
        this.windowRecords.set(info.session.id, info);
        return;
      }
      case 'state':
        this.relay.acceptState(event.state);
        for (const listener of [...this.stateListeners]) listener(event.state);
        return;
      case 'removed': {
        const epoch = this.lastEpoch.get(event.runtimeRunId) ?? null;
        this.relay.remove(event.runtimeRunId);
        for (const listener of [...this.removedListeners]) {
          listener({ runtimeRunId: event.runtimeRunId, runtimeEpoch: epoch });
        }
        return;
      }
      case 'process-exited': {
        const record = this.mainRecords.get(event.sessionId);
        if (record) record.agentProcessAlive = false;
        this.host.runsChanged();
        return;
      }
      case 'handoff': {
        const { previousSessionId, session } = event;
        // Main deals the shell the dead agent's terminal as its identity, and tells the window.
        this.mainIdentities.set(session.id, previousSessionId);
        this.host.runsChanged();
        this.window.identities.set(session.id, previousSessionId);
        this.window.visualIds.set(session.id, this.window.visualIds.get(previousSessionId) ?? previousSessionId);
        for (const pane of this.window.panes) if (pane.session.id === previousSessionId) pane.session = session;
        return;
      }
      case 'window':
        event.patch(this.window);
        return;
      case 'labels':
        this.labels = new Map(event.labels);
        this.host.runsChanged();
        return;
    }
  }

  private readonly lastEpoch = new Map<string, number>();

  step(frame: DifferentialFrame): FrameRows {
    const at = frame.at;
    const activeBefore = this.window.panes.find((pane) => pane.id === this.window.activePaneId)?.session.id;
    const statesFor = new Set(
      frame.events.flatMap((event) => (event.type === 'state' ? [event.state.runtimeRunId] : [])),
    );
    // The backend's clock reaches the frame first (its 10 s and 30 s clocks fire at their own times on the way), so
    // every push of this frame is read at `at`, as the old seam's `Date.now()` reads it.
    this.clock.advanceTo(at);
    this.ticks.flush();
    for (const event of frame.events) {
      if (event.type === 'state') this.lastEpoch.set(event.state.runtimeRunId, event.state.runtimeEpoch);
      this.apply(event);
    }
    const window = this.window;
    const sessions = window.panes.map((pane) => pane.session);
    const attachments = buildPaneAttachments(window.panes, window.activePaneId, window.paneColours);
    const activeSessionId = window.panes.find((pane) => pane.id === window.activePaneId)?.session.id;

    // OLD: the seam's memo at this moment, its 10 s clock ticking from mount.
    const oldNowMs = this.start + Math.floor((at - this.start) / RECENCY_TICK_MS) * RECENCY_TICK_MS;
    const old = this.old.project(
      {
        sessions,
        activeSessionId,
        attachments,
        identities: window.identities,
        visualIds: window.visualIds,
        explicit: window.explicit,
        exited: window.exited,
        closing: window.closing,
        colours: { tint: TINT, neutral: NEUTRAL },
        profileLabels: this.labels,
      },
      at,
      oldNowMs,
    );

    // NEW: the backend at this moment, the window's report and join, the replica's frame, the shim.
    this.ticks.flush();
    const terminals = mergeMonitorTerminals({
      explicit: window.explicit,
      workspaceSessions: sessions,
      exitedSessionIds: window.exited,
      closingSessionIds: window.closing,
      identities: window.identities,
    });
    const liveSessions = new Map(sessions.map((session) => [session.id, session] as const));
    const report = terminalReport(terminals, liveSessions, window.identities);
    const reportKey = JSON.stringify(report);
    // The window sends only a report that changed, as the hook does.
    if (reportKey !== this.lastTerminalReport) {
      this.lastTerminalReport = reportKey;
      this.traffic.terminalReports += 1;
    }
    this.host.reportTerminals('window', report);
    this.ticks.flush();
    const terminalIds = windowTerminalIds(terminals, window.identities);
    const visible = (row: MonitorAgentRow): boolean => row.kind === 'agent' || terminalIds.has(row.id);
    const agentSessions = agentSessionsByRow(this.windowRecords.keys(), window.identities);
    // A pane joins the row its session backs, which the model's kinds decide: join, publish, join again until still.
    for (let pass = 0; pass < 3; pass += 1) {
      this.replica.setLocal(
        windowLocal(
          {
            model: this.replica.getSnapshot().model,
            agentSessions,
            attachments,
            activeSessionId,
            terminals,
            identities: window.identities,
          },
          visible,
        ),
      );
      this.frameRun();
    }
    const next = this.legacy.rowsFor(this.replica.getSnapshot().model, {
      agentSessions,
      terminals,
      identities: window.identities,
      visualIds: window.visualIds,
    });
    // The window reports what its active pane shows (L5): the backend's unread fold reads it at its next tick.
    const shown = windowLocal(
      {
        model: this.replica.getSnapshot().model,
        agentSessions,
        attachments,
        activeSessionId,
        terminals,
        identities: window.identities,
      },
      visible,
    ).activeIds;
    const shownKey = [...shown].sort().join('\n');
    if (shownKey !== this.lastShownReport) {
      this.lastShownReport = shownKey;
      this.traffic.shownReports += 1;
    }
    this.backend.reportShown('window', [...shown]);
    this.ticks.flush();
    this.frameRun();
    return { at, old, next, oldNowMs, statesFor, activeChanged: activeSessionId !== activeBefore };
  }

  /** The rows after the window's shown report landed (what the views draw on the next frame). */
  settled(): readonly ViewsMonitorAgent[] {
    return this.legacy.rowsFor(this.replica.getSnapshot().model, {
      agentSessions: agentSessionsByRow(this.windowRecords.keys(), this.window.identities),
      terminals: mergeMonitorTerminals({
        explicit: this.window.explicit,
        workspaceSessions: this.window.panes.map((pane) => pane.session),
        exitedSessionIds: this.window.exited,
        closingSessionIds: this.window.closing,
        identities: this.window.identities,
      }),
      identities: this.window.identities,
      visualIds: this.window.visualIds,
    });
  }

  dispose(): void {
    this.backend.dispose();
    this.replica.dispose();
  }
}

/** Counts and JSON sizes of what each feed carried over a scenario. */
export interface FeedTraffic {
  /** The chrome's feed (M19): the relay's full states and removals, one message each — the old seam's only feed. */
  chromeMessages: number;
  chromeBytes: number;
  /** The model (`monitor:change`): what the new path adds. */
  modelChanges: number;
  modelBytes: number;
  /** Window -> main: the terminal reports and the shown reports that changed. */
  terminalReports: number;
  shownReports: number;
}

/** Runs a scenario through both paths; one entry per frame, and what crossed between main and the window. */
export function runDifferential(scenario: DifferentialScenario): FrameRows[] & { traffic?: FeedTraffic } {
  const harness = new Harness(scenario);
  try {
    const frames: FrameRows[] & { traffic?: FeedTraffic } = scenario.frames.map((frame) => {
      const rows = harness.step(frame);
      return { ...rows, next: harness.settled() };
    });
    frames.traffic = { ...harness.traffic };
    return frames;
  } finally {
    harness.dispose();
  }
}
