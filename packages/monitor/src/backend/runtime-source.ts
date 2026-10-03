import type { AgentMonitorState, MonitorNotification } from '@vibecook/puppeteer-core';
import type { AgentMonitorRemoval, AgentMonitorSource } from '../store.js';

/**
 * The slice of puppeteer's `AgentRuntime` the backend reads, spelled
 * structurally so this package depends on core alone and never on the runtime.
 * `monitorStates()` is the all-runs snapshot; the three listeners are the
 * runtime's global push bus. A removal carries the epoch the runtime sealed.
 */
export interface MonitorRuntimeSource {
  monitorStates(): readonly AgentMonitorState[];
  onMonitorState(listener: (state: AgentMonitorState) => void): () => void;
  onMonitorNotification(listener: (notification: MonitorNotification) => void): () => void;
  onMonitorRemoved(listener: (runtimeRunId: string, removal: { readonly runtimeEpoch: number }) => void): () => void;
}

/**
 * The runtime as a run source: subscribe-before-list over its push bus
 * (`connectAgentMonitorStore` subscribes to all three, then lists), with the
 * all-runs snapshot the runtime grew for it. A removal seals the epoch the
 * runtime names; a runtime from before that argument seals the last epoch this
 * source saw for the run, and null when it never saw one (store.ts semantics).
 */
export function runtimeRunSource(runtime: MonitorRuntimeSource): AgentMonitorSource {
  const lastEpochByRun = new Map<string, number>();
  const remember = (state: AgentMonitorState): void => {
    lastEpochByRun.set(state.runtimeRunId, state.runtimeEpoch);
  };
  return {
    async listStates() {
      const states = [...runtime.monitorStates()];
      for (const state of states) remember(state);
      return states;
    },
    onState(listener) {
      return runtime.onMonitorState((state) => {
        remember(state);
        listener(state);
      });
    },
    onNotification(listener) {
      return runtime.onMonitorNotification(listener);
    },
    onRemoved(listener) {
      return runtime.onMonitorRemoved((runtimeRunId, removal?: { readonly runtimeEpoch: number }) => {
        const runtimeEpoch = removal?.runtimeEpoch ?? lastEpochByRun.get(runtimeRunId) ?? null;
        lastEpochByRun.delete(runtimeRunId);
        const sealed: AgentMonitorRemoval = { runtimeRunId, runtimeEpoch };
        listener(sealed);
      });
    },
  };
}
