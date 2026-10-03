// The legacy shim (L9): the SDK's model as the legacy `MonitorAgent`, until every view is ported. MV-8 deletes it.
export {
  toMonitorAgent,
  toMonitorAgents,
  viewReadProjection,
  type MonitorAgentViewReads,
  type MonitorAgentViewReadsBlocker,
} from './from-agent-view.js';
