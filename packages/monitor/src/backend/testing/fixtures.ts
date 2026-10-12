import type { AgentMonitorState, MonitorNotification } from '@vibefield/puppeteer-core';
import type { MonitorAgentRow, MonitorDeviceRef, MonitorModelChange } from '@vibefield/puppeteer-view-sdk/model';
import type { AgentMonitorRemoval } from '../../store.js';
import { createMonitorBackend } from '../backend.js';
import { createMemoryProjectIdentityStore } from '../identity.js';
import type {
  CreateMonitorBackendOptions,
  MonitorClock,
  MonitorCommandSink,
  MonitorCreateRequest,
  MonitorHostFacts,
  MonitorHostPort,
  MonitorHostRun,
  MonitorHostTerminal,
  MonitorRunSource,
  MonitorScheduler,
  MonitorSelectTarget,
} from '../ports.js';

// Test fixtures for the backend: a hand-driven clock and scheduler, a run
// source the test pushes into, a host whose facts the test replaces, and the
// plain records the two hosts would hand over.

export const T0 = Date.parse('2026-10-03T10:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export const DEVICE: MonitorDeviceRef = { id: 'desk-1', name: 'Studio', os: 'mac', self: true };

export function monitorState(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: 3,
    runtimeEpoch: 1,
    revision: 1,
    runtimeRunId: 'run-1',
    status: 'working',
    statusSince: iso(T0),
    blockers: [],
    activity: { kind: 'tool', line: 'Edit · src/app.ts', since: iso(T0) },
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0) },
    alive: true,
    ...overrides,
  };
}

export function hostRun(overrides: Partial<MonitorHostRun> = {}): MonitorHostRun {
  return {
    runtimeRunId: 'run-1',
    createdAt: T0 - 60_000,
    provider: { id: 'claude', label: 'Claude Code' },
    terminalSessionId: 'pty-1',
    ...overrides,
  };
}

export function hostTerminal(overrides: Partial<MonitorHostTerminal> = {}): MonitorHostTerminal {
  return { sessionId: 'pty-9', createdAt: T0 - 30_000, cwd: '/Users/me/notes', ...overrides };
}

export function facts(overrides: Partial<MonitorHostFacts> = {}): MonitorHostFacts {
  return { device: DEVICE, runs: [], terminals: [], profileSets: null, ...overrides };
}

export interface ManualClock {
  clock: MonitorClock;
  /** Moves time forward, running every task that falls due, in order. */
  advance(ms: number): void;
  now(): number;
}

