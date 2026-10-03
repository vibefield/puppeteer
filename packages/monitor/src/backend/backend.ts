import { DEFAULT_MONITOR_FRESHNESS_POLICY, type AgentMonitorState } from '@vibecook/puppeteer-core';
import {
  compareMonitorRows,
  type AgentStatus,
  type MonitorAgentRow,
  type MonitorCost,
  type MonitorDeviceRef,
  type MonitorModelChange,
  type MonitorModelSnapshot,
} from '@vibecook/puppeteer-view-sdk/model';
import { createAgentMonitorStore } from '../store.js';
import {
  DEFAULT_REPLY_MAX_LENGTH,
  classifyTerminalStatus,
  deriveAgentRow,
  deriveTerminalRow,
  isStale,
  personaSets,
  projectKey,
  resolveProfileSet,
} from './derive.js';
import { deepEqual, freezeTree } from './equal.js';
import { USAGE_STEP_MS, UsageLedger, type UsageHistory } from './usage-ledger.js';
import type {
  CreateMonitorBackendOptions,
  MonitorBackend,
  MonitorClock,
  MonitorHostProfileSet,
  MonitorHostRun,
  MonitorHostTerminal,
  MonitorScheduler,
} from './ports.js';

export const DEFAULT_RECENCY_INTERVAL_MS = 10_000;

const defaultClock: MonitorClock = {
  now: () => Date.now(),
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
};

/** One emission per macrotask: every push inside a turn lands in one change. */
const defaultScheduler: MonitorScheduler = (task) => {
  const timer = setTimeout(task, 0);
  return () => clearTimeout(timer);
};

/** The inputs a row was derived from; the same inputs mean the same row without deriving it again. */
interface AgentInputs {
  readonly kind: 'agent';
  readonly host: MonitorHostRun;
  readonly state: AgentMonitorState | undefined;
  readonly device: MonitorDeviceRef;
  readonly seq: number | undefined;
  readonly profileSet: string;
  readonly stale: boolean;
  readonly cost: MonitorCost | undefined;
  readonly unread: boolean;
}

interface TerminalInputs {
  readonly kind: 'terminal';
  readonly host: MonitorHostTerminal;
  readonly device: MonitorDeviceRef;
  readonly statusSince: number;
}

type RowInputs = AgentInputs | TerminalInputs;

interface RowEntry {
  readonly row: MonitorAgentRow;
  readonly inputs: RowInputs;
}

function sameInputs(previous: RowInputs, next: RowInputs): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'agent' && next.kind === 'agent') {
    return (
      previous.state === next.state &&
      previous.seq === next.seq &&
      previous.profileSet === next.profileSet &&
      previous.stale === next.stale &&
      previous.cost === next.cost &&
      previous.unread === next.unread &&
      deepEqual(previous.device, next.device) &&
      deepEqual(previous.host, next.host)
    );
  }
  if (previous.kind === 'terminal' && next.kind === 'terminal') {
    return (
      previous.statusSince === next.statusSince &&
      deepEqual(previous.device, next.device) &&
      deepEqual(previous.host, next.host)
    );
  }
  return false;
}

/** Urgent: what a person waits on. Everything else coalesces to the next tick. */
function isUrgentTransition(previous: AgentMonitorState | undefined, next: AgentMonitorState): boolean {
  if (!previous) return true;
  return (
    previous.alive !== next.alive ||
    previous.status !== next.status ||
    JSON.stringify(previous.blockers) !== JSON.stringify(next.blockers)
  );
}

const EMPTY_ROWS: readonly MonitorAgentRow[] = Object.freeze([]);

/**
 * One backend per desktop, beside the runtime. It joins the runtime's run table
 * (the store, fed subscribe-before-list) with the host's facts, derives every
 * row once, and emits revisioned changes with structural sharing: a row whose
 * facts did not change keeps its object, and an idle model emits nothing.
 */
