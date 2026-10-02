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
} from 'react';
import { STATUS_HISTORY_HORIZON_MS } from '../../monitor/status-history.js';
import type { AgentMonitorProps, MonitorAgent } from '../../monitor/types.js';
import { pulseMap, pulseRowsFor, PULSE_GEOMETRY } from './pulse-map.js';
import {
  createLaneCache,
  laneContentKey,
  noteFirstSeen,
  scrolledOutIds,
  stateAt,
  stepLight,
  timelineLanes,
  type TimelineLane,
  type TimelineLaneSet,
} from './timeline-lanes.js';
import {
  css,
  paintPulse,
  paintWakes,
  resolveTimelineInks,
  sizeCanvas,
  type PlacedLane,
  type TimelineInks,
} from './timeline-paint.js';
import { normalizeTimelineParameters } from './timeline-parameters.js';
import {
  clampSpan,
  earliestEnd,
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
import { formatClock, formatWords, laneLabel, readoutAt } from './timeline-words.js';

// The timeline — Godview's swarm through time (DESIGN §8; TL, design F
// "Wakes" with its map of the day, `draft/godview-timeline/`). Each lane is
// one wake painted into a canvas, the swarm's bodies sit at the head, and the
// map above is a scrubber over the whole day.
//
// React lays the lanes out (names, heads, the offscreen buttons); everything
// that moves with time — the wakes, the map, the ticks, the clock chip and the
// readouts — is drawn from a rAF loop that repaints only what changed, the way
// the rain keeps a render out of every frame.

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

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function motionAllowed(root: Element | null): boolean {
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
  return !reduced && root?.closest('.vf-godview')?.getAttribute('data-godview-animations') !== 'off';
}

function dayLabel(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }).toUpperCase();
}

/** The map's left end: the day's first recorded moment, at most a horizon back, never inside the window. */
function mapStart(set: TimelineLaneSet, scale: TimelineScale, nowMs: number): number {
  let start = nowMs - scale.spanMs;
  for (const lane of set.agents) start = Math.min(start, Math.max(lane.bornMs, lane.recordedFromMs));
  return Math.max(nowMs - STATUS_HISTORY_HORIZON_MS, start);
}

