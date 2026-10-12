/**
 * Which panes may show the empty pane launcher (QL-D7), from the same facts
 * the deck's unused-shell reaper (`UnusedPaneSessions`) is fed: a shell
 * Ghosttea's runtime created in this window (its birth receipt covers the
 * first pane and every split or new pane; restored, claimed and main-seeded
 * sessions have none) that has not been used. Input, exit, agent or remote
 * ownership consumes the receipt. Shell startup is only temporary activity.
 */

export interface PaneUseSession {
  id: string;
  exited: boolean;
  activity: { kind: string };
  cwd?: string | null | undefined;
}

export interface PaneUseFacts {
  hasInput(sessionId: string): boolean;
  hasAgent(sessionId: string): boolean;
  isRemote(sessionId: string): boolean;
}

/** The launcher's gate: input reached it, it exited, an agent owns it, or it is remote. */
export function launcherSessionUsed(session: PaneUseSession, facts: PaneUseFacts): boolean {
  return facts.hasInput(session.id) || session.exited || facts.hasAgent(session.id) || facts.isRemote(session.id);
}

/** Lifetime use, shared with the launcher. Startup jobs only defer detached cleanup. */
export function paneSessionUsed(session: PaneUseSession, facts: PaneUseFacts): boolean {
  return launcherSessionUsed(session, facts);
}

/** The on-screen shells born here and still unused. */
export function freshSessionIds<Session extends PaneUseSession>(
  panes: readonly { session: Session }[],
  createdHere: (sessionId: string) => boolean,
  used: (session: Session) => boolean,
): Set<string> {
  const fresh = new Set<string>();
  for (const { session } of panes) {
    if (!fresh.has(session.id) && createdHere(session.id) && !used(session)) fresh.add(session.id);
  }
  return fresh;
}

/**
 * A folder as a path. A shell reports its folder by OSC 7 as a `file://host/…`
 * URL, which Ghosttea keeps as the session's cwd; main takes absolute paths
 * only, so a URL passed on would ask "here" of no folder at all.
 */
export function launcherFolderPath(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^file:\/\//iu.test(trimmed)) return trimmed;
  try {
    const path = decodeURIComponent(new URL(trimmed).pathname);
    return path.startsWith('/') ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Where each fresh shell's launch starts: the folder it reported, else the frame's fallback. */
export function launcherCwds(
  fresh: ReadonlySet<string>,
  panes: readonly { session: PaneUseSession }[],
  fallbacks: ReadonlyMap<string, string>,
): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const { session } of panes) {
    if (!fresh.has(session.id) || cwds.has(session.id)) continue;
    const folder = launcherFolderPath(session.cwd) ?? launcherFolderPath(fallbacks.get(session.id));
    if (folder) cwds.set(session.id, folder);
  }
  return cwds;
}

/** Where an accepted launch or resume goes, and whether the launcher ends the shell it replaced itself. */
export interface LauncherReplacePlan {
  /** `mount`: into the fresh shell's pane. `add`: that pane closed during the launch — split the agent in. */
  place: 'mount' | 'add';
  /** The last attachment of an unused shell is an explicit launcher handoff. */
  terminate: boolean;
  /**
   * The session of the pane that was selected when the agent arrived, when
   * that was not the launcher's pane: the person moved on during a slow
   * launch, and placing the agent (which selects its pane) must not take
   * the selection from them. Selected again right after.
   */
  restoreSessionId?: string;
}

export function planLauncherReplace<Session extends PaneUseSession>(
  panes: readonly { id: string; session: Session }[],
  freshSessionId: string,
  used: (session: Session) => boolean,
  activePaneId?: string | undefined,
): LauncherReplacePlan {
  const showing = panes.filter((pane) => pane.session.id === freshSessionId);
  const active = panes.find((pane) => pane.id === activePaneId);
  const restore = active && active.session.id !== freshSessionId ? { restoreSessionId: active.session.id } : {};
  const [first] = showing;
  if (!first) return { place: 'add', terminate: false, ...restore };
  return { place: 'mount', terminate: showing.length === 1 && !used(first.session), ...restore };
}
