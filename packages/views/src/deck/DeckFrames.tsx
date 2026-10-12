import { useEffect, useState, type ComponentType, type RefObject } from 'react';
import { GHOSTTEA_PANE_SELECTOR, usePaneElements } from './pane-elements.js';
import { PaneFrame, type PaneFrameVerbs } from './PaneFrame.js';
import type { PaneFrameAgent, PaneFrameSession } from './pane-frame.js';

/** A pane Ghosttea has laid out: its id and the session it shows. */
export interface DeckFramePane {
  id: string;
  session: PaneFrameSession;
}

/** What one frame is handed; a host's own frame component takes the same. */
export interface DeckFrameSlotProps {
  paneId: string;
  /** Ghosttea's pane element for the portal. */
  pane: HTMLElement;
  session: PaneFrameSession;
  agent?: PaneFrameAgent | undefined;
  color?: string | undefined;
  /** The host's remembered folder for the pane's session when its summary has no cwd. */
  fallbackCwd?: string | undefined;
  zoomed: boolean;
  nowMs: number;
  verbs: PaneFrameVerbs;
}

export interface DeckFramesProps {
  deckRef: RefObject<HTMLElement | null>;
  panes: readonly DeckFramePane[];
  /** The agent facts per SESSION id (a pane shows a session). */
  agentsBySession: ReadonlyMap<string, PaneFrameAgent>;
  /** The pane colours per PANE id (a pane owns its colour). */
  paneColors: ReadonlyMap<string, string>;
  /**
   * The folder the host remembers per SESSION id for a shell whose summary
   * carries no cwd yet — the badge's last fallback (the reference host keeps
   * one from the parent pane at a split).
   */
  fallbackCwdBySession?: ReadonlyMap<string, string> | undefined;
  verbs: PaneFrameVerbs;
  /**
   * The frame per pane; `PaneFrame` by default. A host whose facts need hooks
   * (a remote device name from its own lifecycle) supplies a component that
   * renders `PaneFrame` with them.
   */
  frame?: ComponentType<DeckFrameSlotProps> | undefined;
  /** How a pane element is found under the deck; Ghosttea's by default. */
  paneSelector?: string | undefined;
  /**
   * Which pane is zoomed. Absent, the mounter reads Ghosttea's own `is-zoomed`
   * class off the pane elements; a host that owns its zoom (a deck-side morph)
   * says so here instead, and the class is not consulted.
   */
  zoomedPaneId?: string | null | undefined;
}

/**
 * The class `deck-frame.css` scopes its pane rules to. `DeckFrames` sets it on
 * the deck element it reads panes from, but a host should ALSO put it in the
 * deck's static className: the pane padding, the active radius and the line
 * are then present at the first style computation rather than arriving from
 * an effect (a pane already laid out would animate its padding when the class
 * lands — `transition: padding` is in the stylesheet).
 */
export const DECK_FRAMED_CLASS = 'vf-deck-framed';
export { GHOSTTEA_PANE_SELECTOR };

function DefaultFrame({ paneId: _paneId, ...props }: DeckFrameSlotProps) {
  return <PaneFrame {...props} />;
}

/**
 * One frame per pane Ghosttea has laid out. Ghosttea owns the pane elements;
 * this finds them under the deck and follows their coming, going and zooming
 * through a mutation observer, so the workspace never has to know about the
 * chrome drawn around its terminals. It also marks the deck `vf-deck-framed`,
 * which is what the frame stylesheet's pane rules key on.
 */
export function DeckFrames({
  deckRef,
  panes,
  agentsBySession,
  paneColors,
  fallbackCwdBySession,
  verbs,
  frame: Frame = DefaultFrame,
  paneSelector = GHOSTTEA_PANE_SELECTOR,
  zoomedPaneId,
}: DeckFramesProps) {
  // The class rides the same effect as the observer, so a deck element that
  // is replaced behind a stable ref is re-marked whenever the panes change —
  // and a host that puts the class in its static className loses nothing.
  const elements = usePaneElements(deckRef, paneSelector, panes, DECK_FRAMED_CLASS);
  const [nowMs, setNowMs] = useState(() => Date.now());

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
        const fallbackCwd = fallbackCwdBySession?.get(pane.session.id);
        return (
          <Frame
            key={pane.id}
            paneId={pane.id}
            pane={element}
            session={pane.session}
            {...(agent ? { agent } : {})}
            {...(color ? { color } : {})}
            {...(fallbackCwd ? { fallbackCwd } : {})}
            zoomed={(zoomedPaneId === undefined ? elements.zoomedPaneId : (zoomedPaneId ?? undefined)) === pane.id}
            nowMs={nowMs}
            verbs={verbs}
          />
        );
      })}
    </>
  );
}
