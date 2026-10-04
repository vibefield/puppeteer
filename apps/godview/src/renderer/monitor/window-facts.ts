import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { MonitorHostTerminal } from '@vibecook/puppeteer-monitor';
import type { MonitorReplicaAttachment, MonitorReplicaLocal } from '@vibecook/puppeteer-monitor/replica';
import type { MonitorAgentRow, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import type { PaneAttachment } from '../pane-attachments.js';

/**
 * What only this window knows (MV-2), as the backend and the replica read it.
 *
 * The backend computes every row once, in main; a window holds its panes, the
 * pane it is working in, the shells it opened, closed or saw exit, and the
 * identities its handoffs carried. Nothing here derives a business fact: it
 * names this window's terminals for the host port, and joins its panes to the
 * rows the model already has (the replica's `setLocal`).
 *
 * A row's id is the identity its terminal carries across handoffs, else the
 * terminal session's own id: the convention main's host port keys runs and
 * terminals by, and exactly how this window's seam named its rows.
 */

/** A terminal the user opened that no agent has claimed, as this window holds it. */
export interface MonitorTerminalRecord {
  /** Optional stable visual identity across a dead-PTY -> shell handoff. */
  id?: string;
  session: SessionSummary;
  /** Remembered directory used only when the live session has no cwd metadata. */
  cwd?: string;
  spawnHint?: { x: number; y: number };
}

export interface MergeMonitorTerminalsInput {
  explicit: readonly MonitorTerminalRecord[];
  workspaceSessions: readonly SessionSummary[];
  exitedSessionIds?: ReadonlySet<string> | undefined;
  closingSessionIds?: ReadonlySet<string> | undefined;
  identities?: ReadonlyMap<string, string> | undefined;
}

/** Mounted workspace sessions are terminal resources even when no UI gesture created a placeholder for them. */
export function mergeMonitorTerminals(input: MergeMonitorTerminalsInput): readonly MonitorTerminalRecord[] {
  const bySession = new Map(input.explicit.map((terminal) => [terminal.session.id, terminal] as const));
  for (const session of input.workspaceSessions) {
    if (session.exited || input.exitedSessionIds?.has(session.id) || input.closingSessionIds?.has(session.id)) continue;
    const existing = bySession.get(session.id);
    const cwd = session.cwd ?? existing?.cwd ?? undefined;
    const identity = input.identities?.get(session.id);
    bySession.set(session.id, {
      ...existing,
      ...(identity ? { id: identity } : {}),
      session,
      ...(cwd ? { cwd } : {}),
    });
  }
  return [...bySession.values()].filter(
    (terminal) =>
      !terminal.session.exited &&
      !input.exitedSessionIds?.has(terminal.session.id) &&
      !input.closingSessionIds?.has(terminal.session.id),
  );
}

/** The id a session's row carries: the identity its terminal keeps across handoffs, else the session's own. */
export function rowIdForSession(sessionId: string, identities?: ReadonlyMap<string, string>): string {
  return identities?.get(sessionId) ?? sessionId;
}

/** A terminal record's live summary: the workspace's, else the one it was created with. */
export function liveSession(
  terminal: MonitorTerminalRecord,
  sessions: ReadonlyMap<string, SessionSummary> | undefined,
): SessionSummary {
  return sessions?.get(terminal.session.id) ?? terminal.session;
}

/**
 * This window's bare-terminal candidates for the host port: every terminal it
 * holds (agents' PTYs included, so a promoted shell stays listed until its run
 * is named, and the backend's dedupe covers the overlap), with the facts its
 * seam drew a terminal from. No title: a terminal in no folder reads `terminal`.
 */
export function terminalReport(
  terminals: readonly MonitorTerminalRecord[],
  sessions: ReadonlyMap<string, SessionSummary> | undefined,
  identities: ReadonlyMap<string, string> | undefined,
): MonitorHostTerminal[] {
  const report: MonitorHostTerminal[] = [];
  for (const terminal of terminals) {
    const session = liveSession(terminal, sessions);
    if (session.exited) continue;
    const identity = identities?.get(session.id);
    const cwd = session.cwd ?? terminal.cwd ?? undefined;
    report.push({
      sessionId: session.id,
      ...(identity ? { identity } : {}),
      createdAt: session.createdAtMs,
      ...(cwd ? { cwd } : {}),
      ...(session.activity ? { activity: { kind: session.activity.kind } } : {}),
    });
  }
  return report;
}

export interface WindowLocalInput {
  /** The replica's model: which rows are agents, so a pane joins only the row its session backs. */
  readonly model: MonitorModel;
  /** Each agent row's terminal session, from main's agent records. */
  readonly agentSessions: ReadonlyMap<string, string>;
  /** This window's panes, by the session each shows. */
  readonly attachments: ReadonlyMap<string, PaneAttachment>;
  readonly activeSessionId?: string | undefined;
  /** This window's terminals (merged), whose rows this window shows. */
  readonly terminals: readonly MonitorTerminalRecord[];
  readonly identities?: ReadonlyMap<string, string> | undefined;
}

/**
 * Whether a pane showing `sessionId` stands for row `rowId`. Not when that row
 * is an agent backed by ANOTHER session: a crashed agent's row stays until it
 * is acknowledged while its pane already shows the shell it was handed, and
 * that pane is not the crashed row's (the seam keyed panes by session).
 */
function paneShowsRow(rowId: string, sessionId: string, input: WindowLocalInput): boolean {
  const row = input.model.byId.get(rowId);
  return row?.kind !== 'agent' || input.agentSessions.get(rowId) === sessionId;
}

/** The ids of this window's terminal rows: the only terminals it shows (each window's seam drew its own). */
export function windowTerminalIds(
  terminals: readonly MonitorTerminalRecord[],
  identities: ReadonlyMap<string, string> | undefined,
): ReadonlySet<string> {
  return new Set(terminals.map((terminal) => rowIdForSession(terminal.session.id, identities)));
}

/**
 * The replica's local join for this window. `visible` keeps every agent (a
 * crashed one until it is acknowledged, M3) and only this window's terminals;
 * the predicate is passed in so it keeps its identity while the set does.
 */
export function windowLocal(input: WindowLocalInput, visible: (row: MonitorAgentRow) => boolean): MonitorReplicaLocal {
  const attachments = new Map<string, MonitorReplicaAttachment>();
  for (const [sessionId, attachment] of input.attachments) {
    const rowId = rowIdForSession(sessionId, input.identities);
    if (!paneShowsRow(rowId, sessionId, input)) continue;
    attachments.set(
      rowId,
      attachment.color === undefined
        ? { panes: attachment.paneIds.length }
        : { panes: attachment.paneIds.length, colour: attachment.color },
    );
  }
  const activeIds = new Set<string>();
  if (input.activeSessionId !== undefined) {
    const rowId = rowIdForSession(input.activeSessionId, input.identities);
    if (paneShowsRow(rowId, input.activeSessionId, input)) activeIds.add(rowId);
  }
  // A spawn hint places a terminal born where the gesture was; an agent's row never carried one.
  const spawnHints = new Map<string, { x: number; y: number }>();
  for (const terminal of input.terminals) {
    if (!terminal.spawnHint) continue;
    const rowId = rowIdForSession(terminal.session.id, input.identities);
    if (input.model.byId.get(rowId)?.kind === 'agent') continue;
    spawnHints.set(rowId, terminal.spawnHint);
  }
  return { attachments, activeIds, spawnHints, visible };
}

/** Each agent row's terminal session, in main's record order: the first record to carry a row's id is its session. */
export function agentSessionsByRow(
  sessionIds: Iterable<string>,
  identities: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  const sessions = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const rowId = rowIdForSession(sessionId, identities);
    if (!sessions.has(rowId)) sessions.set(rowId, sessionId);
  }
  return sessions;
}

