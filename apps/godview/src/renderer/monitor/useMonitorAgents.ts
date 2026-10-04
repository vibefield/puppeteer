import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type { MonitorNotification } from '@vibecook/puppeteer-core';
import { createAgentMonitorStore } from '@vibecook/puppeteer-monitor';
import { useAgentMonitorStore } from '@vibecook/puppeteer-react';
import type { AgentMonitorRemovedMessage, AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorPalette } from '@vibecook/puppeteer-views';
import {
  assembleMonitorAgents,
  mergeMonitorTerminals,
  monitorIdentity,
  type MonitorAgentRecord,
  type MonitorTerminalRecord,
} from './agents.js';
import type { MonitorActions, MonitorAgent } from './types.js';
import {
  EMPTY_STATUS_LEDGER,
  EMPTY_UNREAD_LEDGER,
  observeStatuses,
  reconcileUnread,
  statusHistoryBook,
  type MonitorHistoryBook,
  type StatusLedger,
  type UnreadLedger,
} from '@vibecook/puppeteer-views';
import { EMPTY_USAGE_LEDGER, reconcileUsage, USAGE_STEP_MS, type UsageLedger } from '@vibecook/puppeteer-views';

export interface UseMonitorAgentsOptions {
  workspace?: GhostteaWorkspaceContext | undefined;
  attachments: ReadonlyMap<string, PaneAttachment>;
  /** Live terminal id -> stable monitor identity across PTY handoffs. */
  terminalIdentities?: ReadonlyMap<string, string> | undefined;
  terminalVisualIds?: ReadonlyMap<string, string> | undefined;
  /** Shells being terminated after losing their final pane. */
  closingSessionIds?: ReadonlySet<string> | undefined;
  /** Terminal-runtime exits, so a placeholder for a closed terminal stops being shown. */
  onSessionExited(listener: (sessionId: string) => void): () => void;
  /** The live tokens; a row's colour is its project's tint, or the ramp with no project. */
  palette: MonitorPalette;
  /** Account id -> label, so a row can name the account its session was launched under. */
  profileLabels?: ReadonlyMap<string, string> | undefined;
}

export interface MonitorAgentsResult {
  agents: readonly MonitorAgent[];
  actions: MonitorActions;
  /** What each lane did while this window watched, for views that draw the past. */
  history: MonitorHistoryBook;
  notifications: readonly MonitorNotification[];
  dismissNotification(runtimeRunId: string, notificationId: string): void;
}

/**
 * The single subscription to everything a monitor view renders.
 *
 * It lives beside the view contract rather than inside any one view, so a
 * second view is a consumer of this hook and never a consumer of the swarm.
 */
