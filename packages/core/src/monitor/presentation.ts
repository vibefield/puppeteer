import type { AgentMonitorState, MonitorBlocker } from './types.js';

export interface AgentMonitorHeadlinePresentation {
  status: AgentMonitorState['status'];
  label: 'Idle' | 'Working' | 'Blocked';
  detail: string;
  since: string;
  blockerCount: number;
}

export function monitorBlockerDetail(blocker: MonitorBlocker): string {
  if (blocker.kind === 'permission') {
    return (
      blocker.detail ?? (blocker.permission?.tool ? `permission · ${blocker.permission.tool}` : 'permission required')
    );
  }
  if (blocker.kind === 'question') {
    const question = blocker.questions[0];
    return (
      blocker.detail ?? (question ? `question · ${question.header ?? question.prompt}` : 'question requires input')
    );
  }
  return blocker.detail ?? (blocker.failure?.code ? `failure · ${blocker.failure.code}` : 'failure requires attention');
}

/** Shared wording only; status itself is copied directly from core projection. */
export function presentAgentMonitorHeadline(state: AgentMonitorState): AgentMonitorHeadlinePresentation {
  const blocker = state.blockers[0];
  return {
    status: state.status,
    label: state.status === 'idle' ? 'Idle' : state.status === 'working' ? 'Working' : 'Blocked',
    detail:
      state.status === 'blocked'
        ? blocker
          ? monitorBlockerDetail(blocker)
          : 'blocked'
        : state.status === 'working'
          ? (state.activity?.line ?? 'working')
          : 'idle',
    since: state.status === 'working' && state.activity ? state.activity.since : state.statusSince,
    blockerCount: state.blockers.length,
  };
}
