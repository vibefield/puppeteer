import type { PaneFrameAgent } from '@vibecook/puppeteer-views';
import type { MonitorAgent } from '../monitor/types.js';

/**
 * The frame itself lives in `@vibecook/puppeteer-views` since PU-14 (design-
 * system record §07); what stays here is the seam — this host's monitor facet
 * projected into the facts the frame reads.
 */
export function paneFrameAgent(agent: MonitorAgent): PaneFrameAgent | undefined {
  const facet = agent.agent;
  if (!facet) return undefined;
  const effort = facet.monitor.effort;
  const context = facet.contextWindow;
  const usedPercent = context?.usedPercent;
  const contextKnown =
    context !== undefined &&
    context.percentageSource !== 'unavailable' &&
    usedPercent !== undefined &&
    Number.isFinite(usedPercent);
  return {
    providerId: facet.provider.id,
    providerLabel: facet.provider.label,
    status: agent.status,
    alive: facet.monitor.alive,
    statusSince: facet.monitor.statusSince,
    project: agent.project,
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(facet.model ? { model: facet.model } : {}),
    ...(effort?.value ? { effort: { value: effort.value, configured: effort.intent === 'configured' } } : {}),
    ...(contextKnown ? { contextPercent: usedPercent } : {}),
  };
}

/**
 * The folders the monitor remembers per session — the badge's last fallback for
 * a shell whose summary has no cwd yet (a fresh split before its first prompt),
 * which the frame would otherwise name "terminal". Every row carries one, facet
 * or not.
 */
export function paneFallbackCwds(agentsBySession: ReadonlyMap<string, MonitorAgent>): ReadonlyMap<string, string> {
  const cwds = new Map<string, string>();
  for (const [sessionId, agent] of agentsBySession) {
    if (agent.cwd) cwds.set(sessionId, agent.cwd);
  }
  return cwds;
}

/** The frame's agents, keyed like the monitor's rows: by the session a pane shows. */
export function paneFrameAgents(
  agentsBySession: ReadonlyMap<string, MonitorAgent>,
): ReadonlyMap<string, PaneFrameAgent> {
  const frames = new Map<string, PaneFrameAgent>();
  for (const [sessionId, agent] of agentsBySession) {
    const frame = paneFrameAgent(agent);
    if (frame) frames.set(sessionId, frame);
  }
  return frames;
}
