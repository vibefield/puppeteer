import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PaneLaunchChrome } from './PaneLaunchChrome.js';
import {
  LAUNCH_DRAIN_MS,
  LAUNCH_HOME_DELAY_MS,
  LAUNCH_HOME_MS,
  LAUNCH_HOP_MS,
  LAUNCH_MARK_SIZE,
  LAUNCH_PATCH_RADIUS,
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

/** The class that lets a launch measure the badge's slot open without animating it (`deck-frame.css`). */
export const PANE_LAUNCH_MEASURE_CLASS = 'vf-pane-launch-measuring';

const ISLAND = 'cubic-bezier(0.25, 1, 0.3, 1)';
const POP = 'cubic-bezier(0.34, 1.45, 0.64, 1)';

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
  /** `performance.now()` at the click, for the caption's seconds. */
  startedAt: number;
  /** The facts so far (`reduceLaunch`). */
  state: LaunchState;
  /** The mark is in the badge, or back in its row: the mounter lets the launch go. */
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

/**
 * Where the badge will wear the mark: its slot measured OPEN, without the slot
 * animating (the measuring class), then closed again for the flight to open
 * it. Undefined when the frame has no mark for this pane yet (a host whose
 * agent facts arrive later): the mark then flies to the badge's leading edge.
 */
function badgeSlot(pane: HTMLElement): { rect: LaunchRect; color: string; found: boolean } | undefined {
  const slot = pane.querySelector<HTMLElement>('.vf-pane-frame .vf-pane-mark');
  if (slot) {
    pane.classList.add(PANE_LAUNCH_MEASURE_CLASS);
    const previous = pane.getAttribute(PANE_LAUNCHING_ATTRIBUTE);
    pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'landing');
    const rect = rectIn(slot, pane);
    const color = getComputedStyle(slot).color;
    if (previous === null) pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
    else pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, previous);
    reflow(pane);
    pane.classList.remove(PANE_LAUNCH_MEASURE_CLASS);
    return { rect, color, found: true };
  }
  const badge = pane.querySelector<HTMLElement>('.vf-pane-frame .vf-pane-badge');
  if (!badge) return undefined;
  const box = rectIn(badge, pane);
  return {
    rect: { x: box.x + 6, y: box.y + box.height / 2 - 5, width: 10, height: 10 },
    color: getComputedStyle(badge).color,
    found: false,
  };
}

/**
 * One launch, portalled into its pane (look C · Cells, pass 4 §30): the mark
 * hops from the clicked row to the middle on the pop spring; the terminal's
 * ground covers the pane and its cell grid wakes around the mark, reaching the
 * corners once the agent runs; on the first frame a last ripple opens the
 * ground from the mark and the mark flies into the badge's slot, which the
 * frame held closed (`data-vf-launching`); on a refusal the grid drains and the
 * mark hops back to its row. Every move is a CSS transition on the named
 * easings (DESIGN.md §6 M3) — timers only sequence them, so a stalled
 * compositor at worst snaps a move to its end.
 */
export function PaneLaunch({
  pane,
  launchId,
  verb,
  providerId,
  label,
  color,
  from,
  startedAt,
  state,
  onSettled,
  reducedMotion,
}: PaneLaunchProps) {
  const reduced = useMemo(() => reducedMotion ?? prefersReducedMotion(), [reducedMotion]);
  const geometry = useMemo(() => {
    const width = pane.clientWidth;
    const height = pane.clientHeight;
    const centre = launchCentre(width, height);
    return { centre, reach: launchReach(width, height, centre) };
  }, [pane]);
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
  const moveMark = (to: LaunchPoint, size: number, ms: number, easing: string, colour?: string): void => {
    const mark = markRef.current;
    if (!mark) return;
    const transform = markTransform(to, size);
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

  // The click's frame (C1): the frame holds its own mark, the ground rises, and
  // the mark, placed exactly on the clicked one, hops to the middle.
  useLayoutEffect(() => {
    pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'held');
    const mark = markRef.current;
    if (mark) {
      mark.style.transition = 'none';
      mark.style.transform = markTransform(centreOf(from), from.width || LAUNCH_MARK_SIZE * 0.6);
      reflow(mark);
      moveMark(geometry.centre, LAUNCH_MARK_SIZE, LAUNCH_HOP_MS, POP);
    }
    setLit(true);
    return () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
      pane.removeAttribute(PANE_LAUNCHING_ATTRIBUTE);
      pane.classList.remove(PANE_LAUNCH_MEASURE_CLASS);
    };
    // Once per launch: the portal is keyed by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The grid follows the facts: a patch while the agent starts, the corners once it runs.
  const waiting = launchWaiting(state.phase);
  useLayoutEffect(() => {
    if (!waiting) return;
    setReach(state.running ? geometry.reach : LAUNCH_PATCH_RADIUS);
  }, [waiting, state.running, geometry.reach]);

  // The ways out: home to the badge, or back to the row.
  useLayoutEffect(() => {
    if (state.phase === 'home') {
      const flyHome = (): void => {
        const slot = badgeSlot(pane);
        if (slot?.found) pane.setAttribute(PANE_LAUNCHING_ATTRIBUTE, 'landing');
        if (slot) moveMark(centreOf(slot.rect), slot.rect.width, LAUNCH_HOME_MS, ISLAND, slot.color);
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
      groundRef.current?.style.setProperty('--vf-launch-hole', `${geometry.reach + 40}px`);
      if (reduced) setLit(false);
      later(LAUNCH_HOME_DELAY_MS, flyHome);
      return;
    }
    if (state.phase === 'refused') {
      const grid = gridRef.current;
      if (grid) grid.style.transition = `--vf-launch-r ${LAUNCH_DRAIN_MS}ms ${ISLAND}`;
      setReach(0);
      later(LAUNCH_DRAIN_MS - 40, () => {
        setLit(false);
        moveMark(centreOf(from), from.width || LAUNCH_MARK_SIZE * 0.6, LAUNCH_RETURN_MS, ISLAND, '');
        later(LAUNCH_RETURN_MS + 20, () => {
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
