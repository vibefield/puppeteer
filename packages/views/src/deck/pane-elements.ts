import { useEffect, useState, type RefObject } from 'react';

/**
 * Where Ghosttea's pane elements are under a deck, for anything the views draw
 * INTO a pane (the frame, the empty pane's launcher). Ghosttea owns the pane
 * elements; this finds them and follows their coming, going and zooming
 * through a mutation observer, so the workspace never has to know what is
 * portalled into its panes.
 */

export const GHOSTTEA_PANE_SELECTOR = '.ghostty-pane[data-pane-id]';

export interface PaneElements {
  byId: ReadonlyMap<string, HTMLElement>;
  zoomedPaneId?: string;
}

export function readPaneElements(deck: HTMLElement, selector: string): PaneElements {
  const byId = new Map<string, HTMLElement>();
  let zoomedPaneId: string | undefined;
  for (const element of deck.querySelectorAll<HTMLElement>(selector)) {
    const paneId = element.dataset.paneId;
    if (!paneId) continue;
    byId.set(paneId, element);
    if (element.classList.contains('is-zoomed')) zoomedPaneId = paneId;
  }
  return { byId, ...(zoomedPaneId ? { zoomedPaneId } : {}) };
}

export function samePaneElements(left: PaneElements, right: PaneElements): boolean {
  if (left.zoomedPaneId !== right.zoomedPaneId || left.byId.size !== right.byId.size) return false;
  for (const [paneId, element] of left.byId) {
    if (right.byId.get(paneId) !== element) return false;
  }
  return true;
}

/**
 * The pane elements under `deckRef`, refreshed whenever the deck's subtree or
 * a class in it changes, and whenever `refreshKey` changes (a host's pane list:
 * a deck element replaced behind a stable ref is found again). `deckClass`, when
 * given, is put on the deck for as long as the hook is mounted, in the same
 * effect — and taken off again only if this hook was the one to add it.
 */
export function usePaneElements(
  deckRef: RefObject<HTMLElement | null>,
  paneSelector: string,
  refreshKey: unknown,
  deckClass?: string,
): PaneElements {
  const [elements, setElements] = useState<PaneElements>({ byId: new Map() });

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const marked = deckClass !== undefined && !deck.classList.contains(deckClass);
    if (marked) deck.classList.add(deckClass);
    let pending: number | undefined;
    const sync = (): void => {
      pending = undefined;
      const next = readPaneElements(deck, paneSelector);
      setElements((current) => (samePaneElements(current, next) ? current : next));
    };
    // A timer rather than an animation frame: an occluded window paints no
    // frames, and a pane zoomed while hidden should still be found on return.
    const schedule = (): void => {
      if (pending === undefined) pending = window.setTimeout(sync, 0);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(deck, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
    return () => {
      observer.disconnect();
      if (pending !== undefined) window.clearTimeout(pending);
      if (marked) deck.classList.remove(deckClass);
    };
  }, [deckRef, refreshKey, paneSelector, deckClass]);

  return elements;
}
