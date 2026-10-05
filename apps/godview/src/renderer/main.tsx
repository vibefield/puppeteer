import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import { BarControl, InstrumentBar, type AccountUsagePort, type HistoryPort } from '@vibecook/puppeteer-views';
import { UsageColumn } from '@vibecook/puppeteer-views';
import { useAgentProfiles } from './agent-profiles.js';
import {
  TweakPanel,
  defaultGodviewTuning,
  godviewTuningStyle,
  type GodviewTuning,
  type TweakSection,
} from './TweakPanel.js';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from '@vibecook/puppeteer-views';
import { useMonitorPalette } from '@vibecook/puppeteer-views';
import {
  loadMonitorParameters,
  monitorParameterDefaults,
  normalizeMonitorParameters,
  saveMonitorParameters,
  type MonitorParameters,
} from '@vibecook/puppeteer-views';
import { MONITOR_VIEWS, monitorViewFor } from '@vibecook/puppeteer-views';
import type { MonitorTheme, StageGeometry } from '@vibecook/puppeteer-view-sdk';
import { frameScheduler, MonitorViewHost } from '@vibecook/puppeteer-view-sdk/host';
import type { MonitorViewEntry } from '@vibecook/puppeteer-views';
import {
  SAFE_AREA_BOTTOM_KEY,
  SAFE_AREA_LEFT_KEY,
  SAFE_AREA_RIGHT_KEY,
  SAFE_AREA_TOP_KEY,
  SCANLINE_DENSITY_KEY,
  SCANLINE_OPACITY_KEY,
  STAGE_HEIGHT_KEY,
  STAGE_PARAMETER_GROUPS,
  VIGNETTE_OPACITY_KEY,
} from './monitor/stage-parameters.js';
import { FindSheet } from '@vibecook/puppeteer-views';
import { useMonitorAgents } from './monitor/useMonitorAgents.js';
import { buildPaneAttachments } from './pane-attachments.js';
import { dealPaneColours, EMPTY_PANE_COLOUR_LEDGER, paneColours } from '@vibecook/puppeteer-views';
import { paneSessionLaunchSource } from './pane-session.js';
import {
  DECK_FRAMED_CLASS,
  DeckFrames,
  UnusedPaneSessions,
  useDeckZoom,
  zoomLayoutApplied,
} from '@vibecook/puppeteer-views';
import { AppPaneFrame, useAppPaneFrameVerbs } from './deck/pane-frame-host.js';
import { AppDeckLaunchers, recordBornShell, usePaneSessionUsed } from './deck/launcher-host.js';
import { launcherSessionUsed } from './deck/launcher-fresh.js';
import { paneFallbackCwds, paneFrameAgents } from './deck/pane-frame.js';
import { useTerminalGround } from './deck/terminal-ground.js';
import { useWorkspaceSettings } from './deck/workspace-settings.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles/tokens.css';
import './styles/godview.css';
import '@vibecook/puppeteer-views/styles/views.css';
import '@vibecook/puppeteer-views/styles/deck-frame.css';
import '@vibecook/puppeteer-views/styles/pane-launcher.css';
import './styles/agents-drawer.css';

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

function viewParametersKey(view: MonitorViewEntry): string {
  return `godview:monitor-parameters:v1:${view.id}${view.parametersRevision ? `:${view.parametersRevision}` : ''}`;
}

