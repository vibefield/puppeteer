import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  GhostteaProvider,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
} from '@vibecook/ghosttea-react';
import {
  GHOSTTY_COLOR_THEMES,
  GhostteaWorkspace,
  TERMINAL_THEMES,
  type GhostteaPaneRehydration,
  type GhostteaWorkspaceContext,
  type GhostteaWorkspacePaneDecoration,
} from '@vibecook/ghosttea-react/workspace';
import { withGodviewTerminalThemes, type GodviewTheme } from '../appearance-themes.js';
import { paneRecoveryMetadata } from '../restore-snapshot.js';
import type { TerminalSessionHandoff } from '../protocol.js';
import { AgentMonitorInspector } from './AgentMonitorInspector.js';
import { AgentsDrawer } from './AgentsDrawer.js';
import { InstrumentBar } from './InstrumentBar.js';
import { UsageColumn } from './UsageColumn.js';
import { useAgentProfiles } from './agent-profiles.js';
import {
  TweakPanel,
  defaultGodviewTuning,
  godviewTuningStyle,
  type GodviewTuning,
  type TweakSection,
} from './TweakPanel.js';
import type { AgentVisualStatus } from './agent-status.js';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from './monitor/chrome.js';
import { monitorAgentCounts, nextMonitorAgentForStatus } from './monitor/agents.js';
import { useMonitorPalette } from './monitor/monitor-palette.js';
import {
  loadMonitorParameters,
  monitorParameterDefaults,
  normalizeMonitorParameters,
  saveMonitorParameters,
  type MonitorParameters,
} from './monitor/parameters.js';
import { MONITOR_VIEWS, monitorViewFor } from './monitor/registry.js';
import type { AgentMonitorView } from './monitor/types.js';
import {
  SCANLINE_DENSITY_KEY,
  SCANLINE_OPACITY_KEY,
  STAGE_HEIGHT_KEY,
  STAGE_PARAMETER_GROUPS,
  VIGNETTE_OPACITY_KEY,
} from './monitor/stage-parameters.js';
import { FindSheet } from './find/FindSheet.js';
import { useMonitorAgents } from './monitor/useMonitorAgents.js';
import { buildPaneAttachments } from './pane-attachments.js';
import { paneSessionLaunchSource } from './pane-session.js';
import { DeckFrames } from './deck/DeckFrames.js';
import { useTerminalGround } from './deck/terminal-ground.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles/tokens.css';
import './styles/godview.css';
import './styles/deck.css';
import './styles/agents-drawer.css';
import './styles/find-sheet.css';

GHOSTTY_COLOR_THEMES.splice(0, GHOSTTY_COLOR_THEMES.length, ...withGodviewTerminalThemes(GHOSTTY_COLOR_THEMES));

const THEME_STORAGE_KEY = 'godview:color-theme:v1';
const VIEW_STORAGE_KEY = 'godview:monitor-view:v1';
// The stage's tunables predate their name: the key keeps every installation's
// CRT values, and the stage height lands from its default.
const STAGE_PARAMETERS_KEY = 'godview:screen-parameters:v1';
// Where every tunable lived before views owned their own controls; read as a
// seed so an installation keeps the look it was tuned to.
const LEGACY_PARAMETERS_KEY = 'godview:swarm-parameters:v1';
const WORKSPACE_STORAGE_KEY = `godview:ghosttea-workspace:v2:${window.desktop.tabId}`;

function viewParametersKey(view: AgentMonitorView): string {
  return `godview:monitor-parameters:v1:${view.id}${view.parametersRevision ? `:${view.parametersRevision}` : ''}`;
}

/** A revised view starts from its own defaults; the legacy seed is for views that never moved. */
function loadViewParameters(view: AgentMonitorView): MonitorParameters {
  return loadMonitorParameters(
    viewParametersKey(view),
    view.parameterGroups,
    view.parametersRevision ? undefined : LEGACY_PARAMETERS_KEY,
  );
}

