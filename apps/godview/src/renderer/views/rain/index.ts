import type { AgentMonitorView } from '../../monitor/types.js';
import { RainView } from './RainView.js';
import { RAIN_PARAMETER_GROUPS } from './rain-parameters.js';

export const rainMonitorView: AgentMonitorView = {
  id: 'rain',
  label: 'RAIN',
  parameterGroups: RAIN_PARAMETER_GROUPS,
  Component: RainView,
};
