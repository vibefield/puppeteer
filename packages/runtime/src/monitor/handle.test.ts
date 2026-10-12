import type { AgentMonitorState, MonitorNotification } from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  createMonitorHandle,
  MonitorNotificationGapError,
  type MonitorHandleSource,
  type MonitorHandleSubscriber,
} from './handle.js';

function state(revision: number): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeEpoch: 1,
    revision,
    runtimeRunId: 'run-1',
    status: revision === 1 ? 'working' : 'idle',
    statusSince: '2026-08-16T12:00:00.000Z',
    blockers: [],
    ...(revision === 1
      ? { activity: { kind: 'starting' as const, line: 'Starting', since: '2026-08-16T12:00:00.000Z' } }
      : {}),
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'terminal-only', families: {} },
    alive: true,
  };
}

function notification(index: number): MonitorNotification {
  return {
    notificationId: `notice-${index}`,
    runtimeRunId: 'run-1',
    at: '2026-08-16T12:00:00.000Z',
    type: 'blocked.entered',
  };
}

function source(
  onSubscribe?: () => void,
): MonitorHandleSource & { emitState(value: AgentMonitorState): void; emitNotice(value: MonitorNotification): void } {
  let current = state(1);
  const subscribers = new Set<MonitorHandleSubscriber>();
  return {
    runtimeRunId: 'run-1',
    current: () => current,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      onSubscribe?.();
      return () => subscribers.delete(subscriber);
    },
    emitState(value) {
      current = value;
      for (const subscriber of subscribers) subscriber.publishState(value);
    },
    emitNotice(value) {
      for (const subscriber of subscribers) subscriber.publishNotification(value);
    },
  };
}

describe('createMonitorHandle', () => {
  it('subscribes before installing its readiness snapshot and cannot miss a racing publication', async () => {
    let input!: ReturnType<typeof source>;
    input = source(() => input.emitState(state(2)));
    const handle = createMonitorHandle(input, 8);

    await expect(handle.ready).resolves.toMatchObject({ revision: 2 });
    await expect(handle.states[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { revision: 2 },
    });
  });

  it('conflates undrained states to the latest full replacement', async () => {
    const input = source();
    const handle = createMonitorHandle(input, 8);
    input.emitState(state(2));
    input.emitState(state(3));

    await expect(handle.states[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: { revision: 3 } });
    expect(handle.current()?.revision).toBe(3);
  });

  it('keeps notification order and fails explicitly on a consumer gap', async () => {
    const orderedSource = source();
    const ordered = createMonitorHandle(orderedSource, 2);
    const iterator = ordered.notifications[Symbol.asyncIterator]();
    orderedSource.emitNotice(notification(1));
    orderedSource.emitNotice(notification(2));
    await expect(iterator.next()).resolves.toMatchObject({ value: { notificationId: 'notice-1' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { notificationId: 'notice-2' } });

    const overflowSource = source();
    const overflow = createMonitorHandle(overflowSource, 2);
    const overflowIterator = overflow.notifications[Symbol.asyncIterator]();
    overflowSource.emitNotice(notification(1));
    overflowSource.emitNotice(notification(2));
    overflowSource.emitNotice(notification(3));
    await expect(overflowIterator.next()).rejects.toBeInstanceOf(MonitorNotificationGapError);
  });
});
