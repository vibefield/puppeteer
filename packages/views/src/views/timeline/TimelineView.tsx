import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import type { ReactMonitorViewProps } from '@vibecook/puppeteer-view-sdk/react';
import {
  canvasRatio,
  createMotionLoop,
  formatClock,
  formatWords,
  keyLegend,
  projectName,
  sizeCanvas,
  type MotionLoop,
} from '@vibecook/puppeteer-view-sdk/toolkit';
import { pulseMap, pulseRowsFor, PULSE_GEOMETRY } from './pulse-map.js';
import { css, resolveTimelineInks, type TimelineInks } from './timeline-inks.js';
import {
  dayStart,
  earliestHead,
  laneContentKey,
  stateAt,
  stepLight,
  timelineLanes,
  type TimelineLaneSet,
} from './timeline-lanes.js';
import { paintPulse, paintWakes, type PlacedLane } from './timeline-paint.js';
import { normalizeTimelineParameters } from './timeline-parameters.js';
import {
  clampSpan,
  followNow,
  glideTween,
  headAt,
  initialScale,
  panBy,
  tickStep,
  ticksBetween,
  tweenAt,
  settledScale,
  tweenBetween,
  zoomAt,
  ZOOM_PRESETS,
  type ScaleTween,
  type TimelineScale,
} from './timeline-scale.js';
import { laneLabel, laneSubLine, readoutAt } from './timeline-words.js';

// The timeline — Godview's swarm through time (DESIGN §8; TL, design F
// "Wakes" with its map of the day, `draft/godview-timeline/`). Each lane is
// one wake painted into a canvas, the swarm's bodies sit at the head, and the
// map above is a scrubber over the whole day.
//
// An SDK view (MV-6): it reads its input alone (the model's rows, the theme,
// the stage, its parameters) and calls `commands.select`. Runtime only: each
// lane is its row's birth and its current state (`timeline-lanes.ts`), and the
// view remembers nothing a row did.
//
// React lays the lanes out (names, heads, the offscreen buttons); everything
// that moves with time — the wakes, the map, the ticks, the clock chip and the
// readouts — is drawn by one draw that repaints only what changed. With motion
// it runs every frame (the toolkit's loop); still (animations off, or motion
// reduced) no frame loop runs (MV-W4): the clock is information, so the view
// draws once a second on a timer, and once when anything changes.

const MAP_STRIP = 46;
const AXIS = 22;
const TERMINAL_LANE = 18;
const DIVIDER = 20;
const MAP_LEFT = 14;
const LANE_MIN = 24;
const MINUTE = 60_000;

interface Columns {
  width: number;
  /** The floating names' width, over the wakes' far end. */
  names: number;
  /** The head column: bodies and readouts. */
  head: number;
  /** The head line: where the wakes end. */
  x1: number;
  narrow: boolean;
}

function columnsFor(width: number): Columns {
  const names = width >= 900 ? 196 : width >= 640 ? 166 : 116;
  const head = width >= 900 ? 170 : width >= 640 ? 148 : 104;
  return { width, names, head, x1: Math.max(1, width - head), narrow: width < 640 };
}

interface Layout {
  placed: PlacedLane[];
  /** Where the terminals' group starts, when there is one. */
  divider?: number | undefined;
  height: number;
}

function layoutLanes(set: TimelineLaneSet, bodyHeight: number, laneMax: number): Layout {
  const count = set.agents.length;
  const terminals = set.terminals.length;
  const block = terminals ? terminals * TERMINAL_LANE + DIVIDER : 0;
  const room = Math.floor((bodyHeight - 6 - block) / Math.max(1, count));
  const h = Math.min(laneMax, Math.max(LANE_MIN, room));
  const placed: PlacedLane[] = [];
  let y = 2;
  for (const lane of set.agents) {
    placed.push({ lane, y, h });
    y += h;
  }
  let divider: number | undefined;
  if (terminals) {
    divider = y;
    y += DIVIDER;
    for (const lane of set.terminals) {
      placed.push({ lane, y, h: TERMINAL_LANE });
      y += TERMINAL_LANE;
    }
  }
  return { placed, divider, height: y + 4 };
}

/** Whether the element has the keyboard's focus ring (a click's focus does not). */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

function dayLabel(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }).toUpperCase();
}