export function createMonitorBackend(options: CreateMonitorBackendOptions): MonitorBackend {
  const { runs: source, host, identity } = options;
  const clock = options.clock ?? defaultClock;
  const scheduler = options.scheduler ?? defaultScheduler;
  const replyMaxLength = options.replyMaxLength ?? DEFAULT_REPLY_MAX_LENGTH;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_MONITOR_FRESHNESS_POLICY.staleAfterMs;
  const recencyIntervalMs = options.recencyIntervalMs ?? DEFAULT_RECENCY_INTERVAL_MS;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // a diagnostic hook cannot interrupt the backend
    }
  };

  const store = createAgentMonitorStore({
    ...(options.notificationCapacity === undefined ? {} : { notificationCapacity: options.notificationCapacity }),
    onListenerError: report,
  });
  /** Runs the runtime removed and nothing has revived: no row, even when the host still names them. */
  const sealed = new Set<string>();
  /** The model id each run carries, for the backend's lifetime. */
  const idByRun = new Map<string, string>();
  /** Last assembly's terminal ids by session, so a run promoted from a shell that just left the list still finds it. */
  let terminalIdBySession: ReadonlyMap<string, string> = new Map();
  const terminalStatus = new Map<string, { status: AgentStatus; since: number }>();
  /** The usage ledger, by run; a run's reading is taken once per state object. */
  const ledger = new UsageLedger();
  const observed = new Map<string, AgentMonitorState | undefined>();
  const costCache = new Map<
    string,
    { history: UsageHistory | undefined; ratePerMin: number | undefined; cost: MonitorCost | undefined }
  >();
  let entries = new Map<string, RowEntry>();
  let personasOf: { sets: readonly MonitorHostProfileSet[] | null; personas: ReadonlyMap<string, string> } | undefined;

  let snapshot: MonitorModelSnapshot = Object.freeze({ revision: 0, rows: EMPTY_ROWS });
  const listeners = new Set<(change: MonitorModelChange) => void>();
  let cancelTick: (() => void) | undefined;
  let cancelRecency: (() => void) | undefined;
  let cancelStep: (() => void) | undefined;
  let disposed = false;

  /** The row's cost from the ledger's history and core's live rate; the same object while neither moved. */
  const costOf = (
    runtimeRunId: string,
    history: UsageHistory | undefined,
    ratePerMin: number | undefined,
  ): MonitorCost | undefined => {
    const cached = costCache.get(runtimeRunId);
    if (cached && cached.history === history && cached.ratePerMin === ratePerMin) return cached.cost;
    const cost =
      history?.total === undefined
        ? undefined
        : freezeTree({
            usd: history.total,
            coverage: history.coverage,
            ...(ratePerMin === undefined ? {} : { burnPerHour: ratePerMin * 60 }),
            series: { stepMs: history.stepMs, steps: history.steps, lastStepAt: history.lastStepAt },
          });
    costCache.set(runtimeRunId, { history, ratePerMin, cost });
    return cost;
  };

  const personas = (sets: readonly MonitorHostProfileSet[] | null): ReadonlyMap<string, string> => {
    if (personasOf?.sets !== sets) personasOf = { sets, personas: personaSets(sets) };
    return personasOf.personas;
  };

  const schedule = (): void => {
    if (disposed || cancelTick) return;
    cancelTick = scheduler(() => {
      cancelTick = undefined;
      flush();
    });
  };

  const flush = (): void => {
    if (disposed) return;
    cancelTick?.();
    cancelTick = undefined;
    const change = recompute();
    if (change) emit(change);
  };

  const emit = (
    change: Omit<MonitorModelChange, 'since' | 'revision'> & { rows: readonly MonitorAgentRow[] },
  ): void => {
    const since = snapshot.revision;
    const revision = since + 1;
    snapshot = Object.freeze({
      revision,
      rows: Object.freeze(change.rows),
      ...(snapshot.spawn ? { spawn: snapshot.spawn } : {}),
    });
    const published: MonitorModelChange = Object.freeze({
      since,
      revision,
      upserts: Object.freeze(change.upserts),
      removed: Object.freeze(change.removed),
    });
    for (const listener of [...listeners]) {
      try {
        listener(published);
      } catch (error) {
        report(error);
      }
    }
  };

  /** Keeps the previous frozen row when the newly derived one says the same thing (MV-D21). */
  const settle = (previous: RowEntry | undefined, row: MonitorAgentRow, inputs: RowInputs): RowEntry => {
    if (previous && deepEqual(previous.row, row)) return { row: previous.row, inputs };
    return { row: freezeTree(row), inputs };
  };

  const recompute = (): { upserts: MonitorAgentRow[]; removed: string[]; rows: MonitorAgentRow[] } | undefined => {
    const facts = host.getFacts();
    const nowMs = clock.now();
    const device = facts.device;
    const sets = personas(facts.profileSets);
    const next = new Map<string, RowEntry>();
    const upserts: MonitorAgentRow[] = [];

    // 1. The bare terminals, by the id each would be a row under.
    const liveTerminals = facts.terminals.filter((terminal) => terminal.exited !== true);
    const tidBySession = new Map(
      liveTerminals.map((terminal) => [terminal.sessionId, terminal.identity ?? terminal.sessionId]),
    );

    // 2. The runs, each under the id it carries: a run promoted from a shell takes the shell row's id;
    //    otherwise its runtimeRunId, which already survives epochs and PTY swaps. No id is held twice.
    const taken = new Set<string>();
    const agents: Array<{ host: MonitorHostRun; state: AgentMonitorState | undefined; id: string }> = [];
    for (const run of facts.runs) {
      const state = store.getState(run.runtimeRunId);
      if (!state && sealed.has(run.runtimeRunId)) continue;
      let id = idByRun.get(run.runtimeRunId);
      if (id === undefined || taken.has(id)) {
        const terminalId = (session: string | undefined): string | undefined =>
          session === undefined ? undefined : (tidBySession.get(session) ?? terminalIdBySession.get(session));
        const candidates = [
          run.terminalIdentity,
          terminalId(run.terminalSessionId),
          terminalId(run.replacedTerminalSessionId),
          run.runtimeRunId,
        ];
        id = candidates.find((candidate) => candidate !== undefined && !taken.has(candidate)) ?? run.runtimeRunId;
        idByRun.set(run.runtimeRunId, id);
      }
      taken.add(id);
      agents.push({ host: run, state, id });
    }

    // 3. Agent rows.
    for (const agent of agents) {
      const { runtimeRunId } = agent.host;
      const key = projectKey(agent.host, agent.state);
      const seq = key === undefined ? undefined : (identity.seq(key) ?? identity.deal(key));
      if (agent.state !== observed.get(runtimeRunId) || !observed.has(runtimeRunId)) {
        // The reading Godview's seam makes: the run is `${runtimeRunId}:${epoch}` (a new epoch is a new run), the
        // conversation is the provider plus the native session id, so a resume accumulates and a new one resets.
        observed.set(runtimeRunId, agent.state);
        const nativeSessionId = agent.state?.session.nativeSessionId ?? agent.host.nativeSessionId;
        ledger.observe(
          {
            id: runtimeRunId,
            ...(agent.state
              ? {
                  runId: `${runtimeRunId}:${agent.state.runtimeEpoch}`,
                  revision: agent.state.revision,
                  usage: agent.state.usage,
                }
              : {}),
            ...(nativeSessionId ? { session: { providerId: agent.host.provider.id, nativeSessionId } } : {}),
          },
          nowMs,
        );
      }
      const inputs: AgentInputs = {
        kind: 'agent',
        host: agent.host,
        state: agent.state,
        device,
        seq,
        profileSet: resolveProfileSet(agent.host, sets),
        stale: isStale(agent.state, nowMs, staleAfterMs),
        cost: costOf(runtimeRunId, ledger.history(runtimeRunId), agent.state?.usage.costRatePerMin),
        unread: false,
      };
      const previous = entries.get(agent.id);
      const entry =
        previous && sameInputs(previous.inputs, inputs)
          ? { row: previous.row, inputs }
          : settle(previous, deriveAgentRow({ id: agent.id, replyMaxLength, ...inputs }), inputs);
      next.set(agent.id, entry);
      if (entry.row !== previous?.row) upserts.push(entry.row);
    }

    // 4. Terminal rows: the ones no agent speaks for (its PTY, the one it replaced, or its very id).
    const claimedSessions = new Set<string>();
    for (const agent of agents) {
      if (agent.host.terminalSessionId !== undefined) claimedSessions.add(agent.host.terminalSessionId);
      if (agent.host.replacedTerminalSessionId !== undefined) claimedSessions.add(agent.host.replacedTerminalSessionId);
    }
    const liveTerminalIds = new Set<string>();
    for (const terminal of liveTerminals) {
      const id = tidBySession.get(terminal.sessionId) ?? terminal.sessionId;
      if (claimedSessions.has(terminal.sessionId) || taken.has(id) || liveTerminalIds.has(id)) continue;
      liveTerminalIds.add(id);
      const status = classifyTerminalStatus(terminal.activity);
      let known = terminalStatus.get(id);
      if (!known || known.status !== status) {
        known = { status, since: known ? nowMs : terminal.createdAt || nowMs };
        terminalStatus.set(id, known);
      }
      const inputs: TerminalInputs = { kind: 'terminal', host: terminal, device, statusSince: known.since };
      const previous = entries.get(id);
      const entry =
        previous && sameInputs(previous.inputs, inputs)
          ? { row: previous.row, inputs }
          : settle(previous, deriveTerminalRow({ id, host: terminal, device, statusSince: known.since }), inputs);
      next.set(id, entry);
      if (entry.row !== previous?.row) upserts.push(entry.row);
    }
    for (const id of [...terminalStatus.keys()]) if (!liveTerminalIds.has(id)) terminalStatus.delete(id);

    // 5. What left, and what to forget.
    const removed = [...entries.keys()].filter((id) => !next.has(id));
    const named = new Set(facts.runs.map((run) => run.runtimeRunId));
    for (const runtimeRunId of new Set([...idByRun.keys(), ...observed.keys()])) {
      if (named.has(runtimeRunId) || store.getState(runtimeRunId) !== undefined) continue;
      idByRun.delete(runtimeRunId);
      observed.delete(runtimeRunId);
      costCache.delete(runtimeRunId);
      ledger.forget(runtimeRunId);
    }
    terminalIdBySession = tidBySession;
    entries = next;
    if (upserts.length === 0 && removed.length === 0) return undefined;
    const rows = [...next.values()].map((entry) => entry.row).sort(compareMonitorRows);
    return { upserts, removed, rows };
  };

  // The run table, fed subscribe-before-list over the runtime's push bus.
  const unsubscribeState = source.onState((state) => {
    if (disposed) return;
    const previous = store.getState(state.runtimeRunId);
    if (!store.acceptState(state)) return;
    sealed.delete(state.runtimeRunId);
    if (isUrgentTransition(previous, state)) flush();
    else schedule();
  });
  const unsubscribeNotification = source.onNotification((notification) => {
    if (!disposed) store.acceptNotification(notification);
  });
  const unsubscribeRemoved = source.onRemoved((removal) => {
    if (disposed) return;
    if (!store.remove(removal)) return;
    sealed.add(removal.runtimeRunId);
    flush();
  });
  const ready = source
    .listStates()
    .then((states) => {
      if (disposed) return;
      for (const state of states) {
        if (store.acceptState(state)) sealed.delete(state.runtimeRunId);
      }
      schedule();
    })
    .catch((error: unknown) => {
      report(error);
    });
  const unsubscribeHost = host.subscribe(() => schedule());

  // The 10 s clock: recency is re-read, and only a row whose staleness flipped is rebuilt.
  const armRecency = (): void => {
    cancelRecency = clock.schedule(recencyIntervalMs, () => {
      cancelRecency = undefined;
      if (disposed) return;
      schedule();
      armRecency();
    });
  };
  armRecency();

  // The 30 s step, aligned to the boundaries so every row's bars shift together; a priced row re-emits once per step.
  const armStep = (): void => {
    cancelStep = clock.schedule(USAGE_STEP_MS - (clock.now() % USAGE_STEP_MS), () => {
      cancelStep = undefined;
      if (disposed) return;
      if (ledger.step(clock.now()).length > 0) schedule();
      armStep();
    });
  };
  armStep();
  schedule();

  return {
    ready,
    getSnapshot: () => snapshot,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    command: () => false,
    reportShown: () => undefined,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTick?.();
      cancelTick = undefined;
      cancelRecency?.();
      cancelRecency = undefined;
      cancelStep?.();
      cancelStep = undefined;
      unsubscribeState();
      unsubscribeNotification();
      unsubscribeRemoved();
      unsubscribeHost();
      listeners.clear();
      store.clear();
    },
  };
}