/** A revised view starts from its own defaults; the legacy seed is for views that never moved. */
function loadViewParameters(view: MonitorViewEntry): MonitorParameters {
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

/** The daemon and the usage monitor reach the views through ports (PU-5): here, the preload bridge. */
const historyPort: HistoryPort = {
  status: () => window.puppeteer.historyStatus(),
  facts: (ids) => window.puppeteer.historyFacts(ids),
  search: (request) => window.puppeteer.historySearch(request),
};
const usagePort: AccountUsagePort = {
  snapshot: () => window.puppeteer.accountUsage(),
  subscribe: (listener) => window.puppeteer.onAccountUsage(listener),
};

/** The stage before its first measurement: nothing to steer around yet. */
const EMPTY_STAGE: StageGeometry = Object.freeze({
  width: 0,
  height: 0,
  insets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
  obstacles: Object.freeze([]),
});

/** The person's reduced-motion preference, live. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

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
  const [terminalVisualIds, setTerminalVisualIds] = useState<ReadonlyMap<string, string>>(() => new Map());
  const transferBubble = useCallback((previous: string, next: string): void => {
    setTerminalVisualIds((current) => new Map(current).set(next, current.get(previous) ?? previous));
  }, []);
  const [terminalIdentities, setTerminalIdentities] = useState<ReadonlyMap<string, string>>(() => new Map());
  const paneLedgerRef = useRef(EMPTY_PANE_COLOUR_LEDGER);
  const stageRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLElement>(null);
  const unusedPanes = useRef(new UnusedPaneSessions<SessionSummary>());
  const releaseUnusedShell = useCallback((id: string): void => {
    // Main owns PTY disposal from the tab attachment ledger. A renderer
    // terminate races that owner and used to report "unknown session" twice.
    setClosingSessionIds((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);
  const [closingSessionIds, setClosingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const zoom = useDeckZoom(deckRef, workspace?.activePaneId, undefined, active);
  const settings = useWorkspaceSettings(deckRef);
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
  // reads the chrome's rect directly and steers bodies around it. The same
  // measurement is the view host's stage (MV-D19): its size, the chrome's right
  // edge as the left inset, and the chrome's rect as an obstacle.
  const [stageGeometry, setStageGeometry] = useState<StageGeometry>(EMPTY_STAGE);
  useEffect(() => {
    const stage = stageRef.current;
    const chrome = chromeRef.current;
    if (!stage || !chrome) return;
    const publish = (): void => {
      const rect = chrome.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const chromeRight = Math.round(rect.right - stageRect.left);
      stage.style.setProperty('--vf-monitor-chrome-height', `${Math.round(rect.height)}px`);
      stage.style.setProperty('--vf-monitor-chrome-right', `${chromeRight}px`);
      setStageGeometry({
        width: Math.round(stageRect.width),
        height: Math.round(stageRect.height),
        insets: { top: 0, right: 0, bottom: 0, left: chromeRight },
        obstacles: [
          {
            x: Math.round(rect.left - stageRect.left),
            y: Math.round(rect.top - stageRect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        ],
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    observer.observe(stage);
    publish();
    return () => observer.disconnect();
  }, []);
  const reducedMotion = useReducedMotion();
  const monitorTheme = useMemo<MonitorTheme>(
    () => ({ scheme: theme, tokens: palette, reducedMotion, animations: true }),
    [palette, reducedMotion, theme],
  );

  // Each pane owns a colour (record §02, revised 2026-09-12): dealt as panes
  // open, on the wheel parallel to the projects', retired with the pane. The
  // session in a pane wears it while mounted there.
  const paneColors = useMemo(() => {
    paneLedgerRef.current = dealPaneColours(
      paneLedgerRef.current,
      (workspace?.panes ?? []).map((pane) => pane.id),
    );
    return paneColours(paneLedgerRef.current, palette.tint);
  }, [palette.tint, workspace?.panes]);
  const paneAttachments = useMemo(
    () => buildPaneAttachments(workspace?.panes ?? [], workspace?.activePaneId, paneColors),
    [paneColors, workspace?.activePaneId, workspace?.panes],
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
        // Main owns this birth. Record its fresh-shell receipt before the pane
        // publishes, so both the launcher and final-attachment reaper see it.
        transferBubble(handoff.previousSessionId, handoff.session.id);
        recordBornShell(terminalRuntime, handoff.session.id);
        unusedPanes.current.created(handoff.session.id);
        // Replace all current mirrors without focus changes, unzooming or a
        // renderer reload (which previously interrupted every background exit).
        if (workspace?.replaceSession(handoff.previousSessionId, handoff.session)) {
          window.desktop.acknowledgeTerminalSessionHandoff(handoff.handoffId);
        }
      }),
    [workspace],
  );

  const monitor = useMonitorAgents({
    workspace,
    attachments: paneAttachments,
    terminalIdentities,
    terminalVisualIds,
    closingSessionIds,
    onSessionExited,
    palette,
  });
  // The chrome's rows (M19): the inspector, Find, the deck's frames and split sessions read these; the views, the
  // counts and the status shortcuts read the model through the replica.
  const { agents, actions, counts, selectNextStatus, notifications, dismissNotification } = monitor;
  const agentsBySession = useMemo(() => new Map(agents.map((agent) => [agent.session.id, agent] as const)), [agents]);
  // The frame's facts, keyed like the rows (PU-14: the frame is the package's).
  const frameAgentsBySession = useMemo(() => paneFrameAgents(agentsBySession), [agentsBySession]);
  const frameFallbackCwds = useMemo(() => paneFallbackCwds(agentsBySession), [agentsBySession]);
  const activeAgent = agents.find((agent) => agent.active);

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
      const session = await terminalRuntime.createSession({
        executable: platform.defaultShell,
        args: [],
        ...(source.cwd ? { cwd: source.cwd } : {}),
        environment: { mode: 'inherit' },
        cols: source.session.cols,
        rows: source.session.rows,
        persistence: 'terminate-with-app',
        programKind: 'interactive-shell',
      });
      unusedPanes.current.created(session.id);
      return session;
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

  // Only the pane's own colour: the badge and the rest of the frame are the
  // package's (`@vibecook/puppeteer-views` DeckFrames, PU-14), drawn into the
  // pane Ghosttea lays out.
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
  const frameVerbs = useAppPaneFrameVerbs(agentsBySession, mountResumedSession, zoom.toggle);
  const paneSessionUsed = usePaneSessionUsed(agentsBySession);
  const launcherGate = usePaneSessionUsed(agentsBySession, launcherSessionUsed);
  useLayoutEffect(() => {
    if (!workspace) return;
    // Includes Ghosttea's initial empty-workspace birth, outside the split override.
    for (const { session } of workspace.panes) {
      if (terminalRuntime.sessionCreatedHere(session.id)) unusedPanes.current.created(session.id);
    }
    const detached = unusedPanes.current.update(
      workspace.panes.map((pane) => pane.session),
      paneSessionUsed,
      (session) => session.activity.kind === 'foreground-job',
    );
    for (const session of detached) releaseUnusedShell(session.id);
  }, [workspace, paneSessionUsed]);
  useEffect(() => {
    const observe = (event: Event): void => {
      const session = (event as CustomEvent<SessionSummary>).detail;
      const ready = unusedPanes.current.observe(
        session,
        paneSessionUsed(session),
        session.activity.kind === 'foreground-job',
      );
      for (const shell of ready) releaseUnusedShell(shell.id);
    };
    terminalRuntime.addEventListener('session-metadata', observe);
    return () => terminalRuntime.removeEventListener('session-metadata', observe);
  }, [paneSessionUsed]);
  const prepareLauncherReplacement = useCallback(
    (previous: string, next: string): (() => void) => {
      const showing = workspace?.panes.filter((pane) => pane.session.id === previous) ?? [];
      if (showing.length !== 1 || paneSessionUsed(showing[0]!.session)) return () => undefined;
      transferBubble(previous, next);
      return () => setTerminalVisualIds((current) => new Map(current).set(next, next));
    },
    [workspace, paneSessionUsed, transferBubble],
  );
  const onLauncherReplaced = useCallback(
    (previous: string, next: string): void => {
      unusedPanes.current.release(previous);
      transferBubble(previous, next);
      releaseUnusedShell(previous);
    },
    [transferBubble],
  );
  const zoomedPaneId = zoomLayoutApplied(zoom.state.phase) ? zoom.state.paneId : null;
  const paneVisibility = useMemo(
    () =>
      Object.fromEntries(
        (workspace?.panes ?? []).map((pane) => [pane.id, zoomedPaneId === null || pane.id === zoomedPaneId]),
      ),
    [workspace, zoomedPaneId],
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
    '--vf-terminal-safe-top': `${stageParameters[SAFE_AREA_TOP_KEY] ?? 34}px`,
    '--vf-terminal-safe-right': `${stageParameters[SAFE_AREA_RIGHT_KEY] ?? 28}px`,
    '--vf-terminal-safe-bottom': `${stageParameters[SAFE_AREA_BOTTOM_KEY] ?? 30}px`,
    '--vf-terminal-safe-left': `${stageParameters[SAFE_AREA_LEFT_KEY] ?? 30}px`,
    '--vf-scanline-density': `${stageParameters[SCANLINE_DENSITY_KEY] ?? 2}px`,
    '--vf-scanline-opacity': stageParameters[SCANLINE_OPACITY_KEY] ?? 0.4,
    '--vf-vignette-opacity': stageParameters[VIGNETTE_OPACITY_KEY] ?? 1,
  } as CSSProperties;

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
        theme={theme}
        onThemeChange={changeTheme}
        leading={
          <div className="vf-godview-window-controls" aria-hidden="true">
            <i className="is-close" />
            <i className="is-minimize" />
            <i className="is-expand" />
          </div>
        }
        trailing={
          <>
            <BarControl
              mark="find"
              label="FIND"
              shortcut="⌘F"
              ariaLabel="Find an agent by what was said"
              controls="vf-find-sheet"
              on={findOpen}
              onClick={() => setFindOpen((current) => !current)}
            />
            <BarControl
              mark="agents"
              label="AGENTS"
              ariaLabel="Installed agents and accounts"
              controls="vf-agents-drawer"
              on={agentsDrawerOpen}
              onClick={() => setAgentsDrawerOpen((current) => !current)}
            />
            <BarControl
              mark="tune"
              label="SYSTEM CONTROL"
              ariaLabel="System control"
              controls="vf-godview-tweak-panel"
              on={tweakPanelOpen}
              onClick={() => setTweakPanelOpen((current) => !current)}
            />
            {settings ? (
              <BarControl
                mark="settings"
                label="SETTINGS"
                ariaLabel="Open settings"
                haspopup="dialog"
                end
                disabled={!settings.enabled}
                onClick={settings.open}
              />
            ) : null}
          </>
        }
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
        history={historyPort}
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
        {/* One view, drawn from this window's replica (MV-2): list, rain and timeline as themselves (MV-4, MV-6), the
            swarm through the view host's legacy bridge (L6). */}
        <MonitorViewHost
          replica={monitor.replica}
          view={monitor.views.get(view.id)!}
          stage={stageGeometry}
          theme={monitorTheme}
          parameters={parameters}
          commands={monitor.commands}
          scheduler={frameScheduler}
        />
        <div ref={chromeRef} className="vf-monitor-chrome" {...{ [MONITOR_CHROME_ATTRIBUTE]: '' }}>
          <UsageColumn port={usagePort} />
        </div>
        {activeAgent?.agent?.monitor ? (
          <AgentMonitorInspector
            key={activeAgent.agent.monitor.runtimeRunId}
            state={activeAgent.agent.monitor}
            nowMs={Date.now()}
            onAcknowledge={() => monitor.acknowledge(activeAgent.id)}
            {...(activeAgent.agent.account ? { account: activeAgent.agent.account } : {})}
          />
        ) : null}
      </section>

      <section
        ref={deckRef}
        className={`vf-godview-terminal-deck vf-deck-zoom ${DECK_FRAMED_CLASS}`}
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
            onTogglePaneZoom={zoom.toggle}
            paneVisibility={paneVisibility}
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
          agentsBySession={frameAgentsBySession}
          paneColors={paneColors}
          fallbackCwdBySession={frameFallbackCwds}
          verbs={frameVerbs}
          frame={AppPaneFrame}
          zoomedPaneId={zoomedPaneId}
        />
        <AppDeckLaunchers
          deckRef={deckRef}
          workspace={workspace}
          used={paneSessionUsed}
          gate={launcherGate}
          onReplaced={onLauncherReplaced}
          prepareReplacement={prepareLauncherReplacement}
          fallbackCwds={frameFallbackCwds}
          paneColors={paneColors}
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
