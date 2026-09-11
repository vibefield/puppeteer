import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type { MonitorNotification } from '@vibecook/puppeteer-core';
import { createAgentMonitorStore } from '@vibecook/puppeteer-monitor';
import { useAgentMonitorStore } from '@vibecook/puppeteer-react';
import type { AgentMonitorRemovedMessage, AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorPalette } from './monitor-palette.js';
import {
  assembleMonitorAgents,
  mergeMonitorTerminals,
  type MonitorAgentRecord,
  type MonitorTerminalRecord,
} from './agents.js';
import type { MonitorActions, MonitorAgent } from './types.js';
import { EMPTY_UNREAD_LEDGER, reconcileUnread, type UnreadLedger } from './unread.js';

export interface UseMonitorAgentsOptions {
  workspace?: GhostteaWorkspaceContext;
  attachments: ReadonlyMap<string, PaneAttachment>;
  /** Live terminal id -> stable monitor identity across PTY handoffs. */
  terminalIdentities?: ReadonlyMap<string, string>;
  /** Terminal-runtime exits, so a placeholder for a closed terminal stops being shown. */
  onSessionExited(listener: (sessionId: string) => void): () => void;
  /** The live tokens; a row's colour is its project's tint, or the ramp with no project. */
  palette: MonitorPalette;
  /** Account id -> label, so a row can name the account its session was launched under. */
  profileLabels?: ReadonlyMap<string, string>;
}

export interface MonitorAgentsResult {
  agents: readonly MonitorAgent[];
  actions: MonitorActions;
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
      current.set(info.runtimeSessionId, { ...existing, info, ...(monitor ? { monitor } : {}) });
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
      if (!record) return;
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
        identities: terminalIdentities,
      }),
    [exitedTerminalIds, terminalIdentities, terminals, workspace?.sessions],
  );

  const agents = useMemo(() => {
    const assembled = assembleMonitorAgents({
      agents: [...records.values()],
      terminals: visibleTerminals,
      sessions,
      attachments,
      identities: terminalIdentities,
      nowMs,
      colours: { tint: palette.tint, neutral: palette.neutral },
      ...(workspace?.activeSession ? { activeSessionId: workspace.activeSession.id } : {}),
    });
    // Unread is a fold over successive projections; the ledger is the only
    // state here that is not derivable from one snapshot.
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
    return assembled.map((agent) => {
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
  }, [
    attachments,
    nowMs,
    palette.neutral,
    palette.tint,
    profileLabels,
    records,
    sessions,
    terminalIdentities,
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

  return {
    agents,
    actions,
    notifications: monitorSnapshot.notifications,
    dismissNotification,
  };
}
