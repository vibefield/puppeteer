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
import type { AgentView, StageGeometry } from '@vibecook/puppeteer-view-sdk';
import type { ReactMonitorViewProps } from '@vibecook/puppeteer-view-sdk/react';
import { createMotionLoop, formatClock, sizeCanvas, type MotionLoop } from '@vibecook/puppeteer-view-sdk/toolkit';
import { liftedFill, siblingIndex, siblingTone } from './spend-ink.js';
import { fitList, listOrder, moreWords } from './spend-list.js';
import {
  css,
  paintSpend,
  resolveSpendInks,
  sceneMoves,
  type Rgba,
  type SceneHead,
  type SceneLine,
  type SpendInks,
  type SpendScene,
} from './spend-paint.js';
import {
  easeTop,
  heldIn,
  momentIn,
  moneyScale,
  moneyTicks,
  SPEND_WINDOW_MS,
  spendWindow,
  timeTicks,
} from './spend-scale.js';
import { normalizeSpendParameters } from './spend-parameters.js';
import { rateAt, spendAt, spendMeters, spentAt, spentPoints, valueAt, type SpendLine } from './spend-series.js';
import {
  axisMoney,
  est,
  fitWords,
  money,
  NOT_RECORDED,
  perHour,
  printedBurn,
  spendNames,
  spendStateAt,
  stateWords,
  waits,
  type SpendGlyph,
  type SpendName,
  type SpendState,
  type SpendTone,
} from './spend-words.js';

// The spend view — "Where the Money Went" (SV, design B · Watchlist with its
// round-2 refinements, `draft/godview-spend/` §B′). Runtime only (James,
// 2026-10-03): the chart is the last ten minutes Core holds, always ending at
// now, and each priced agent's line is what it spent in them, in its project's
// colour — from $0 where the window begins for it, its head at what it has
// spent since. A watchlist beside the chart names every line in words, most
// spent first, each with its run's TOTAL, so the two figures never read as one.
// The view draws only what the live rows say now: it keeps nothing across
// models but its own UI state, and persists nothing.
//
// An SDK view (MV-7): it reads its input alone — the model's rows and the
// backend's `MonitorCost` on each (`spend-series.ts`), the theme, the stage, its
// parameters — and calls `commands.select`.
//
// Pointing at the chart reads a moment: the list, the hero and the header all
// say what was spent by then, rows not yet started fade and say when they
// start, and the chart past the moment fades (SV-D15…D17). A click on empty
// chart sets the moment (SV-D18); waiting rows the scroll leaves out dock at
// the list's foot (SV-D19).
//
// React lays out the DOM (the hero, the axes, the rows) from the view's state;
// the canvas is painted after each render, and the toolkit's loop repaints it
// only while a waiting head's wave moves. Still (animations off, or motion
// reduced) no frame loop runs (MV-W4): nothing waves, eases or glides.

/** A line within this many px of the pointer is the one pointed at; further, the click sets the moment. */
const REACH_PX = 16;
/** Under this height the rows go to one line of 30 px (the terminals are up). */
const COMPACT_BELOW = 418;
const GREY: Rgba = [0.5, 0.5, 0.5, 1];

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The view's layout at a size: the plot and the list column (the lab presses the plot through it). */
export interface Geometry {
  width: number;
  height: number;
  compact: boolean;
  /** Too narrow for the hero's caption: it keeps the number and the burn. */
  narrow: boolean;
  /** The plot. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The list column. */
  lx0: number;
  listW: number;
  ly0: number;
  ly1: number;
  rowH: number;
  axisY: number;
}

export function geometryFor(width: number, height: number): Geometry {
  const compact = height < COMPACT_BELOW;
  const narrow = width < 640;
  const margin = width < 640 ? 12 : 24;
  const listW = width >= 960 ? 316 : Math.round(Math.min(316, Math.max(168, width * 0.34)));
  const lx0 = width - margin - listW;
  const x1 = Math.max(margin + 40, lx0 - (width < 640 ? 44 : 52));
  const y0 = compact ? 48 : 80;
  const y1 = Math.max(y0 + 40, height - 26);
  return {
    width,
    height,
    compact,
    narrow,
    x0: margin,
    x1,
    y0,
    y1,
    lx0,
    listW,
    ly0: 12,
    ly1: height - 4,
    rowH: compact ? 30 : 54,
    axisY: y1 + 6,
  };
}

