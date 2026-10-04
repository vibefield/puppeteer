import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorAgent as ViewsMonitorAgent } from '@vibecook/puppeteer-views';
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
 * model's row as the views see it (the legacy shim's), joined by session with
 * those facts exactly as the seam joined them.
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
  readonly model: MonitorModel;
  /** The rows the views draw for `model` (the shim's, one per visual identity), in its order. */
  readonly legacy: readonly ViewsMonitorAgent[];
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

/** The folder a run works in, the seam's chain: the observed directory, the workspace's, the terminal's. */
function agentCwd(info: AgentSessionInfo, monitor: AgentMonitorStateMessage['state']): string | undefined {
  return monitor.environment.cwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || undefined;
}

function withSession(
  legacy: ViewsMonitorAgent,
  session: SessionSummary,
  cwd: string | undefined,
  attachment: PaneAttachment | undefined,
): MonitorAgent {
  const { attachment: _replicaAttachment, agent: _agent, cwd: _cwd, session: _session, ...rest } = legacy;
  return {
    ...rest,
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
  // The views' rows, each joined: a row the views do not draw (a second body for one visual identity) is none here.
  for (const legacy of input.legacy) {
    const row = input.model.byId.get(legacy.id);
    if (!row) continue;
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
        rows.push(withSession(legacy, info.session, info.session.cwd ?? undefined, attachment));
        continue;
      }
      const facet = legacy.agent;
      rows.push({
        ...withSession(legacy, info.session, agentCwd(info, monitor), attachment),
        agent: {
          provider: { ...info.provider },
          ...(facet?.model ? { model: facet.model } : {}),
          ...(facet?.account ? { account: facet.account } : {}),
          ...(facet?.branch ? { branch: facet.branch } : {}),
          ...(monitor.context ? { contextWindow: monitor.context } : {}),
          monitor,
          ...(facet?.usage ? { usage: facet.usage } : {}),
          recency: legacy.stale ? 'stale' : 'fresh',
          ...(info.nativeSession?.id ? { nativeSessionId: info.nativeSession.id } : {}),
          info,
        },
      });
      continue;
    }
    const terminal = terminalBySession.get(row.id);
    if (!terminal) continue;
    const session = liveSession(terminal, input.sessions);
    rows.push(
      withSession(legacy, session, session.cwd ?? terminal.cwd ?? undefined, input.attachments.get(session.id)),
    );
  }
  return rows;
}