// A slot is reused across windows, so an explicitly new tab starts from an
// empty document rather than inheriting the layout its predecessor left there.
//
// Strictly once per window. The flag is fixed at window creation and so is
// still set on a reload, and this window reloads itself to recover from a dead
// renderer — clearing again there would throw away the layout the user has
// built since opening it. sessionStorage is exactly the right lifetime: it
// survives the reload and dies with the window.
const WORKSPACE_RESET_MARKER = 'godview:workspace-reset-applied';
if (window.desktop.resetWorkspace) {
  try {
    if (!sessionStorage.getItem(WORKSPACE_RESET_MARKER)) {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      sessionStorage.setItem(WORKSPACE_RESET_MARKER, '1');
    }
  } catch {
    // A disabled storage partition already yields an empty workspace.
  }
}

function initialTheme(): GodviewTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function initialViewId(): string {
  try {
    return monitorViewFor(localStorage.getItem(VIEW_STORAGE_KEY)).id;
  } catch {
    return monitorViewFor(undefined).id;
  }
}

const bootTheme = initialTheme();
const bootViewId = initialViewId();
document.documentElement.dataset.theme = bootTheme;

const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: 'godview',
  // Godview windows are viewports, not PTY owners. Agent sessions remain live
  // while bubbles and panes attach, detach, or mirror them.
  platform: {
    openExternal: (url) => window.desktop.openExternal(url),
    writeClipboard: (text) => window.desktop.writeClipboard(text),
    forceCanvasFallback: () => sessionStorage.getItem('ghosttea:force-canvas-fallback') === '1',
    setForceCanvasFallback: (enabled) => {
      if (enabled) sessionStorage.setItem('ghosttea:force-canvas-fallback', '1');
      else sessionStorage.removeItem('ghosttea:force-canvas-fallback');
    },
    reload: () => window.location.reload(),
  },
});

const WorkspaceReporterContext = createContext<(workspace: GhostteaWorkspaceContext) => void>(() => undefined);

