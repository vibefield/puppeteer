import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { useGhostteaRuntime } from '@vibecook/ghosttea-react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import {
  DeckLaunchers,
  LAUNCHER_LEAVE_MS,
  type LauncherOutcome,
  type LauncherPort,
} from '@vibecook/puppeteer-views/launcher';
import type { CreateAgentSessionResult, LauncherAgentRow } from '../../protocol.js';
import type { MonitorAgent } from '../monitor/types.js';
import {
  freshSessionIds,
  launcherCwds,
  paneSessionUsed,
  planLauncherReplace,
  type PaneUseFacts,
  type PaneUseSession,
} from './launcher-fresh.js';

/** "Has this pane's shell been used?" — the reaper's rule (`paneSessionUsed`) or the launcher's gate (`launcherSessionUsed`). */
export type PaneSessionUsed = (session: SessionSummary) => boolean;

/** A "used" rule over this window's runtime and its agents; the reaper's by default. */
export function usePaneSessionUsed(
  agentsBySession: ReadonlyMap<string, MonitorAgent>,
  rule: (session: PaneUseSession, facts: PaneUseFacts) => boolean = paneSessionUsed,
): PaneSessionUsed {
  const runtime = useGhostteaRuntime();
  return useCallback<PaneSessionUsed>(
    (session) =>
      rule(session, {
        hasInput: (id) => runtime.sessionHasInput(id),
        hasAgent: (id) => agentsBySession.get(id)?.agent !== undefined,
        isRemote: (id) => runtime.remoteSession(id) !== undefined,
      }),
    [agentsBySession, rule, runtime],
  );
}

