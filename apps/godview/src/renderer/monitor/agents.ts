import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  aggregateAffiliatedAgentMonitorTeam,
  classifyMonitorRecency,
  presentAgentMonitorHeadline,
  type AgentMonitorState,
} from '@vibecook/puppeteer-core';
import type { AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import { agentColor, classifyTerminalStatus, projectLabel, type AgentVisualStatus } from '../agent-status.js';
import { folderName } from '../folder-name.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorAgent } from './types.js';

export interface MonitorAgentRecord {
  info: AgentSessionInfo;
  monitor?: AgentMonitorStateMessage;
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
  exitedSessionIds?: ReadonlySet<string>;
  identities?: ReadonlyMap<string, string>;
}

/** Mounted workspace sessions are terminal resources even when no UI gesture created a placeholder for them. */
export function mergeMonitorTerminals(input: MergeMonitorTerminalsInput): readonly MonitorTerminalRecord[] {
  const bySession = new Map(input.explicit.map((terminal) => [terminal.session.id, terminal] as const));
  for (const session of input.workspaceSessions) {
    if (session.exited || input.exitedSessionIds?.has(session.id)) continue;
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
    (terminal) => !terminal.session.exited && !input.exitedSessionIds?.has(terminal.session.id),
  );
}

export interface AssembleMonitorAgentsInput {
  agents: readonly MonitorAgentRecord[];
  terminals: readonly MonitorTerminalRecord[];
  /** Live summaries, so a terminal placeholder reflects current activity rather than launch state. */
  sessions?: ReadonlyMap<string, SessionSummary>;
  attachments?: ReadonlyMap<string, PaneAttachment>;
  /** Live terminal id -> stable monitor identity. */
  identities?: ReadonlyMap<string, string>;
  activeSessionId?: string;
  nowMs?: number;
}

/** Undefined for a session that has stopped being worth showing at all. */
export function monitorAgentFromSession(
  record: MonitorAgentRecord,
  options: { allMonitorStates?: readonly AgentMonitorState[]; nowMs?: number } = {},
): MonitorAgent | undefined {
  const { info, monitor } = record;
  if (!monitor) return undefined;
  const current = monitor.state;
  const headline = presentAgentMonitorHeadline(current);
  const currentCwd = current.environment.cwd;
  const branch = current.environment.git?.branch ?? info.workspace.branch;
  const cwd = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || undefined;
  const cumulativeTokens = current.usage.cumulativeTokens;
  const burn = current.usage.burnRatePerMin;
  const detail = [
    headline.detail,
    headline.blockerCount > 1 ? `+${headline.blockerCount - 1} blockers` : undefined,
    cumulativeTokens === undefined ? undefined : `${Math.round(cumulativeTokens).toLocaleString()} tokens`,
    burn === undefined ? undefined : `${Math.round(burn).toLocaleString()} tok/min`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const recency = classifyMonitorRecency(current.freshness.lastEvidenceAt, options.nowMs ?? Number.NaN).recency;
  const teamAggregate = current.team
    ? aggregateAffiliatedAgentMonitorTeam(current, options.allMonitorStates ?? [current])
    : undefined;
  return {
    id: info.session.id,
    session: info.session,
    status: current.status,
    project: projectLabel(info, currentCwd),
    detail,
    color: agentColor(info.runtimeSessionId),
    active: false,
    ...(recency === 'stale' ? { stale: true } : {}),
    ...(cwd ? { cwd } : {}),
    agent: {
      provider: { ...info.provider },
      ...(current.model ? { model: current.model.displayName || current.model.id } : {}),
      ...(branch ? { branch } : {}),
      ...(current.context ? { contextWindow: current.context } : {}),
      monitor: current,
      ...(teamAggregate ? { teamAggregate } : {}),
      recency,
      info,
    },
  };
}

export function monitorAgentFromTerminal(record: MonitorTerminalRecord): MonitorAgent {
  const { session, cwd, spawnHint } = record;
  const id = record.id ?? session.id;
  const path = session.cwd ?? cwd ?? undefined;
  return {
    id,
    session,
    status: classifyTerminalStatus(session.activity),
    project: folderName(path, 'terminal'),
    detail: path || 'Unassigned terminal',
    color: agentColor(id),
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
  const allMonitorStates = input.agents.flatMap((record) => (record.monitor ? [record.monitor.state] : []));
  const agents = input.agents
    .map((record) =>
      monitorAgentFromSession(record, {
        allMonitorStates,
        nowMs: input.nowMs,
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
    .map(monitorAgentFromTerminal);

  return [...agents, ...terminals].map((agent) => {
    const attachment = input.attachments?.get(agent.session.id);
    return {
      ...agent,
      id: input.identities?.get(agent.session.id) ?? agent.id,
      active: input.activeSessionId === agent.session.id,
      ...(attachment ? { attachment } : {}),
    };
  });
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
