/**
 * Which panes may show the empty pane launcher (QL-D7 a–c), decided from
 * facts this window holds. A shell qualifies when it was BORN IN THIS VIEW —
 * through the deck's own split / new-pane door, or as the workspace's first
 * pane when the window opened on no saved document — has no agent facet, and
 * has not exited. A restored, claimed or handed-off session never qualifies:
 * every restored window opens on a saved document, and a claimed session
 * existed before the window did. (d), no input yet, is the launcher's own.
 */

export interface FreshPaneSession {
  id: string;
  exited: boolean;
  createdAtMs: number;
  cwd?: string | null | undefined;
}

export interface FreshPane {
  id: string;
  session: FreshPaneSession;
}

export interface FirstPaneFacts {
  /** A workspace document was waiting when the window rendered: restored, reloaded or seeded by main. */
  savedAtBoot: boolean;
  /** When this window's document began (`performance.timeOrigin`). */
  bootAtMs: number;
  /** The panes of the first workspace this window reported. */
  panes: readonly FreshPane[];
}

/**
 * The workspace's first pane, when Ghosttea created it for this window: no
 * saved document, one pane, and a session younger than the window (a claimed
 * session is older). Undefined otherwise.
 */
export function firstPaneBirth(facts: FirstPaneFacts): string | undefined {
  if (facts.savedAtBoot || facts.panes.length !== 1) return undefined;
  const session = facts.panes[0]!.session;
  return session.createdAtMs >= facts.bootAtMs ? session.id : undefined;
}

/** The shells born here that are still on screen, still running, and still no agent's. */
export function freshSessionIds(
  born: ReadonlySet<string>,
  panes: readonly FreshPane[],
  hasAgent: (sessionId: string) => boolean,
): Set<string> {
  const fresh = new Set<string>();
  for (const pane of panes) {
    const { id, exited } = pane.session;
    if (born.has(id) && !exited && !hasAgent(id)) fresh.add(id);
  }
  return fresh;
}

/**
 * Where each fresh shell's launch starts: the folder the shell last reported,
 * else the folder it was born in, else the frame's fallback for the session.
 */
export function launcherCwds(
  fresh: ReadonlySet<string>,
  panes: readonly FreshPane[],
  bornCwds: ReadonlyMap<string, string>,
  fallbacks: ReadonlyMap<string, string>,
): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const pane of panes) {
    const { id, cwd } = pane.session;
    if (!fresh.has(id) || cwds.has(id)) continue;
    const folder = cwd || bornCwds.get(id) || fallbacks.get(id);
    if (folder) cwds.set(id, folder);
  }
  return cwds;
}

/** How many panes show a session: a replaced shell is closed only when no other pane still shows it. */
export function paneCountOf(panes: readonly FreshPane[], sessionId: string): number {
  return panes.filter((pane) => pane.session.id === sessionId).length;
}
