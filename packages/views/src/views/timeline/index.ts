import type { AgentMonitorView } from '../../monitor/types.js';
import { TimelineView } from './TimelineView.js';
import { TIMELINE_PARAMETER_GROUPS } from './timeline-parameters.js';

export const timelineMonitorView: AgentMonitorView = {
  id: 'timeline',
  label: 'TIMELINE',
  parameterGroups: TIMELINE_PARAMETER_GROUPS,
  Component: TimelineView,
};
