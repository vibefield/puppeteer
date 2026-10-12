import type { PaneAttachment } from '@vibefield/puppeteer-views';

export type { PaneAttachment };

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