function firstBirth(set: TimelineLaneSet, nowMs: number): number {
  let first = nowMs;
  for (const lane of set.agents) first = Math.min(first, lane.bornMs);
  for (const lane of set.terminals) first = Math.min(first, lane.bornMs);
  return first;
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

/** A peer's lane: a desktop's line mark, its name in the title (the facet carries no OS to draw). */
function PeerMark({ name }: { name: string }) {
  return (
    <svg className="vf-monitor-timeline-mark is-peer" viewBox="0 0 24 24" role="img" aria-label={`on ${name}`}>
      <title>{name}</title>
      <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5ZM9 20.5h6M12 17v3.5" />
    </svg>
  );
}

function NowMark() {
  return (
    <svg className="vf-monitor-timeline-now-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h10.5M11 8.5l3.5 3.5-3.5 3.5M19.5 4.5v15" />
    </svg>
  );
}

function subLine(agent: MonitorAgent): string {
  return [agent.agent?.model ?? agent.agent?.provider.label, agent.agent?.branch].filter(Boolean).join(' · ');
}

export function TimelineView({ agents, parameters, actions, palette, history }: AgentMonitorProps) {
  const settings = useMemo(() => normalizeTimelineParameters(parameters), [parameters]);
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
  const [firstSeen, setFirstSeen] = useState<ReadonlyMap<string, number>>(() => new Map());
  /** Ended lanes that have scrolled out of the window, as a sorted id list (changes rarely). */
  const [scrolledOut, setScrolledOut] = useState('');
  const [bar, setBar] = useState<{ spanMs: number; live: boolean }>({ spanMs: initialScale(0).spanMs, live: true });

  useEffect(() => {
    setFirstSeen((previous) => noteFirstSeen(previous, agents, Date.now()));
  }, [agents]);

  const laneCache = useRef(createLaneCache());
  const laneSet = useMemo(
    () => timelineLanes({ agents, history, nowMs: Date.now(), firstSeen, cache: laneCache.current }),
    [agents, history, firstSeen],
  );
  const visible = useMemo(() => {
    if (!scrolledOut) return laneSet;
    const out = new Set(scrolledOut.split('\n'));
    const keep = (lane: TimelineLane): boolean => !out.has(lane.id);
    return { agents: laneSet.agents.filter(keep), terminals: laneSet.terminals.filter(keep) };
  }, [laneSet, scrolledOut]);
  const columns = columnsFor(size.width);
  const bodyHeight = Math.max(0, size.height - MAP_STRIP - AXIS);
  const layout = useMemo(
    () => layoutLanes(visible, bodyHeight, settings.laneMax),
    [visible, bodyHeight, settings.laneMax],
  );
  // What the canvases draw of the layout: a projection that changes none of it repaints nothing.
  const layoutKey = useMemo(
    () => `${laneContentKey(layout.placed.map((placed) => placed.lane))}#${bodyHeight}#${settings.laneMax}`,
    [layout, bodyHeight, settings.laneMax],
  );

  // What the loop reads: the latest of everything, through refs, so a new row
  // or a theme change repaints the next frame without tearing the loop down.
  const scaleRef = useRef<TimelineScale>(initialScale(Date.now()));
  const tweenRef = useRef<ScaleTween | null>(null);
  const laneSetRef = useRef(laneSet);
  const layoutRef = useRef(layout);
  const columnsRef = useRef(columns);
  const bodyHeightRef = useRef(bodyHeight);
  const settingsRef = useRef(settings);
  const actionsRef = useRef(actions);
  const inksRef = useRef<TimelineInks | null>(null);
  const fontRef = useRef('ui-monospace, monospace');
  /** The lit lane and the keyboard's lane, by id: indices go stale when a lane is added or scrolls out. */
  const litRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const dirtyRef = useRef(true);
  const scrolledOutRef = useRef(scrolledOut);
  const wakeKeyRef = useRef('');
  const mapKeyRef = useRef('');
  const tickKeyRef = useRef('');
  const headKeysRef = useRef<string[]>([]);
  const mapRangeRef = useRef<[number, number]>([0, 1]);
  /** Motion is allowed: read from the media query and the host's attribute when they change, not per frame. */
  const motionRef = useRef(true);
  const readoutKeyRef = useRef('');
  const barRef = useRef(bar);

  laneSetRef.current = laneSet;
  layoutRef.current = layout;
  columnsRef.current = columns;
  bodyHeightRef.current = bodyHeight;
  settingsRef.current = settings;
  actionsRef.current = actions;
  scrolledOutRef.current = scrolledOut;

  useEffect(() => {
    revRef.current += 1;
    headKeysRef.current = [];
    dirtyRef.current = true;
  }, [layoutKey, columns.width, settings]);

  // The palette, resolved once per theme into the numbers the canvases want;
  // the state lights also reach the DOM bodies as custom properties, so the
  // CSS never names a colour of its own.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inks = resolveTimelineInks(palette, root);
    inksRef.current = inks;
    fontRef.current = getComputedStyle(root).fontFamily || fontRef.current;
    root.dataset.ground = inks.dark ? 'dark' : 'light';
    set(root, '--vf-monitor-timeline-orange', css(inks.orange));
    set(root, '--vf-monitor-timeline-blue', css(inks.blue));
    set(root, '--vf-monitor-timeline-orange-ink', css(inks.orangeInk));
    set(root, '--vf-monitor-timeline-blue-ink', css(inks.blueInk));
    set(root, '--vf-monitor-timeline-orange-ground', css(inks.orangeGround));
    set(root, '--vf-monitor-timeline-blue-ground', css(inks.blueGround));
    revRef.current += 1;
    headKeysRef.current = [];
    dirtyRef.current = true;
  }, [palette]);

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
    return earliestEnd(firstBirth(laneSetRef.current, nowMs), scale.spanMs, nowMs);
  }, []);

  /** Put a new scale in place now: a drag, a key, the map. Any tween stops. */
  const place = useCallback((next: TimelineScale): void => {
    tweenRef.current = null;
    scaleRef.current = next;
    dirtyRef.current = true;
  }, []);

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
      const target = zoomAt(base, spanMs, 0, columnsRef.current.x1, now);
      if (!motionRef.current) {
        place(target);
        return;
      }
      const from = current();
      scaleRef.current = from;
      tweenRef.current = tweenBetween(from, target, performance.now());
      dirtyRef.current = true;
    },
    [current, place],
  );

  /** Pinch or ⌘-scroll: zoom about the pointer, easing toward a target that each event moves on. */
  const zoomAround = useCallback(
    (factor: number, anchorFromHeadPx: number): void => {
      const now = Date.now();
      const base = settledScale(scaleRef.current, tweenRef.current, now);
      const target = zoomAt(base, clampSpan(base.spanMs * factor), anchorFromHeadPx, columnsRef.current.x1, now);
      if (!motionRef.current) {
        place(target);
        return;
      }
      const from = current();
      scaleRef.current = from;
      tweenRef.current = tweenBetween(from, target, performance.now());
      dirtyRef.current = true;
    },
    [current, place],
  );

  const toNow = useCallback((): void => {
    const from = current();
    if (from.live && !tweenRef.current) return;
    scaleRef.current = from;
    tweenRef.current = glideTween(from, performance.now());
    dirtyRef.current = true;
  }, [current]);

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
    // An ended agent has nothing left to open.
    if (!placed || placed.lane.endedAtMs !== undefined) return;
    actionsRef.current.select(placed.lane.agent);
  }, []);

  const light = useCallback((id: string | null): void => {
    if (litRef.current === id) return;
    litRef.current = id;
    dirtyRef.current = true;
  }, []);

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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const read = (): void => {
      const motion = motionAllowed(root);
      motionRef.current = motion;
      root.dataset.motion = motion ? 'on' : 'off';
    };
    read();
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : undefined;
    query?.addEventListener('change', read);
    const host = root.closest('.vf-godview');
    const observer = host && typeof MutationObserver !== 'undefined' ? new MutationObserver(read) : undefined;
    if (host) observer?.observe(host, { attributes: true, attributeFilter: ['data-godview-animations'] });
    return () => {
      query?.removeEventListener('change', read);
      observer?.disconnect();
    };
  }, []);

  // ───────────────────────────── the loop
  useEffect(() => {
    let frame = 0;
    let lastSecond = -1;

    const draw = (time: number): void => {
      const root = rootRef.current;
      const inks = inksRef.current;
      const cols = columnsRef.current;
      if (!root || !inks || cols.width <= 0) return;
      const now = Date.now();
      const motion = motionRef.current;
      let scale = scaleRef.current;
      const tween = tweenRef.current;
      if (tween) {
        const step = tweenAt(tween, time, now, !motion);
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

      // An ended lane stays until it has scrolled out (TL-D6).
      const all = laneSetRef.current;
      const out = scrolledOutIds(all, t0);
      if (out !== scrolledOutRef.current) {
        scrolledOutRef.current = out;
        setScrolledOut(out);
      }

      const lay = layoutRef.current;
      const rows = Math.max(lay.height, bodyHeightRef.current);
      const second = Math.floor(now / 1000);
      const tick = second !== lastSecond;
      lastSecond = second;

      // The wakes: repainted when the head has moved a third of a pixel, or anything else changed.
      const wake = wakeRef.current;
      const lit = litRef.current === null ? -1 : lay.placed.findIndex((placed) => placed.lane.id === litRef.current);
      const wakeKey = `${Math.round(t1 * k * 3)}|${Math.round(scale.spanMs)}|${revRef.current}|${lit}|${cols.x1}x${rows}`;
      if (wake && (wakeKey !== wakeKeyRef.current || dirtyRef.current)) {
        wakeKeyRef.current = wakeKey;
        const ratio = sizeCanvas(wake, cols.x1, rows);
        const ctx = wake.getContext('2d');
        if (ctx) {
          paintWakes(
            ctx,
            {
              width: cols.x1,
              height: rows,
              ratio,
              lanes: lay.placed,
              t0,
              t1,
              nowMs: now,
              lit,
              namesRight: cols.names - 24,
              glow: settingsRef.current.glow,
              font: fontRef.current,
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
        const start = mapStart(all, scale, now);
        mapRangeRef.current = [start, now];
        const mapKey = `${revRef.current}|${width}|${Math.round(start / 1000)}`;
        if (tick || mapKey !== mapKeyRef.current || dirtyRef.current) {
          mapKeyRef.current = mapKey;
          const ratio = sizeCanvas(mapCanvas, width, PULSE_GEOMETRY.height);
          const ctx = mapCanvas.getContext('2d');
          const pulseRows = pulseRowsFor(all.agents, now);
          if (ctx) {
            const map = pulseMap(pulseRows, start, now, { fromMs: t0, toMs: t1 }, { ...PULSE_GEOMETRY, width });
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
        if (box.getAttribute('aria-valuetext') !== say) {
          box.setAttribute('aria-valuetext', say);
          box.setAttribute('aria-valuemin', String(Math.round(start)));
          box.setAttribute('aria-valuemax', String(Math.round(now)));
          box.setAttribute('aria-valuenow', String(Math.round(t1)));
        }
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
    };

    const loop = (time: number): void => {
      frame = requestAnimationFrame(loop);
      draw(time);
    };
    const start = (): void => {
      if (frame === 0 && document.visibilityState !== 'hidden') frame = requestAnimationFrame(loop);
    };
    const stop = (): void => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const visibility = (): void => (document.visibilityState === 'hidden' ? stop() : start());
    document.addEventListener('visibilitychange', visibility);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

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
      place(headAt(scale, mapRangeRef.current[0] + scale.spanMs, now, earliest(scale, now)));
    } else if (event.key === 'End') {
      event.preventDefault();
      toNow();
    }
  };

  const presetIndex = ZOOM_PRESETS.findIndex((preset) => Math.abs(preset.spanMs - bar.spanMs) < 1000);
  const nextPreset = ZOOM_PRESETS[(presetIndex + 1) % ZOOM_PRESETS.length]!;
  const rootStyle = {
    '--vf-monitor-timeline-x1': `${columns.x1}px`,
    '--vf-monitor-timeline-head': `${columns.head}px`,
    '--vf-monitor-timeline-names': `${columns.names}px`,
  } as CSSProperties;
  const empty = layout.placed.length === 0;

  return (
    <div ref={rootRef} className={`vf-monitor-timeline${columns.narrow ? ' is-narrow' : ''}`} style={rootStyle}>
      <div className="vf-monitor-timeline-map">
        <div
          ref={mapBoxRef}
          className="vf-monitor-timeline-map-box"
          role="slider"
          tabIndex={0}
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
        onPointerLeave={() => {
          dropDrag();
          light(bodyRef.current === document.activeElement ? focusRef.current : null);
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
              const agent = lane.agent;
              const two = h >= 30 && lane.kind === 'agent' && subLine(agent) !== '';
              const pane = agent.attachment;
              return (
                <div
                  key={lane.id}
                  className={`vf-monitor-timeline-name${two ? ' is-two' : ''}${lane.kind === 'terminal' ? ' is-terminal' : ''}${lane.endedAtMs !== undefined ? ' is-ended' : ''}${lane.receded ? ' is-receded' : ''}${agent.active ? ' is-active' : ''}`}
                  style={{ top: y, height: h, '--pc': agent.color } as CSSProperties}
                >
                  {pane ? (
                    <i
                      className={`vf-monitor-timeline-band${agent.active ? ' is-active' : ''}`}
                      style={pane.color ? { background: pane.color } : undefined}
                    />
                  ) : null}
                  <span className="vf-monitor-timeline-who">
                    {agent.remote ? <PeerMark name={agent.remote.deviceName} /> : null}
                    <FolderMark terminal={lane.kind === 'terminal'} />
                    <b>{agent.project}</b>
                  </span>
                  {two ? <small>{subLine(agent)}</small> : null}
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
                style={{ top: y, height: h, '--h': `${h}px`, '--pc': lane.agent.color } as CSSProperties}
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
        <div className="vf-monitor-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : null}
      {/* The canvas carries no accessible tree of its own, so the lanes it draws are also offered as controls. */}
      <ul className="vf-monitor-timeline-agents">
        {layout.placed.map(({ lane }) => (
          <li key={lane.id}>
            {lane.endedAtMs === undefined ? (
              <button
                type="button"
                onClick={() => actions.select(lane.agent)}
                aria-current={lane.agent.active ? 'true' : undefined}
              >
                {laneLabel(lane, Date.now())}
              </button>
            ) : (
              <span>{laneLabel(lane, Date.now())}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
