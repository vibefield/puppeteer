import type { AgentMonitorState } from './types.js';

export interface MonitorRevisionStamp {
  runtimeEpoch: number;
  revision: number;
}

/** Strict epoch/revision ordering shared by hosts, renderers, and aggregators. */
export function isNewerMonitorRevision(candidate: MonitorRevisionStamp, current: MonitorRevisionStamp): boolean {
  return (
    candidate.runtimeEpoch > current.runtimeEpoch ||
    (candidate.runtimeEpoch === current.runtimeEpoch && candidate.revision > current.revision)
  );
}

/** Removal seals an epoch; a durable run identity revives only through a newer epoch. */
export function isMonitorStateAfterRemoval(state: AgentMonitorState, sealedRuntimeEpoch: number | null): boolean {
  return sealedRuntimeEpoch !== null && state.runtimeEpoch > sealedRuntimeEpoch;
}
