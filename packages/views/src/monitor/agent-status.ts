import type { AgentMonitorStatus } from '@vibecook/puppeteer-core';

/**
 * What a session is doing, derived only from reduced runtime state — never from
 * terminal text (DESIGN ADR-003/-005). How a status is then drawn is each
 * monitor view's own business. The word is Core's: `idle`, `working`,
 * `blocked`; a host with its own vocabulary translates at its seam.
 */
export type AgentVisualStatus = AgentMonitorStatus;

/** A terminal no agent has claimed: working while a foreground job runs, idle otherwise. */
export function classifyTerminalStatus(activity: { kind: string } | undefined): Exclude<AgentVisualStatus, 'blocked'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}
