import type {
  MonitorHostFacts,
  MonitorHostPort,
  MonitorHostRun,
  MonitorHostTerminal,
} from '@vibecook/puppeteer-monitor';
import type { AgentSessionInfo } from '../protocol.js';
import { isOpaqueMonitorIdentifier } from './monitor-ipc.js';

/**
 * Godview's side of the monitor backend's host port (MV-2): what only this app
 * knows about its agents and terminals, read by the backend beside the runtime.
 *
 * - The runs are main's agent records: one per terminal session, as the
 *   renderer's seam keyed them. A run's id is the identity its terminal carries
 *   across handoffs, else the terminal session's id, exactly as that seam named
 *   a row, so a shell promoted to an agent keeps its body.
 * - The terminals are what each window reports of its panes' sessions: a bare
 *   terminal is a window fact (its workspace's panes, the shells it is closing,
 *   the ones that exited). Each window shows only its own (the replica's
 *   `visible`), as each window's seam did.
 * - The project key is the registry's canonical root, or null while main has
 *   not folded the workspace yet (L4), so the row wears the ramp until then.
 */

/** What the host port reads of one of main's agent records. */
export interface MonitorAgentRecordLike {
  readonly info: AgentSessionInfo;
  /** The terminal can outlive its adopted agent's process. */
  readonly agentProcessAlive: boolean;
}

export interface GodviewMonitorHostOptions {
  readonly device: MonitorHostFacts['device'];
  /** Main's agent records, read again whenever `runsChanged` says they moved. */
  readonly records: () => Iterable<MonitorAgentRecordLike>;
  /** The identity a terminal carries across a handoff (main dealt it), when it has one. */
  readonly identityOf: (sessionId: string) => string | undefined;
  /** The account a run is bound to, by its profile id, as the registry labels it. */
  readonly accountLabel: (profileId: string) => string | undefined;
}

export interface GodviewMonitorHost {
  readonly port: MonitorHostPort;
  /** Main's records, an identity or an account label moved: the next read rebuilds the runs. */
  runsChanged(): void;
  /** One window's bare-terminal candidates, replacing whatever it reported before. */
  reportTerminals(windowId: string, terminals: readonly MonitorHostTerminal[]): void;
  /** A window that closed or reloaded: its terminals are no longer anyone's. */
  forgetWindow(windowId: string): void;
}

/** One agent record as the backend's run. */
export function monitorHostRun(
  record: MonitorAgentRecordLike,
  identityOf: GodviewMonitorHostOptions['identityOf'],
  accountLabel: GodviewMonitorHostOptions['accountLabel'],
): MonitorHostRun {
  const { info } = record;
  const sessionId = info.session.id;
  const { root, sourcePath, branch } = info.workspace;
  const account = info.profileId ? accountLabel(info.profileId) : undefined;
  return {
    runtimeRunId: info.runtimeRunId,
    createdAt: info.session.createdAtMs,
    provider: { id: info.provider.id, label: info.provider.label },
    terminalSessionId: sessionId,
    terminalIdentity: identityOf(sessionId) ?? sessionId,
    projectKey: info.project?.key ?? null,
    workspace: {
      ...(root ? { root } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(branch ? { branch } : {}),
    },
    ...(info.session.cwd ? { cwd: info.session.cwd } : {}),
    ...(info.profileId ? { profileId: info.profileId } : {}),
    ...(account ? { account } : {}),
    ...(record.agentProcessAlive ? {} : { alive: false }),
    ...(info.nativeSession.id ? { nativeSessionId: info.nativeSession.id } : {}),
  };
}

export function createGodviewMonitorHost(options: GodviewMonitorHostOptions): GodviewMonitorHost {
  const listeners = new Set<() => void>();
  const terminalsByWindow = new Map<string, readonly MonitorHostTerminal[]>();
  let facts: MonitorHostFacts | undefined;
  let runs: readonly MonitorHostRun[] | undefined;
  let terminals: readonly MonitorHostTerminal[] | undefined;

  const notify = (): void => {
    facts = undefined;
    for (const listener of [...listeners]) listener();
  };

  /** Every window's report, one row per session: a session mirrored in two windows is one terminal. */
  const unionTerminals = (): readonly MonitorHostTerminal[] => {
    const bySession = new Map<string, MonitorHostTerminal>();
    for (const reported of terminalsByWindow.values()) {
      for (const terminal of reported)
        if (!bySession.has(terminal.sessionId)) bySession.set(terminal.sessionId, terminal);
    }
    return [...bySession.values()];
  };

  const port: MonitorHostPort = {
    getFacts() {
      if (facts) return facts;
      runs ??= [...options.records()].map((record) => monitorHostRun(record, options.identityOf, options.accountLabel));
      terminals ??= unionTerminals();
      // Godview offers no Agent Profile sets to a spawn menu: a create is the window's own (its active pane).
      facts = { device: options.device, runs, terminals, profileSets: [] };
      return facts;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    port,
    runsChanged() {
      runs = undefined;
      notify();
    },
    reportTerminals(windowId, reported) {
      terminalsByWindow.set(windowId, reported);
      terminals = undefined;
      notify();
    },
    forgetWindow(windowId) {
      if (!terminalsByWindow.delete(windowId)) return;
      terminals = undefined;
      notify();
    },
  };
}

const MAX_REPORTED_TERMINALS = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_WORD_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A renderer's report, read tolerantly: a malformed entry is dropped, a malformed report is refused whole. */
export function parseMonitorTerminalReport(value: unknown): MonitorHostTerminal[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_TERMINALS) return undefined;
  const terminals: MonitorHostTerminal[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isOpaqueMonitorIdentifier(entry.sessionId)) continue;
    const { identity, createdAt, cwd, activity } = entry;
    if (identity !== undefined && !isOpaqueMonitorIdentifier(identity)) continue;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) continue;
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > MAX_PATH_LENGTH)) continue;
    const kind = isRecord(activity) && typeof activity.kind === 'string' ? activity.kind : undefined;
    if (activity !== undefined && (kind === undefined || kind.length > MAX_WORD_LENGTH)) continue;
    terminals.push({
      sessionId: entry.sessionId,
      ...(identity === undefined ? {} : { identity }),
      createdAt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(kind === undefined ? {} : { activity: { kind } }),
    });
  }
  return terminals;
}

/** A renderer's "shown in my active pane" report (L5): the row ids, opaque and bounded. */
export function parseMonitorShownReport(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_TERMINALS) return undefined;
  return value.filter((id): id is string => isOpaqueMonitorIdentifier(id));
}
