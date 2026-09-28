import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { classifyMonitorRecency, presentAgentMonitorHeadline, type AgentMonitorState } from '@vibecook/puppeteer-core';
import type { AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import { classifyTerminalStatus, projectLabel, type AgentVisualStatus } from '../agent-status.js';
import { folderName, formatUsd } from '@vibecook/puppeteer-views';
import type { PaneAttachment } from '../pane-attachments.js';
import { projectTint, type ProjectTint } from '@vibecook/puppeteer-views';
import type { MonitorAgent } from './types.js';
import type { UsageHistory } from '@vibecook/puppeteer-views';

export interface MonitorAgentRecord {
  info: AgentSessionInfo;
  monitor?: AgentMonitorStateMessage | undefined;
}

/** A terminal the user opened that no agent has claimed. */
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

export interface AssembleMonitorAgentsInput {
  agents: readonly MonitorAgentRecord[];
  terminals: readonly MonitorTerminalRecord[];
  /** Live summaries, so a terminal placeholder reflects current activity rather than launch state. */
  sessions?: ReadonlyMap<string, SessionSummary> | undefined;
  attachments?: ReadonlyMap<string, PaneAttachment> | undefined;
  /** Live terminal id -> stable monitor identity. */
  identities?: ReadonlyMap<string, string> | undefined;
  activeSessionId?: string | undefined;
  nowMs?: number | undefined;
  /** The theme's tint for project colours and the ramp for sessions with no project (record §02). */
  colours?: MonitorColours | undefined;
  /** The UI's usage ledger, by stable monitor identity. */
  usage?: ReadonlyMap<string, UsageHistory> | undefined;
}

/** The identity views key on: stable across PTY handoffs when the shell knows one, else the live terminal id. */
export function monitorIdentity(sessionId: string, identities?: ReadonlyMap<string, string>): string {
  return identities?.get(sessionId) ?? sessionId;
}

export interface MonitorColours {
  tint: ProjectTint;
  neutral: string;
}

/**
 * The project's dealt tint, or the ramp until main has folded the workspace to
 * its project. With no palette mounted the answer is `currentColor`: a
 * rendering with no colour rather than an invented one.
 */
function sessionColour(project: { seq: number } | undefined, colours: MonitorColours | undefined): string {
  if (!colours) return 'currentColor';
  return project ? projectTint(project.seq, colours.tint) : colours.neutral;
}

/** Undefined for a session that has stopped being worth showing at all. */
export function monitorAgentFromSession(
  record: MonitorAgentRecord,
  options: {
    nowMs?: number | undefined;
    colours?: MonitorColours | undefined;
    usage?: UsageHistory | undefined;
  } = {},
): MonitorAgent | undefined {
  const { info, monitor } = record;
  if (!monitor) return undefined;
  const current = monitor.state;
  const headline = presentAgentMonitorHeadline(current);
  const currentCwd = current.environment.cwd;
  const branch = current.environment.git?.branch ?? info.workspace.branch;
  const cwd = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || undefined;
  // Cached observed runs extend the estimate; the live rate always comes from Core.
  const costUsd = options.usage?.total ?? current.usage.costUsd;
  const coverage = options.usage?.coverage ?? current.usage.costCoverage;
  const burn = current.usage.costRatePerMin;
  const detail = [
    headline.detail,
    headline.blockerCount > 1 ? `+${headline.blockerCount - 1} blockers` : undefined,
    costUsd === undefined
      ? 'cost unavailable'
      : `~${formatUsd(costUsd)} estimated API cost${coverage === 'partial' ? ' (partial)' : ''}`,
    burn === undefined ? undefined : `${formatUsd(burn)}/min`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const recency = classifyMonitorRecency(current.freshness.lastEvidenceAt, options.nowMs ?? Number.NaN).recency;
  return {
    id: info.session.id,
    session: info.session,
    createdAtMs: info.session.createdAtMs,
    status: current.status,
    project: projectLabel(info, currentCwd),
    detail,
    color: sessionColour(info.project, options.colours),
    active: false,
    ...(recency === 'stale' ? { stale: true } : {}),
    ...(cwd ? { cwd } : {}),
    agent: {
      provider: { ...info.provider },
      ...(current.model ? { model: current.model.displayName || current.model.id } : {}),
      ...(branch ? { branch } : {}),
      ...(current.context ? { contextWindow: current.context } : {}),
      monitor: current,
      ...(options.usage ? { usage: options.usage } : {}),
      recency,
      ...(info.nativeSession?.id ? { nativeSessionId: info.nativeSession.id } : {}),
      info,
    },
  };
}

/** A terminal no agent has claimed belongs to no project, so it wears the ramp, not a colour. */
export function monitorAgentFromTerminal(record: MonitorTerminalRecord, colours?: MonitorColours): MonitorAgent {
  const { session, cwd, spawnHint } = record;
  const id = record.id ?? session.id;
  const path = session.cwd ?? cwd ?? undefined;
  return {
    id,
    session,
    createdAtMs: session.createdAtMs,
    status: classifyTerminalStatus(session.activity),
    project: folderName(path, 'terminal'),
    detail: path || 'Unassigned terminal',
    color: sessionColour(undefined, colours),
    active: false,
    ...(path ? { cwd: path } : {}),
    ...(spawnHint ? { spawnHint } : {}),
  };
}

/**
 * The one projection every view consumes: agents first in launch order, then
 * the terminals no agent has claimed, each decorated with the pane facts the
 * shell owns. Pure, so the seam is testable without a renderer.
 */
export function assembleMonitorAgents(input: AssembleMonitorAgentsInput): readonly MonitorAgent[] {
  const agents = input.agents
    .map((record) =>
      monitorAgentFromSession(record, {
        nowMs: input.nowMs,
        ...(input.colours ? { colours: input.colours } : {}),
        ...(input.usage?.has(monitorIdentity(record.info.session.id, input.identities))
          ? { usage: input.usage.get(monitorIdentity(record.info.session.id, input.identities)) }
          : {}),
      }),
    )
    .filter((agent): agent is MonitorAgent => agent !== undefined)
    .sort((left, right) => left.session.createdAtMs - right.session.createdAtMs);
  const claimed = new Set(agents.map((agent) => agent.session.id));
  const terminals = input.terminals
    .filter((terminal) => !claimed.has(terminal.session.id))
    .map((terminal) => ({
      ...terminal,
      session: input.sessions?.get(terminal.session.id) ?? terminal.session,
    }))
    .filter((terminal) => !terminal.session.exited)
    .map((terminal) => monitorAgentFromTerminal(terminal, input.colours));

  const decorate = (agent: MonitorAgent): MonitorAgent => {
    const attachment = input.attachments?.get(agent.session.id);
    return {
      ...agent,
      // A terminal record may carry its own stable id, so the fallback is the row's, not the session's.
      id: input.identities?.get(agent.session.id) ?? agent.id,
      active: input.activeSessionId === agent.session.id,
      ...(attachment ? { attachment } : {}),
    };
  };
  const agentRows = agents.map(decorate);
  // One identity, one row. A crashed agent keeps its row until the failure is
  // acknowledged, while the shell its pane was handed already wears its
  // identity so placement survives; the agent's row speaks for both until it
  // goes, and the shell's row takes over then.
  const spoken = new Set(agentRows.map((agent) => agent.id));
  return [...agentRows, ...terminals.map(decorate).filter((terminal) => !spoken.has(terminal.id))];
}

/** Agent-backed only: the status shortcuts navigate agents, not bare terminals. */
export function nextMonitorAgentForStatus(
  agents: readonly MonitorAgent[],
  status: AgentVisualStatus,
  currentSessionId: string | undefined,
): MonitorAgent | undefined {
  const matching = agents.filter((agent) => agent.agent && agent.status === status);
  if (matching.length === 0) return undefined;
  const currentIndex = matching.findIndex((agent) => agent.session.id === currentSessionId);
  return matching[(currentIndex + 1) % matching.length];
}

export function monitorAgentCounts(agents: readonly MonitorAgent[]): Record<AgentVisualStatus, number> {
  const counts: Record<AgentVisualStatus, number> = { idle: 0, working: 0, blocked: 0 };
  for (const agent of agents) {
    if (agent.agent) counts[agent.status] += 1;
  }
  return counts;
}