function savedWorkspace(): unknown {
  try {
    const serialized = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return serialized ? (JSON.parse(serialized) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function WorkspaceReporter({ workspace }: { workspace: GhostteaWorkspaceContext }) {
  const report = useContext(WorkspaceReporterContext);
  useEffect(() => report(workspace), [report, workspace]);
  return null;
}

function Godview() {
  const [active, setActive] = useState(document.visibilityState !== 'hidden');
  const [theme, setTheme] = useState<GodviewTheme>(bootTheme);
  // The stage-surface and bubble-colour instrument. Memory-only, and re-seeded
  // from the tokens on every theme change so a light tune never bleeds into dark.
  const [tuning, setTuning] = useState<GodviewTuning>(() => defaultGodviewTuning(bootTheme));
  const [viewId, setViewId] = useState(bootViewId);
  const [parametersByView, setParametersByView] = useState<Record<string, MonitorParameters>>(() => ({
    [bootViewId]: loadViewParameters(monitorViewFor(bootViewId)),
  }));
  const [stageParameters, setStageParameters] = useState<MonitorParameters>(() =>
    loadMonitorParameters(STAGE_PARAMETERS_KEY, STAGE_PARAMETER_GROUPS, LEGACY_PARAMETERS_KEY),
  );
  const [tweakPanelOpen, setTweakPanelOpen] = useState(false);
  const [agentsDrawerOpen, setAgentsDrawerOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [workspace, setWorkspace] = useState<GhostteaWorkspaceContext>();
  const [terminalIdentities, setTerminalIdentities] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [paneColors, setPaneColors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const stageRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLElement>(null);
  const palette = useMonitorPalette();
  const profiles = useAgentProfiles();
  const terminalGround = useTerminalGround(theme);
  const view = monitorViewFor(viewId);
  // Seeded on boot and on every switch, so the fallback is a guard rather than a
  // path. Memoized regardless: a fresh object here would re-fire the save effect
  // on every render.
  const parameters = useMemo(
    () => parametersByView[view.id] ?? monitorParameterDefaults(view.parameterGroups),
    [parametersByView, view],
  );
  const platform = useMemo(
    () => ({
      platform: window.desktop.platform,
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      setCanCopy: window.desktop.setTerminalCanCopy,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
      newWindow: window.desktop.newWindow,
      quit: window.desktop.quit,
      closeAllWindows: window.desktop.closeAllWindows,
      openConfig: window.desktop.openConfig,
      reloadConfig: window.desktop.reloadConfig,
      ...(window.desktop.saveAppearance
        ? {
            saveAppearance: (update: Parameters<NonNullable<typeof window.desktop.saveAppearance>>[1]) =>
              window.desktop.saveAppearance!(theme, update),
          }
        : {}),
      ...(window.desktop.configEditor ? { configEditor: window.desktop.configEditor } : {}),
      newTab: window.desktop.newTab,
      // Godview reserves ⌘1/2/3 for status navigation. Ghosttea still owns
      // every other table-driven tab binding, including the "last" target.
      selectTab: (target: 'previous' | 'next' | 'last' | number) => {
        if (typeof target === 'number' && target >= 1 && target <= 3) return;
        window.desktop.selectTab(target);
      },
      closeTab: window.desktop.closeTab,
      onMenuAction: window.desktop.onMenuAction,
    }),
    [theme],
  );

  const changeTheme = useCallback((next: GodviewTheme): void => {
    setTheme(next);
    setTuning(defaultGodviewTuning(next));
  }, []);

  const changeTuning = useCallback((patch: Partial<GodviewTuning>): void => {
    setTuning((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    const updateVisibility = (): void => setActive(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A disabled storage partition should not prevent theme switching.
    }
    window.desktop.setTheme(theme);
  }, [theme]);

  useEffect(() => window.desktop.onThemeChanged(changeTheme), [changeTheme]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, viewId);
    } catch {
      // Keep the switcher usable when persistence is unavailable.
    }
  }, [viewId]);

  useEffect(() => saveMonitorParameters(viewParametersKey(view), parameters), [parameters, view]);
  useEffect(() => saveMonitorParameters(STAGE_PARAMETERS_KEY, stageParameters), [stageParameters]);

  useEffect(() => {
    if (!tweakPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTweakPanelOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [tweakPanelOpen]);

  // Views that lay out in flow clear the chrome with these; the swarm instead
  // reads the chrome's rect directly and steers bodies around it.
  useEffect(() => {
    const stage = stageRef.current;
    const chrome = chromeRef.current;
    if (!stage || !chrome) return;
    const publish = (): void => {
      const rect = chrome.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      stage.style.setProperty('--vf-monitor-chrome-height', `${Math.round(rect.height)}px`);
      stage.style.setProperty('--vf-monitor-chrome-right', `${Math.round(rect.right - stageRect.left)}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    publish();
    return () => observer.disconnect();
  }, []);

  const paneAttachments = useMemo(
    () => buildPaneAttachments(workspace?.panes ?? [], workspace?.activePaneId),
    [workspace?.activePaneId, workspace?.panes],
  );

  const onSessionExited = useCallback((listener: (sessionId: string) => void) => {
    const handler = (event: Event): void => listener((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    terminalRuntime.addEventListener('session-exited', handler);
    return () => terminalRuntime.removeEventListener('session-exited', handler);
  }, []);

  useEffect(
    () =>
      window.desktop.onTerminalSessionHandoff((handoff: TerminalSessionHandoff) => {
        const affected = workspace?.panes.filter((pane) => pane.session.id === handoff.previousSessionId) ?? [];
        if (affected.length === 0) {
          // A duplicate delivered after the local mount is already complete is
          // safe to acknowledge; otherwise let main's bounded reload recover a
          // renderer that missed the transition.
          if (workspace?.sessions.some((session) => session.id === handoff.session.id)) {
            window.desktop.acknowledgeTerminalSessionHandoff(handoff.handoffId);
          }
          return;
        }
        setTerminalIdentities((current) => {
          const next = new Map(current);
          next.set(handoff.session.id, handoff.monitorIdentity);
          return next;
        });
        if (affected.length === 1 && affected[0]?.id === workspace?.activePaneId) {
          // Ghosttea commits this replacement synchronously through its public
          // workspace context, retaining focus and the pane's split geometry.
          workspace.mountSession(handoff.session);
          window.desktop.acknowledgeTerminalSessionHandoff(handoff.handoffId);
          return;
        }
        // The current Ghosttea API replaces only the active pane. Its startup
        // rehydrator can replace every mirrored/background reference in tree
        // order, using the complete document main queued before this message.
        window.desktop.acknowledgeTerminalSessionHandoff(handoff.handoffId);
        window.location.reload();
      }),
    [workspace],
  );

  const { agents, actions, notifications, dismissNotification } = useMonitorAgents({
    workspace,
    attachments: paneAttachments,
    terminalIdentities,
    onSessionExited,
    palette,
    profileLabels: profiles.labels,
  });
  const agentsBySession = useMemo(() => new Map(agents.map((agent) => [agent.session.id, agent] as const)), [agents]);
  const activeAgent = agents.find((agent) => agent.active);

  // A pane owns no colour (record §02, P-4): it wears the project colour of
  // the agent mounted in it, and nothing while it shows a bare shell. Held as
  // state with an equality check so Ghosttea's workspace is not redrawn on
  // every monitor tick.
  useEffect(() => {
    const next = new Map<string, string>();
    for (const pane of workspace?.panes ?? []) {
      const agent = agentsBySession.get(pane.session.id);
      if (agent?.agent) next.set(pane.id, agent.color);
    }
    setPaneColors((current) => {
      if (current.size === next.size && [...next].every(([id, color]) => current.get(id) === color)) return current;
      return next;
    });
  }, [agentsBySession, workspace?.panes]);
  const counts = useMemo(() => monitorAgentCounts(agents), [agents]);

  const selectNextStatus = useCallback(
    (status: AgentVisualStatus): void => {
      const next = nextMonitorAgentForStatus(agents, status, workspace?.activeSession?.id);
      if (next) actions.select(next);
    },
    [actions, agents, workspace?.activeSession?.id],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      const status = ({ Digit1: 'blocked', Digit2: 'working', Digit3: 'idle' } as const)[
        event.code as 'Digit1' | 'Digit2' | 'Digit3'
      ];
      if (!status) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectNextStatus(status);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectNextStatus]);

  // ⌘F summons Find. The terminal has no find of its own, so nothing is stolen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.code !== 'KeyF') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFindOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const createSplitSession = useCallback(
    async (selectedSession: SessionSummary): Promise<SessionSummary> => {
      const refreshedSessions = await terminalRuntime.listSessions();
      const monitored = agentsBySession.get(selectedSession.id);
      const facet = monitored?.agent;
      const agentCwd = facet?.monitor.environment.cwd;
      const refreshedSession =
        refreshedSessions.find((candidate) => candidate.id === selectedSession.id) ?? selectedSession;
      const processCwd =
        !agentCwd && refreshedSession.pid ? await window.desktop.resolveProcessCwd(refreshedSession.pid) : undefined;
      const fallbackCwd = facet?.info.workspace.sourcePath || facet?.info.workspace.root || monitored?.cwd || undefined;
      const source = paneSessionLaunchSource(selectedSession, refreshedSessions, {
        agent: agentCwd,
        process: processCwd,
        fallback: fallbackCwd,
      });
      return terminalRuntime.createSession({
        executable: platform.defaultShell,
        args: [],
        ...(source.cwd ? { cwd: source.cwd } : {}),
        environment: { mode: 'inherit' },
        cols: source.session.cols,
        rows: source.session.rows,
        persistence: 'terminate-with-app',
        programKind: 'interactive-shell',
      });
    },
    [agentsBySession, platform.defaultShell],
  );

  // Main owns the durable descriptors, so the answer to "what was this pane?"
  // is a lookup there; the saved session id is the key both sides already share.
  const rehydratePane = useCallback(
    (request: GhostteaPaneRehydration): Promise<SessionSummary | null> => window.puppeteer.rehydratePane(request),
    [],
  );

  const persistPaneRecovery = useCallback(
    (session: SessionSummary) => paneRecoveryMetadata(session, agentsBySession.get(session.id)?.agent?.info),
    [agentsBySession],
  );

  const reportTabSessions = useCallback((sessionIds: readonly string[]): void => {
    window.desktop.updateTabSessions(sessionIds, savedWorkspace());
  }, []);

  // Ghosttea owns the local workspace document. Mirror each changed serialized
  // value into the main-process durable journal; the comparison keeps the idle
  // cost at a localStorage read and also catches zoom-only changes that do not
  // alter the public workspace context.
  useEffect(() => {
    let previous = '';
    const checkpoint = (): void => {
      try {
        const serialized = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '';
        if (!serialized || serialized === previous) return;
        previous = serialized;
        window.desktop.updateWorkspace(JSON.parse(serialized) as unknown);
      } catch {
        // Ghosttea logs malformed/localStorage failures and will replace them on
        // the next valid workspace commit.
      }
    };
    checkpoint();
    const timer = window.setInterval(checkpoint, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Only the colour, and only for a pane holding an agent: the badge and the
  // rest of the frame are the deck's own (`deck/PaneFrame.tsx`), drawn into
  // the pane Ghosttea lays out.
  const decoratePane = useCallback(
    (_session: SessionSummary, paneId: string): GhostteaWorkspacePaneDecoration => {
      const color = paneColors.get(paneId);
      return color ? { color } : {};
    },
    [paneColors],
  );

  const mountResumedSession = useCallback(
    (session: SessionSummary): void => workspace?.mountSession(session),
    [workspace],
  );

  const updateParameter = useCallback(
    (key: string, value: number): void => {
      setParametersByView((current) => ({
        ...current,
        [view.id]: normalizeMonitorParameters(view.parameterGroups, { ...current[view.id], [key]: value }),
      }));
    },
    [view],
  );

  const updateStageParameter = useCallback((key: string, value: number): void => {
    setStageParameters((current) => normalizeMonitorParameters(STAGE_PARAMETER_GROUPS, { ...current, [key]: value }));
  }, []);

  const selectView = useCallback((nextViewId: string): void => {
    const next = monitorViewFor(nextViewId);
    setParametersByView((current) =>
      current[next.id] ? current : { ...current, [next.id]: loadViewParameters(next) },
    );
    setViewId(next.id);
  }, []);

  // The stage's groups first, then the active view's own — rebuilt when the
  // view changes, which is what makes a view's controls come and go with it.
  const tweakSections = useMemo<readonly TweakSection[]>(
    () => [
      ...STAGE_PARAMETER_GROUPS.map((group) => ({
        id: `stage:${group.title}`,
        group,
        values: stageParameters,
        onChange: updateStageParameter,
      })),
      ...view.parameterGroups.map((group) => ({
        id: `${view.id}:${group.title}`,
        group,
        values: parameters,
        onChange: updateParameter,
      })),
    ],
    [parameters, stageParameters, updateParameter, updateStageParameter, view],
  );

  const screenStyle = {
    ...godviewTuningStyle(tuning),
    '--vf-monitor-stage-height': `${stageParameters[STAGE_HEIGHT_KEY] ?? 35}%`,
    '--vf-scanline-density': `${stageParameters[SCANLINE_DENSITY_KEY] ?? 2}px`,
    '--vf-scanline-opacity': stageParameters[SCANLINE_OPACITY_KEY] ?? 0.4,
    '--vf-vignette-opacity': stageParameters[VIGNETTE_OPACITY_KEY] ?? 1,
  } as CSSProperties;
  const MonitorView = view.Component;

  return (
    <div
      className={`vf-godview theme-${theme} platform-${window.desktop.platform}`}
      data-godview-open="true"
      data-godview-tuning-open={tweakPanelOpen ? 'true' : 'false'}
      data-godview-animations="on"
      style={screenStyle}
    >
      <div className="vf-godview-scanlines" aria-hidden="true" />
      <div className="vf-godview-vignette" aria-hidden="true" />
      <InstrumentBar
        counts={counts}
        onSelectStatus={selectNextStatus}
        views={MONITOR_VIEWS}
        viewId={view.id}
        onSelectView={selectView}
        findOpen={findOpen}
        onToggleFind={() => setFindOpen((current) => !current)}
        agentsOpen={agentsDrawerOpen}
        onToggleAgents={() => setAgentsDrawerOpen((current) => !current)}
        tuneOpen={tweakPanelOpen}
        onToggleTune={() => setTweakPanelOpen((current) => !current)}
        theme={theme}
        onThemeChange={changeTheme}
      />

      {notifications.length ? (
        <div className="vf-godview-monitor-feed" aria-live="polite" aria-label="Agent monitor notifications">
          {notifications.map((message) => (
            <div className="vf-godview-monitor-notice" key={`${message.runtimeRunId}:${message.notificationId}`}>
              <span>{message.summary ?? message.type}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissNotification(message.runtimeRunId, message.notificationId)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <AgentsDrawer open={agentsDrawerOpen} profiles={profiles} onClose={() => setAgentsDrawerOpen(false)} />

      <FindSheet
        open={findOpen}
        agents={agents}
        onClose={() => setFindOpen(false)}
        onSelect={(agent) => {
          actions.select(agent);
          setFindOpen(false);
        }}
      />

      <TweakPanel
        open={tweakPanelOpen}
        theme={theme}
        value={tuning}
        sections={tweakSections}
        onClose={() => setTweakPanelOpen(false)}
        onThemeChange={changeTheme}
        onChange={changeTuning}
        onReset={() => {
          setTuning(defaultGodviewTuning(theme));
          setStageParameters(monitorParameterDefaults(STAGE_PARAMETER_GROUPS));
          setParametersByView((current) => ({
            ...current,
            [view.id]: monitorParameterDefaults(view.parameterGroups),
          }));
        }}
      />

      <section ref={stageRef} className={MONITOR_STAGE_CLASS} aria-label="Agent monitor">
        <MonitorView agents={agents} parameters={parameters} actions={actions} palette={palette} />
        <div ref={chromeRef} className="vf-monitor-chrome" {...{ [MONITOR_CHROME_ATTRIBUTE]: '' }}>
          <UsageColumn />
        </div>
        {activeAgent?.agent?.monitor ? (
          <AgentMonitorInspector
            key={activeAgent.agent.monitor.runtimeRunId}
            state={activeAgent.agent.monitor}
            allStates={agents.flatMap((agent) => (agent.agent?.monitor ? [agent.agent.monitor] : []))}
            nowMs={Date.now()}
            {...(activeAgent.agent.account ? { account: activeAgent.agent.account } : {})}
          />
        ) : null}
      </section>

      <section
        ref={deckRef}
        className="vf-godview-terminal-deck"
        aria-label="Terminal panes"
        style={
          {
            '--vf-godview-terminal-bg': terminalGround.background,
            '--vf-godview-terminal-ink': terminalGround.foreground,
          } as CSSProperties
        }
      >
        <WorkspaceReporterContext.Provider value={setWorkspace}>
          <GhostteaWorkspace
            platform={platform}
            {...(!window.desktop.saveAppearance
              ? { theme: theme === 'dark' ? TERMINAL_THEMES.midnight : TERMINAL_THEMES.daylight }
              : {})}
            storageKey={WORKSPACE_STORAGE_KEY}
            sidebar={WorkspaceReporter}
            decoratePane={decoratePane}
            paneMeta={persistPaneRecovery}
            createSplitSession={createSplitSession}
            splitSizing="equal"
            onRehydratePane={rehydratePane}
            claimExistingSessions={window.desktop.claimExistingSessions}
            enableRemoteSessions={window.desktop.remoteSessionsEnabled}
            active={active}
            showTitlebar={false}
            onSessionsChange={reportTabSessions}
            onActiveSessionChange={(session) => window.desktop.updateActiveCwd(session?.cwd ?? undefined)}
            {...(window.desktop.initialCwd ? { initialCwd: window.desktop.initialCwd } : {})}
          />
        </WorkspaceReporterContext.Provider>
        <DeckFrames
          deckRef={deckRef}
          panes={workspace?.panes ?? []}
          agentsBySession={agentsBySession}
          paneColors={paneColors}
          onResume={mountResumedSession}
        />
      </section>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  try {
    const restored = await window.desktop.takeRestoreWorkspace();
    if (restored) localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(restored));
  } catch (error) {
    console.error('[restore] failed to seed the durable workspace snapshot', error);
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <GhostteaProvider runtime={terminalRuntime}>
        <Godview />
      </GhostteaProvider>
    </StrictMode>,
  );
}

void bootstrap();
