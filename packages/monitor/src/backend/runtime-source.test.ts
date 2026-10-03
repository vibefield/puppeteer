import { describe, expect, it } from 'vitest';
import type { AgentMonitorState, MonitorNotification } from '@vibecook/puppeteer-core';
import { connectAgentMonitorStore, createAgentMonitorStore } from '../store.js';
import { runtimeRunSource, type MonitorRuntimeSource } from './runtime-source.js';

function monitorState(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: 3,
    runtimeEpoch: 1,
    revision: 1,
    runtimeRunId: 'run-1',
    status: 'idle',
    statusSince: '2026-10-03T10:00:00.000Z',
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],
    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

/** A runtime whose bus the test drives by hand, recording the order of its calls. */
function fakeRuntime(initial: AgentMonitorState[] = []) {
  const calls: string[] = [];
  const stateListeners = new Set<(state: AgentMonitorState) => void>();
  const noticeListeners = new Set<(notification: MonitorNotification) => void>();
  const removedListeners = new Set<(runtimeRunId: string, removal: { readonly runtimeEpoch: number }) => void>();
  const runtime: MonitorRuntimeSource = {
    monitorStates() {
      calls.push('list');
      return initial;
    },
    onMonitorState(listener) {
      calls.push('subscribe:state');
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onMonitorNotification(listener) {
      calls.push('subscribe:notification');
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    onMonitorRemoved(listener) {
      calls.push('subscribe:removed');
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },
  };
  return {
    runtime,
    calls,
    push: (state: AgentMonitorState) => stateListeners.forEach((listener) => listener(state)),
    notify: (notification: MonitorNotification) => noticeListeners.forEach((listener) => listener(notification)),
    remove: (runtimeRunId: string, removal?: { runtimeEpoch: number }) =>
      // an older runtime passes no second argument; the type says one always comes
      removedListeners.forEach((listener) => listener(runtimeRunId, removal as { runtimeEpoch: number })),
    listeners: () => stateListeners.size + noticeListeners.size + removedListeners.size,
  };
}

describe('runtimeRunSource', () => {
  it('subscribes to the bus before it lists, so a live push cannot be overwritten by the listing', async () => {
    const stale = monitorState({ revision: 1 });
    const fake = fakeRuntime([stale]);
    const store = createAgentMonitorStore();
    const connection = connectAgentMonitorStore(store, runtimeRunSource(fake.runtime));
    expect(fake.calls).toEqual(['subscribe:state', 'subscribe:notification', 'subscribe:removed', 'list']);
    fake.push(monitorState({ revision: 2, status: 'working' }));
    await connection.ready;
    expect(store.getSnapshot().states).toMatchObject([{ revision: 2, status: 'working' }]);
    connection.close();
    expect(fake.listeners()).toBe(0);
  });

  it('seals a removal with the epoch the runtime names', () => {
    const fake = fakeRuntime();
    const store = createAgentMonitorStore();
    connectAgentMonitorStore(store, runtimeRunSource(fake.runtime));
    fake.push(monitorState({ runtimeEpoch: 2, revision: 5 }));
    fake.remove('run-1', { runtimeEpoch: 2 });
    expect(store.getSnapshot().states).toEqual([]);
    // the same epoch is sealed; only a newer one revives the identity
    expect(store.acceptState(monitorState({ runtimeEpoch: 2, revision: 6 }))).toBe(false);
    expect(store.acceptState(monitorState({ runtimeEpoch: 3, revision: 1 }))).toBe(true);
  });

  it('falls back to the last epoch it saw when a runtime names none, and to null when it saw none', async () => {
    const fake = fakeRuntime([monitorState({ runtimeRunId: 'listed', runtimeEpoch: 4 })]);
    const store = createAgentMonitorStore();
    const connection = connectAgentMonitorStore(store, runtimeRunSource(fake.runtime));
    await connection.ready;
    fake.push(monitorState({ runtimeRunId: 'pushed', runtimeEpoch: 7 }));
    fake.remove('listed');
    fake.remove('pushed');
    fake.remove('unknown');
    expect(store.acceptState(monitorState({ runtimeRunId: 'listed', runtimeEpoch: 4, revision: 9 }))).toBe(false);
    expect(store.acceptState(monitorState({ runtimeRunId: 'listed', runtimeEpoch: 5 }))).toBe(true);
    expect(store.acceptState(monitorState({ runtimeRunId: 'pushed', runtimeEpoch: 8 }))).toBe(true);
    // never seen: sealed for good, which is the honest answer when ordering cannot be proven
    expect(store.acceptState(monitorState({ runtimeRunId: 'unknown', runtimeEpoch: 99 }))).toBe(false);
  });

  it('passes notifications through untouched', () => {
    const fake = fakeRuntime();
    const store = createAgentMonitorStore();
    connectAgentMonitorStore(store, runtimeRunSource(fake.runtime));
    const notification: MonitorNotification = {
      notificationId: 'n-1',
      runtimeRunId: 'run-1',
      at: '2026-10-03T10:00:00.000Z',
      type: 'blocked.entered',
    };
    fake.notify(notification);
    expect(store.getSnapshot().notifications).toEqual([notification]);
  });
});

describe('runtimeRunSource acknowledge (M3)', () => {
  it('passes a failure acknowledgement to a runtime that has the verb, and offers none otherwise', async () => {
    const calls: Array<[string, string]> = [];
    const fake = fakeRuntime();
    const withVerb = runtimeRunSource({
      ...fake.runtime,
      async acknowledgeFailureBlocker(runtimeRunId, blockerId) {
        calls.push([runtimeRunId, blockerId]);
        return true;
      },
    });
    await expect(withVerb.acknowledgeFailure?.('run-1', 'b-1')).resolves.toBe(true);
    expect(calls).toEqual([['run-1', 'b-1']]);
    expect(runtimeRunSource(fake.runtime).acknowledgeFailure).toBeUndefined();
  });
});