const set = (element: HTMLElement | null, key: string, value: string): void => {
  if (element && element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
};

function FolderMark({ terminal }: { terminal: boolean }) {
  return (
    <svg className="vf-monitor-timeline-mark" viewBox="0 0 24 24" aria-hidden="true">
      {terminal ? (
        <path d="M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3ZM7 9.5l3 2.5-3 2.5M12 15h4.5" />
      ) : (
        <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      )}
    </svg>
  );
}

/** A peer's lane: a desktop's line mark, its name in the title (the row carries no OS to draw by yet). */
function PeerMark({ name }: { name: string }) {
  return (
    <svg className="vf-monitor-timeline-mark is-peer" viewBox="0 0 24 24" role="img" aria-label={`on ${name}`}>
      <title>{name}</title>
      <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5ZM9 20.5h6M12 17v3.5" />
    </svg>
  );
}

/**
 * The key that brings the head back to now. The manifest declares it, the map hears it, and the now button, which does
 * the same, prints its legend under the mark (M177 ruling 4).
 */
export const NOW_KEY = 'End';

function NowMark() {
  return (
    <svg className="vf-monitor-timeline-now-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h10.5M11 8.5l3.5 3.5-3.5 3.5M19.5 4.5v15" />
    </svg>
  );
}

export function TimelineView({ input, commands }: ReactMonitorViewProps): ReactElement {
  const { model, parameters, theme, stage } = input;
  const rows = model.agents;
  const settings = useMemo(() => normalizeTimelineParameters(parameters), [parameters]);
  // The host's animations switch and the person's reduced-motion preference: either one stills the view.
  const motion = theme.animations && !theme.reducedMotion;
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const wakeRef = useRef<HTMLCanvasElement>(null);
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const dimLeftRef = useRef<HTMLElement>(null);
  const dimRightRef = useRef<HTMLElement>(null);
  const knobRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const sinceRef = useRef<HTMLSpanElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const focusRingRef = useRef<HTMLDivElement>(null);
  const headEls = useRef<(HTMLDivElement | null)[]>([]);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bar, setBar] = useState<{ spanMs: number; live: boolean }>({ spanMs: initialScale(0).spanMs, live: true });

  const laneSet = useMemo(() => timelineLanes(rows, Date.now()), [rows]);
  const columns = columnsFor(size.width);
  const bodyHeight = Math.max(0, size.height - MAP_STRIP - AXIS);
  const layout = useMemo(
    () => layoutLanes(laneSet, bodyHeight, settings.laneMax),
    [laneSet, bodyHeight, settings.laneMax],
  );
  // What the canvases draw of the layout: a model that changes none of it repaints nothing.
  const layoutKey = useMemo(
    () => `${laneContentKey(layout.placed.map((placed) => placed.lane))}#${bodyHeight}#${settings.laneMax}`,
    [layout, bodyHeight, settings.laneMax],
  );

  // What the draw reads: the latest of everything, through refs, so a new row
  // or a theme change repaints the next frame without tearing the loop down.
  const scaleRef = useRef<TimelineScale>(initialScale(Date.now()));
  const tweenRef = useRef<ScaleTween | null>(null);
  const laneSetRef = useRef(laneSet);
  const layoutRef = useRef(layout);
  const columnsRef = useRef(columns);
  const bodyHeightRef = useRef(bodyHeight);
  const settingsRef = useRef(settings);
  const commandsRef = useRef(commands);
  const inksRef = useRef<TimelineInks | null>(null);
  const fontRef = useRef('ui-monospace, monospace');
  /** The lit lane and the keyboard's lane, by id: indices go stale when a lane is added or leaves. */
  const litRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const revRef = useRef(0);
  /** The wakes want a repaint (the light moved, the scale was put); the map has its own, since its lens is DOM. */
  const dirtyRef = useRef(true);
  const mapDirtyRef = useRef(true);
  const wakeKeyRef = useRef('');
  const mapKeyRef = useRef('');
  const tickKeyRef = useRef('');
  const headKeysRef = useRef<string[]>([]);
  const mapRangeRef = useRef<[number, number]>([0, 1]);
  /** Motion is allowed: tweens play and the owed body rings. */
  const motionRef = useRef(motion);
  const readoutKeyRef = useRef('');
  const barRef = useRef(bar);
  const drawRef = useRef<(time: number) => void>(() => undefined);
  const loopRef = useRef<MotionLoop | null>(null);
  const frameRef = useRef(0);

  laneSetRef.current = laneSet;
  layoutRef.current = layout;
  columnsRef.current = columns;
  bodyHeightRef.current = bodyHeight;
  settingsRef.current = settings;
  commandsRef.current = commands;
  motionRef.current = motion;

  /** One frame for a still view; with motion the loop's next frame draws anyway. */
  const requestDraw = useCallback((): void => {
    if (loopRef.current?.running || frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame((time) => {
      frameRef.current = 0;
      drawRef.current(time);
    });
  }, []);

  /** The wakes repaint: the light moved, the scale was put. */
  const invalidate = useCallback((): void => {
    dirtyRef.current = true;
    requestDraw();
  }, [requestDraw]);

  // The palette, resolved once per theme into the numbers the canvases want;
  // the state lights also reach the DOM bodies as custom properties, so the
  // CSS never names a colour of its own.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inks = resolveTimelineInks(theme.tokens, root);
    inksRef.current = inks;
    fontRef.current = getComputedStyle(root).fontFamily || fontRef.current;
    root.dataset.ground = inks.dark ? 'dark' : 'light';
    set(root, '--mv-timeline-orange', css(inks.orange));
    set(root, '--mv-timeline-blue', css(inks.blue));
    set(root, '--mv-timeline-orange-ink', css(inks.orangeInk));
    set(root, '--mv-timeline-blue-ink', css(inks.blueInk));
    set(root, '--mv-timeline-orange-ground', css(inks.orangeGround));
    set(root, '--mv-timeline-blue-ground', css(inks.blueGround));
    revRef.current += 1;
    headKeysRef.current = [];
    dirtyRef.current = true;
    mapDirtyRef.current = true;
    requestDraw();
  }, [theme.tokens, requestDraw]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = (): void =>
      setSize((current) =>
        current.width === root.clientWidth && current.height === root.clientHeight
          ? current
          : { width: root.clientWidth, height: root.clientHeight },
      );
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, []);

  const earliest = useCallback((scale: TimelineScale, nowMs: number): number => {
    return earliestHead(laneSetRef.current, scale.spanMs, nowMs);
  }, []);

  /** A held head no earlier than the map allows at its span: a zoom out near the day's start stays on the map. */
  const clampHead = useCallback(
    (scale: TimelineScale, nowMs: number): TimelineScale =>
      scale.live ? scale : headAt(scale, scale.endMs, nowMs, earliest(scale, nowMs)),
    [earliest],
  );

  /** Put a new scale in place now: a drag, a key, the map. Any tween stops. */
  const place = useCallback(
    (next: TimelineScale): void => {
      tweenRef.current = null;
      scaleRef.current = next;
      invalidate();
    },
    [invalidate],
  );

  /** The scale as the loop last drew it, mid-tween included. */
  const current = useCallback((): TimelineScale => {
    const tween = tweenRef.current;
    if (!tween) return scaleRef.current;
    return tweenAt(tween, performance.now(), Date.now(), !motionRef.current).scale;
  }, []);

  /** Zoom to `spanMs` about the head (a preset, − =), building on any tween's target. */
  const zoomTo = useCallback(
    (spanMs: number): void => {
      const now = Date.now();
      const base = settledScale(scaleRef.current, tweenRef.current, now);
      const target = clampHead(zoomAt(base, spanMs, 0, columnsRef.current.x1, now), now);
      if (!motionRef.current) {
        place(target);
        return;
      }
      const from = current();
      scaleRef.current = from;
      tweenRef.current = tweenBetween(from, target, performance.now());
      invalidate();
    },
    [clampHead, current, invalidate, place],
  );

  /** Pinch or ⌘-scroll: zoom about the pointer, easing toward a target that each event moves on. */
  const zoomAround = useCallback(
    (factor: number, anchorFromHeadPx: number): void => {
      const now = Date.now();
      const base = settledScale(scaleRef.current, tweenRef.current, now);
      const target = clampHead(
        zoomAt(base, clampSpan(base.spanMs * factor), anchorFromHeadPx, columnsRef.current.x1, now),
        now,
      );
      if (!motionRef.current) {
        place(target);
        return;
      }
      const from = current();
      scaleRef.current = from;
      tweenRef.current = tweenBetween(from, target, performance.now());
      invalidate();
    },
    [clampHead, current, invalidate, place],
  );

  const toNow = useCallback((): void => {
    const from = current();
    if (from.live && !tweenRef.current) return;
    scaleRef.current = from;
    tweenRef.current = glideTween(from, performance.now());
    invalidate();
  }, [current, invalidate]);

  const pan = useCallback(
    (deltaMs: number): void => {
      const now = Date.now();
      const from = current();
      place(panBy(from, deltaMs, now, earliest(from, now)));
    },
    [current, earliest, place],
  );

  const placedOf = (id: string | null): PlacedLane | undefined =>
    id === null ? undefined : layoutRef.current.placed.find((placed) => placed.lane.id === id);

  const choose = useCallback((id: string | null): void => {
    const placed = placedOf(id);
    if (placed) commandsRef.current.select(placed.lane.id);
  }, []);

  const light = useCallback(
    (id: string | null): void => {
      if (litRef.current === id) return;
      litRef.current = id;
      invalidate();
    },
    [invalidate],
  );

  /** The keyboard's ring on its lane (CSS shows it only for keyboard focus); `reveal` scrolls it into view. */
  const paintFocusRing = useCallback((reveal = false): void => {
    const ring = focusRingRef.current;
    const placed = placedOf(focusRef.current);
    if (!ring) return;
    ring.hidden = !placed;
    if (!placed) return;
    ring.style.top = `${placed.y}px`;
    ring.style.height = `${placed.h}px`;
    const body = bodyRef.current;
    if (body && reveal) {
      if (placed.y < body.scrollTop) body.scrollTop = placed.y;
      else if (placed.y + placed.h > body.scrollTop + body.clientHeight)
        body.scrollTop = placed.y + placed.h - body.clientHeight;
    }
  }, []);

  // The ring follows its lane's id through a new layout; a lane that left takes the ring with it.
  useLayoutEffect(() => {
    paintFocusRing();
  }, [layout, paintFocusRing]);

  // ───────────────────────────── the draw
  useEffect(() => {
    let lastSecond = -1;

    const draw = (time: number): void => {
      const root = rootRef.current;
      const inks = inksRef.current;
      const cols = columnsRef.current;
      if (!root || !inks || cols.width <= 0) return;
      const now = Date.now();
      const moving = motionRef.current;
      let scale = scaleRef.current;
      const tween = tweenRef.current;
      if (tween) {
        const step = tweenAt(tween, time, now, !moving);
        scale = step.scale;
        if (step.done) tweenRef.current = null;
        scaleRef.current = scale;
      } else {
        scale = followNow(scale, now);
        scaleRef.current = scale;
      }
      const following = scale.live || (tween?.live === true && tween.toEndMs === 'now');
      const t1 = scale.endMs;
      const t0 = t1 - scale.spanMs;
      const k = cols.x1 / scale.spanMs;

      const all = laneSetRef.current;
      const lay = layoutRef.current;
      // A move between displays changes the ratio: both canvases repaint at the new one.
      const ratio = canvasRatio(2);
      const rowsHeight = Math.max(lay.height, bodyHeightRef.current);
      const second = Math.floor(now / 1000);
      const tick = second !== lastSecond;
      lastSecond = second;

      // The wakes: repainted when the head has moved a third of a pixel, or anything else changed.
      const wake = wakeRef.current;
      const lit = litRef.current === null ? -1 : lay.placed.findIndex((placed) => placed.lane.id === litRef.current);
      const wakeKey = `${Math.round(t1 * k * 3)}|${Math.round(scale.spanMs)}|${revRef.current}|${lit}|${cols.x1}x${rowsHeight}@${ratio}`;
      if (wake && (wakeKey !== wakeKeyRef.current || dirtyRef.current)) {
        wakeKeyRef.current = wakeKey;
        sizeCanvas(wake, cols.x1, rowsHeight, { maxRatio: 2 });
        const ctx = wake.getContext('2d');
        if (ctx) {
          paintWakes(
            ctx,
            {
              width: cols.x1,
              height: rowsHeight,
              ratio,
              lanes: lay.placed,
              t0,
              t1,
              nowMs: now,
              lit,
              glow: settingsRef.current.glow,
            },
            inks,
          );
        }
      }

      // The axis: wall-clock ticks, rebuilt when their step or range moves, slid the rest of the time.
      const layer = ticksRef.current;
      if (layer) {
        const step = tickStep(k);
        const origin = Math.floor(t0 / step) * step;
        const tickKey = `${step}|${origin}|${Math.round(k * 1e9)}`;
        if (tickKey !== tickKeyRef.current) {
          tickKeyRef.current = tickKey;
          const html: string[] = [];
          for (const mark of ticksBetween(origin - step, origin + scale.spanMs + 2 * step, step)) {
            const d = new Date(mark.t);
            const midnight = d.getHours() === 0 && d.getMinutes() === 0;
            html.push(
              `<span class="vf-monitor-timeline-tick${mark.hour ? ' is-hour' : ''}" style="left:${((mark.t - origin) * k).toFixed(1)}px">${midnight ? dayLabel(mark.t) : formatClock(mark.t)}</span>`,
            );
          }
          layer.innerHTML = html.join('');
        }
        set(layer, 'transform', `translate3d(${((origin - t0) * k).toFixed(2)}px,0,0)`);
      }
      const chip = chipRef.current;
      if (chip) {
        const text = following ? formatClock(now, true) : formatClock(t1);
        if (chip.textContent !== text) chip.textContent = text;
      }
      root.dataset.detached = following ? 'false' : 'true';

      // The map: its content moves once a second (its right end is now); its lens every frame.
      const box = mapBoxRef.current;
      const mapCanvas = mapRef.current;
      if (box && mapCanvas) {
        const width = Math.max(1, cols.x1 - MAP_LEFT);
        const start = dayStart(all, scale.spanMs, now);
        mapRangeRef.current = [start, now];
        const mapKey = `${revRef.current}|${width}|${Math.round(start / 1000)}@${ratio}`;
        if (tick || mapKey !== mapKeyRef.current || mapDirtyRef.current) {
          mapKeyRef.current = mapKey;
          mapDirtyRef.current = false;
          sizeCanvas(mapCanvas, width, PULSE_GEOMETRY.height, { maxRatio: 2 });
          const ctx = mapCanvas.getContext('2d');
          if (ctx) {
            const map = pulseMap(pulseRowsFor(all.agents, now), start, now, { ...PULSE_GEOMETRY, width });
            paintPulse(
              ctx,
              mapCanvas,
              map,
              { width, height: PULSE_GEOMETRY.height, ratio, startMs: start, nowMs: now, font: fontRef.current },
              inks,
            );
          }
          const since = `SINCE ${formatClock(start)}`;
          if (sinceRef.current && sinceRef.current.textContent !== since) sinceRef.current.textContent = since;
        }
        const range = Math.max(1, now - start);
        const left = Math.min(1, Math.max(0, (t0 - start) / range)) * width;
        const right = Math.min(1, Math.max(0, (t1 - start) / range)) * width;
        set(dimLeftRef.current, 'width', `${left.toFixed(1)}px`);
        set(dimRightRef.current, 'left', `${right.toFixed(1)}px`);
        set(dimRightRef.current, 'width', `${Math.max(0, width - right).toFixed(1)}px`);
        set(knobRef.current, 'left', `${right.toFixed(1)}px`);
        knobRef.current?.classList.toggle('is-back', !following);
        const say = following ? `Now, ${formatClock(now)}` : `${formatClock(t1)}, ${formatWords(now - t1)} ago`;
        // Each attribute on its own: a render may have reset any of them to its own moment.
        const aria: [string, string][] = [
          ['aria-valuetext', say],
          ['aria-valuemin', String(Math.round(start))],
          ['aria-valuemax', String(Math.round(now / 1000) * 1000)],
          ['aria-valuenow', String(Math.round(following ? now / 1000 : t1 / 1000) * 1000)],
        ];
        for (const [name, value] of aria) if (box.getAttribute(name) !== value) box.setAttribute(name, value);
      }

      // The bodies relight to the head's moment; following now they are now (TL-D13).
      const at = following ? now : t1;
      // Once a second following now; looking back, when the head moves; and when the lanes change.
      const readoutKey = `${following ? second : Math.round(t1 / 1000)}|${revRef.current}`;
      const readoutsDue = readoutKey !== readoutKeyRef.current;
      readoutKeyRef.current = readoutKey;
      if (readoutsDue)
        lay.placed.forEach((placed, index) => {
          const el = headEls.current[index];
          if (!el) return;
          const readout = readoutAt(placed.lane, stateAt(placed.lane, at), at, following, now);
          const key = `${readout.tone}|${readout.big}|${readout.small}|${readout.owed}`;
          if (headKeysRef.current[index] === key) return;
          headKeysRef.current[index] = key;
          el.dataset.tone = readout.tone;
          el.dataset.owed = readout.owed ? 'true' : 'false';
          const big = el.querySelector('b');
          const small = el.querySelector('small');
          if (big) big.textContent = readout.big;
          if (small) small.textContent = readout.small;
        });

      dirtyRef.current = false;
      const preset = Math.round(scale.spanMs / 1000) * 1000;
      if (barRef.current.spanMs !== preset || barRef.current.live !== following) {
        barRef.current = { spanMs: preset, live: following };
        setBar(barRef.current);
      }
      // A tween still landing wants its next frame; a still view lands it at once.
      if (tweenRef.current) requestDraw();
    };
    drawRef.current = draw;
    return () => {
      drawRef.current = () => undefined;
    };
  }, [requestDraw]);

  // ───────────────────────────── when it draws
  // With motion, every frame: the toolkit's loop asks for none while animations are off or motion is reduced.
  useEffect(() => {
    const loop = createMotionLoop((time) => drawRef.current(time), {
      animations: theme.animations,
      reducedMotion: theme.reducedMotion,
    });
    loopRef.current = loop;
    return () => {
      loop.dispose();
      loopRef.current = null;
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
    // the loop lives as long as the view; the switches reach it below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Still, the clock keeps time once a second, on the second, from a timer rather than a frame loop.
  useEffect(() => {
    loopRef.current?.update({ animations: theme.animations, reducedMotion: theme.reducedMotion });
    requestDraw();
    if (motion) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const second = (): void => {
      timer = setTimeout(second, 1000 - (Date.now() % 1000));
      drawRef.current(performance.now());
    };
    timer = setTimeout(second, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  }, [motion, theme.animations, theme.reducedMotion, requestDraw]);

  // A new layout, width or tuning: every canvas and readout draws again.
  useEffect(() => {
    revRef.current += 1;
    headKeysRef.current = [];
    dirtyRef.current = true;
    mapDirtyRef.current = true;
    requestDraw();
  }, [layoutKey, columns.width, settings, requestDraw]);

  // ───────────────────────────── pointing
  const pointer = useRef<{ x: number; id: number; moved: boolean; inTrack: boolean } | null>(null);
  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = rowsRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  const laneAt = (y: number): string | null =>
    layoutRef.current.placed.find((p) => y >= p.y && y < p.y + p.h)?.lane.id ?? null;
  const dropDrag = (): void => {
    pointer.current = null;
    rootRef.current?.removeAttribute('data-panning');
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const { x } = local(event);
    pointer.current = { x: event.clientX, id: event.pointerId, moved: false, inTrack: x <= columnsRef.current.x1 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    let drag = pointer.current;
    // A press released outside the view never reached pointerup here: no button down, no drag.
    if (drag && (event.buttons & 1) === 0) {
      dropDrag();
      drag = null;
    }
    if (drag?.inTrack) {
      const dx = event.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 4) {
        drag.moved = true;
        event.currentTarget.setPointerCapture?.(drag.id);
        rootRef.current?.setAttribute('data-panning', 'true');
      }
      if (drag.moved) {
        const k = columnsRef.current.x1 / current().spanMs;
        pan(-dx / k);
        drag.x = event.clientX;
        return;
      }
    }
    light(laneAt(local(event).y));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = pointer.current;
    dropDrag();
    if (!drag || drag.moved || event.type !== 'pointerup') return;
    const id = laneAt(local(event).y);
    if (id !== null) {
      focusRef.current = id;
      paintFocusRing();
      choose(id);
    }
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const wheel = (event: WheelEvent): void => {
      const { x } = local(event);
      const cols = columnsRef.current;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(event.deltaY * (event.ctrlKey ? 0.012 : 0.004));
        zoomAround(factor, cols.x1 - Math.min(cols.x1, Math.max(0, x)));
        return;
      }
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
      const overflow = body.scrollHeight > body.clientHeight + 1;
      if (horizontal || !overflow) {
        event.preventDefault();
        const delta = horizontal ? (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) : event.deltaY;
        pan(delta * (current().spanMs / cols.x1));
      }
    };
    body.addEventListener('wheel', wheel, { passive: false });
    return () => body.removeEventListener('wheel', wheel);
  }, [current, pan, zoomAround]);

  const onBodyKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const count = layoutRef.current.placed.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!count) return;
      event.preventDefault();
      const lanes = layoutRef.current.placed.map((placed) => placed.lane);
      const from = lanes.findIndex((lane) => lane.id === focusRef.current);
      focusRef.current = lanes[stepLight(lanes, from, event.key === 'ArrowDown' ? 1 : -1)]?.id ?? focusRef.current;
      paintFocusRing(true);
      light(focusRef.current);
    } else if (event.key === 'Enter' && focusRef.current !== null) {
      event.preventDefault();
      choose(focusRef.current);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      pan((event.key === 'ArrowLeft' ? -1 : 1) * current().spanMs * 0.125);
    } else if (event.key === '-' || event.key === '=' || event.key === '+') {
      event.preventDefault();
      const base = settledScale(scaleRef.current, tweenRef.current, Date.now());
      zoomTo(base.spanMs * (event.key === '-' ? 2 : 0.5));
    }
  };

  // ───────────────────────────── the map: a scrubber
  const scrubbing = useRef(false);
  const mapFraction = (clientX: number): { f: number; x: number; width: number } => {
    const rect = mapBoxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return { f: 1, x: 0, width: 1 };
    const x = clientX - rect.left;
    return { f: Math.min(1, Math.max(0, x / rect.width)), x, width: rect.width };
  };
  const scrubTo = (clientX: number): void => {
    const { f, width } = mapFraction(clientX);
    const now = Date.now();
    const [start, end] = mapRangeRef.current;
    const scale = current();
    if (f >= 1 - 5 / width) {
      place({ spanMs: scale.spanMs, endMs: now, live: true });
      return;
    }
    place(headAt(scale, start + f * (end - start), now, earliest(scale, now)));
  };
  const showTip = (clientX: number): void => {
    const tip = tipRef.current;
    if (!tip) return;
    const { f, x, width } = mapFraction(clientX);
    const [start, end] = mapRangeRef.current;
    tip.textContent = f >= 1 - 5 / width ? 'NOW' : formatClock(start + f * (end - start));
    tip.style.left = `${Math.min(width - 20, Math.max(20, x))}px`;
    tip.hidden = false;
  };
  const onMapDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    scrubbing.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    rootRef.current?.setAttribute('data-scrubbing', 'true');
    scrubTo(event.clientX);
    showTip(event.clientX);
  };
  const onMapMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    showTip(event.clientX);
    if (scrubbing.current) scrubTo(event.clientX);
  };
  const onMapEnd = (): void => {
    scrubbing.current = false;
    rootRef.current?.removeAttribute('data-scrubbing');
  };
  const onMapKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const now = Date.now();
    const scale = current();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = (event.shiftKey ? 30 : 5) * MINUTE;
      pan(event.key === 'ArrowLeft' ? -step : step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      place(headAt(scale, earliest(scale, now), now, earliest(scale, now)));
    } else if (event.key === NOW_KEY) {
      event.preventDefault();
      toNow();
    }
  };

  // The slider's values from the first render (the draw keeps them current between renders).
  const renderNow = Date.now();
  const renderScale = followNow(scaleRef.current, renderNow);
  const slider = {
    min: dayStart(laneSet, renderScale.spanMs, renderNow),
    max: renderNow,
    now: renderScale.endMs,
    text: renderScale.live
      ? `Now, ${formatClock(renderNow)}`
      : `${formatClock(renderScale.endMs)}, ${formatWords(renderNow - renderScale.endMs)} ago`,
  };
  const presetIndex = ZOOM_PRESETS.findIndex((preset) => Math.abs(preset.spanMs - bar.spanMs) < 1000);
  const nextPreset = ZOOM_PRESETS[(presetIndex + 1) % ZOOM_PRESETS.length]!;
  // The view's own properties (L18): its geometry from the stage (the chrome it clears on the left and, M58, above)
  // and its columns, the ground from the palette.
  const rootStyle = {
    '--mv-timeline-inset-left': `${stage.insets.left}px`,
    '--mv-timeline-inset-top': `${stage.insets.top}px`,
    '--mv-timeline-ground': theme.tokens.timeline.ground,
    '--mv-timeline-x1': `${columns.x1}px`,
    '--mv-timeline-head': `${columns.head}px`,
    '--mv-timeline-names': `${columns.names}px`,
  } as CSSProperties;
  const empty = layout.placed.length === 0;

  return (
    <div
      ref={rootRef}
      className={`vf-monitor-timeline${columns.narrow ? ' is-narrow' : ''}`}
      style={rootStyle}
      data-motion={motion ? 'on' : 'off'}
    >
      <div className="vf-monitor-timeline-map">
        <div
          ref={mapBoxRef}
          className="vf-monitor-timeline-map-box"
          role="slider"
          tabIndex={0}
          aria-valuemin={Math.round(slider.min)}
          aria-valuemax={Math.round(slider.max / 1000) * 1000}
          aria-valuenow={Math.round(slider.now / 1000) * 1000}
          aria-valuetext={slider.text}
          aria-label="The head’s moment in the day"
          title="The whole day. Press to put the head there; drag to play it back."
          onPointerDown={onMapDown}
          onPointerMove={onMapMove}
          onPointerUp={onMapEnd}
          onPointerCancel={onMapEnd}
          onPointerLeave={() => {
            if (!scrubbing.current && tipRef.current) tipRef.current.hidden = true;
          }}
          onKeyDown={onMapKey}
        >
          <canvas ref={mapRef} className="vf-monitor-timeline-map-canvas" aria-hidden="true" />
          <i ref={dimLeftRef} className="vf-monitor-timeline-map-dim is-left" aria-hidden="true" />
          <i ref={dimRightRef} className="vf-monitor-timeline-map-dim is-right" aria-hidden="true" />
          <i ref={knobRef} className="vf-monitor-timeline-map-head" aria-hidden="true" />
          <span ref={tipRef} className="vf-monitor-timeline-map-tip" aria-hidden="true" hidden />
        </div>
        <div className="vf-monitor-timeline-tools">
          {columns.narrow ? (
            <button
              type="button"
              className="vf-monitor-timeline-tool"
              title={nextPreset.title}
              aria-label={`Span ${ZOOM_PRESETS[presetIndex]?.label ?? 'custom'}; ${nextPreset.title}`}
              onClick={() => zoomTo(nextPreset.spanMs)}
            >
              {ZOOM_PRESETS[presetIndex]?.label ?? '—'}
            </button>
          ) : (
            <div className="vf-monitor-timeline-zoom" role="group" aria-label="Time span">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="vf-monitor-timeline-tool"
                  title={preset.title}
                  aria-pressed={preset.spanMs === ZOOM_PRESETS[presetIndex]?.spanMs}
                  onClick={() => zoomTo(preset.spanMs)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="vf-monitor-timeline-tool is-now"
            aria-pressed={bar.live}
            aria-label={bar.live ? 'Following now' : 'Back to now'}
            title={bar.live ? 'Following now' : 'Back to now'}
            onClick={toNow}
          >
            <NowMark />
            <span className="vf-monitor-timeline-key" aria-hidden="true">
              {keyLegend(NOW_KEY)}
            </span>
          </button>
        </div>
        <span ref={sinceRef} className="vf-monitor-timeline-since" aria-hidden="true" />
      </div>
      <div className="vf-monitor-timeline-axis" aria-hidden="true">
        <div className="vf-monitor-timeline-axis-clip">
          <div ref={ticksRef} className="vf-monitor-timeline-ticks" />
        </div>
        <div ref={chipRef} className="vf-monitor-timeline-chip" />
      </div>
      <div
        ref={bodyRef}
        className="vf-monitor-timeline-body"
        tabIndex={0}
        role="group"
        aria-label="Agents over time. Up and down light a lane, Enter opens it, left and right move through time, minus and equals zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={(event) => {
          dropDrag();
          // The keyboard's lane keeps the light while the body holds focus.
          light(event.currentTarget.matches(':focus') ? focusRef.current : null);
        }}
        onLostPointerCapture={dropDrag}
        onKeyDown={onBodyKey}
        onFocus={(event) => {
          // A click's focus takes the lane it lands on (pointerup); the keyboard's enters at the first.
          if (focusRef.current === null && focusVisible(event.currentTarget)) {
            const lanes = layoutRef.current.placed.map((placed) => placed.lane);
            focusRef.current = lanes[stepLight(lanes, -1, 1)]?.id ?? null;
          }
          paintFocusRing(true);
        }}
      >
        <div ref={rowsRef} className="vf-monitor-timeline-rows" style={{ height: layout.height }}>
          <canvas ref={wakeRef} className="vf-monitor-timeline-wakes" aria-hidden="true" />
          {layout.divider === undefined ? null : (
            <div
              className="vf-monitor-timeline-divider"
              style={{ top: layout.divider, height: DIVIDER }}
              aria-hidden="true"
            >
              <span>TERMINALS</span>
            </div>
          )}
          <div className="vf-monitor-timeline-names" aria-hidden="true">
            {layout.placed.map(({ lane, y, h }) => {
              const row = lane.row;
              const sub = laneSubLine(lane);
              const two = h >= 30 && lane.kind === 'agent' && sub !== '';
              const pane = row.attachment;
              return (
                <div
                  key={lane.id}
                  className={`vf-monitor-timeline-name${two ? ' is-two' : ''}${lane.kind === 'terminal' ? ' is-terminal' : ''}${lane.receded ? ' is-receded' : ''}${row.active ? ' is-active' : ''}`}
                  style={{ top: y, height: h, '--mv-timeline-colour': row.colour } as CSSProperties}
                >
                  {pane ? (
                    <i
                      className={`vf-monitor-timeline-band${row.active ? ' is-active' : ''}`}
                      style={pane.colour ? { background: pane.colour } : undefined}
                    />
                  ) : null}
                  <span className="vf-monitor-timeline-who">
                    {row.device.self ? null : <PeerMark name={row.device.name} />}
                    <FolderMark terminal={lane.kind === 'terminal'} />
                    <b>{projectName(row)}</b>
                  </span>
                  {two ? <small>{sub}</small> : null}
                </div>
              );
            })}
          </div>
          <div className="vf-monitor-timeline-heads" aria-hidden="true">
            {layout.placed.map(({ lane, y, h }, index) => (
              <div
                key={lane.id}
                ref={(element) => {
                  headEls.current[index] = element;
                }}
                className={`vf-monitor-timeline-head${lane.kind === 'terminal' ? ' is-terminal' : ''}${h < 30 ? ' is-one' : ''}${lane.receded ? ' is-receded' : ''}`}
                style={
                  {
                    top: y,
                    height: h,
                    '--mv-timeline-lane-height': `${h}px`,
                    '--mv-timeline-colour': lane.row.colour,
                  } as CSSProperties
                }
              >
                <i className="vf-monitor-timeline-body-mark" />
                <span className="vf-monitor-timeline-readout">
                  <b />
                  <small />
                </span>
              </div>
            ))}
          </div>
          <div ref={focusRingRef} className="vf-monitor-timeline-focus" hidden aria-hidden="true" />
        </div>
      </div>
      {empty ? (
        <div className="vf-monitor-timeline-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : null}
      {/* The canvas carries no accessible tree of its own, so the lanes it draws are also offered as controls. */}
      <ul className="vf-monitor-timeline-agents">
        {layout.placed.map(({ lane }) => (
          <li key={lane.id}>
            <button
              type="button"
              onClick={() => commands.select(lane.id)}
              aria-current={lane.row.active ? 'true' : undefined}
            >
              {laneLabel(lane, Date.now())}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
