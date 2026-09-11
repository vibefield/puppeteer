import { useEffect, useState, type RefObject } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { GhostteaWorkspacePane } from '@vibecook/ghosttea-react/workspace';
import type { MonitorAgent } from '../monitor/types.js';
import { PaneFrame } from './PaneFrame.js';

export interface DeckFramesProps {
  deckRef: RefObject<HTMLElement | null>;
  panes: readonly GhostteaWorkspacePane[];
  agentsBySession: ReadonlyMap<string, MonitorAgent>;
  paneColors: ReadonlyMap<string, string>;
  onResume(session: SessionSummary): void;
}

interface PaneElements {
  byId: ReadonlyMap<string, HTMLElement>;
  zoomedPaneId?: string;
}

const PANE_SELECTOR = '.ghostty-pane[data-pane-id]';

function readPaneElements(deck: HTMLElement): PaneElements {
  const byId = new Map<string, HTMLElement>();
  let zoomedPaneId: string | undefined;
  for (const element of deck.querySelectorAll<HTMLElement>(PANE_SELECTOR)) {
    const paneId = element.dataset.paneId;
    if (!paneId) continue;
    byId.set(paneId, element);
    if (element.classList.contains('is-zoomed')) zoomedPaneId = paneId;
  }
  return { byId, ...(zoomedPaneId ? { zoomedPaneId } : {}) };
}

function samePaneElements(left: PaneElements, right: PaneElements): boolean {
  if (left.zoomedPaneId !== right.zoomedPaneId || left.byId.size !== right.byId.size) return false;
  for (const [paneId, element] of left.byId) {
    if (right.byId.get(paneId) !== element) return false;
  }
  return true;
}

/**
 * One frame per pane Ghosttea has laid out. Ghosttea owns the pane elements;
 * this finds them under the deck and follows their coming, going and zooming
 * through a mutation observer, so the workspace never has to know about the
 * chrome drawn around its terminals.
 */
export function DeckFrames({ deckRef, panes, agentsBySession, paneColors, onResume }: DeckFramesProps) {
  const [elements, setElements] = useState<PaneElements>({ byId: new Map() });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    let pending: number | undefined;
    const sync = (): void => {
      pending = undefined;
      const next = readPaneElements(deck);
      setElements((current) => (samePaneElements(current, next) ? current : next));
    };
    // A timer rather than an animation frame: an occluded window paints no
    // frames, and a pane zoomed while hidden should still be framed on return.
    const schedule = (): void => {
      if (pending === undefined) pending = window.setTimeout(sync, 0);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(deck, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
    return () => {
      observer.disconnect();
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, [deckRef, panes]);

  // The stop verb carries the turn's time, so the clock ticks while a mounted agent works.
  const working = panes.some((pane) => agentsBySession.get(pane.session.id)?.status === 'working');
  useEffect(() => {
    if (!working) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working]);

  return (
    <>
      {panes.map((pane) => {
        const element = elements.byId.get(pane.id);
        if (!element) return null;
        const agent = agentsBySession.get(pane.session.id);
        const color = paneColors.get(pane.id);
        return (
          <PaneFrame
            key={pane.id}
            pane={element}
            session={pane.session}
            {...(agent ? { agent } : {})}
            {...(color ? { color } : {})}
            zoomed={elements.zoomedPaneId === pane.id}
            nowMs={nowMs}
            onResume={onResume}
          />
        );
      })}
    </>
  );
}
