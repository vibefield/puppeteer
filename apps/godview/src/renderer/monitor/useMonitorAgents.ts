import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type { MonitorNotification } from '@vibecook/puppeteer-core';
import { createAgentMonitorStore, type MonitorHostTerminal } from '@vibecook/puppeteer-monitor';
import { createMonitorReplica, type MonitorReplica } from '@vibecook/puppeteer-monitor/replica';
import { useAgentMonitorStore } from '@vibecook/puppeteer-react';
import type { MonitorView } from '@vibecook/puppeteer-view-sdk';
import { frameScheduler, type ViewSlotCommands } from '@vibecook/puppeteer-view-sdk/host';
import type { AgentStatus, MonitorAgentRow, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import { projectColourFor } from '@vibecook/puppeteer-view-sdk/toolkit';
import { MONITOR_VIEWS, type MonitorAgent as ViewsMonitorAgent, type MonitorPalette } from '@vibecook/puppeteer-views';
import type { AgentMonitorRemovedMessage, AgentMonitorStateMessage, AgentSessionInfo } from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import { chromeRows, type ChromeAgentRecord } from './chrome-rows.js';
import type { MonitorAgent } from './types.js';
import {
  agentSessionsByRow,
  mergeMonitorTerminals,
  sameVisualIds,
  sessionIdForRow,
  terminalReport,
  visualIdsForRows,
  windowLocal,
  windowTerminalIds,
  type MonitorTerminalRecord,
} from './window-facts.js';

/**
 * Puppeteer's Godview on the monitor backend (MV-2).
 *
 * The backend in main computes every row; this window holds a REPLICA of its
 * model (a snapshot, then the changes, on one ordered channel: M23) and joins
 * only what the window knows: its panes, the pane it works in, the terminals it
 * holds, the theme's colours. All four views are SDK views the view host
 * mounts directly — the list and the rain (MV-4), the swarm (MV-5) and the
 * timeline (MV-6): they read the model and word the line under a name by the
 * toolkit's one rule (reply-first, M4). The view host mounts SDK views only
 * (the legacy bridge and its shim went with MV-8). The counts and the status
 * shortcuts read the model. Nothing here records what a row did: the timeline
 * draws births and current states (runtime only, MV-D13).
 *
 * The chrome outside the views (the inspector, the find sheet, the deck's pane
 * frames, split sessions, pane recovery) reads rows joined with the chrome's own
 * full-state feed (M19, `chrome-rows.ts`). Nothing the views draw reads it.
 */

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
  /** The live tokens: the theme's project colours (L7). */
  palette: MonitorPalette;
}

export interface MonitorAgentsResult {
  /** This window's replica of the backend's model; the view host mounts the view on it. */
  replica: MonitorReplica;
  model: MonitorModel;
  /** The four views by id, each as itself: list and rain (MV-4), the swarm (MV-5), the timeline (MV-6). */
  views: ReadonlyMap<string, MonitorView>;
  /** The view host's commands: select and create stay this window's own. */
  commands: ViewSlotCommands;
  /** Agent rows by status, from the model. */
  counts: Record<AgentStatus, number>;
  /** Mounts the next agent in `status` after the active one, from the model. */
  selectNextStatus(status: AgentStatus): void;
  /** The chrome's rows (M19); never handed to a view. */
  agents: readonly MonitorAgent[];
  /** The chrome's verbs: mount a row's session in the active pane; open a terminal there. */
  actions: {
    select(agent: Pick<ViewsMonitorAgent, 'id'>): void;
    /** True when a terminal opened (M59: nothing opened is a refusal to the view's create). */
    createAt(position?: { x: number; y: number }): Promise<boolean>;
  };
  /** Acknowledges a crashed row's failure through the backend, so the row leaves the model and the chrome alike. */
  acknowledge(id: string): void;
  notifications: readonly MonitorNotification[];
  dismissNotification(runtimeRunId: string, notificationId: string): void;
}

/** The four views by id, each mounted by the view host as itself. */
const VIEWS: ReadonlyMap<string, MonitorView> = new Map(MONITOR_VIEWS.map((entry) => [entry.id, entry.view] as const));

/** The replica's theme key (L7): the same tint and ramp are the same colours. */
function themeKey(palette: Pick<MonitorPalette, 'tint' | 'neutral'>): string {
  return `${palette.tint.l}:${palette.tint.c}:${palette.neutral}`;
}

