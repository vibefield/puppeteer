import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PaneLaunchChrome } from './PaneLaunchChrome.js';
import { LAUNCHER_SOURCE_ATTRIBUTE } from './PaneLauncherChrome.js';
import {
  LAUNCH_DRAIN_MS,
  LAUNCH_GONE_MS,
  LAUNCH_HOME_DELAY_MS,
  LAUNCH_HOME_MS,
  LAUNCH_HOP_MS,
  LAUNCH_MARK_SIZE,
  LAUNCH_PATCH_RADIUS,
  LAUNCH_RECENTRE_MS,
  LAUNCH_RETURN_MS,
  launchCaption,
  launchCentre,
  launchReach,
  launchWaiting,
  type LaunchPoint,
  type LaunchRect,
  type LaunchState,
  type LaunchVerb,
} from './launch-model.js';

/** The attribute a launch puts on its pane while its mark is out: `held`, then `landing` (`deck-frame.css`). */
export const PANE_LAUNCHING_ATTRIBUTE = 'data-vf-launching';

/**
 * The class that stills the badge's slot (`deck-frame.css`): the slot opens
 * without animating while a launch measures it, and under reduced motion as
 * the mark lands.
 */
export const PANE_LAUNCH_STILL_CLASS = 'vf-pane-launch-still';

const ISLAND = 'cubic-bezier(0.25, 1, 0.3, 1)';
const POP = 'cubic-bezier(0.34, 1.45, 0.64, 1)';

/** The badge's own mark size when a frame has no mark to measure. */
const BADGE_MARK_SIZE = 10;

export type PaneLaunchOutcome = 'landed' | 'returned';

