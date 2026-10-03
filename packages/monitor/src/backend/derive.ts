import {
  classifyMonitorRecency,
  presentAgentMonitorHeadline,
  type AgentMonitorState,
  type MonitorBlocker,
} from '@vibecook/puppeteer-core';
import type {
  AgentStatus,
  MonitorAgentRow,
  MonitorCost,
  MonitorDeviceRef,
  MonitorReply,
  MonitorTokens,
  MonitorWait,
} from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorHostProfileSet, MonitorHostRun, MonitorHostTerminal } from './ports.js';

// The pure derivations: one host record and one runtime state in, one row's
// field out. Every rule here is read from the two shipping seams (VibeField's
// `godview/monitor/agents.ts` + `agent-status.ts`, Godview's
// `renderer/monitor/agents.ts`); where they differ the README names the pick.

export const DEFAULT_REPLY_MAX_LENGTH = 280;

/** The native set's id: the agents' own folders ("This Mac"). */
export const NATIVE_PROFILE_SET = 'native';

/** Only the final path component, for names and badges (`views/monitor/folder-name.ts`). */
export function folderName(path: string | null | undefined, fallback: string): string {
  const normalized = path?.trim().replace(/[\\/]+$/, '') ?? '';
  return normalized.split(/[\\/]/).pop() || fallback;
}

/** A terminal no agent has claimed: working while a foreground job runs, idle otherwise. */
export function classifyTerminalStatus(activity: { kind: string } | undefined): Exclude<AgentStatus, 'blocked'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}

/** Trimmed and bounded by code points, so a cut never splits a surrogate pair. */
export function boundText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return Array.from(trimmed).slice(0, maxLength).join('');
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Every sign-in the feed lists, by the profile it is in. */
export function personaSets(sets: readonly MonitorHostProfileSet[] | null): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const set of sets ?? []) for (const persona of set.personas) map.set(persona.profileId, set.id);
  return map;
}

/**
 * The profile SET a run runs under: the host's word first, then the set its
 * sign-in is listed in, else the machine's own (VibeField's `agentProfileSet`).
 */
export function resolveProfileSet(run: MonitorHostRun, personas: ReadonlyMap<string, string>): string {
  if (run.profileSet !== undefined) return run.profileSet;
  if (run.profileId !== undefined) return personas.get(run.profileId) ?? NATIVE_PROFILE_SET;
  return NATIVE_PROFILE_SET;
}

/** A pending run is idle (AR-4); a run nobody has heard from is working at "starting"; else the runtime's word. */
export function agentStatus(host: MonitorHostRun, state: AgentMonitorState | undefined): AgentStatus {
  if (host.pending !== undefined) return 'idle';
  return state?.status ?? 'working';
}

export function agentStatusSince(host: MonitorHostRun, state: AgentMonitorState | undefined): number {
  return (state ? parseTime(state.statusSince) : undefined) ?? host.createdAt;
}

/** The host's witnessed exit outranks a lagging mirror; otherwise the runtime's own word. */
export function agentAlive(host: MonitorHostRun, state: AgentMonitorState | undefined): boolean {
  if (host.alive === false) return false;
  return state?.alive ?? true;
}

export function agentDetail(host: MonitorHostRun, state: AgentMonitorState | undefined): string {
  if (host.pending === 'resume-when-idle') return 'unobserved · resumes when idle';
  if (host.pending !== undefined) return 'unobserved';
  if (!state) return 'starting';
  return presentAgentMonitorHeadline(state).detail;
}

/** The observed directory first, then the workspace's, then the terminal's; the provider's label when nothing names one. */
export function projectName(host: MonitorHostRun, state: AgentMonitorState | undefined): string {
  const path = state?.environment.cwd || host.workspace?.sourcePath || host.workspace?.root || host.cwd;
  return folderName(path, host.provider.label.trim() || host.provider.id);
}

/** The observation decides: a git value of null means "not in a repo" and is an answer; absent falls through to the workspace. */
export function projectBranch(host: MonitorHostRun, state: AgentMonitorState | undefined): string | null | undefined {
  const git = state?.environment.git;
  if (git !== undefined) return git?.branch ?? null;
  return host.workspace?.branch;
}

/** The key a project's colour is dealt by: the host's canonical root, else the observed directory. */
export function projectKey(host: MonitorHostRun, state: AgentMonitorState | undefined): string | undefined {
  return host.projectKey || state?.environment.cwd || undefined;
}

function blockerTool(blocker: MonitorBlocker): string | undefined {
  return blocker.kind === 'permission' ? blocker.permission?.tool || undefined : undefined;
}

function blockerQuestion(blocker: MonitorBlocker, maxLength: number): string | undefined {
  if (blocker.kind !== 'question') return undefined;
  const question = blocker.questions[0];
  const text = question?.header ?? question?.prompt;
  return text === undefined || text.trim() === '' ? undefined : boundText(text, maxLength);
}

