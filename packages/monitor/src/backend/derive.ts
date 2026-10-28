import {
  classifyMonitorRecency,
  presentAgentMonitorHeadline,
  type AgentMonitorState,
  type MonitorBlocker,
} from '@vibefield/puppeteer-core';
import type {
  AgentStatus,
  MonitorActivity,
  MonitorAgentRow,
  MonitorCost,
  MonitorDeviceRef,
  MonitorEffort,
  MonitorReply,
  MonitorTokens,
  MonitorWait,
} from '@vibefield/puppeteer-view-sdk/model';
import { classifyTerminalStatus } from '../terminal-status.js';
import type { MonitorHostProfileSet, MonitorHostRun, MonitorHostTerminal } from './ports.js';

// The pure derivations: one host record and one runtime state in, one row's
// field out. Every rule here is read from the two shipping seams (VibeField's
// `godview/monitor/agents.ts` + `agent-status.ts`, Godview's
// `renderer/monitor/agents.ts`); where they differ the README names the pick.

/** The native set's id: the agents' own folders ("This Mac"). */
export const NATIVE_PROFILE_SET = 'native';

/** Only the final path component, for names and badges (`views/monitor/folder-name.ts`). */
export function folderName(path: string | null | undefined, fallback: string): string {
  const normalized = path?.trim().replace(/[\\/]+$/, '') ?? '';
  return normalized.split(/[\\/]/).pop() || fallback;
}

/** A terminal no agent has claimed: the one rule lives beside the replica, which applies it too (M28). */
export { classifyTerminalStatus };

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

/**
 * The observed branch when the observation names one; else the branch the host supplies for that case (M26); else
 * the observation's answer — null for "looked: no repository, or no branch" — and when nothing looked, the workspace's.
 */
export function projectBranch(host: MonitorHostRun, state: AgentMonitorState | undefined): string | null | undefined {
  const git = state?.environment.git;
  if (git?.branch) return git.branch;
  if (host.fallbackBranch) return host.fallbackBranch;
  if (git !== undefined) return git?.branch ?? null;
  return host.workspace?.branch;
}

/** The key a project's colour is dealt by: the host's canonical root, else the observed directory; none while the host is folding it (null). */
export function projectKey(host: MonitorHostRun, state: AgentMonitorState | undefined): string | undefined {
  if (host.projectKey === null) return undefined;
  return host.projectKey || state?.environment.cwd || undefined;
}

function blockerTool(blocker: MonitorBlocker): string | undefined {
  return blocker.kind === 'permission' ? blocker.permission?.tool || undefined : undefined;
}

function blockerCode(blocker: MonitorBlocker): string | undefined {
  return blocker.kind === 'failure' ? blocker.failure?.code || undefined : undefined;
}

/** Trimmed and bounded; absent when blank. */
function boundedOrAbsent(text: string | undefined, maxLength: number): string | undefined {
  if (text === undefined) return undefined;
  const bounded = boundText(text, maxLength);
  return bounded === '' ? undefined : bounded;
}

/**
 * The first blocker, its parts kept separate (M2) — the swarm and the timeline
 * word them in different orders — each bounded like the reply. `count` is how
 * many wait, counted before core's own bound (its `omitted.blockers`), and
 * absent when it is one (M10).
 */
export function agentWait(
  state: AgentMonitorState | undefined,
  statusSince: number,
  maxLength: number,
): MonitorWait | undefined {
  const blockers = state?.blockers ?? [];
  const blocker = blockers[0];
  if (!blocker || !state) return undefined;
  const count = blockers.length + (state.omitted?.blockers ?? 0);
  const question = blocker.kind === 'question' ? blocker.questions[0] : undefined;
  const tool = blockerTool(blocker);
  const code = blockerCode(blocker);
  const header = boundedOrAbsent(question?.header, maxLength);
  const prompt = boundedOrAbsent(question?.prompt, maxLength);
  const detail = boundedOrAbsent(blocker.detail, maxLength);
  return {
    kind: blocker.kind,
    since: parseTime(blocker.since) ?? statusSince,
    ...(count > 1 ? { count } : {}),
    ...(tool === undefined ? {} : { tool }),
    ...(code === undefined ? {} : { code }),
    ...(header === undefined ? {} : { header }),
    ...(prompt === undefined ? {} : { question: prompt }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The runtime's activity: its kind, its line bounded, and when it began. */
export function agentActivity(state: AgentMonitorState | undefined, maxLength: number): MonitorActivity | undefined {
  const activity = state?.activity;
  if (!activity) return undefined;
  const line = boundedOrAbsent(activity.line, maxLength);
  const since = parseTime(activity.since);
  return {
    kind: activity.kind,
    ...(line === undefined ? {} : { line }),
    ...(since === undefined ? {} : { since }),
  };
}

/** The effort the run works at, and whether that is evidence or only the launch's intent. */
export function agentEffort(state: AgentMonitorState | undefined): MonitorEffort | undefined {
  const effort = state?.effort;
  if (!effort) return undefined;
  return { value: effort.value, ...(effort.intent === undefined ? {} : { intent: effort.intent }) };
}

/** The runtime has reported a state and something drives the run (M10): false while starting and while pending. */
export function agentObserved(host: MonitorHostRun, state: AgentMonitorState | undefined): boolean {
  return state !== undefined && host.pending === undefined;
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

/**
 * Evidence recency, presentation metadata only, and only while the run should be talking: a working or blocked row
 * with no root tool call open. An idle row sends nothing because it has nothing to say, and a tool may run silent for
 * minutes, so neither quiet is staleness. A run with no evidence clock is never stale.
 */
export function isStale(
  host: MonitorHostRun,
  state: AgentMonitorState | undefined,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (!state || agentStatus(host, state) === 'idle') return false;
  // A compaction outranks a tool as the headline activity, so core also says whether a root tool is open.
  if (state.activity?.kind === 'tool' || state.freshness.toolOpen === true) return false;
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
  const effort = agentEffort(state);
  const activity = agentActivity(state, input.replyMaxLength);
  const usedPercent = state?.context?.usedPercent;
  const wait = agentWait(state, statusSince, input.replyMaxLength);
  const reply = agentReply(state, input.replyMaxLength);
  const tokens = agentTokens(state);
  const attachable = host.terminalSessionId !== undefined;
  return {
    id: input.id,
    kind: 'agent',
    createdAt: host.createdAt,
    status: agentStatus(host, state),
    statusSince,
    stale: input.stale,
    alive: agentAlive(host, state),
    observed: agentObserved(host, state),
    ...(host.pending === undefined ? {} : { pending: true }),
    detail: agentDetail(host, state),
    ...(activity === undefined ? {} : { activity }),
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
    attachable,
    // M41: the home desktop's write policy, computed once. Today it is the rule `attachable` says: a PTY is named.
    writable: attachable,
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
    observed: true,
    detail: path ?? 'Unassigned terminal',
    ...(host.activity === undefined ? {} : { activity: { kind: host.activity.kind } }),
    project: { name: folderName(path, host.title || 'terminal') },
    unread: false,
    device: input.device,
    ...(host.profileSet === undefined ? {} : { profileSet: host.profileSet }),
    attachable: true,
    writable: true,
  };
}
