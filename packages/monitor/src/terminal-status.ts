import type { AgentStatus } from '@vibecook/puppeteer-view-sdk/model';

/**
 * A terminal no agent has claimed: working while a foreground job runs, idle otherwise. The ONE rule, shared by the
 * backend (which classifies the host's activity) and the replica's join (which classifies the activity only the window
 * knows, M28), so a terminal reads the same whichever side knew what it was doing.
 */
export function classifyTerminalStatus(
  activity: { readonly kind: string } | undefined,
): Exclude<AgentStatus, 'blocked'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}