export function useMonitorAgents({
  workspace,
  attachments,
  terminalIdentities,
  terminalVisualIds,
  closingSessionIds,
  onSessionExited,
  palette,
  profileLabels,
}: UseMonitorAgentsOptions): MonitorAgentsResult {
  const [records, setRecords] = useState(() => new Map<string, MonitorAgentRecord>());
  const [terminals, setTerminals] = useState<readonly MonitorTerminalRecord[]>([]);
  const [exitedTerminalIds, setExitedTerminalIds] = useState(() => new Set<string>());
  const [monitorStore] = useState(() => createAgentMonitorStore({ notificationCapacity: 4 }));
  const monitorSnapshot = useAgentMonitorStore(monitorStore);
  const [nowMs, setNowMs] = useState(Date.now());
  const unreadRef = useRef<UnreadLedger>(EMPTY_UNREAD_LEDGER);
  const visualIdsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const usageRef = useRef<UsageLedger>(EMPTY_USAGE_LEDGER);
  // What each lane did while this window watched (the timeline's record). Godview keeps no durable one.
  const statusRef = useRef<StatusLedger>(EMPTY_STATUS_LEDGER);
  /** The usage ledger's clock: a fold at every step boundary, whether or not anything else changed. */
  const [usageStep, setUsageStep] = useState(0);

  useEffect(() => {
    let alive = true;
    let publishFrame: number | undefined;
    const current = new Map<string, MonitorAgentRecord>();
    const monitorsByRun = new Map<string, AgentMonitorStateMessage>();
    const removed = new Set<string>();
    const publish = (): void => {
      if (publishFrame !== undefined) return;
      publishFrame = window.requestAnimationFrame(() => {
        publishFrame = undefined;
        if (alive) setRecords(new Map(current));
      });
    };
    const remember = (info: AgentSessionInfo): void => {
      removed.delete(info.runtimeSessionId);
      const existing = current.get(info.runtimeSessionId);
      const monitor = monitorsByRun.get(info.runtimeRunId);
      const retainedMonitor =
        monitor ?? (existing?.info.runtimeRunId === info.runtimeRunId ? existing.monitor : undefined);
      current.set(info.runtimeSessionId, { info, ...(retainedMonitor ? { monitor: retainedMonitor } : {}) });
      publish();
    };
    const forget = (runtimeSessionId: string): void => {
      removed.add(runtimeSessionId);
      if (current.delete(runtimeSessionId)) publish();
    };
    const acceptMonitor = (message: AgentMonitorStateMessage): boolean => {
      if (!monitorStore.acceptState(message.state)) return false;
      monitorsByRun.set(message.runtimeRunId, message);
      return true;
    };
    const updateMonitor = (message: AgentMonitorStateMessage): void => {
      if (!acceptMonitor(message)) return;
      const terminalSessionId =
        message.terminalSessionId ??
        [...current.values()].find((record) => record.info.runtimeRunId === message.runtimeRunId)?.info
          .runtimeSessionId;
      if (!terminalSessionId) return;
      const record = current.get(terminalSessionId);
      if (!record || record.info.runtimeRunId !== message.runtimeRunId) return;
      current.set(terminalSessionId, { ...record, monitor: message });
      publish();
    };
    const removeMonitor = (message: AgentMonitorRemovedMessage): void => {
      if (!monitorStore.remove({ runtimeRunId: message.runtimeRunId, runtimeEpoch: message.runtimeEpoch })) return;
      monitorsByRun.delete(message.runtimeRunId);
      const terminalSessionId =
        message.terminalSessionId ??
        [...current.values()].find((record) => record.info.runtimeRunId === message.runtimeRunId)?.info
          .runtimeSessionId;
      if (!terminalSessionId) return;
      forget(terminalSessionId);
    };
    const publishNotification = (notification: MonitorNotification): void => {
      if (alive) monitorStore.acceptNotification(notification);
    };

    const unsubscribeSession = window.puppeteer.onAgentSession(remember);
    const unsubscribeRemoved = window.puppeteer.onAgentRemoved(forget);
    const unsubscribeMonitorState = window.puppeteer.onAgentMonitorState(updateMonitor);
    const unsubscribeMonitorRemoved = window.puppeteer.onAgentMonitorRemoved(removeMonitor);
    const unsubscribeMonitorNotification = window.puppeteer.onAgentMonitorNotification((message) =>
      publishNotification(message.notification),
    );

    void (async () => {
      const [snapshots, monitorSnapshots] = await Promise.all([
        window.puppeteer.listAgentSessions(),
        window.puppeteer.listAgentMonitors(),
      ]);
      if (!alive) return;
      for (const monitor of monitorSnapshots) acceptMonitor(monitor);
      const next = new Map<string, MonitorAgentRecord>();
      for (const snapshot of snapshots) {
        const id = snapshot.info.runtimeSessionId;
        const monitor = monitorsByRun.get(snapshot.info.runtimeRunId);
        if (removed.has(id)) continue;
        const live = current.get(id);
        next.set(id, {
          info: live?.info ?? snapshot.info,
          ...((live?.monitor ?? monitor) ? { monitor: live?.monitor ?? monitor } : {}),
        });
      }
      for (const [id, record] of current) {
        if (!next.has(id) && !removed.has(id)) next.set(id, record);
      }
      current.clear();
      for (const [id, record] of next) current.set(id, record);
      publish();
    })();

    return () => {
      alive = false;
      if (publishFrame !== undefined) window.cancelAnimationFrame(publishFrame);
      unsubscribeSession();
      unsubscribeRemoved();
      unsubscribeMonitorState();
      unsubscribeMonitorRemoved();
      unsubscribeMonitorNotification();
      monitorStore.clear();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let interval: number | undefined;
    // Aligned to the step boundaries, so every agent's bars shift together.
    const timeout = window.setTimeout(
      () => {
        setUsageStep((step) => step + 1);
        interval = window.setInterval(() => setUsageStep((step) => step + 1), USAGE_STEP_MS);
      },
      USAGE_STEP_MS - (Date.now() % USAGE_STEP_MS),
    );
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  useEffect(
    () =>
      onSessionExited((sessionId) => {
        setExitedTerminalIds((current) => new Set(current).add(sessionId));
        setTerminals((current) => {
          const next = current.filter((terminal) => terminal.session.id !== sessionId);
          return next.length === current.length ? current : next;
        });
      }),
    [onSessionExited],
  );

  const sessions = useMemo(
    () => new Map((workspace?.sessions ?? []).map((session) => [session.id, session] as const)),
    [workspace?.sessions],
  );

  // The workspace is the authority for mounted terminal resources. Explicit
  // records only add gesture metadata such as a swarm spawn position; restored
  // shells and agent handoffs must not need a second creation-only registry in
  // order to remain visible.
  const visibleTerminals = useMemo(
    () =>
      mergeMonitorTerminals({
        explicit: terminals,
        workspaceSessions: workspace?.sessions ?? [],
        exitedSessionIds: exitedTerminalIds,
        closingSessionIds,
        identities: terminalIdentities,
      }),
    [closingSessionIds, exitedTerminalIds, terminalIdentities, terminals, workspace?.sessions],
  );

  const agents = useMemo(() => {
    // Every view reads the same corrected USD total and observation buckets.
    // The UI clock ages buckets; it never derives new spend from total changes.
    const usage = reconcileUsage(
      usageRef.current,
      [...records.values()].map((record) => {
        const state = record.monitor?.state;
        const nativeSessionId = state?.session.nativeSessionId ?? record.info.nativeSession?.id;
        return {
          id: monitorIdentity(record.info.session.id, terminalIdentities),
          runId: `${state?.runtimeRunId ?? record.info.runtimeRunId}:${state?.runtimeEpoch ?? record.info.runtimeEpoch}`,
          ...(nativeSessionId ? { session: { providerId: record.info.provider.id, nativeSessionId } } : {}),
          ...(state ? { usage: state.usage, revision: state.revision } : {}),
        };
      }),
      Date.now(),
    );
    usageRef.current = usage;
    const assembled = assembleMonitorAgents({
      agents: [...records.values()],
      terminals: visibleTerminals,
      sessions,
      attachments,
      identities: terminalIdentities,
      visualIds: terminalVisualIds,
      previousVisualIds: visualIdsRef.current,
      nowMs,
      colours: { tint: palette.tint, neutral: palette.neutral },
      usage: usage.histories,
      ...(workspace?.activeSession ? { activeSessionId: workspace.activeSession.id } : {}),
    });
    // Unread is a fold over successive projections; the ledger is the only
    // state here that is not derivable from one snapshot.
    visualIdsRef.current = new Map(assembled.map((agent) => [agent.id, agent.visualId ?? agent.id]));
    const ledger = reconcileUnread(
      unreadRef.current,
      assembled.map((agent) => {
        const statusSinceMs = agent.agent ? Date.parse(agent.agent.monitor.statusSince) : Number.NaN;
        return {
          id: agent.id,
          status: agent.status,
          active: agent.active,
          hasAgent: agent.agent !== undefined,
          ...(Number.isFinite(statusSinceMs) ? { statusSinceMs } : {}),
        };
      }),
      Date.now(),
    );
    unreadRef.current = ledger;
    const projected = assembled.map((agent) => {
      const unread = ledger.unreadIds.has(agent.id);
      // The account is an identity ground, resolved from the registry rather
      // than from anything the session said about itself.
      const profileId = agent.agent?.info.profileId;
      const account = profileId ? profileLabels?.get(profileId) : undefined;
      if (!unread && !account) return agent;
      return {
        ...agent,
        ...(unread ? { unread: true } : {}),
        ...(account && agent.agent ? { agent: { ...agent.agent, account } } : {}),
      };
    });
    statusRef.current = observeStatuses(statusRef.current, projected, Date.now());
    return projected;
  }, [
    attachments,
    nowMs,
    palette.neutral,
    palette.tint,
    profileLabels,
    records,
    sessions,
    terminalIdentities,
    terminalVisualIds,
    usageStep,
    visibleTerminals,
    workspace?.activeSession,
  ]);

  const select = useCallback(
    (agent: MonitorAgent): void => {
      workspace?.mountSession(agent.session);
    },
    [workspace],
  );

  const createAt = useCallback(
    async (position?: { x: number; y: number }): Promise<void> => {
      if (!workspace?.activeSession) return;
      const sourceCwd = workspace.activeSession.cwd;
      const session = await workspace.createSessionInActivePane();
      if (!session) return;
      setExitedTerminalIds((current) => {
        if (!current.has(session.id)) return current;
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      const cwd = session.cwd ?? sourceCwd;
      setTerminals((current) => [
        ...current.filter((terminal) => terminal.session.id !== session.id),
        { session, ...(cwd ? { cwd } : {}), ...(position ? { spawnHint: position } : {}) },
      ]);
    },
    [workspace],
  );

  const actions = useMemo<MonitorActions>(() => ({ select, createAt }), [createAt, select]);

  const dismissNotification = useCallback(
    (runtimeRunId: string, notificationId: string): void => {
      monitorStore.dismissNotification(runtimeRunId, notificationId);
    },
    [monitorStore],
  );

  const history = useMemo<MonitorHistoryBook>(() => statusHistoryBook(statusRef.current), [agents]);

  return {
    agents,
    actions,
    history,
    notifications: monitorSnapshot.notifications,
    dismissNotification,
  };
}
