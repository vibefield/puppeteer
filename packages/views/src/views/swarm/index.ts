import type { AgentMonitorView } from '../../monitor/types.js';
import { AgentSwarm } from './AgentSwarm.js';
import { SWARM_PARAMETER_GROUPS } from './swarm-parameters.js';

export const swarmMonitorView: AgentMonitorView = {
  id: 'swarm',
  label: 'SWARM',
  parameterGroups: SWARM_PARAMETER_GROUPS,
  // The design was locked on this date (RFC 005, record §10) with new sizes
  // and lights; installations tuned under the proposals start from the lock.
  parametersRevision: '2026-09-09',
  Component: AgentSwarm,
};