/** The first blocker, bounded. */
export function agentWait(
  state: AgentMonitorState | undefined,
  statusSince: number,
  maxLength: number,
): MonitorWait | undefined {
  const blocker = state?.blockers[0];
  if (!blocker) return undefined;
  const tool = blockerTool(blocker);
  const question = blockerQuestion(blocker, maxLength);
  return {
    kind: blocker.kind,
    since: parseTime(blocker.since) ?? statusSince,
    ...(tool === undefined ? {} : { tool }),
    ...(question === undefined ? {} : { question }),
  };
}

/** The latest reply line, bounded; absent when the runtime has none or it is blank. */
export function agentReply(state: AgentMonitorState | undefined, maxLength: number): MonitorReply | undefined {
  const message = state?.lastAssistantMessage;
  if (!message) return undefined;
  const text = boundText(message.text, maxLength);
  if (text === '') return undefined;
  const at = parseTime(message.at);
  return { text, ...(at === undefined ? {} : { at }), final: message.final };
}

export function agentTokens(state: AgentMonitorState | undefined): MonitorTokens | undefined {
  const usage = state?.usage;
  if (!usage) return undefined;
  const total = usage.cumulativeTokens;
  const perMinute = usage.burnRatePerMin;
  if (total === undefined && perMinute === undefined) return undefined;
  return {
    ...(total === undefined ? {} : { total }),
    ...(perMinute === undefined ? {} : { perMinute }),
  };
}

/** Evidence recency, presentation metadata only; a run with no evidence clock is never stale. */
export function isStale(state: AgentMonitorState | undefined, nowMs: number, staleAfterMs: number): boolean {
  if (!state) return false;
  return classifyMonitorRecency(state.freshness.lastEvidenceAt, nowMs, { staleAfterMs }).recency === 'stale';
}

export interface DeriveAgentRowInput {
  id: string;
  host: MonitorHostRun;
  state: AgentMonitorState | undefined;
  device: MonitorDeviceRef;
  seq: number | undefined;
  profileSet: string;
  stale: boolean;
  cost: MonitorCost | undefined;
  unread: boolean;
  replyMaxLength: number;
}

export function deriveAgentRow(input: DeriveAgentRowInput): MonitorAgentRow {
  const { host, state } = input;
  const statusSince = agentStatusSince(host, state);
  const branch = projectBranch(host, state);
  const model = state?.model ? state.model.displayName || state.model.id : undefined;
  const effort = state?.effort?.value;
  const usedPercent = state?.context?.usedPercent;
  const wait = agentWait(state, statusSince, input.replyMaxLength);
  const reply = agentReply(state, input.replyMaxLength);
  const tokens = agentTokens(state);
  return {
    id: input.id,
    kind: 'agent',
    createdAt: host.createdAt,
    status: agentStatus(host, state),
    statusSince,
    stale: input.stale,
    alive: agentAlive(host, state),
    ...(host.pending === undefined ? {} : { pending: true }),
    detail: agentDetail(host, state),
    project: {
      name: projectName(host, state),
      ...(branch === undefined ? {} : { branch }),
      ...(input.seq === undefined ? {} : { seq: input.seq }),
    },
    provider: { id: host.provider.id, label: host.provider.label },
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(host.account === undefined ? {} : { account: host.account }),
    ...(typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? { context: { usedPercent } } : {}),
    ...(wait === undefined ? {} : { wait }),
    ...(reply === undefined ? {} : { reply }),
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    ...(tokens === undefined ? {} : { tokens }),
    unread: input.unread,
    device: input.device,
    ...(host.tier === undefined ? {} : { tier: host.tier }),
    profileSet: input.profileSet,
    attachable: host.terminalSessionId !== undefined,
  };
}

export interface DeriveTerminalRowInput {
  id: string;
  host: MonitorHostTerminal;
  device: MonitorDeviceRef;
  /** When the backend saw the terminal's status begin. */
  statusSince: number;
}

/** A terminal no agent has claimed: no project, no colour, never unread. */
export function deriveTerminalRow(input: DeriveTerminalRowInput): MonitorAgentRow {
  const { host } = input;
  const path = host.cwd || undefined;
  return {
    id: input.id,
    kind: 'terminal',
    createdAt: host.createdAt,
    status: classifyTerminalStatus(host.activity),
    statusSince: input.statusSince,
    stale: false,
    alive: true,
    detail: path ?? 'Unassigned terminal',
    ...(host.activity === undefined ? {} : { activity: host.activity.kind }),
    project: { name: folderName(path, host.title || 'terminal') },
    unread: false,
    device: input.device,
    ...(host.profileSet === undefined ? {} : { profileSet: host.profileSet }),
    attachable: true,
  };
}
