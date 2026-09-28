/**
 * Which panes may show the empty pane launcher (QL-D7), from the same facts
 * the deck's unused-shell reaper (`UnusedPaneSessions`) is fed: a shell
 * Ghosttea's runtime created in this window (its birth receipt covers the
 * first pane and every split or new pane; restored, claimed and main-seeded
 * sessions have none) that has not been used. "Used" is one rule for both:
 * input reached it, it exited, it runs a foreground job, an agent owns it, or
 * it is a remote session.
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

/** The deck's one rule for "this shell has been used", shared by the reaper and the launcher. */
export function paneSessionUsed(session: PaneUseSession, facts: PaneUseFacts): boolean {
  return (
    facts.hasInput(session.id) ||
    session.exited ||
    session.activity.kind === 'foreground-job' ||
    facts.hasAgent(session.id) ||
    facts.isRemote(session.id)
  );
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

/** Where each fresh shell's launch starts: the folder it reported, else the frame's fallback. */
export function launcherCwds(
  fresh: ReadonlySet<string>,
  panes: readonly { session: PaneUseSession }[],
  fallbacks: ReadonlyMap<string, string>,
): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const { session } of panes) {
    if (!fresh.has(session.id) || cwds.has(session.id)) continue;
    const folder = session.cwd || fallbacks.get(session.id);
    if (folder) cwds.set(session.id, folder);
  }
  return cwds;
}