export interface PaneLaunchProps {
  /** Ghosttea's pane element; the launch is portalled into it and outlives the shell's swap. */
  pane: HTMLElement;
  launchId: string;
  verb: LaunchVerb;
  providerId?: string | undefined;
  label: string;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  /** The clicked mark at the click, in the pane's own pixels. */
  from: LaunchRect;
  /**
   * The row the mark came from (`launchSource`): a refusal hops the mark back
   * to where that row's mark is then, and to `from` when the row is not drawn.
   */
  source?: string | undefined;
  /** `performance.now()` at the click, for the caption's seconds. */
  startedAt: number;
  /** The facts so far (`reduceLaunch`). */
  state: LaunchState;
  /** The mark is in the badge, back in its row, or gone with its agent: the mounter lets the launch go. */
  onSettled(outcome: PaneLaunchOutcome): void;
  /** Reduced motion, when the mounter knows better than the media query (a test, a catalog). */
  reducedMotion?: boolean | undefined;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function centreOf(rect: LaunchRect): LaunchPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The mark's transform for a centre and a size, as one element of `LAUNCH_MARK_SIZE` scaled. */
function markTransform(point: LaunchPoint, size: number): string {
  const half = LAUNCH_MARK_SIZE / 2;
  const scale = Math.max(0.05, size / LAUNCH_MARK_SIZE);
  return `translate(${(point.x - half).toFixed(2)}px, ${(point.y - half).toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

function reflow(element: Element): void {
  element.getBoundingClientRect();
}

/** A box in `pane`'s own pixels. */
function rectIn(element: Element, pane: HTMLElement): LaunchRect {
  const box = element.getBoundingClientRect();
  const origin = pane.getBoundingClientRect();
  return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
}

function paneSize(pane: HTMLElement): { width: number; height: number } {
  return { width: pane.clientWidth, height: pane.clientHeight };
}

/**
 * Where the badge will wear the mark: its slot measured OPEN, without the slot
 * animating (the still class), then closed again for the flight to open it;
 * `size` is the badge mark's em, which the flying mark scales to. Under reduced
 * motion the still class stays on, so the slot opens at once when it lands.
 * Undefined when the frame has no badge; `found: false` when it has no mark for
 * this pane yet (a host whose agent facts arrive later): the mark then flies
 * to the badge's leading edge.
 */
function badgeSlot(
  pane: HTMLElement,
  still: boolean,
): { rect: LaunchRect; size: number; color: string; found: boolean } | undefined {
  const slot = pane.querySelector<HTMLElement>('.vf-pane-frame .vf-pane-mark');
  if (slot) {
    pane.classList.add(PANE_LAUNCH_STILL_CLASS);
    const previous = pane.getAttribute(PANE_LAUNCHING_ATTRIBUTE);
    pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'landing');
    const rect = rectIn(slot, pane);
    const style = getComputedStyle(slot);
    const size = Number.parseFloat(style.fontSize) || rect.width;
    if (previous === null) pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
    else pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, previous);
    reflow(pane);
    if (!still) pane.classList.remove(PANE_LAUNCH_STILL_CLASS);
    return { rect, size, color: style.color, found: true };
  }
  const badge = pane.querySelector<HTMLElement>('.vf-pane-frame .vf-pane-badge');
  if (!badge) return undefined;
  const box = rectIn(badge, pane);
  return {
    rect: {
      x: box.x + 6,
      y: box.y + box.height / 2 - BADGE_MARK_SIZE / 2,
      width: BADGE_MARK_SIZE,
      height: BADGE_MARK_SIZE,
    },
    size: BADGE_MARK_SIZE,
    color: getComputedStyle(badge).color,
    found: false,
  };
}

/** The launcher row's mark where it is now, for a refusal's return; undefined when that row is not drawn. */
function rowMark(pane: HTMLElement, source: string | undefined): LaunchRect | undefined {
  if (source === undefined) return undefined;
  const mark = pane.querySelector<HTMLElement>(`[${LAUNCHER_SOURCE_ATTRIBUTE}="${source}"] .vf-pane-launcher-mark`);
  if (!mark) return undefined;
  const rect = rectIn(mark, pane);
  return rect.width > 0 && rect.height > 0 ? rect : undefined;
}

/**
 * One launch, portalled into its pane (look C · Cells, pass 4 §30): the mark
 * hops from the clicked row to the middle on the pop spring; the terminal's
 * ground covers the pane and its cell grid wakes around the mark, reaching the
 * corners once the agent runs; on the first frame a last ripple opens the
 * ground from the mark and the mark flies into the badge's slot, which the
 * frame held closed (`data-vf-launching`); on a refusal the grid drains and the
 * mark hops back to its row; when the agent's session leaves the pane before
 * it drew, the grid drains and the mark goes out where it is. The geometry
 * follows the pane's size while the launch waits. Every move is a CSS
 * transition on the named easings (DESIGN.md §6 M3) — timers only sequence
 * them, so a stalled compositor at worst snaps a move to its end.
 */
export function PaneLaunch({
  pane,
  launchId,
  verb,
  providerId,
  label,
  color,
  from,
  source,
  startedAt,
  state,
  onSettled,
  reducedMotion,
}: PaneLaunchProps) {
  const reduced = useMemo(() => reducedMotion ?? prefersReducedMotion(), [reducedMotion]);
  const [size, setSize] = useState(() => paneSize(pane));
  const geometry = useMemo(() => {
    const centre = launchCentre(size.width, size.height);
    return { centre, reach: launchReach(size.width, size.height, centre) };
  }, [size.width, size.height]);
  /** Where the mark is drawn at mount; the launch moves it itself from then on. */
  const mountCentre = useRef(geometry.centre);
  /** The middle the mark was last sent to. */
  const markCentre = useRef(geometry.centre);
  const markRef = useRef<HTMLElement | null>(null);
  const groundRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const captionRef = useRef<HTMLSpanElement | null>(null);
  const [lit, setLit] = useState(false);
  const [reach, setReach] = useState(0);
  const timers = useRef<number[]>([]);
  /** The caption as last shown: it keeps its words while it fades out, never flipping back to `starting`. */
  const shownCaption = useRef(launchCaption(verb, 'starting', 0));
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const later = (ms: number, run: () => void): void => {
    timers.current.push(window.setTimeout(run, reduced ? Math.round(ms / 2) : ms));
  };

  /** Move the mark: a transition in full motion, a fade out and in under reduced motion (M6). */
  const moveMark = (to: LaunchPoint, markSize: number, ms: number, easing: string, colour?: string): void => {
    const mark = markRef.current;
    if (!mark) return;
    const transform = markTransform(to, markSize);
    if (reduced) {
      mark.style.transition = 'opacity 60ms ease';
      mark.style.opacity = '0';
      later(60, () => {
        mark.style.transition = 'none';
        mark.style.transform = transform;
        if (colour !== undefined) mark.style.color = colour;
        reflow(mark);
        mark.style.transition = 'opacity 80ms ease';
        mark.style.opacity = '1';
      });
      return;
    }
    mark.style.transition = `transform ${ms}ms ${easing}, color 160ms ease ${Math.max(0, ms - 200)}ms, opacity 120ms ease`;
    mark.style.transform = transform;
    if (colour !== undefined) mark.style.color = colour;
  };

  /** The grid drains into the mark (a refusal, an agent gone); under reduced motion it fades where it is. */
  const drain = (): void => {
    const grid = gridRef.current;
    if (reduced) {
      if (grid) grid.style.opacity = '0';
      return;
    }
    if (grid) grid.style.transition = `--vf-launch-r ${LAUNCH_DRAIN_MS}ms ${ISLAND}`;
    setReach(0);
  };

  // The click's frame (C1): the frame holds its own mark, the ground rises, and
  // the mark, placed exactly on the clicked one, hops to the middle.
  useLayoutEffect(() => {
    pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'held');
    const mark = markRef.current;
    if (mark) {
      mark.style.transition = 'none';
      mark.style.transform = markTransform(centreOf(from), from.width || LAUNCH_MARK_SIZE * 0.6);
      reflow(mark);
      moveMark(markCentre.current, LAUNCH_MARK_SIZE, LAUNCH_HOP_MS, POP);
    }
    setLit(true);
    return () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
      pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
      pane.classList.remove(PANE_LAUNCH_STILL_CLASS);
    };
    // Once per launch: the portal is keyed by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The pane's size, followed while the launch is up (a split, a resized window).
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = paneSize(pane);
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);

  // A mark resting at the middle follows it; one already on its way out keeps going.
  useLayoutEffect(() => {
    const at = markCentre.current;
    if (at.x === geometry.centre.x && at.y === geometry.centre.y) return;
    markCentre.current = geometry.centre;
    if (state.phase === 'depart' || launchWaiting(state.phase)) {
      moveMark(geometry.centre, LAUNCH_MARK_SIZE, LAUNCH_RECENTRE_MS, ISLAND);
    }
    // Only a new middle moves the mark; the phase is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry.centre]);

  // The grid follows the facts: a patch while the agent starts, the corners once it runs.
  const waiting = launchWaiting(state.phase);
  useLayoutEffect(() => {
    if (!waiting) return;
    setReach(state.running ? geometry.reach : LAUNCH_PATCH_RADIUS);
  }, [waiting, state.running, geometry.reach]);

  // The ways out: home to the badge, back to the row, or gone with the agent.
  useLayoutEffect(() => {
    if (state.phase === 'home') {
      const flyHome = (): void => {
        const slot = badgeSlot(pane, reduced);
        if (slot?.found) pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'landing');
        if (slot) moveMark(centreOf(slot.rect), slot.size, LAUNCH_HOME_MS, ISLAND, slot.color);
        const mark = markRef.current;
        if (mark && !slot) {
          // No frame to land in: the mark goes where it is.
          mark.style.transition = 'opacity 160ms ease';
          mark.style.opacity = '0';
        } else if (mark && slot && !slot.found) {
          mark.style.transition += ', opacity 160ms ease 260ms';
          mark.style.opacity = '0';
        }
        later(LAUNCH_HOME_MS + 20, () => {
          pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
          settled.current('landed');
        });
      };
      if (state.fast) {
        // Drawn before the indicator was due (C5): nothing waits, the ground just goes.
        setLit(false);
        flyHome();
        return;
      }
      // The last ripple opens the ground from the mark; under reduced motion it fades (M6).
      if (reduced) setLit(false);
      else groundRef.current?.style.setProperty('--vf-launch-hole', `${geometry.reach + 40}px`);
      later(LAUNCH_HOME_DELAY_MS, flyHome);
      return;
    }
    if (state.phase === 'refused') {
      drain();
      later(LAUNCH_DRAIN_MS - 40, () => {
        setLit(false);
        const row = rowMark(pane, source) ?? from;
        moveMark(centreOf(row), row.width || LAUNCH_MARK_SIZE * 0.6, LAUNCH_RETURN_MS, ISLAND, '');
        later(LAUNCH_RETURN_MS + 20, () => {
          pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
          settled.current('returned');
        });
      });
      return;
    }
    if (state.phase === 'left') {
      // The agent went before it drew (it exited, and the host put a shell
      // back): there is no badge of its own to land in and its row may have
      // moved, so the mark goes out where it is, into the middle.
      drain();
      later(LAUNCH_DRAIN_MS - 40, () => {
        setLit(false);
        const mark = markRef.current;
        if (mark) {
          mark.style.transition = reduced
            ? `opacity ${LAUNCH_GONE_MS}ms ease`
            : `transform ${LAUNCH_GONE_MS}ms ${ISLAND}, opacity ${LAUNCH_GONE_MS}ms ease`;
          if (!reduced) mark.style.transform = markTransform(markCentre.current, LAUNCH_MARK_SIZE / 2);
          mark.style.opacity = '0';
        }
        later(LAUNCH_GONE_MS + 20, () => {
          pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
          settled.current('returned');
        });
      });
    }
    // Each way out runs once, when the phase first reaches it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // The seconds (C4), written straight into the caption: a clock is not a render.
  useEffect(() => {
    if (!waiting) return;
    const tick = (): void => {
      const text = launchCaption(verb, state.phase, performance.now() - startedAt);
      shownCaption.current = text;
      const caption = captionRef.current;
      if (caption && caption.textContent !== text) caption.textContent = text;
    };
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [waiting, verb, state.phase, startedAt]);

  if (waiting) shownCaption.current = launchCaption(verb, state.phase, performance.now() - startedAt);
  return createPortal(
    <PaneLaunchChrome
      launchId={launchId}
      verb={verb}
      {...(providerId ? { providerId } : {})}
      label={label}
      phase={state.phase}
      caption={shownCaption.current}
      {...(color ? { color } : {})}
      centre={geometry.centre}
      markAt={mountCentre.current}
      reach={reach}
      lit={lit}
      waiting={waiting}
      reduced={reduced}
      markRef={markRef}
      groundRef={groundRef}
      gridRef={gridRef}
      captionRef={captionRef}
    />,
    pane,
  );
}
