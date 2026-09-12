/**
 * Which panes show a session, and the colour of the one it is worked in. A
 * pane owns its colour (record §02, revised 2026-09-12, `pane-colours.ts`);
 * the session wears it while mounted there, as the band and, in the selected
 * pane, the light. The project's colour stays the session's own mark.
 */
export interface PaneAttachment {
  /** The pane the session is worked in: the active pane when it shows this session, else its first pane. */
  primaryPaneId: string;
  /** Every pane showing the session, the primary first, the rest in tree order. */
  paneIds: readonly string[];
  /** The primary pane's colour; absent only for a pane no colour has been dealt to. */
  color?: string;
}

interface MountedPane {
  id: string;
  session: { id: string };
}

export function buildPaneAttachments(
  panes: readonly MountedPane[],
  activePaneId?: string,
  colours?: ReadonlyMap<string, string>,
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
    const color = colours?.get(primaryPaneId);
    result.set(sessionId, {
      primaryPaneId,
      paneIds: [primaryPaneId, ...paneIds.filter((paneId) => paneId !== primaryPaneId)],
      ...(color ? { color } : {}),
    });
  }
  return result;
}