/** The launcher's agent rows, asked for while a launcher could show and again whenever they may have changed. */
function useLauncherAgents(wanted: boolean): { agents: readonly LauncherAgentRow[]; refresh(): void } {
  const [agents, setAgents] = useState<readonly LauncherAgentRow[]>([]);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback((): void => setGeneration((current) => current + 1), []);

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void window.puppeteer.launcherAgents().then(
      (rows) => {
        if (alive) setAgents(rows);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [generation, wanted]);

  // A default profile set in the drawer, or an agent installed from a terminal
  // while the window was away, changes a row.
  useEffect(() => window.puppeteer.onProfiles(refresh), [refresh]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return { agents, refresh };
}

function outcomeOf(result: CreateAgentSessionResult): { session: SessionSummary } | { reason: string } {
  return 'error' in result ? { reason: result.error.message } : { session: result.session };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A selected pane takes the keyboard into its terminal a frame later. When
 * the keyboard was in the host's own chrome (outside every pane) as an agent
 * arrived, it goes back there once that has happened.
 */
function keepHostFocus(focused: Element | null): void {
  if (!(focused instanceof HTMLElement) || focused === document.body || focused.closest('[data-pane-id]')) return;
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      if (focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }),
  );
}

export interface AppDeckLaunchersProps {
  deckRef: RefObject<HTMLElement | null>;
  workspace: GhostteaWorkspaceContext | undefined;
  /** The rule the deck's unused-shell reaper applies (`paneSessionUsed`). */
  used: PaneSessionUsed;
  /** The launcher's gate (`launcherSessionUsed`): the reaper's rule less a foreground job. */
  gate: PaneSessionUsed;
  /** Whether the reaper still holds the shell's birth receipt (`UnusedPaneSessions.holds`). */
  reaperHolds?: ((sessionId: string) => boolean) | undefined;
  /** The frame's fallback folders per session. */
  fallbackCwds: ReadonlyMap<string, string>;
  paneColors: ReadonlyMap<string, string>;
}

/**
 * Godview's empty pane launchers (QL-1): the package's `DeckLaunchers`, fed
 * this window's fresh shells and a port over main's launcher channels. An
 * accepted launch or resume is mounted into the launcher's pane once the
 * launcher has left (QL-D8). The shell it replaced is then detached and born
 * here; while it is unused by the reaper's own rule (keys and pastes are held
 * during a launch) the deck's `UnusedPaneSessions` reaper terminates it like
 * any other unused shell. One that was used anyway — a binding's or a menu's
 * paste, a foreground job, an exit — or whose receipt the reaper gave up
 * earlier (it saw the shell's startup run a foreground job) the reaper keeps,
 * so the launcher ends it itself, unless another pane still shows it
 * (`planLauncherReplace`). The launcher's own gate ignores foreground jobs
 * (`launcherSessionUsed`), so a shell's startup does not flicker it away.
 *
 * Known limits of QL-1. On Linux, Ghosttea's default table binds alt+1…9 to
 * goto_tab and its workspace binding listener, registered first on window
 * capture, consumes with `stopPropagation` only, so ⌥digit can both switch
 * the tab and launch; macOS binds no ⌥digit or ⌥↵ and is unaffected. A tab
 * main opens from a seeded document (a profile tab, `newTerminalTab`) mounts a
 * shell main created, which carries no birth receipt of this window's
 * runtime, so its first pane shows no launcher — intended for QL-1.
 */
export function AppDeckLaunchers({
  deckRef,
  workspace,
  used,
  gate,
  reaperHolds,
  fallbackCwds,
  paneColors,
}: AppDeckLaunchersProps) {
  const runtime = useGhostteaRuntime();
  const panes = useMemo(() => workspace?.panes ?? [], [workspace?.panes]);

  // Ghosttea's birth receipt covers the first pane and every split; restored,
  // claimed and main-seeded shells have none.
  const fresh = useMemo(
    () => freshSessionIds(panes, (id) => runtime.sessionCreatedHere(id), gate),
    [panes, runtime, gate],
  );
  const cwdBySession = useMemo(() => launcherCwds(fresh, panes, fallbackCwds), [fallbackCwds, fresh, panes]);
  const hasInput = useCallback((sessionId: string): boolean => runtime.sessionHasInput(sessionId), [runtime]);

  const { agents, refresh } = useLauncherAgents(fresh.size > 0);

  // The port is built once: `recent()` refetches whenever its identity changes.
  const latest = useRef({ workspace, agents, refresh, used, reaperHolds });
  latest.current = { workspace, agents, refresh, used, reaperHolds };
  const profileByKey = useRef(new Map<string, string>());

  const port = useMemo<LauncherPort>(() => {
    /**
     * Mount `session` where the fresh shell was, after the launcher's leave;
     * the shell is ended (above). A Godview tab is its own window and
     * renderer, so the workspace here is always the one the launch started
     * in: a tab switch during a launch cannot aim the mount at another tab.
     */
    const replace = (freshSessionId: string, session: SessionSummary): void => {
      window.setTimeout(() => {
        const current = latest.current.workspace;
        if (!current) return;
        const plan = planLauncherReplace(
          current.panes,
          freshSessionId,
          latest.current.used,
          current.activePaneId,
          latest.current.reaperHolds,
        );
        const focused = document.activeElement;
        if (plan.place === 'add') {
          // The pane closed while the agent started: keep the agent on screen.
          current.addSession(session);
        } else {
          // Ghosttea mounts into the ACTIVE pane; activating the shell's pane first targets it.
          current.activateSession(freshSessionId);
          current.mountSession(session);
          if (plan.terminate) runtime.terminate(freshSessionId);
        }
        // Placing the agent selected its pane; the person had moved on during the launch.
        if (plan.restoreSessionId) current.activateSession(plan.restoreSessionId);
        keepHostFocus(focused);
      }, LAUNCHER_LEAVE_MS);
    };
    const settle = (freshSessionId: string, result: CreateAgentSessionResult): LauncherOutcome => {
      const outcome = outcomeOf(result);
      if ('reason' in outcome) return { accepted: false, reason: outcome.reason };
      replace(freshSessionId, outcome.session);
      latest.current.refresh();
      return { accepted: true };
    };
    return {
      recent: async (request) => {
        const answer = await window.puppeteer.launcherRecent(request);
        for (const session of answer.sessions) {
          if (session.profileId) profileByKey.current.set(session.key, session.profileId);
        }
        return answer;
      },
      words: (request) => window.puppeteer.launcherWords(request),
      launch: async ({ sessionId, providerId, cwd }) => {
        const profile = latest.current.agents.find((agent) => agent.providerId === providerId)?.profileId;
        try {
          const result = await window.puppeteer.createAgentSession({
            agent: providerId,
            ...(cwd ? { cwd } : {}),
            ...(profile ? { profile } : {}),
          });
          return settle(sessionId, result);
        } catch (error) {
          return { accepted: false, reason: reasonOf(error) };
        }
      },
      resume: async ({ sessionId, session, cwd }) => {
        if (!session.providerId || !session.nativeSessionId) return { accepted: false, reason: "can't resume" };
        const profileId = profileByKey.current.get(session.key);
        const folder = session.cwd ?? cwd;
        try {
          const result = await window.puppeteer.resumeNativeSession({
            providerId: session.providerId,
            nativeSessionId: session.nativeSessionId,
            ...(folder ? { cwd: folder } : {}),
            ...(profileId ? { profileId } : {}),
          });
          return settle(sessionId, result);
        } catch (error) {
          return { accepted: false, reason: reasonOf(error) };
        }
      },
    };
  }, [runtime]);

  // Ghosttea's workspace selects by session; a fresh shell shows in one pane.
  const activatePane = useCallback((paneId: string): void => {
    const current = latest.current.workspace;
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    if (pane && current?.activePaneId !== paneId) current?.activateSession(pane.session.id);
  }, []);

  return (
    <DeckLaunchers
      deckRef={deckRef}
      panes={panes}
      activePaneId={workspace?.activePaneId}
      onActivatePane={activatePane}
      freshSessionIds={fresh}
      cwdBySession={cwdBySession}
      paneColors={paneColors}
      agents={agents}
      port={port}
      hasInput={hasInput}
    />
  );
}