/** The view's own box: the stage past the chrome it clears on the left and above (MV-D19, M58). */
const stageBox = (stage: StageGeometry): Size => ({
  width: Math.max(0, stage.width - stage.insets.left),
  height: Math.max(0, stage.height - stage.insets.top),
});

const setProperty = (element: HTMLElement | null, key: string, value: string): void => {
  if (element && element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
};

/** Text widths for fitting a task at a word. */
type TextMeasure = (text: string, font: string) => number;

/** Where nothing can measure: an average glyph. */
const averageGlyph: TextMeasure = (text) => text.length * 6.4;

/** A 2D canvas's advance widths, the canvas made detached from the root's own document (MV-W2); none where none draws. */
function canvasMeasure(within: Element): TextMeasure | undefined {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = within.ownerDocument.createElement('canvas').getContext('2d');
  } catch {
    // no document, or none that draws
  }
  if (!context) return undefined;
  const ctx = context;
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

// The glyphs (DESIGN §13 Instrument construction: 24 box, one 2-unit stroke, round caps).
const GLYPH_PATHS: Record<SpendGlyph, ReactElement> = {
  question: (
    <>
      <path d="M9 9.5a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.8v.5" />
      <circle className="is-dot" cx="12" cy="17.75" r="1.35" />
    </>
  ),
  failure: (
    <>
      <path d="M12 5v9" />
      <circle className="is-dot" cx="12" cy="18" r="1.35" />
    </>
  ),
  permission: <path d="M8 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM10.5 10.5 19 19M15.5 15.5l2-2M13 13l2-2" />,
  reply: <path d="M20 14a2 2 0 0 1-2 2H9l-4.5 3.5V6a2 2 0 0 1 2-2h11.5a2 2 0 0 1 2 2Z" />,
};

function Glyph({ glyph }: { glyph: SpendGlyph }) {
  return (
    <svg className="vf-monitor-spend-glyph" viewBox="0 0 24 24" aria-hidden="true">
      {GLYPH_PATHS[glyph]}
    </svg>
  );
}

/** Another desktop's agent: a desktop's line mark, its name in the title (the facet carries no OS to draw). */
function PeerMark({ name }: { name: string }) {
  return (
    <svg className="vf-monitor-spend-peer" viewBox="0 0 24 24" role="img" aria-label={`on ${name}`}>
      <title>{`On ${name}`}</title>
      <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5ZM9 20.5h6M12 17v3.5" />
    </svg>
  );
}

function NowMark() {
  return (
    <svg className="vf-monitor-spend-now-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h10.5M11 8.5l3.5 3.5-3.5 3.5M19.5 4.5v15" />
    </svg>
  );
}

/** One row's words at the moment, as the row-spec table says them (design page §row). */
interface RowModel {
  id: string;
  line?: SpendLine | undefined;
  agent: AgentView;
  name: SpendName;
  colour: string;
  state: SpendState;
  value: number | undefined;
  partial: boolean;
  status: { text: string; tone: SpendTone };
  /** The burn its words print, a minute: the hero adds exactly these. */
  burn: number | undefined;
  /** Started, but what it had spent then nobody recorded: another desktop's row carries a total, no buckets. */
  unrecorded: boolean;
  priced: boolean;
}

interface Pointer {
  /** The pointer's moment over the chart, and the line within reach. */
  t: number;
  near: string | null;
}

export function SpendView({ input, commands }: ReactMonitorViewProps): ReactElement {
  const { model, parameters, theme, stage } = input;
  const settings = useMemo(() => normalizeSpendParameters(parameters), [parameters]);
  // The host's animations switch and the person's reduced-motion preference: either one stills the view.
  const motion = theme.animations && !theme.reducedMotion;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The root's own size once laid out; until then (and wherever nothing lays out) the stage's. */
  const [measured, setMeasured] = useState<Size | null>(null);
  const size = measured ?? stageBox(stage);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pointer, setPointer] = useState<Pointer | null>(null);
  /** The moment a click set (SV-D18); it stays while the pointer crosses to the list, until the window passes it. */
  const [held, setHeld] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  /** The order the list showed when the pointer came onto it: rows never move under the pointer (SV-D12). */
  const [listHeld, setListHeld] = useState<string[] | null>(null);
  const [listOffset, setListOffset] = useState(0);
  const [yShown, setYShown] = useState<number | null>(null);
  const [inks, setInks] = useState<SpendInks | null>(null);
  const [font, setFont] = useState('-apple-system, BlinkMacSystemFont, system-ui, sans-serif');
  const [measure, setMeasure] = useState<TextMeasure>(() => averageGlyph);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const sceneRef = useRef<SpendScene | null>(null);

  // ───────────────────────────── the world now
  // Once per published model: a row the model kept keeps its meter (MV-D21, M64); only the head moves with the clock.
  const meters = useMemo(() => spendMeters(model.agents), [model.agents]);
  const set = useMemo(() => spendAt(meters, nowMs), [meters, nowMs]);
  const dark = inks?.dark ?? false;
  const colours = useMemo(() => {
    const sib = siblingIndex(
      meters.lines.map((line) => ({ id: line.id, project: line.agent.project.name, bornMs: line.bornMs })),
    );
    const out = new Map<string, { ink: Rgba; fill: string }>();
    for (const line of meters.lines) {
      const base = inks?.project(line.agent.colour) ?? GREY;
      const n = sib.get(line.id) ?? 0;
      out.set(line.id, { ink: siblingTone(base, n, dark), fill: liftedFill(base, n) });
    }
    return out;
  }, [meters, inks, dark]);
  const names = useMemo(
    () => spendNames([...meters.lines.map((line) => line.agent), ...meters.unpriced.map((row) => row.agent)]),
    [meters],
  );

  const g = geometryFor(size.width, size.height);
  const span = spendWindow(nowMs);
  const { ta, tb } = span;
  const pinned = heldIn(held, span);
  const crossT = pinned ?? pointer?.t ?? null;
  const tCross = crossT === null ? null : momentIn(crossT, span);
  const tView = tCross ?? tb;
  const xOf = (t: number): number => g.x0 + ((t - ta) / (tb - ta)) * (g.x1 - g.x0);

  const lines = set.lines;
  const unpriced = set.unpriced;

  // The order: most spent first, still while the pointer is on the list, now's order while scrubbing.
  const order = listOrder(
    lines.map((line) => ({ id: line.id, value: line.total, bornMs: line.bornMs })),
    { held: listHeld },
  );
  const byId = new Map(lines.map((line) => [line.id, line]));

  // The scale: from $0 to a round number above the most spent in the window, eased so a new high never jumps.
  const target = moneyScale(Math.max(0, ...lines.map((line) => spentAt(line, ta, tb) ?? 0)), g.compact);
  const yMax = yShown ?? target.max;
  const yOf = (value: number): number => g.y1 - (value / Math.max(1e-9, yMax)) * (g.y1 - g.y0);

  // ───────────────────────────── each row at the moment
  const rowOf = (line: SpendLine): RowModel => {
    const state = spendStateAt(line, tView, nowMs);
    const before = state.key === 'before';
    const value = before ? undefined : valueAt(line, tView);
    // Started, and still no figure: a row with a total alone, at any moment but now.
    const unrecorded = !before && value === undefined;
    const rate = value === undefined ? undefined : rateAt(line, tView);
    const colour = colours.get(line.id);
    return {
      id: line.id,
      line,
      agent: line.agent,
      name: names.get(line.id)!,
      colour: colour ? css(colour.ink) : 'currentColor',
      state,
      value,
      partial: line.partial,
      status: unrecorded ? NOT_RECORDED : stateWords(state, tView, rate),
      burn: unrecorded ? undefined : printedBurn(state, rate),
      unrecorded,
      priced: true,
    };
  };
  const rows = order.map((id) => rowOf(byId.get(id)!));
  const unpricedRows: RowModel[] = unpriced.map((row) => {
    const state = spendStateAt(row, tView, nowMs);
    return {
      id: row.id,
      agent: row.agent,
      name: names.get(row.id)!,
      colour: 'currentColor',
      state,
      value: undefined,
      partial: false,
      status: state.key === 'working' ? { text: 'working', tone: 'live' } : stateWords(state, tView, undefined),
      burn: undefined,
      unrecorded: false,
      priced: false,
    };
  });

  // The hero: what the field had spent by the moment (at now, every run's total), a plus when some went unpriced
  // or nobody recorded it, and the burn — exactly the sum of the rates the rows print (review must-fix 2).
  let spent = 0;
  let partial = false;
  let perMinute = 0;
  for (const row of rows) {
    if (row.state.key === 'before') continue;
    if (row.value === undefined) partial = true;
    else {
      spent += row.value;
      if (row.partial && row.value > 0) partial = true;
    }
    perMinute += row.burn ?? 0;
  }
  const missing = unpriced.filter((row) => row.bornMs <= tView);
  const leftOut =
    missing.length === 1
      ? ` · not counting ${names.get(missing[0]!.id)!.one}`
      : missing.length > 1
        ? ` · not counting ${missing.length} agents with no price`
        : '';
  const heroRate =
    tCross !== null ? `by ${formatClock(tCross)} · ${perHour(perMinute)} then` : `${perHour(perMinute)} now`;
  const heroWhat = `since each agent started, at API prices${leftOut}`;

  // The header: how many had started by the moment, and what the money column means.
  const all = rows.length + unpricedRows.length;
  const started = [...rows, ...unpricedRows].filter((row) => row.state.key !== 'before').length;
  // The compact form's slim header says only what it must: who had started while some had not, and "Total".
  const headA = started < all ? `${started} of ${all} started` : g.compact ? '' : 'By spend';
  // The list's money is each run's total, the chart's what it spent in the window: the header says which.
  const headB = tCross !== null ? `Total by ${formatClock(tCross)}` : 'Total';

  // The list: its header (26 px, or one slim 14 px line in the compact form, taken out of the rows' room), whole
  // rows, a "more" row, waiting rows docked at the foot.
  const listTop = g.ly0 + (g.compact ? 14 : 26);
  const room = g.ly1 - listTop - unpricedRows.length * g.rowH - (unpricedRows.length ? 6 : 0);
  const cap = Math.max(1, Math.floor(room / g.rowH));
  const waiting = new Map(rows.filter((row) => waits(row.state)).map((row) => [row.id, row.state.sinceMs]));
  const fit = fitList(order, cap, listOffset, waiting);
  const dockIndex = new Map(fit.docked.map((id, index) => [id, index]));
  const shownRows = fit.more ? cap : rows.length;

  // ───────────────────────────── the canvas's scene
  const hot = hover;
  const sceneLines: SceneLine[] = lines.map((line) => ({
    id: line.id,
    colour: colours.get(line.id)?.ink ?? GREY,
    points: spentPoints(line, ta, tb).map((point) => [xOf(point.t), yOf(point.v)] as const),
  }));
  // Every head is at now, on what its run spent in the window; a row with a total alone has neither line nor head.
  const heads: SceneHead[] = lines.flatMap((line) => {
    const spent = spentAt(line, ta, tb);
    if (spent === undefined) return [];
    const colour = colours.get(line.id)?.ink ?? GREY;
    return [{ id: line.id, x: xOf(tb), y: yOf(spent), colour, key: spendStateAt(line, tb, nowMs).key }];
  });
  const hotLine = hot === null ? undefined : byId.get(hot);
  const startsLater = hotLine !== undefined && tCross !== null && tCross < hotLine.bornMs;
  const scene: SpendScene = {
    width: g.width,
    height: g.height,
    ratio: 1,
    x0: g.x0,
    x1: g.x1,
    y0: g.y0,
    y1: g.y1,
    weight: settings.weight,
    wash: settings.wash,
    grid: moneyTicks(yMax, target.step).map(yOf),
    nowX: xOf(tb),
    lines: sceneLines,
    hot,
    fadeX: tCross === null ? null : xOf(tCross),
    heads,
    // A moment fades the heads, and a faded head has no wave: the loop rests while one is read.
    waves: tCross === null,
    ...(tCross !== null
      ? {
          cross: {
            x: xOf(tCross),
            held: pinned !== null,
            dots: lines.flatMap((line) => {
              const spent = tCross < line.bornMs ? undefined : spentAt(line, ta, tCross);
              if (spent === undefined) return [];
              return [{ x: xOf(tCross), y: yOf(spent), colour: colours.get(line.id)!.ink, id: line.id }];
            }),
          },
        }
      : {}),
    ...(pinned !== null && pointer ? { ghostX: xOf(momentIn(pointer.t, span)) } : {}),
    ...(startsLater
      ? {
          start: {
            x: xOf(Math.max(hotLine.bornMs, ta)),
            y: yOf(0),
            colour: colours.get(hotLine.id)!.ink,
          },
        }
      : {}),
    time: 0,
  };
  sceneRef.current = scene;

  // The tag at the pointed line's head — what it spent in the window by then — the only label on the chart; a row
  // not yet started shows its start instead.
  let tag: { text: string; fill: string; style: CSSProperties } | null = null;
  if (hotLine) {
    const fill = colours.get(hotLine.id)!.fill;
    if (startsLater) {
      tag = {
        text: `starts ${formatClock(hotLine.bornMs)}`,
        fill,
        style: { transform: `translate(${xOf(Math.max(hotLine.bornMs, ta)) + 8}px, ${yOf(0) - 30}px)` },
      };
    } else {
      const t = tCross ?? tb;
      const spent = t < hotLine.bornMs ? undefined : spentAt(hotLine, ta, t);
      if (spent !== undefined)
        tag = {
          text: est(spent, hotLine.partial),
          fill,
          style: { transform: `translate(calc(${xOf(t) - 10}px - 100%), ${yOf(spent) - 11}px)` },
        };
    }
  }

  // ───────────────────────────── effects: size, inks, the loop
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measureRoot = (): void => {
      const width = root.clientWidth;
      const height = root.clientHeight;
      // A root nothing lays out (a hidden stage, a test's DOM) keeps drawing at the stage's size.
      setMeasured((current) =>
        width <= 0 || height <= 0
          ? null
          : current?.width === width && current.height === height
            ? current
            : { width, height },
      );
    };
    measureRoot();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measureRoot);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, []);

  // The palette, resolved once per theme into the numbers the canvas wants; the state inks also reach the DOM as
  // the view's own properties, so the CSS reads no host token (L18).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resolved = resolveSpendInks(theme.tokens, root);
    setInks(resolved);
    setFont((current) => getComputedStyle(root).fontFamily || current);
    setMeasure(() => canvasMeasure(root) ?? averageGlyph);
    root.dataset.ground = resolved.dark ? 'dark' : 'light';
    setProperty(root, '--mv-spend-orange', css(resolved.orange));
    setProperty(root, '--mv-spend-blue', css(resolved.blue));
    setProperty(root, '--mv-spend-orange-ink', css(resolved.orangeInk));
    setProperty(root, '--mv-spend-blue-ink', css(resolved.blueInk));
    setProperty(root, '--mv-spend-green-ink', css(resolved.greenInk));
  }, [theme.tokens]);

  const paint = useCallback(
    (time: number): void => {
      const canvas = canvasRef.current;
      const current = sceneRef.current;
      if (!canvas || !current || !inks || current.width <= 0) return;
      const { ratio } = sizeCanvas(canvas, current.width, current.height, { maxRatio: 2 });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      paintSpend(ctx, { ...current, ratio, time, waves: current.waves && motionRef.current }, inks);
    },
    [inks],
  );

  // Every render repaints the canvas from its scene.
  useLayoutEffect(() => {
    paint(typeof performance === 'undefined' ? 0 : performance.now());
  });

  // The top eases toward its target, a frame at a time; still, it lands at once.
  useEffect(() => {
    if (yShown === target.max) return;
    if (yShown === null || !motion) {
      setYShown(target.max);
      return;
    }
    const frame = requestAnimationFrame(() => setYShown((shownTop) => easeTop(shownTop, target.max)));
    return () => cancelAnimationFrame(frame);
  }, [yShown, target.max, motion]);

  // The clock: now moves about a pixel at a time; the wave repaints the canvas alone.
  const msPerPx = SPEND_WINDOW_MS / Math.max(1, g.x1 - g.x0);
  useEffect(() => {
    const every = Math.min(1000, Math.max(250, msPerPx));
    const id = setInterval(() => setNowMs(Date.now()), every);
    return () => clearInterval(id);
  }, [msPerPx]);

  // A set moment the window has slid past lets go.
  useEffect(() => {
    if (held !== null && pinned === null) setHeld(null);
  }, [held, pinned]);

  // The wave's loop: the toolkit's, which asks for no frame at all while animations are off or motion is reduced.
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const loopRef = useRef<MotionLoop | null>(null);
  useEffect(() => {
    let last = 0;
    const loop = createMotionLoop(
      (time) => {
        const current = sceneRef.current;
        if (!current || !sceneMoves(current) || time - last < 33) return;
        last = time;
        paintRef.current(time);
      },
      { animations: theme.animations, reducedMotion: theme.reducedMotion },
    );
    loopRef.current = loop;
    return () => {
      loop.dispose();
      loopRef.current = null;
    };
    // the loop lives as long as the view; the switches reach it below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    loopRef.current?.update({ animations: theme.animations, reducedMotion: theme.reducedMotion });
  }, [theme.animations, theme.reducedMotion]);

  // ───────────────────────────── acts
  const select = (id: string): void => {
    const row = rows.find((candidate) => candidate.id === id) ?? unpricedRows.find((candidate) => candidate.id === id);
    if (row) commands.select(row.id);
  };

  const release = (): void => setHeld(null);

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = rootRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  const tAt = (x: number): number => momentIn(ta + ((x - g.x0) / (g.x1 - g.x0)) * (tb - ta), span);
  const nearest = (t: number, y: number): string | null => {
    let best: string | null = null;
    let distance = REACH_PX;
    for (const line of lines) {
      const spent = t < line.bornMs ? undefined : spentAt(line, ta, t);
      if (spent === undefined) continue;
      const d = Math.abs(yOf(spent) - y);
      if (d < distance) {
        distance = d;
        best = line.id;
      }
    }
    return best;
  };

  const point = (x: number, y: number): void => {
    const inPlot = x >= g.x0 - 2 && x <= g.x1 + 2 && y >= g.y0 - 12 && y <= g.y1 + 6;
    if (!inPlot) {
      setPointer(null);
      setHover(focus);
      return;
    }
    const t = tAt(x);
    const near = nearest(t, y);
    setPointer({ t, near });
    setHover(near ?? focus);
  };
  const press = useRef<{ x: number; y: number } | null>(null);
  const onHitDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button === 0) press.current = { x: event.clientX, y: event.clientY };
  };
  const onHitMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(event);
    point(x, y);
  };
  const onHitUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = press.current;
    press.current = null;
    // A press that travelled is no click: nothing pans the window, and a stray drag sets nothing.
    if (!from || Math.abs(event.clientX - from.x) > 4 || Math.abs(event.clientY - from.y) > 4) return;
    const { x, y } = local(event);
    const t = tAt(x);
    const near = nearest(t, y);
    // A line within reach opens; empty chart sets the moment there, and a click on the moment lets it go.
    if (near) select(near);
    else if (pinned !== null && Math.abs(xOf(t) - xOf(pinned)) < 8) release();
    else setHeld(t);
  };
  const onHitLeave = (): void => {
    press.current = null;
    setPointer(null);
    setHover(focus);
  };

  const listRef = useRef<HTMLDivElement>(null);
  const listWheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  listWheelRef.current = (event: WheelEvent): void => {
    if (!fit.more) return;
    event.preventDefault();
    setListOffset(Math.min(fit.maxOffset, Math.max(0, fit.offset + Math.sign(event.deltaY))));
  };
  useEffect(() => {
    const list = listRef.current;
    const onList = (event: WheelEvent): void => listWheelRef.current(event);
    list?.addEventListener('wheel', onList, { passive: false });
    return () => list?.removeEventListener('wheel', onList);
  }, []);

  const keyOrder = [...order, ...unpricedRows.map((row) => row.id)];
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!keyOrder.length) return;
      event.preventDefault();
      const index = focus === null ? -1 : keyOrder.indexOf(focus);
      const next =
        event.key === 'ArrowDown'
          ? index < 0
            ? 0
            : Math.min(keyOrder.length - 1, index + 1)
          : index < 0
            ? 0
            : Math.max(0, index - 1);
      const id = keyOrder[next] ?? null;
      setFocus(id);
      setHover(id);
      // The focused row scrolls into the list's sequence.
      const at = id === null ? -1 : order.indexOf(id);
      if (at >= 0 && (at < fit.offset || at >= fit.offset + fit.fits))
        setListOffset(at < fit.offset ? at : at - fit.fits + 1);
    } else if (event.key === 'Enter' && focus !== null) {
      event.preventDefault();
      select(focus);
    } else if (event.key === 'End') {
      event.preventDefault();
      release();
    }
  };

  // ───────────────────────────── the DOM
  const yTicks = moneyTicks(yMax, target.step);
  const chips = [xOf(tb), ...(tCross !== null ? [xOf(tCross)] : [])];
  const ticks = timeTicks(ta, tb, g.x0, g.x1, chips);
  const l2w = g.listW - 35;
  const rowFont = `400 12px ${font}`;

  const rowElement = (row: RowModel, index: number, foot: boolean): ReactElement => {
    const one = g.compact;
    const docked = dockIndex.get(row.id);
    const inSequence = !foot && index >= fit.offset && index < fit.offset + fit.fits;
    const hidden = !foot && !inSequence && docked === undefined;
    const slot = foot ? shownRows + index : docked !== undefined ? fit.fits + 1 + docked : index - fit.offset;
    const top = listTop + slot * g.rowH + (foot ? 6 : 0);
    const before = row.state.key === 'before';
    const hollow = row.state.key === 'idle';
    // Its state's glyph, unless nobody recorded it then (the one-line form keeps only the muted dash).
    const glyph = row.unrecorded ? undefined : row.state.glyph;
    const figure = before
      ? one
        ? row.status.text
        : '—'
      : row.priced && !row.unrecorded
        ? est(row.value, row.partial)
        : '—';
    const stateWidth = measure(row.status.text, `600 12px ${font}`) + (glyph ? 15 : 0);
    const task = row.priced
      ? fitWords(row.name.task || row.name.model, l2w - stateWidth - 12, (text) => measure(text, rowFont))
      : '';
    const mounted = row.agent.attachment !== undefined;
    const what = row.name.task || row.name.model;
    const provider = row.agent.provider?.label ?? 'its provider';
    const label = before
      ? `${row.name.one}, ${what}, had not started then; ${row.status.text}.`
      : row.unrecorded
        ? `${row.name.one}, ${what}: what it had spent then was not recorded (its row carries only its total). Open in your pane.`
        : row.priced
          ? `${row.name.one}, ${what}, ${est(row.value, row.partial)}${row.status.text ? `, ${row.status.text}` : ''}${mounted ? ', in a pane' : ''}. Open in your pane.`
          : `${row.name.one}: ${provider} reports no cost, so it isn't drawn${row.status.text ? `; ${row.status.text}` : ''}. Open in your pane.`;
    const title = row.priced
      ? `${row.name.one} · ${row.name.model}${row.name.task ? ` · ${row.name.task}` : ''}`
      : `${row.name.one} · ${provider} reports no cost, so it isn't drawn${row.name.task ? ` · ${row.name.task}` : ''}`;
    const classes = [
      'vf-monitor-spend-row',
      one ? 'is-one' : '',
      row.priced ? '' : 'is-none',
      row.unrecorded ? 'is-unrecorded' : '',
      hover === row.id ? 'is-hot' : '',
      hover !== null && hover !== row.id ? 'is-dim' : '',
      focus === row.id ? 'is-focus' : '',
      before ? 'is-before' : '',
      docked !== undefined ? 'is-docked' : '',
      docked === 0 ? 'is-dock-first' : '',
      mounted ? 'is-mounted' : '',
      row.agent.active ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <button
        key={row.id}
        type="button"
        className={classes}
        data-id={row.id}
        data-state={row.state.key}
        data-dir={docked === undefined ? undefined : index < fit.offset ? 'up' : 'down'}
        hidden={hidden}
        tabIndex={-1}
        title={title}
        aria-label={label}
        style={
          {
            transform: `translate(${g.lx0}px, ${top}px)`,
            width: g.listW,
            height: g.rowH - 2,
            '--mv-spend-key': row.colour,
          } as CSSProperties
        }
        onPointerEnter={() => setHover(row.id)}
        onClick={() => select(row.id)}
      >
        <span className="vf-monitor-spend-r1">
          <i className={`vf-monitor-spend-key${hollow ? ' is-hollow' : ''}`} aria-hidden="true" />
          <b className="vf-monitor-spend-name">{one ? row.name.one : row.name.name}</b>
          {row.agent.device.self ? null : <PeerMark name={row.agent.device.name} />}
          <span className="vf-monitor-spend-pane" aria-hidden="true" />
          {one && glyph ? (
            <span className="vf-monitor-spend-stg" data-tone={row.status.tone}>
              <Glyph glyph={glyph} />
            </span>
          ) : null}
          <span className="vf-monitor-spend-v">{figure}</span>
        </span>
        {one ? null : (
          <span className="vf-monitor-spend-r2">
            <span className="vf-monitor-spend-task">
              {row.priced ? task : `${row.agent.provider?.label ?? 'agent'} · no price`}
            </span>
            <span className="vf-monitor-spend-state" data-tone={row.status.tone}>
              {glyph ? <Glyph glyph={glyph} /> : null}
              {row.status.text}
            </span>
          </span>
        )}
      </button>
    );
  };

  const empty = rows.length === 0 && unpricedRows.length === 0;
  // The view's own properties (L18): its geometry from the stage (the chrome it clears on the left and, M58, above),
  // the list's width, and the two palette colours its sheet draws with, the focus ring's and the dark ground's.
  const rootStyle = {
    '--mv-spend-inset-left': `${stage.insets.left}px`,
    '--mv-spend-inset-top': `${stage.insets.top}px`,
    '--mv-spend-list': `${g.listW}px`,
    '--mv-spend-select': theme.tokens.swarm.blue,
    '--mv-spend-deep': theme.tokens.stage,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`vf-monitor-spend${g.compact ? ' is-compact' : ''}`}
      style={rootStyle}
      data-motion={motion ? 'on' : 'off'}
      tabIndex={0}
      role="group"
      aria-label="Spend: what each agent spent in the last ten minutes, a line each from $0, and each run's total in the list. Up and down move between agents, Return opens one, End lets go of a set moment."
      onKeyDown={onKey}
    >
      <canvas ref={canvasRef} className="vf-monitor-spend-canvas" aria-hidden="true" />
      <div
        className="vf-monitor-spend-hit"
        style={{ left: g.x0 - 6, top: g.y0 - 14, width: g.x1 - g.x0 + 14, height: g.y1 - g.y0 + 22 }}
        onPointerDown={onHitDown}
        onPointerMove={onHitMove}
        onPointerUp={onHitUp}
        onPointerCancel={() => {
          press.current = null;
        }}
        onPointerLeave={onHitLeave}
      />
      <div className="vf-monitor-spend-colcap" style={{ left: g.x0, top: g.y0 + 8 }} aria-hidden="true">
        Spent in the last 10 minutes
      </div>
      <div className="vf-monitor-spend-y" aria-hidden="true">
        {yTicks.map((value) => (
          <span key={value} style={{ left: g.x1 + 12, top: yOf(value) - 7 }}>
            {axisMoney(value, target.step)}
          </span>
        ))}
      </div>
      <div className="vf-monitor-spend-x" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.t} style={{ left: tick.x, top: g.axisY }}>
            {formatClock(tick.t)}
          </span>
        ))}
        <span className="vf-monitor-spend-chip" style={{ left: xOf(tb), top: g.axisY - 2 }}>
          {formatClock(tb)}
        </span>
        {tCross !== null ? (
          <span
            className={`vf-monitor-spend-chip is-moment${pinned !== null ? ' is-held' : ''}`}
            style={{ left: xOf(tCross), top: g.axisY - 2 }}
          >
            {formatClock(tCross)}
          </span>
        ) : null}
      </div>
      <div
        className={`vf-monitor-spend-hero${g.compact || g.narrow ? ' is-compact' : ''}${g.narrow ? ' is-narrow' : ''}`}
        style={{ left: g.x0 }}
      >
        <span className="vf-monitor-spend-big">{`~${money(spent)}${partial ? '+' : ''}`}</span>
        <span className="vf-monitor-spend-cap">
          <b>{heroRate}</b>
          <i>{heroWhat}</i>
        </span>
      </div>
      {pinned !== null ? (
        // Now, with the key it answers to printed under its glyph (M177 ruling 4: the button is the key).
        <button
          type="button"
          className="vf-monitor-spend-back"
          style={{ right: g.width - g.x1 + 4, top: g.y0 + 2 }}
          title="Back to now (End)"
          aria-label="Back to now"
          aria-keyshortcuts="End"
          onClick={release}
        >
          <span className="vf-monitor-spend-now-key" aria-hidden="true">
            <NowMark />
            <b className="vf-monitor-spend-legend">End</b>
          </span>
          <span>Now</span>
        </button>
      ) : null}
      {tag ? (
        <div className="vf-monitor-spend-tag" style={{ ...tag.style, background: tag.fill }} aria-hidden="true">
          {tag.text}
        </div>
      ) : null}
      <div
        ref={listRef}
        className="vf-monitor-spend-list"
        onPointerEnter={() => setListHeld(order)}
        onPointerLeave={() => {
          setListHeld(null);
          setHover(focus);
        }}
      >
        <div
          className={`vf-monitor-spend-head${g.compact ? ' is-slim' : ''}`}
          style={{ transform: `translate(${g.lx0}px, ${g.ly0}px)`, width: g.listW }}
        >
          <span>{headA}</span>
          <span>{headB}</span>
        </div>
        {rows.map((row, index) => rowElement(row, index, false))}
        {fit.more ? (
          <div
            className="vf-monitor-spend-row is-one is-rest"
            style={{
              transform: `translate(${g.lx0}px, ${listTop + fit.fits * g.rowH}px)`,
              width: g.listW,
              height: g.rowH - 2,
            }}
          >
            <span className="vf-monitor-spend-r1">
              <b className="vf-monitor-spend-name">{moreWords(fit)}</b>
              <span className="vf-monitor-spend-v" data-tone={fit.waitingUnshown > 0 ? 'attention' : undefined}>
                {fit.waitingUnshown > 0 ? `${fit.waitingUnshown} more waiting` : ''}
              </span>
            </span>
          </div>
        ) : null}
        {unpricedRows.map((row, index) => rowElement(row, index, true))}
      </div>
      {empty ? (
        <div className="vf-monitor-spend-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : null}
    </div>
  );
}
