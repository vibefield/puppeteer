import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import { isMonitorStateAfterRemoval, isNewerMonitorRevision } from '@vibecook/puppeteer-core';
import type {
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
  AgentSessionInfo,
  AgentStateMessage,
} from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import {
  assembleMonitorAgents,
  mergeMonitorTerminals,
  type MonitorAgentRecord,
  type MonitorTerminalRecord,
} from './agents.js';
import type { MonitorActions, MonitorAgent } from './types.js';

export interface UseMonitorAgentsOptions {
  workspace?: GhostteaWorkspaceContext;
  attachments: ReadonlyMap<string, PaneAttachment>;
  /** Live terminal id -> stable monitor identity across PTY handoffs. */
  terminalIdentities?: ReadonlyMap<string, string>;
  /** Terminal-runtime exits, so a placeholder for a closed terminal stops being shown. */
  onSessionExited(listener: (sessionId: string) => void): () => void;
}

export interface MonitorAgentsResult {
  agents: readonly MonitorAgent[];
  actions: MonitorActions;
  notifications: readonly AgentMonitorNotificationMessage[];
  dismissNotification(runtimeRunId: string, notificationId: string): void;
  godviewMonitorV2: boolean;
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
}: UseMonitorAgentsOptions): MonitorAgentsResult {
  const [records, setRecords] = useState(() => new Map<string, MonitorAgentRecord>());
  const [terminals, setTerminals] = useState<readonly MonitorTerminalRecord[]>([]);
  const [exitedTerminalIds, setExitedTerminalIds] = useState(() => new Set<string>());
  const [notifications, setNotifications] = useState<AgentMonitorNotificationMessage[]>([]);
  const [monitorRendererV2, setMonitorRendererV2] = useState<boolean>();
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    let rendererV2 = false;
    let configurationReady = false;
    let publishFrame: number | undefined;
    const current = new Map<string, MonitorAgentRecord>();
    const monitorsByRun = new Map<string, AgentMonitorStateMessage>();
    const monitorRemovals = new Map<string, AgentMonitorRemovedMessage>();
    const removed = new Set<string>();
    const pendingFinals = new Set<string>();
    const pendingNotifications: AgentMonitorNotificationMessage[] = [];
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
    const updateState = (state: AgentStateMessage): void => {
      const existing = current.get(state.runtimeSessionId);
      if (!existing) return;
      current.set(state.runtimeSessionId, { ...existing, state });
      publish();
    };
    const acceptMonitor = (message: AgentMonitorStateMessage): boolean => {
      const removal = monitorRemovals.get(message.runtimeRunId);
      if (removal && !isMonitorStateAfterRemoval(message.state, removal.runtimeEpoch)) return false;
      const existing = monitorsByRun.get(message.runtimeRunId);
      if (existing && !isNewerMonitorRevision(message.state, existing.state)) return false;
      monitorRemovals.delete(message.runtimeRunId);
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
      monitorRemovals.set(message.runtimeRunId, message);
      monitorsByRun.delete(message.runtimeRunId);
      const terminalSessionId =
        message.terminalSessionId ??
        [...current.values()].find((record) => record.info.runtimeRunId === message.runtimeRunId)?.info
          .runtimeSessionId;
      if (!terminalSessionId) return;
      if (rendererV2) {
        forget(terminalSessionId);
        return;
      }
      const record = current.get(terminalSessionId);
      if (record?.monitor) {
        current.set(terminalSessionId, { info: record.info, ...(record.state ? { state: record.state } : {}) });
        publish();
      }
    };
    const publishNotification = (message: AgentMonitorNotificationMessage): void => {
      if (!alive) return;
      setNotifications((existing) => {
        if (
          existing.some(
            (notice) =>
              notice.runtimeRunId === message.runtimeRunId &&
              notice.notification.notificationId === message.notification.notificationId,
          )
        ) {
          return existing;
        }
        return [...existing.slice(-3), message];
      });
    };

    const unsubscribeSession = window.puppeteer.onAgentSession(remember);
    const unsubscribeState = window.puppeteer.onAgentState(updateState);
    const unsubscribeRemoved = window.puppeteer.onAgentRemoved(forget);
    const unsubscribeFinal = window.puppeteer.onWorkspaceFinal((event) => {
      if (!configurationReady) pendingFinals.add(event.runtimeSessionId);
      else if (!rendererV2) forget(event.runtimeSessionId);
    });
    const unsubscribeMonitorState = window.puppeteer.onAgentMonitorState(updateMonitor);
    const unsubscribeMonitorRemoved = window.puppeteer.onAgentMonitorRemoved(removeMonitor);
    const unsubscribeMonitorNotification = window.puppeteer.onAgentMonitorNotification((message) => {
      if (!configurationReady) {
        pendingNotifications.push(message);
        if (pendingNotifications.length > 4) pendingNotifications.shift();
      } else if (rendererV2) publishNotification(message);
    });

    void (async () => {
      const configuration = await window.puppeteer
        .agentMonitorConfiguration()
        .catch(() => ({ godviewMonitorV2: false }));
      if (!alive) return;
      rendererV2 = configuration.godviewMonitorV2;
      configurationReady = true;
      setMonitorRendererV2(rendererV2);
      if (rendererV2) {
        for (const message of pendingNotifications) publishNotification(message);
      }
      pendingNotifications.length = 0;
      if (!rendererV2) {
        for (const runtimeSessionId of pendingFinals) forget(runtimeSessionId);
      }
      pendingFinals.clear();
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
        if (rendererV2 ? !monitor : snapshot.final || snapshot.info.session.exited) continue;
        const live = current.get(id);
        next.set(id, {
          info: live?.info ?? snapshot.info,
          state: live?.state ?? snapshot.state,
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
      unsubscribeState();
      unsubscribeRemoved();
      unsubscribeFinal();
      unsubscribeMonitorState();
      unsubscribeMonitorRemoved();
      unsubscribeMonitorNotification();
    };
  }, []);

  useEffect(() => {
    if (monitorRendererV2 !== true) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [monitorRendererV2]);

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
    if (monitorRendererV2 === undefined) return [];
    return assembleMonitorAgents({
      agents: [...records.values()],
      terminals: visibleTerminals,
      sessions,
      attachments,
      identities: terminalIdentities,
      godviewMonitorV2: monitorRendererV2,
      nowMs,
      ...(workspace?.activeSession ? { activeSessionId: workspace.activeSession.id } : {}),
    });
  }, [
    attachments,
    monitorRendererV2,
    nowMs,
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

  const dismissNotification = useCallback((runtimeRunId: string, notificationId: string): void => {
    setNotifications((current) =>
      current.filter(
        (message) => message.runtimeRunId !== runtimeRunId || message.notification.notificationId !== notificationId,
      ),
    );
  }, []);

  return {
    agents,
    actions,
    notifications,
    dismissNotification,
    godviewMonitorV2: monitorRendererV2 === true,
  };
}
