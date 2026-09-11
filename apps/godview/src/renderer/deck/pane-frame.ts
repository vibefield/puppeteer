import type { SessionSummary, WorkspaceConfig } from '@vibecook/ghosttea-protocol';
import {
  defaultBindingsForPlatform,
  formatGhosttyTrigger,
  parseGhosttyAction,
  parseGhosttyTrigger,
  synthesizeKeyEvent,
  type GhosttyBindingEntry,
  type KeyEventLike,
} from '@vibecook/ghosttea-react/workspace';
import type { MonitorAgent } from '../monitor/types.js';
import { paneBadgeLabel } from '../pane-session.js';

/**
 * What the pane frame draws around one terminal, decided 2026-09-10
 * (design-system record §07). Everything here is a projection of Core's
 * monitor state and Ghosttea's session summary; nothing reads terminal text.
 */
export interface PaneFrameModel {
  /** The folder, never the terminal title. */
  name: string;
  /** The agent mark before the name; absent for a bare shell. */
  providerId?: string;
  /** The device a remote session lives on; absent means local. */
  remote?: string;
  /** model · effort, lowercase in the type; italic effort while only configured. */
  readout?: { model: string; effort?: string; configured: boolean };
  /** The share of the context window in use; absent while the provider says nothing. */
  context?: { percent: number; hot: boolean };
  /** Stop while the agent runs, resume once its process has ended; a shell has no verb. */
  verb?: { kind: 'stop'; elapsed?: string } | { kind: 'resume' };
}

/** Past this share the meter and figure darken; the record keeps them grey, never orange. */
export const CONTEXT_HOT_PERCENT = 80;

/** Below this width the readout hides and the stop verb keeps only its square; the pane's sides tighten. */
export const NARROW_PANE_WIDTH = 220;

export interface PaneFrameInput {
  session: SessionSummary;
  agent?: MonitorAgent;
  /** Device name from Ghosttea's remote lifecycle; absent for a local session. */
  remoteDevice?: string;
  nowMs: number;
}

/** The turn's time as the stop verb says it: m:ss under an hour, then h and m. */
export function formatTurnElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function paneFrameModel({ session, agent, remoteDevice, nowMs }: PaneFrameInput): PaneFrameModel {
  const facet = agent?.agent;
  const model: PaneFrameModel = {
    name: paneBadgeLabel(session, facet ? agent?.project : undefined, agent?.cwd),
    ...(remoteDevice ? { remote: remoteDevice } : {}),
  };
  if (!facet) return model;
  model.providerId = facet.provider.id;

  const effort = facet.monitor.effort;
  model.readout = {
    model: facet.model ?? facet.provider.label,
    ...(effort?.value ? { effort: effort.value } : {}),
    configured: effort?.intent === 'configured',
  };

  const context = facet.contextWindow;
  const usedPercent = context?.usedPercent;
  if (
    context &&
    context.percentageSource !== 'unavailable' &&
    usedPercent !== undefined &&
    Number.isFinite(usedPercent)
  ) {
    const percent = Math.max(0, Math.min(100, Math.floor(usedPercent)));
    model.context = { percent, hot: percent >= CONTEXT_HOT_PERCENT };
  }

  if (session.exited || !facet.monitor.alive) {
    model.verb = { kind: 'resume' };
  } else if (agent?.status === 'working') {
    const since = Date.parse(facet.monitor.statusSince);
    model.verb = {
      kind: 'stop',
      ...(Number.isFinite(since) ? { elapsed: formatTurnElapsed(nowMs - since) } : {}),
    };
  } else {
    model.verb = { kind: 'stop' };
  }
  return model;
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
