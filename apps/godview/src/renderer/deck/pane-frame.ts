import type { WorkspaceConfig } from '@vibecook/ghosttea-protocol';
import {
  defaultBindingsForPlatform,
  formatGhosttyTrigger,
  parseGhosttyAction,
  parseGhosttyTrigger,
  synthesizeKeyEvent,
  type GhosttyBindingEntry,
  type KeyEventLike,
} from '@vibecook/ghosttea-react/workspace';
import type { PaneFrameAgent } from '@vibecook/puppeteer-views';
import type { MonitorAgent } from '../monitor/types.js';

/**
 * The frame itself lives in `@vibecook/puppeteer-views` since PU-14 (design-
 * system record §07); what stays here is the seam — this host's monitor facet
 * projected into the facts the frame reads, and the zoom binding only this
 * host's runtime knows.
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

/**
 * The keystroke Ghosttea's workspace maps to `toggle_split_zoom`, so the
 * fullscreen verb presses exactly what the user's own binding would: the
 * platform defaults with the configuration's `keybind` mutations over them,
 * the same table the workspace resolves against. Null when the action is
 * unbound.
 */
export function zoomKeyEvent(config: WorkspaceConfig | undefined, platform: string | undefined): KeyEventLike | null {
  const table = new Map<string, GhosttyBindingEntry>(
    (config?.clearKeybindings ? [] : defaultBindingsForPlatform(platform as never)).map(
      (entry) => [formatGhosttyTrigger(entry.trigger), entry] as const,
    ),
  );
  for (const mutation of config?.keybindings ?? []) {
    let trigger: ReturnType<typeof parseGhosttyTrigger>;
    try {
      trigger = parseGhosttyTrigger(mutation.trigger.replace(/^(?:(?:all|global|unconsumed|performable):)+/u, ''));
    } catch {
      continue;
    }
    const canonical = formatGhosttyTrigger(trigger);
    if (mutation.action === 'unbind') {
      table.delete(canonical);
      continue;
    }
    try {
      table.set(canonical, {
        trigger,
        triggerRaw: mutation.trigger,
        action: parseGhosttyAction(mutation.action),
        actionRaw: mutation.action,
        flags: { performable: false },
      });
    } catch {
      // An action this Ghosttea cannot name is left as the workspace leaves it.
    }
  }
  // A configured trigger lands after the defaults, and a rebinding is the
  // keystroke the user actually knows, so the last match wins.
  let found: GhosttyBindingEntry | undefined;
  for (const entry of table.values()) {
    if (entry.action.type === 'toggle_split_zoom') found = entry;
  }
  return found ? synthesizeKeyEvent(found.trigger) : null;
}
