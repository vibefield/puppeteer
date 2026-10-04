import { describe, expect, it, vi } from 'vitest';
import type { AgentMonitorState, MonitorNotification } from '@vibecook/puppeteer-core';
import {
  DEFAULT_MONITOR_SEAL_CAPACITY,
  connectAgentMonitorStore,
  createAgentMonitorStore,
  type AgentMonitorSource,
} from './store.js';

function state(runtimeEpoch: number, revision: number, runtimeRunId = 'run-1'): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeRunId,
    runtimeEpoch,
    revision,
    status: 'idle',
    statusSince: '2026-08-26T00:00:00.000Z',
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'structured', families: {} },
    alive: true,
  };
}

function notification(index: number): MonitorNotification {
  return {
    runtimeRunId: 'run-1',
    notificationId: `notice-${index}`,
    at: '2026-08-26T00:00:00.000Z',
    type: 'blocked.entered',
  };
}

describe('createAgentMonitorStore', () => {
  it('publishes only newer revisions and keeps snapshots stable between mutations', () => {
    const store = createAgentMonitorStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const empty = store.getSnapshot();

    expect(store.acceptState(state(1, 2))).toBe(true);
    expect(store.acceptState(state(1, 1))).toBe(false);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getSnapshot()).not.toBe(empty);
    expect(store.getState('run-1')?.revision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('seals a removed epoch and revives a durable run only at a newer epoch', () => {
    const store = createAgentMonitorStore();
    store.acceptState(state(2, 7));

    expect(store.remove({ runtimeRunId: 'run-1', runtimeEpoch: 2 })).toBe(true);
    expect(store.acceptState(state(2, 8))).toBe(false);
    expect(store.acceptState(state(1, 99))).toBe(false);
    expect(store.acceptState(state(3, 1))).toBe(true);
    expect(store.getState('run-1')).toMatchObject({ runtimeEpoch: 3, revision: 1 });
  });

  it('remembers a bounded number of removals, forgetting the oldest first (mv-review)', () => {
    const store = createAgentMonitorStore({ sealCapacity: 2 });
    for (const runtimeRunId of ['a', 'b', 'c']) store.remove({ runtimeRunId, runtimeEpoch: 1 });
    // 'a' is forgotten, so its late state is taken; 'b' and 'c' are still refused
    expect(store.acceptState(state(1, 5, 'b'))).toBe(false);
    expect(store.acceptState(state(1, 5, 'c'))).toBe(false);
    expect(store.acceptState(state(1, 5, 'a'))).toBe(true);
  });

  it('says whether a run is sealed: removed and not revived, within the cap (M25)', () => {
    const store = createAgentMonitorStore({ sealCapacity: 2 });
    store.acceptState(state(1, 1, 'a'));
    expect(store.isSealed('a')).toBe(false);
    store.remove({ runtimeRunId: 'a', runtimeEpoch: 1 });
    expect(store.isSealed('a')).toBe(true);
    expect(store.isSealed('unknown')).toBe(false);
    store.acceptState(state(2, 1, 'a'));
    expect(store.isSealed('a')).toBe(false);
    store.remove({ runtimeRunId: 'a', runtimeEpoch: 2 });
    store.remove({ runtimeRunId: 'b', runtimeEpoch: null });
    store.remove({ runtimeRunId: 'c', runtimeEpoch: 1 });
    expect([store.isSealed('a'), store.isSealed('b'), store.isSealed('c')]).toEqual([false, true, true]);
    store.clear();
    expect(store.isSealed('b')).toBe(false);
  });

  it('makes a run sealed again the newest seal', () => {
    const store = createAgentMonitorStore({ sealCapacity: 2 });
    store.remove({ runtimeRunId: 'a', runtimeEpoch: 1 });
    store.remove({ runtimeRunId: 'b', runtimeEpoch: 1 });
    store.remove({ runtimeRunId: 'a', runtimeEpoch: 2 });
    store.remove({ runtimeRunId: 'c', runtimeEpoch: 1 });
    expect(store.acceptState(state(2, 5, 'a'))).toBe(false);
    expect(store.acceptState(state(1, 5, 'b'))).toBe(true);
  });

  it('keeps DEFAULT_MONITOR_SEAL_CAPACITY seals by default, and refuses a capacity that is not a positive integer', () => {
    const store = createAgentMonitorStore();
    for (let index = 0; index <= DEFAULT_MONITOR_SEAL_CAPACITY; index += 1) {
      store.remove({ runtimeRunId: `run-${index}`, runtimeEpoch: 1 });
    }
    expect(store.acceptState(state(1, 5, 'run-1'))).toBe(false);
    expect(store.acceptState(state(1, 5, 'run-0'))).toBe(true);
    expect(() => createAgentMonitorStore({ sealCapacity: 0 })).toThrow(RangeError);
    expect(() => createAgentMonitorStore({ sealCapacity: 1.5 })).toThrow(RangeError);
  });

  it('ignores an older removal after reconstruction', () => {
    const store = createAgentMonitorStore();
    store.acceptState(state(3, 1));
    expect(store.remove({ runtimeRunId: 'run-1', runtimeEpoch: 2 })).toBe(false);
    expect(store.getState('run-1')).toMatchObject({ runtimeEpoch: 3 });
  });

  it('accepts an unseen removal as a tombstone and rejects state when its epoch is unknown', () => {
    const store = createAgentMonitorStore();
    expect(store.remove({ runtimeRunId: 'run-1', runtimeEpoch: null })).toBe(true);
    expect(store.acceptState(state(99, 1))).toBe(false);
    expect(store.remove({ runtimeRunId: 'run-1', runtimeEpoch: null })).toBe(false);
  });

  it('freezes accepted state and isolates subscriber and diagnostic failures', () => {
    const onListenerError = vi.fn(() => {
      throw new Error('diagnostic failed');
    });
    const store = createAgentMonitorStore({ onListenerError });
    const laterListener = vi.fn();
    store.subscribe(() => {
      throw new Error('subscriber failed');
    });
    store.subscribe(laterListener);
    const next = state(1, 1);

    expect(() => store.acceptState(next)).not.toThrow();
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.usage)).toBe(true);
    expect(laterListener).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('deduplicates, bounds, and dismisses notifications', () => {
    const store = createAgentMonitorStore({ notificationCapacity: 2 });
    expect(store.acceptNotification(notification(1))).toBe(true);
    expect(store.acceptNotification(notification(1))).toBe(false);
    store.acceptNotification(notification(2));
    store.acceptNotification(notification(3));
    expect(store.getSnapshot().notifications.map(({ notificationId }) => notificationId)).toEqual([
      'notice-2',
      'notice-3',
    ]);
    expect(store.dismissNotification('run-1', 'notice-2')).toBe(true);
    expect(store.getSnapshot().notifications.map(({ notificationId }) => notificationId)).toEqual(['notice-3']);
  });

  it('subscribes before loading so a stale initial snapshot cannot overwrite live state', async () => {
    let stateListener: ((value: AgentMonitorState) => void) | undefined;
    const source: AgentMonitorSource = {
      async listStates() {
        stateListener?.(state(1, 2));
        return [state(1, 1)];
      },
      onState(listener) {
        stateListener = listener;
        return () => {
          stateListener = undefined;
        };
      },
      onNotification: () => () => undefined,
      onRemoved: () => () => undefined,
    };
    const store = createAgentMonitorStore();
    const connection = connectAgentMonitorStore(store, source);
    await connection.ready;
    expect(store.getState('run-1')?.revision).toBe(2);
    connection.close();
  });
});
