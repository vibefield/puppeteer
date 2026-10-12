import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentView, MonitorModel } from '@vibefield/puppeteer-view-sdk/model';
import { formatUsd } from '@vibefield/puppeteer-view-sdk/toolkit';
import type { AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorAgent } from './types.js';
import { liveSession, rowIdForSession, type MonitorTerminalRecord } from './window-facts.js';

/**
 * THE CHROME'S ROWS (M19). The inspector, the find sheet, the deck's pane
 * frames, split sessions and pane recovery are this app's chrome, outside the
 * monitor views' wall, and they read facts the model does not carry: the run's
 * full `AgentMonitorState` (`monitor:chrome-state`), its host record, the live
 * terminal summary, the pane attachment by session. Each row here is the
 * model's row (one per body, as the views draw them), joined by session with
 * those facts exactly as the seam joined them. Only what the chrome reads is
 * said: the views read the model's rows themselves, and the legacy shim that
 * once said every row in the old shape for both went with MV-8 (L9).
 *
 * Only the chrome reads these rows. The replica, the views, the counts and the
 * status shortcuts read the model alone.
 */

/** One of main's agent records as this window holds it, with the chrome's full state once it has arrived. */
export interface ChromeAgentRecord {
  info: AgentSessionInfo;
  monitor?: AgentMonitorStateMessage | undefined;
}

export interface ChromeRowsInput {
  /** The replica's model: its rows in order, each wearing the spatial identity this window joined (`visualId`). */
  readonly model: MonitorModel;
  /** Each agent row's terminal session. */
  readonly agentSessions: ReadonlyMap<string, string>;
  /** Main's agent records, by terminal session. */
  readonly records: ReadonlyMap<string, ChromeAgentRecord>;
  /** This window's terminals (merged). */
  readonly terminals: readonly MonitorTerminalRecord[];
  readonly sessions: ReadonlyMap<string, SessionSummary>;
  /** This window's panes, by the session each shows. */
  readonly attachments: ReadonlyMap<string, PaneAttachment>;
  readonly identities?: ReadonlyMap<string, string> | undefined;
}

/**
 * The per-minute rate from the row's per-hour burn. The backend multiplies
 * Core's per-minute rate by 60; dividing back can land an ulp away (0.015 comes
 * back as 0.014999999999999998), and `formatUsd` would print a half cent the other
 * way ("$0.01/min" for "$0.02/min"). Fifteen significant digits restore it (M27).
 */
function perMinute(burnPerHour: number): number {
  return Number((burnPerHour / 60).toPrecision(15));
}

/**
 * The words Find matches an agent's row on: Godview's own line before the
 * views moved to the toolkit's reply-first rule (M4) — the headline, the
 * blockers beyond the first, the cost, the burn. The chrome keeps it, so what
 * Find finds does not move; a terminal's line is the backend's own.
 */
// Model rows are immutable and structurally shared (MV-D21). The old shim
// formatted a row only when that object changed. Keep that property after its
// removal: pane/terminal/chrome updates must not reformat every unchanged cost.
const details = new WeakMap<AgentView, string>();

export function chromeDetail(row: AgentView): string {
  const held = details.get(row);
  if (held !== undefined) return held;
  const detail = formatChromeDetail(row);
  details.set(row, detail);
  return detail;
}

function formatChromeDetail(row: AgentView): string {
  if (row.kind !== 'agent') return row.detail;
  const { cost, wait } = row;
  const blockers = wait ? (wait.count ?? 1) : 0;
  const priced = cost !== undefined && cost.coverage !== 'unavailable';
  return [
    row.detail,
    blockers > 1 ? `+${blockers - 1} blockers` : undefined,
    priced
      ? `~${formatUsd(cost.usd)} estimated API cost${cost.coverage === 'partial' ? ' (partial)' : ''}`
      : 'cost unavailable',
    cost?.burnPerHour === undefined ? undefined : `${formatUsd(perMinute(cost.burnPerHour))}/min`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The folder a run works in, the seam's chain: the observed directory, the workspace's, the terminal's. */
function agentCwd(info: AgentSessionInfo, monitor: AgentMonitorStateMessage['state']): string | undefined {
  return monitor.environment.cwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || undefined;
}

/** A row's own facts as the chrome reads them, with this window's session, folder and panes. */
function chromeRow(
  row: AgentView,
  session: SessionSummary,
  cwd: string | undefined,
  attachment: PaneAttachment | undefined,
): MonitorAgent {
  return {
    id: row.id,
    createdAtMs: row.createdAt,
    status: row.status,
    // With no folder, an agent is named by its provider and a terminal reads `terminal`, as the seam named them.
    project: row.project.name || (row.kind === 'agent' ? (row.provider?.label ?? '') : 'terminal'),
    detail: chromeDetail(row),
    color: row.colour,
    active: row.active,
    ...(row.stale ? { stale: true } : {}),
    session,
    ...(cwd ? { cwd } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

export function chromeRows(input: ChromeRowsInput): readonly MonitorAgent[] {
  const terminalBySession = new Map<string, MonitorTerminalRecord>();
  for (const terminal of input.terminals) {
    const rowId = rowIdForSession(terminal.session.id, input.identities);
    if (!terminalBySession.has(rowId)) terminalBySession.set(rowId, terminal);
  }
  const rows: MonitorAgent[] = [];
  // One row per body, as the views draw them: when two rows wear one visual identity (a launched agent's first
  // state can arrive while the fresh shell it takes over is still in its pane), the earlier in the model's order
  // (agents first) speaks for it.
  const bodies = new Set<string>();
  for (const row of input.model.agents) {
    const body = row.visualId ?? row.id;
    if (bodies.has(body)) continue;
    bodies.add(body);
    if (row.kind === 'agent') {
      const sessionId = input.agentSessions.get(row.id);
      const record = sessionId === undefined ? undefined : input.records.get(sessionId);
      if (!record) continue;
      const { info } = record;
      const monitor = record.monitor?.state;
      const attachment = input.attachments.get(info.session.id);
      // Before the chrome's state arrives (it rides its own channel) the chrome sees the run's terminal, as the seam
      // drew a run before its first state.
      if (!monitor) {
        rows.push(chromeRow(row, info.session, info.session.cwd ?? undefined, attachment));
        continue;
      }
      rows.push({
        ...chromeRow(row, info.session, agentCwd(info, monitor), attachment),
        agent: {
          provider: { ...info.provider },
          ...(row.model ? { model: row.model } : {}),
          ...(row.account ? { account: row.account } : {}),
          ...(row.project.branch ? { branch: row.project.branch } : {}),
          ...(monitor.context ? { contextWindow: monitor.context } : {}),
          monitor,
          recency: row.stale ? 'stale' : 'fresh',
          ...(info.nativeSession?.id ? { nativeSessionId: info.nativeSession.id } : {}),
          info,
        },
      });
      continue;
    }
    const terminal = terminalBySession.get(row.id);
    if (!terminal) continue;
    const session = liveSession(terminal, input.sessions);
    rows.push(chromeRow(row, session, session.cwd ?? terminal.cwd ?? undefined, input.attachments.get(session.id)));
  }
  return rows;
}
