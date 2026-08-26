import { useSyncExternalStore } from 'react';
import type { AgentMonitorState, MonitorNotification } from '@vibecook/puppeteer-core';
import type { AgentMonitorStore, AgentMonitorStoreSnapshot } from '@vibecook/puppeteer-monitor';

/** Subscribe to the complete, referentially stable monitor-store snapshot. */
export function useAgentMonitorStore(store: AgentMonitorStore): AgentMonitorStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useAgentMonitorStates(store: AgentMonitorStore): readonly AgentMonitorState[] {
  return useAgentMonitorStore(store).states;
}

/** Subscribe to one run without rerendering for unrelated run revisions. */
export function useAgentMonitor(store: AgentMonitorStore, runtimeRunId: string): AgentMonitorState | undefined {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState(runtimeRunId),
    () => store.getState(runtimeRunId),
  );
}

export function useAgentMonitorNotifications(store: AgentMonitorStore): readonly MonitorNotification[] {
  return useAgentMonitorStore(store).notifications;
}