/** The session a row stands for in this window: an agent's PTY, or one of this window's terminals. */
export function sessionIdForRow(
  row: Pick<MonitorAgentRow, 'id' | 'kind'>,
  agentSessions: ReadonlyMap<string, string>,
  terminals: readonly MonitorTerminalRecord[],
  identities: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (row.kind === 'agent') return agentSessions.get(row.id);
  return terminals.find((terminal) => rowIdForSession(terminal.session.id, identities) === row.id)?.session.id;
}

/**
 * The swarm's spatial identity for each row, as the seam named it: the visual
 * id the window transferred to the row's session (a launcher's agent takes the
 * fresh shell's body; a handed-off shell the dead agent's), else the one the row
 * wore last time, else its session. Every row is in the result, so it can be
 * the next call's `previous`; `visualId ?? id` is how every view reads it.
 */
export function visualIdsForRows(
  rows: readonly Pick<MonitorAgentRow, 'id' | 'kind'>[],
  sessionOf: (row: Pick<MonitorAgentRow, 'id' | 'kind'>) => string | undefined,
  visualIds: ReadonlyMap<string, string> | undefined,
  previous: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    const sessionId = sessionOf(row);
    const visualId =
      (sessionId === undefined ? undefined : visualIds?.get(sessionId)) ?? previous.get(row.id) ?? sessionId ?? row.id;
    result.set(row.id, visualId);
  }
  return result;
}
