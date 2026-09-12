import { describe, expect, it, vi } from 'vitest';
import type { AgentMonitorState, MonitorNotification } from '@vibecook/puppeteer-core';
import { connectAgentMonitorStore, createAgentMonitorStore, type AgentMonitorSource } from './store.js';

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
    subagents: [],
    workflows: [],
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
    type: 'delegation:subagent-started',
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
