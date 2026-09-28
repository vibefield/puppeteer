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
import { firstPaneBirth, freshSessionIds, launcherCwds, paneCountOf } from './launcher-fresh.js';

/** The deck's split / new-pane door, as main.tsx builds it. */
export type SplitSessionFactory = (selected: SessionSummary) => Promise<SessionSummary>;

/** The shells born in this view (QL-D7 a), and the door that records them. */
export interface SessionBirths {
  /** A workspace document was waiting when the window rendered, so its first pane is not a birth. */
  savedAtBoot: boolean;
  /** Session id → the folder it was born in, when the daemon said. */
  born: ReadonlyMap<string, string | undefined>;
  record(sessionId: string, cwd?: string | null): void;
  /** The deck's own door, recording every shell it creates. */
  createSplitSession: SplitSessionFactory;
}

/**
 * Called from the Godview component BEFORE Ghosttea's workspace initializes:
 * the first render is the moment to read whether a saved document is waiting
 * (a restore, a reload, or main's seeded tab), which decides whether the first
 * pane was born here.
 */
export function useSessionBirths(storageKey: string, createSplitSession: SplitSessionFactory): SessionBirths {
  const [savedAtBoot] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== null;
    } catch {
      return false;
    }
  });
  const [born, setBorn] = useState<ReadonlyMap<string, string | undefined>>(() => new Map());
  const record = useCallback((sessionId: string, cwd?: string | null): void => {
    setBorn((current) => (current.has(sessionId) ? current : new Map(current).set(sessionId, cwd ?? undefined)));
  }, []);
  const recordingSplit = useCallback<SplitSessionFactory>(
    async (selected) => {
      const session = await createSplitSession(selected);
      record(session.id, session.cwd);
      return session;
    },
    [createSplitSession, record],
  );
  return useMemo(
    () => ({ savedAtBoot, born, record, createSplitSession: recordingSplit }),
    [born, record, recordingSplit, savedAtBoot],
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

export interface AppDeckLaunchersProps {
  deckRef: RefObject<HTMLElement | null>;
  workspace: GhostteaWorkspaceContext | undefined;
  births: SessionBirths;
  agentsBySession: ReadonlyMap<string, MonitorAgent>;
  /** The frame's fallback folders per session. */
  fallbackCwds: ReadonlyMap<string, string>;
  paneColors: ReadonlyMap<string, string>;
}

/**
 * Godview's empty pane launchers (QL-1): the package's `DeckLaunchers`, fed
 * this window's fresh shells and a port over main's launcher channels. An
 * accepted launch or resume is mounted into the launcher's pane once the
 * launcher has left, and the fresh shell it replaced is terminated — it had
 * no input by construction (QL-D8).
 *
 * Known limits of QL-1. On Linux, Ghosttea's default table binds alt+1…9 to
 * goto_tab and its workspace binding listener, registered first on window
 * capture, consumes with `stopPropagation` only, so ⌥digit can both switch
 * the tab and launch; macOS binds no ⌥digit or ⌥↵ and is unaffected. A tab
 * main opens from a seeded document (a profile tab, `newTerminalTab`) is a
 * restored window by the gate's rule, so its first pane shows no launcher —
 * intended for QL-1.
 */
export function AppDeckLaunchers({
  deckRef,
  workspace,
  births,
  agentsBySession,
  fallbackCwds,
  paneColors,
}: AppDeckLaunchersProps) {
  const runtime = useGhostteaRuntime();
  const panes = workspace?.panes;
  const { record } = births;

  // The workspace's first pane: judged once, on the first workspace with panes.
  const firstJudged = useRef(false);
  useEffect(() => {
    if (firstJudged.current || !panes || panes.length === 0) return;
    firstJudged.current = true;
    const first = firstPaneBirth({ savedAtBoot: births.savedAtBoot, bootAtMs: performance.timeOrigin, panes });
    if (first) record(first, panes[0]!.session.cwd);
  }, [births.savedAtBoot, panes, record]);

  const bornIds = useMemo(() => new Set(births.born.keys()), [births.born]);
  const fresh = useMemo(
    () => freshSessionIds(bornIds, panes ?? [], (sessionId) => agentsBySession.get(sessionId)?.agent !== undefined),
    [agentsBySession, bornIds, panes],
  );
  const cwdBySession = useMemo(() => {
    const bornCwds = new Map<string, string>();
    for (const [id, cwd] of births.born) if (cwd) bornCwds.set(id, cwd);
    return launcherCwds(fresh, panes ?? [], bornCwds, fallbackCwds);
  }, [births.born, fallbackCwds, fresh, panes]);

  const { agents, refresh } = useLauncherAgents(fresh.size > 0);

  // The port is built once: `recent()` refetches whenever its identity changes.
  const latest = useRef({ workspace, agents, refresh, runtime });
  latest.current = { workspace, agents, refresh, runtime };
  const profileByKey = useRef(new Map<string, string>());

  const port = useMemo<LauncherPort>(() => {
    /** Mount `session` where the fresh shell was, after the launcher's leave, and end the shell. */
    const replace = (freshSessionId: string, session: SessionSummary): void => {
      window.setTimeout(() => {
        const { workspace: current, runtime: terminals } = latest.current;
        if (!current) return;
        const shown = paneCountOf(current.panes, freshSessionId);
        if (shown === 0) {
          // The pane closed while the agent started: keep the agent on screen.
          current.addSession(session);
          return;
        }
        // Ghosttea mounts into the ACTIVE pane; activating the shell's pane first targets it.
        current.activateSession(freshSessionId);
        current.mountSession(session);
        if (shown === 1) terminals.terminate(freshSessionId);
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
  }, []);

  return (
    <DeckLaunchers
      deckRef={deckRef}
      panes={panes ?? []}
      activePaneId={workspace?.activePaneId}
      freshSessionIds={fresh}
      cwdBySession={cwdBySession}
      paneColors={paneColors}
      agents={agents}
      port={port}
    />
  );
}
