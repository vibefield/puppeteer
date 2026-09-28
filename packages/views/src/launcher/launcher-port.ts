/*
 * The empty pane launcher's port (QL-1): what a fresh shell pane asks its host
 * so it can offer to resume a past session or launch an agent in its place.
 * The launcher dials nothing and names no vendor: a provider id is an opaque
 * string it only hands back. Godview's port is its main process over IPC;
 * VibeField's is fieldd's doors (`index.recent`, `agent.spawn`, `agent.resume`).
 *
 * Optional fields also accept `undefined`, so a host building a row from its
 * own optional facts need not spread them in one by one.
 */

/** One row of the host's agent catalog, in the host's own words. */
export interface LauncherAgent {
  providerId: string;
  label: string;
  /** Epoch ms of this agent's last launch; the launcher lists the newest first. */
  lastLaunchedAt?: number | undefined;
  /** Why it cannot launch, in the host's words: "not installed", "hooks off". */
  unavailable?: string | undefined;
  /** What a launch would run, for the preview line: `label · profile`. */
  preview?: string | undefined;
}

export type LauncherReadiness = 'ready' | 'building' | 'catching-up' | 'stale' | 'failed' | 'unreachable';

export interface LauncherHistoryStatus {
  readiness: LauncherReadiness;
  progress?: { done: number; total: number } | undefined;
  /** One sentence from the history service when something is off. */
  detail?: string | undefined;
}

/** A past session the history service knows. */
export interface LauncherSession {
  /** Stable within one answer; the list's React key and the words lane's join key. */
  key: string;
  providerId?: string | undefined;
  nativeSessionId?: string | undefined;
  title: string;
  cwd?: string | undefined;
  /** In the pane's own project (QL-D9), as the host decided it. */
  here: boolean;
  /** Epoch ms of the session's last activity. */
  lastAt?: number | undefined;
  branch?: string | undefined;
  model?: string | undefined;
  resumable: boolean;
  /** Why ↵ is withheld: "folder is gone", "can't resume". */
  unresumable?: string | undefined;
}

export interface LauncherRecentRequest {
  cwd?: string | undefined;
  scope: 'here' | 'all';
  limit?: number | undefined;
}

export interface LauncherRecentResponse {
  status: LauncherHistoryStatus;
  sessions: LauncherSession[];
}

export interface LauncherWordsRequest {
  query: string;
  cwd?: string | undefined;
  scope: 'here' | 'all';
  limit?: number | undefined;
}

/** One transcript line the history service matched. */
export interface LauncherWordHit {
  nativeSessionId?: string | undefined;
  sessionKey?: string | undefined;
  /** `user` or `agent`; anything else is shown as itself. */
  kind: string;
  /** Matches are marked with `[` and `]`. */
  snippet: string;
}

export type LauncherOutcome = { accepted: true } | { accepted: false; reason: string };

export interface LauncherPort {
  /** The pane folder's latest sessions (`here`), or every folder's (`all`). */
  recent(req: LauncherRecentRequest): Promise<LauncherRecentResponse>;
  /** The words lane; a host without transcript search leaves it out. */
  words?(req: LauncherWordsRequest): Promise<{ answered: boolean; hits: LauncherWordHit[] }>;
  /** Launch an agent into this pane, replacing its fresh shell (QL-D8). */
  launch(req: { paneId: string; sessionId: string; providerId: string; cwd?: string }): Promise<LauncherOutcome>;
  /** Resume a past session into this pane, replacing its fresh shell (QL-D10). */
  resume(req: { paneId: string; sessionId: string; session: LauncherSession; cwd?: string }): Promise<LauncherOutcome>;
}