export function useMonitorAgents({
  workspace,
  attachments,
  terminalIdentities,
  terminalVisualIds,
  closingSessionIds,
  onSessionExited,
  palette,
}: UseMonitorAgentsOptions): MonitorAgentsResult {
  // The window's replica, on the view host's ONE frame scheduler (M7). It lives as long as the window and is never
  // disposed, so a StrictMode remount finds it whole. The theme is set at once: no frame of uncoloured rows.
  const [replica] = useState(() => {
    const created = createMonitorReplica({
      scheduler: frameScheduler,
      onListenerError: (error) => console.error('[monitor] replica listener', error),
    });
    created.setTheme({ key: themeKey(palette), colourFor: projectColourFor(palette) });
    return created;
  });
  const model = useSyncExternalStore(replica.subscribe, replica.getSnapshot).model;

  // The model (M23): ask, then take every message of the one channel; a change before the first snapshot is in it.
  useEffect(() => {
    let synced = false;
    const unsubscribe = window.puppeteer.onMonitorModel((update) => {
      if ('rows' in update) synced = true;
      else if (!synced) return;
      replica.apply(update);
    });
    const unsubscribeGap = replica.onGap(() => window.puppeteer.requestMonitorSnapshot());
    window.puppeteer.requestMonitorSnapshot();
    return () => {
      unsubscribe();
      unsubscribeGap();
    };
  }, [replica]);

  const { tint, neutral } = palette;
  useEffect(() => {
    replica.setTheme({ key: themeKey({ tint, neutral }), colourFor: projectColourFor({ tint, neutral }) });
  }, [neutral, replica, tint]);

  // THE CHROME'S FEED (M19): main's agent records and each run's full state (`monitor:chrome-state`), joined by
  // terminal session exactly as the seam joined them. Only `chromeRows` reads `records`: the replica, the views, the
  // counts and the status shortcuts never do. Notifications keep their own store and UX.
  const [records, setRecords] = useState(() => new Map<string, ChromeAgentRecord>());
  const [notificationStore] = useState(() => createAgentMonitorStore({ notificationCapacity: 4 }));
  const notificationSnapshot = useAgentMonitorStore(notificationStore);
  useEffect(() => {
    let alive = true;
    let publishFrame: number | undefined;
    const current = new Map<string, ChromeAgentRecord>();
    const monitorsByRun = new Map<string, AgentMonitorStateMessage>();
    const removed = new Set<string>();
    // Orders full replacements and seals removed epochs, as the seam's store did.
    const chromeStore = createAgentMonitorStore();
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
      if (!chromeStore.acceptState(message.state)) return false;
      monitorsByRun.set(message.runtimeRunId, message);
      return true;
    };
    const terminalOf = (runtimeRunId: string, terminalSessionId: string | null): string | undefined =>
      terminalSessionId ??
      [...current.values()].find((record) => record.info.runtimeRunId === runtimeRunId)?.info.runtimeSessionId;
    const updateMonitor = (message: AgentMonitorStateMessage): void => {
      if (!acceptMonitor(message)) return;
      const terminalSessionId = terminalOf(message.runtimeRunId, message.terminalSessionId);
      if (!terminalSessionId) return;
      const record = current.get(terminalSessionId);
      if (!record || record.info.runtimeRunId !== message.runtimeRunId) return;
      current.set(terminalSessionId, { ...record, monitor: message });
      publish();
    };
    const removeMonitor = (message: AgentMonitorRemovedMessage): void => {
      if (!chromeStore.remove({ runtimeRunId: message.runtimeRunId, runtimeEpoch: message.runtimeEpoch })) return;
      monitorsByRun.delete(message.runtimeRunId);
      const terminalSessionId = terminalOf(message.runtimeRunId, message.terminalSessionId);
      if (terminalSessionId) forget(terminalSessionId);
    };

    const unsubscribeSession = window.puppeteer.onAgentSession(remember);
    const unsubscribeRemoved = window.puppeteer.onAgentRemoved(forget);
    const unsubscribeState = window.puppeteer.onChromeMonitorState(updateMonitor);
    const unsubscribeMonitorRemoved = window.puppeteer.onChromeMonitorRemoved(removeMonitor);
    const unsubscribeNotification = window.puppeteer.onAgentMonitorNotification((message) => {
      if (alive) notificationStore.acceptNotification(message.notification);
    });

    void (async () => {
      const [snapshots, monitorSnapshots] = await Promise.all([
        window.puppeteer.listAgentSessions(),
        window.puppeteer.listChromeMonitors(),
      ]);
      if (!alive) return;
      for (const monitor of monitorSnapshots) acceptMonitor(monitor);
      const next = new Map<string, ChromeAgentRecord>();
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
      unsubscribeState();
      unsubscribeMonitorRemoved();
      unsubscribeNotification();
      chromeStore.clear();
    };
  }, [notificationStore]);

  // This window's terminals: the shells it opened here (with where it asked for them) and every session its panes
  // show, minus the ones that exited or that it is closing.
  const [explicitTerminals, setExplicitTerminals] = useState<readonly MonitorTerminalRecord[]>([]);
  const [exitedTerminalIds, setExitedTerminalIds] = useState(() => new Set<string>());
  useEffect(
    () =>
      onSessionExited((sessionId) => {
        setExitedTerminalIds((current) => new Set(current).add(sessionId));
        setExplicitTerminals((current) => {
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
  const terminals = useMemo(
    () =>
      mergeMonitorTerminals({
        explicit: explicitTerminals,
        workspaceSessions: workspace?.sessions ?? [],
        exitedSessionIds: exitedTerminalIds,
        closingSessionIds,
        identities: terminalIdentities,
      }),
    [closingSessionIds, exitedTerminalIds, explicitTerminals, terminalIdentities, workspace?.sessions],
  );
  // The host port's terminals are what each window reports: a bare terminal is a window fact.
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    const report: MonitorHostTerminal[] = terminalReport(terminals, sessions, terminalIdentities);
    const key = JSON.stringify(report);
    if (reported.current === key) return;
    reported.current = key;
    window.puppeteer.reportMonitorTerminals(report);
  }, [sessions, terminalIdentities, terminals]);

  // Each agent row's terminal session, in main's record order.
  const agentSessions = useMemo(
    () => agentSessionsByRow(records.keys(), terminalIdentities),
    [records, terminalIdentities],
  );

  // The replica's local join. `visible` keeps every agent and only this window's terminals; it keeps its identity
  // while the set does, because a new predicate asks every row again.
  const terminalIdsKey = useMemo(
    () => [...windowTerminalIds(terminals, terminalIdentities)].sort().join('\n'),
    [terminalIdentities, terminals],
  );
  const visible = useMemo(() => {
    const ids = new Set(terminalIdsKey ? terminalIdsKey.split('\n') : []);
    return (row: MonitorAgentRow): boolean => row.kind === 'agent' || ids.has(row.id);
  }, [terminalIdsKey]);
  // A pane joins the row its session backs, which only a row's kind can change: the agent ids stand for the kinds.
  const agentIdsKey = useMemo(
    () =>
      model.agents
        .filter((row) => row.kind === 'agent')
        .map((row) => row.id)
        .join('\n'),
    [model],
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const activeSessionId = workspace?.activeSession?.id;

  // The swarm's spatial identity per row (M59): computed ONCE per published model and kept at the SAME identity across
  // a state-only publish, so the host's render rebuilds nothing and the replica's local join does no per-tick visual-id
  // work. The row->session resolver reads the churning maps through a ref, so only the model/transfer/identities key it.
  const visualIdsInputs = useRef({ agentSessions, terminals, terminalIdentities });
  visualIdsInputs.current = { agentSessions, terminals, terminalIdentities };
  const visualIdsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const visualIds = useMemo(() => {
    const { agentSessions: sessions, terminals: terms, terminalIdentities: ids } = visualIdsInputs.current;
    const next = visualIdsForRows(
      model.agents,
      (row) => sessionIdForRow(row, sessions, terms, ids),
      terminalVisualIds,
      visualIdsRef.current,
    );
    const stable = sameVisualIds(visualIdsRef.current, next) ? visualIdsRef.current : next;
    visualIdsRef.current = stable;
    return stable;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the resolver's maps are read through the ref; the model, a transfer, or an identity change are what move a visual id
  }, [model, terminalVisualIds, terminalIdentities]);

  const local = useMemo(
    () =>
      windowLocal(
        {
          model: modelRef.current,
          agentSessions,
          attachments,
          activeSessionId,
          terminals,
          identities: terminalIdentities,
          readyVisualIds: visualIds,
        },
        visible,
      ),
    // The model's agent ids stand for its kinds (`agentIdsKey`); the model itself is read through the ref, and the
    // spatial identity rides as `visualIds` (its own stable identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, agentIdsKey, agentSessions, attachments, terminalIdentities, terminals, visible, visualIds],
  );
  useLayoutEffect(() => replica.setLocal(local), [local, replica]);

  // L5/M20: a screen's shown rows are whatever its active pane shows; any window showing a row clears its mark.
  const shownKey = useMemo(() => [...local.activeIds].sort().join('\n'), [local]);
  useEffect(() => {
    window.puppeteer.reportMonitorShown(shownKey ? shownKey.split('\n') : []);
  }, [shownKey]);

  const select = useCallback(
    (session: SessionSummary | undefined): void => {
      if (session) workspace?.mountSession(session);
    },
    [workspace],
  );
  /** A row's session as this window mounts it: an agent's from its record, a terminal's live summary. */
  const sessionForRow = useCallback(
    (row: Pick<MonitorAgentRow, 'id' | 'kind'>): SessionSummary | undefined => {
      const sessionId = sessionIdForRow(row, agentSessions, terminals, terminalIdentities);
      if (sessionId === undefined) return undefined;
      if (row.kind === 'agent') return records.get(sessionId)?.info.session;
      const terminal = terminals.find((candidate) => candidate.session.id === sessionId);
      return terminal ? (sessions.get(sessionId) ?? terminal.session) : undefined;
    },
    [agentSessions, records, sessions, terminalIdentities, terminals],
  );

  /** Opens a terminal in the active pane: true when one opened (M59: the slot reads nothing opened as a refusal). */
  const createAt = useCallback(
    async (position?: { x: number; y: number }): Promise<boolean> => {
      if (!workspace?.activeSession) return false;
      const sourceCwd = workspace.activeSession.cwd;
      const session = await workspace.createSessionInActivePane();
      if (!session) return false;
      setExitedTerminalIds((current) => {
        if (!current.has(session.id)) return current;
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      const cwd = session.cwd ?? sourceCwd;
      setExplicitTerminals((current) => [
        ...current.filter((terminal) => terminal.session.id !== session.id),
        { session, ...(cwd ? { cwd } : {}), ...(position ? { spawnHint: position } : {}) },
      ]);
      return true;
    },
    [workspace],
  );

  // The view host reads its commands through the latest props; these reach the latest window too.
  const latest = useRef({ model, sessionForRow, select, createAt });
  latest.current = { model, sessionForRow, select, createAt };
  const commands = useMemo<ViewSlotCommands>(
    () => ({
      select(agentId) {
        const { model: current, sessionForRow: resolve, select: mount } = latest.current;
        const row = current.byId.get(agentId);
        if (row) mount(resolve(row));
      },
      create(at) {
        // M59: the slot reads a fulfilled return as opened and a rejection as a refusal.
        return latest.current.createAt(at).then((opened) => {
          if (!opened) throw new Error('no terminal opened');
        });
      },
    }),
    [],
  );

  // M19: the counts and the status shortcuts read the model, never the chrome's feed.
  const counts = useMemo(() => {
    const result: Record<AgentStatus, number> = { idle: 0, working: 0, blocked: 0 };
    for (const row of model.agents) if (row.kind === 'agent') result[row.status] += 1;
    return result;
  }, [model]);
  const selectNextStatus = useCallback(
    (status: AgentStatus): void => {
      const matching = model.agents.filter((row) => row.kind === 'agent' && row.status === status);
      if (matching.length === 0) return;
      const currentIndex = matching.findIndex((row) => agentSessions.get(row.id) === activeSessionId);
      select(sessionForRow(matching[(currentIndex + 1) % matching.length]!));
    },
    [activeSessionId, agentSessions, model, select, sessionForRow],
  );

  const agents = useMemo(
    () =>
      chromeRows({
        model,
        agentSessions,
        records,
        terminals,
        sessions,
        attachments,
        identities: terminalIdentities,
      }),
    [agentSessions, attachments, model, records, sessions, terminalIdentities, terminals],
  );

  const actions = useMemo(
    () => ({
      select: (agent: Pick<ViewsMonitorAgent, 'id'>): void =>
        select(agents.find((candidate) => candidate.id === agent.id)?.session),
      createAt,
    }),
    [agents, createAt, select],
  );

  const acknowledge = useCallback((id: string): void => {
    void window.puppeteer.acknowledgeMonitorRow(id);
  }, []);

  const dismissNotification = useCallback(
    (runtimeRunId: string, notificationId: string): void => {
      notificationStore.dismissNotification(runtimeRunId, notificationId);
    },
    [notificationStore],
  );

  return {
    replica,
    model,
    views: VIEWS,
    commands,
    counts,
    selectNextStatus,
    agents,
    actions,
    acknowledge,
    notifications: notificationSnapshot.notifications,
    dismissNotification,
  };
}
