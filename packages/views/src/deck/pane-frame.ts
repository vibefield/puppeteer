import type { TerminalKey } from '@vibefield/puppeteer-core';
import type { HostMark, Picture } from '@vibefield/puppeteer-view-sdk';
import type { AgentVisualStatus } from '../monitor/agent-status.js';
import { folderName } from '../monitor/folder-name.js';

/**
 * What the pane frame draws around one terminal, decided 2026-09-10
 * (design-system record §07). Everything here is a projection of facts the
 * HOST hands over — a session's folder and exit, an agent's status, model,
 * effort and context share — never of terminal text, and never of a host's
 * own monitor type: a host adapts its facet to `PaneFrameAgent` at the seam
 * (VibeField's AR-5 rule — the views dial nothing and know no host).
 */
export interface PaneFrameModel {
  /**
   * The session's own title where the host hands one, else the folder. Never the terminal's title: that is terminal
   * text, and the session's title is its provider's own word.
   */
  name: string;
  /** The folder, where a title names the pane: what a pointer reads after the name. */
  folder?: string;
  /** The agent mark before the name; absent for a bare shell, and where the host's mark hides the provider. */
  providerId?: string;
  /** The host's picture before the name (`HostMark.lead`). */
  lead?: Picture;
  /** The device a remote session lives on; absent means local. */
  remote?: string;
  /** model · effort, lowercase in the type; italic effort while only configured. */
  readout?: { model: string; effort?: string; configured: boolean };
  /** The share of the context window in use; absent while the provider says nothing. */
  context?: { percent: number; hot: boolean };
  /** Cancellation is available only while the host observes an active turn. */
  turnActive?: boolean;
  /**
   * Stop while the agent runs, resume once its process has ended; a shell has
   * no verb. `key` is the stop's key as its title names it.
   */
  verb?: { kind: 'stop'; elapsed?: string; key?: string } | { kind: 'resume' };
}

/** The terminal facts the frame reads: Ghosttea's summary, narrowed. */
export interface PaneFrameSession {
  id: string;
  exited: boolean;
  cwd?: string | null | undefined;
}

/**
 * The agent facts the frame reads, in the host's own words. A host builds one
 * from its monitor facet; `contextPercent` is present only when the provider
 * could say (the host applies its `percentageSource` rule before handing it
 * over), `effort.configured` says the effort is an intent the user set rather
 * than one the provider reported.
 */
export interface PaneFrameAgent {
  providerId: string;
  providerLabel: string;
  status: AgentVisualStatus;
  alive: boolean;
  statusSince?: string | undefined;
  /**
   * The session's own title, as the host's monitor says it (the model row's `title`): the badge's name where
   * present, with the folder left to the pointer.
   */
  title?: string | undefined;
  /** The project the badge is named by, before the session's cwd. */
  project?: string | undefined;
  /** The agent's cwd, the badge's last fallback. */
  cwd?: string | undefined;
  model?: string | undefined;
  effort?: { value: string; configured: boolean } | undefined;
  contextPercent?: number | undefined;
  /**
   * The key the host's stop verb presses, in core's words (`TerminalKey`): the
   * agent's own turn stop as its adapter names it, or the host's own choice
   * while the adapter names none. Absent: the stop presses no key (the agent's
   * own native control), and the title names none.
   */
  stopKey?: string | undefined;
  /**
   * The host's stop in flight, in its own open words (for example `sent`,
   * `resent`, `terminating`, `heard`). While a stage other than `heard` is
   * present the frame shows the stop in flight, with no timer of its own.
   * Absent: the frame keeps its own guess around its press.
   */
  stop?: { stage: string; sentAt?: string | undefined; unheardAt?: string | undefined } | undefined;
  /**
   * The host's mark on the pane's row (`HostMark`): its `lead` before the name, its `name` in the name's place, and
   * no provider mark when its `provider` is `hidden`. Absent: the badge as it ships.
   */
  mark?: HostMark | undefined;
}

const STOP_KEY_GLYPHS: Readonly<Record<TerminalKey, string>> = { escape: '⎋', 'ctrl-c': '⌃C' };

/** A stop key as the title names it: its glyph, or a key this build has no glyph for by its own word. */
export function stopKeyLabel(key: string): string {
  return Object.hasOwn(STOP_KEY_GLYPHS, key) ? STOP_KEY_GLYPHS[key as TerminalKey] : key;
}

/** Past this share the meter and figure darken; the record keeps them grey, never orange. */
export const CONTEXT_HOT_PERCENT = 80;

/** Below this width the readout hides and the stop verb keeps only its square; the pane's sides tighten. */
export const NARROW_PANE_WIDTH = 220;

export interface PaneFrameInput {
  session: PaneFrameSession;
  agent?: PaneFrameAgent | undefined;
  /**
   * The folder the host remembers for a session whose summary carries no cwd
   * yet (a freshly split shell before its first prompt): the badge's last
   * fallback, after the agent's project and the session's own cwd.
   */
  fallbackCwd?: string | undefined;
  /** The device name a remote session lives on; absent for a local session. */
  remoteDevice?: string | undefined;
  nowMs: number;
}

/** The turn's time as the stop verb says it: m:ss under an hour, then h and m. */
export function formatTurnElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A pane's folder: a basename, by the project, then the session's own directory. Terminal titles are deliberately ignored. */
export function paneBadgeName(session: PaneFrameSession, agent?: PaneFrameAgent, fallbackCwd?: string): string {
  return folderName(agent?.project || session.cwd || agent?.cwd || fallbackCwd, 'terminal');
}

export function paneFrameModel({ session, agent, remoteDevice, fallbackCwd, nowMs }: PaneFrameInput): PaneFrameModel {
  const folder = paneBadgeName(session, agent, fallbackCwd);
  const title = agent?.mark?.name ? undefined : agent?.title?.trim() || undefined;
  const model: PaneFrameModel = {
    name: agent?.mark?.name || title || folder,
    ...(title ? { folder } : {}),
    ...(remoteDevice ? { remote: remoteDevice } : {}),
  };
  if (!agent) return model;
  if (agent.mark?.provider !== 'hidden') model.providerId = agent.providerId;
  if (agent.mark?.lead) model.lead = agent.mark.lead;

  model.readout = {
    model: agent.model ?? agent.providerLabel,
    ...(agent.effort?.value ? { effort: agent.effort.value } : {}),
    configured: agent.effort?.configured === true,
  };

  const usedPercent = agent.contextPercent;
  if (usedPercent !== undefined && Number.isFinite(usedPercent)) {
    const percent = Math.max(0, Math.min(100, Math.floor(usedPercent)));
    model.context = { percent, hot: percent >= CONTEXT_HOT_PERCENT };
  }

  const key = agent.stopKey ? { key: stopKeyLabel(agent.stopKey) } : {};
  if (session.exited || !agent.alive) {
    model.verb = { kind: 'resume' };
  } else if (agent.status === 'working') {
    model.turnActive = true;
    const since = agent.statusSince === undefined ? Number.NaN : Date.parse(agent.statusSince);
    model.verb = {
      kind: 'stop',
      ...(Number.isFinite(since) ? { elapsed: formatTurnElapsed(nowMs - since) } : {}),
      ...key,
    };
  } else {
    model.verb = { kind: 'stop', ...key };
  }
  return model;
}