export function manualClock(start = T0): ManualClock {
  let now = start;
  const tasks: Array<{ at: number; task: () => void; cancelled: boolean }> = [];
  return {
    clock: {
      now: () => now,
      schedule(delayMs, task) {
        const entry = { at: now + delayMs, task, cancelled: false };
        tasks.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = tasks
          .filter((entry) => !entry.cancelled && entry.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        tasks.splice(tasks.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.task();
      }
      now = target;
    },
    now: () => now,
  };
}

export interface ManualScheduler {
  scheduler: MonitorScheduler;
  /** Runs every queued tick. */
  flush(): void;
  pending(): number;
}

export function manualScheduler(): ManualScheduler {
  const queue: Array<{ task: () => void; cancelled: boolean }> = [];
  return {
    scheduler: (task) => {
      const entry = { task, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    flush() {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry && !entry.cancelled) entry.task();
      }
    },
    pending: () => queue.filter((entry) => !entry.cancelled).length,
  };
}

export interface FakeRunSource {
  source: MonitorRunSource;
  /** The states `listStates` answers with; resolved when the test says so. */
  list(states: readonly AgentMonitorState[]): void;
  push(state: AgentMonitorState): void;
  notify(notification: MonitorNotification): void;
  remove(removal: AgentMonitorRemoval): void;
  /** Every failure acknowledgement the backend asked for: `[runtimeRunId, blockerId]`. */
  acknowledged: Array<[string, string]>;
}

/** With no `initial`, the listing waits for `list()`: a test can push live states under it first. */
export function fakeRunSource(initial?: readonly AgentMonitorState[]): FakeRunSource {
  let listed: readonly AgentMonitorState[] | undefined = initial;
  let resolveList: ((states: readonly AgentMonitorState[]) => void) | undefined;
  const stateListeners = new Set<(state: AgentMonitorState) => void>();
  const noticeListeners = new Set<(notification: MonitorNotification) => void>();
  const removedListeners = new Set<(removal: AgentMonitorRemoval) => void>();
  const acknowledged: Array<[string, string]> = [];
  return {
    acknowledged,
    source: {
      acknowledgeFailure(runtimeRunId, blockerId) {
        acknowledged.push([runtimeRunId, blockerId]);
        return Promise.resolve(true);
      },
      listStates: () =>
        new Promise((resolve) => {
          if (listed !== undefined) resolve(listed);
          else resolveList = resolve;
        }),
      onState(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      onNotification(listener) {
        noticeListeners.add(listener);
        return () => noticeListeners.delete(listener);
      },
      onRemoved(listener) {
        removedListeners.add(listener);
        return () => removedListeners.delete(listener);
      },
    },
    list(states) {
      listed = states;
      resolveList?.(states);
    },
    push: (state) => stateListeners.forEach((listener) => listener(state)),
    notify: (notification) => noticeListeners.forEach((listener) => listener(notification)),
    remove: (removal) => removedListeners.forEach((listener) => listener(removal)),
  };
}

export interface FakeHost {
  host: MonitorHostPort;
  set(facts: MonitorHostFacts): void;
  update(patch: Partial<MonitorHostFacts>): void;
  current(): MonitorHostFacts;
}

export function fakeHost(initial: MonitorHostFacts = facts()): FakeHost {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    host: {
      getFacts: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    update(patch) {
      current = { ...current, ...patch };
      for (const listener of [...listeners]) listener();
    },
    current: () => current,
  };
}

export interface RecordingSink extends MonitorCommandSink {
  selected: MonitorSelectTarget[];
  created: MonitorCreateRequest[];
}

export function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    selected: [],
    created: [],
    select(target) {
      sink.selected.push(target);
    },
    create(request) {
      sink.created.push(request);
    },
  };
  return sink;
}

export interface TestBackend {
  backend: ReturnType<typeof createMonitorBackend>;
  source: FakeRunSource;
  host: FakeHost;
  clock: ManualClock;
  scheduler: ManualScheduler;
  sink: RecordingSink;
  identity: ReturnType<typeof createMemoryProjectIdentityStore>;
  /** Runs the queued tick and returns the rows. */
  rows(): readonly MonitorAgentRow[];
  /** Every change emitted so far. */
  changes: MonitorModelChange[];
}

export function testBackend(
  options: Partial<Omit<CreateMonitorBackendOptions, 'runs' | 'host' | 'identity' | 'sink' | 'clock' | 'scheduler'>> & {
    facts?: MonitorHostFacts;
    states?: readonly AgentMonitorState[];
    /** The listing answers only when the test calls `source.list()`. */
    deferList?: boolean;
  } = {},
): TestBackend {
  const source = fakeRunSource(options.deferList ? undefined : (options.states ?? []));
  const host = fakeHost(options.facts ?? facts());
  const clock = manualClock();
  const scheduler = manualScheduler();
  const sink = recordingSink();
  const identity = createMemoryProjectIdentityStore();
  const { facts: _facts, states: _states, deferList: _deferList, ...rest } = options;
  const backend = createMonitorBackend({
    ...rest,
    runs: source.source,
    host: host.host,
    identity,
    sink,
    clock: clock.clock,
    scheduler: scheduler.scheduler,
  });
  const changes: MonitorModelChange[] = [];
  backend.subscribe((change) => changes.push(change));
  return {
    backend,
    source,
    host,
    clock,
    scheduler,
    sink,
    identity,
    changes,
    rows() {
      scheduler.flush();
      return backend.getSnapshot().rows;
    },
  };
}
