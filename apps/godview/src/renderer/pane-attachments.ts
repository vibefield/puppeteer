/**
 * Which panes show a session. Panes carry no colour of their own (record §02,
 * P-4): a pane wears the project colour of the agent mounted in it, so the
 * only pane fact a view needs is where a session is mounted.
 */
export interface PaneAttachment {
  /** The pane the session is worked in: the active pane when it shows this session, else its first pane. */
  primaryPaneId: string;
  /** Every pane showing the session, the primary first, the rest in tree order. */
  paneIds: readonly string[];
}

interface MountedPane {
  id: string;
  session: { id: string };
}

export function buildPaneAttachments(
  panes: readonly MountedPane[],
  activePaneId?: string,
): ReadonlyMap<string, PaneAttachment> {
  const panesBySession = new Map<string, string[]>();
  for (const pane of panes) {
    const paneIds = panesBySession.get(pane.session.id) ?? [];
    paneIds.push(pane.id);
    panesBySession.set(pane.session.id, paneIds);
  }

  const result = new Map<string, PaneAttachment>();
  for (const [sessionId, paneIds] of panesBySession) {
    const activeIndex = activePaneId === undefined ? -1 : paneIds.indexOf(activePaneId);
    const primaryPaneId = paneIds[activeIndex >= 0 ? activeIndex : 0]!;
    result.set(sessionId, {
      primaryPaneId,
      paneIds: [primaryPaneId, ...paneIds.filter((paneId) => paneId !== primaryPaneId)],
    });
  }
  return result;
}
