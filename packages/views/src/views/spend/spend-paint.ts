import type { MonitorPalette } from '@vibefield/puppeteer-view-sdk';
import {
  isLightTheme,
  readableColour,
  resolveCssColor,
  rgbaCss as css,
  type Rgba,
} from '@vibefield/puppeteer-view-sdk/toolkit';
import type { SpendStateKey } from './spend-words.js';

// The spend view's canvas: the grid, the lines, the heads at now, the hair at a
// moment. Every colour comes from the palette the host hands the view (the
// swarm's own resolved orange and blue, the instrument ink) or from a row's
// project colour; the only other values are alphas of those. The geometry is
// the prototype's `draw()`, `drawHeads()`, `drawCross()` and `startMark()`
// (`draft/godview-spend/site/sv-chart.js`), design B; the line weight and the
// lit wash are the view's two tunables (`spend-parameters.ts`).

export type { Rgba };
export { css };

/** The palette resolved to the numbers a 2D context wants, once per theme. */
export interface SpendInks {
  readonly dark: boolean;
  /** The stage's ground: a head's halo and the start mark's ring are filled with it. */
  readonly ground: Rgba;
  readonly ink: Rgba;
  readonly orange: Rgba;
  readonly blue: Rgba;
  /** Words in the state's colour, readable on this theme's ground. */
  readonly orangeInk: Rgba;
  readonly blueInk: Rgba;
  readonly greenInk: Rgba;
  /** A project colour, resolved in the view's own cascade (a host may hand `var()`). */
  project(colour: string): Rgba;
}

/**
 * The swarm's inks, by the toolkit's light rules (`/toolkit` light.ts, M57): the
 * instrument ink, the state lights at full chroma, and the same lights darkened
 * toward the ink to be read as words on a light theme.
 */
export function resolveSpendInks(palette: MonitorPalette, context: Element | undefined): SpendInks {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const ink = resolve(palette.swarm.ink);
  const light = isLightTheme(ink);
  const orange = resolve(palette.swarm.orange);
  const green = resolve(palette.swarm.green);
  const blue = resolve(palette.swarm.blue);
  const projects = new Map<string, Rgba>();
  return {
    dark: !light,
    ground: resolve(palette.timeline.ground),
    ink,
    orange,
    blue,
    orangeInk: readableColour(orange, ink, light),
    blueInk: readableColour(blue, ink, light),
    greenInk: readableColour(green, ink, light),
    project(colour) {
      let resolved = projects.get(colour);
      if (!resolved) {
        resolved = resolve(colour);
        projects.set(colour, resolved);
      }
      return resolved;
    },
  };
}

export interface SceneLine {
  readonly id: string;
  readonly colour: Rgba;
  /** What it spent across the window, from $0, in canvas px. */
  readonly points: readonly (readonly [number, number])[];
}

export interface SceneHead {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly colour: Rgba;
  readonly key: SpendStateKey;
}

export interface SpendScene {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** A line's width at rest (the lit one is 0.75 heavier), and the lit wash as a multiple of §8's. */
  readonly weight: number;
  readonly wash: number;
  /** The money grid's lines, in px; the first is $0. */
  readonly grid: readonly number[];
  /** The now line, at the plot's right edge. */
  readonly nowX: number;
  readonly lines: readonly SceneLine[];
  /** The row or line pointed at: lit, the rest faint. */
  readonly hot: string | null;
  /** Past the moment pointed at the chart fades (SV-D17); the hot line keeps its future at half strength. */
  readonly fadeX: number | null;
  readonly heads: readonly SceneHead[];
  /** The wave is allowed (motion on, nothing faded). */
  readonly waves: boolean;
  /** The hair at the moment, its dots, and whether the moment is set (SV-D18). */
  readonly cross?:
    | {
        readonly x: number;
        readonly held: boolean;
        readonly dots: readonly { x: number; y: number; colour: Rgba; id: string }[];
      }
    | undefined;
  /** With a moment set, where another click would move it. */
  readonly ghostX?: number | undefined;
  /** A row not yet started at the moment, pointed at: where it will start. */
  readonly start?: { readonly x: number; readonly y: number; readonly colour: Rgba } | undefined;
  /** The animation clock, for the wave's phase. */
  readonly time: number;
}

const TAU = Math.PI * 2;
/** The swarm's wave: 1.1 s out of a head waiting on you. */
const WAVE_MS = 1100;

function path(ctx: CanvasRenderingContext2D, points: SceneLine['points']): void {
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
}

/** Whether any head moves on its own: the loop repaints only then. */
export function sceneMoves(scene: SpendScene): boolean {
  return scene.waves && scene.heads.some((head) => head.key === 'blocked' || head.key === 'unseen');
}

export function paintSpend(ctx: CanvasRenderingContext2D, scene: SpendScene, inks: SpendInks): void {
  const { ratio, x0, x1, y0, y1, hot, fadeX } = scene;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.lineWidth = 1;
  scene.grid.forEach((gy, index) => {
    const y = Math.round(gy) + 0.5;
    ctx.strokeStyle = css(inks.ink, index === 0 ? 0.14 : 0.06);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  });
  const nowX = Math.round(scene.nowX) + 0.5;
  ctx.strokeStyle = css(inks.ink, 0.16);
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(nowX, y0 - 6);
  ctx.lineTo(nowX, y1);
  ctx.stroke();
  ctx.setLineDash([]);

  // The lines, the one pointed at last.
  const lines = [...scene.lines].sort((a, b) => Number(a.id === hot) - Number(b.id === hot));
  const zeroY = scene.grid[0] ?? y1;
  for (const line of lines) {
    const dim = hot !== null && line.id !== hot;
    const lit = line.id === hot;
    const alpha = dim ? 0.18 : 1;
    const width = hot === null ? scene.weight : scene.weight + (lit ? 0.75 : 0.25);
    const future = alpha * (lit && !scene.start ? 0.5 : 0.22);
    if (line.points.length < 2) continue;
    if (lit && scene.wash > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, (fadeX ?? x1) - x0, scene.height);
      ctx.clip();
      ctx.beginPath();
      path(ctx, line.points);
      ctx.lineTo(line.points[line.points.length - 1]![0], zeroY);
      ctx.lineTo(line.points[0]![0], zeroY);
      ctx.closePath();
      const wash = ctx.createLinearGradient(0, y0, 0, y1);
      wash.addColorStop(0, css(line.colour, Math.min(1, 0.16 * scene.wash)));
      wash.addColorStop(1, css(line.colour, Math.min(1, 0.02 * scene.wash)));
      ctx.fillStyle = wash;
      ctx.fill();
      ctx.restore();
    }
    const stroke = (from: number, to: number, a: number): void => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, 0, to - from, scene.height);
      ctx.clip();
      ctx.strokeStyle = css(line.colour, a);
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      path(ctx, line.points);
      ctx.stroke();
      ctx.restore();
    };
    if (fadeX !== null) {
      stroke(x0 - 4, fadeX, alpha);
      stroke(fadeX, x1 + 8, future);
    } else stroke(x0 - 4, x1 + 8, alpha);
  }

  paintHeads(ctx, scene, inks);
  paintCross(ctx, scene, inks);
  if (scene.start) paintStart(ctx, scene, scene.start, inks);
}

/** The heads, in two passes so a ring never covers another head: every wave and ring, then every dot. */
function paintHeads(ctx: CanvasRenderingContext2D, scene: SpendScene, inks: SpendInks): void {
  const faded = scene.fadeX !== null;
  for (const head of scene.heads) {
    const waiting = head.key === 'blocked' || head.key === 'unseen';
    if (!waiting) continue;
    const dim = scene.hot !== null && head.id !== scene.hot;
    const r = head.id === scene.hot ? 4.5 : 4;
    const light = head.key === 'blocked' ? inks.orange : inks.blue;
    const base = faded ? 0.22 : dim ? 0.35 : 1;
    if (scene.waves && !faded) {
      const phase = (scene.time / WAVE_MS) % 1;
      const eased = 1 - Math.pow(1 - phase, 3);
      ctx.strokeStyle = css(light, (dim ? 0.3 : 0.7) * (1 - phase));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 6 + eased * 11, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = css(light, base);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(head.x, head.y, r + 3.5, 0, TAU);
    ctx.stroke();
  }
  for (const head of scene.heads) {
    const dim = scene.hot !== null && head.id !== scene.hot;
    const r = head.id === scene.hot ? 4.5 : 4;
    const alpha = faded ? 0.3 : dim ? 0.35 : 1;
    ctx.fillStyle = css(inks.ground, alpha);
    ctx.beginPath();
    ctx.arc(head.x, head.y, r + 1.5, 0, TAU);
    ctx.fill();
    if (head.key === 'idle') {
      ctx.strokeStyle = css(head.colour, alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(head.x, head.y, r - 1, 0, TAU);
      ctx.stroke();
    } else {
      ctx.fillStyle = css(head.colour, alpha);
      ctx.beginPath();
      ctx.arc(head.x, head.y, r, 0, TAU);
      ctx.fill();
    }
  }
}

function paintCross(ctx: CanvasRenderingContext2D, scene: SpendScene, inks: SpendInks): void {
  const cross = scene.cross;
  if (!cross) return;
  if (scene.ghostX !== undefined && Math.abs(scene.ghostX - cross.x) > 3) {
    const gx = Math.round(scene.ghostX) + 0.5;
    ctx.save();
    ctx.strokeStyle = css(inks.ink, 0.22);
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, scene.y0 - 4);
    ctx.lineTo(gx, scene.y1);
    ctx.stroke();
    ctx.restore();
  }
  const x = Math.round(cross.x) + 0.5;
  ctx.strokeStyle = css(inks.ink, cross.held ? 0.5 : 0.32);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, scene.y0 - 4);
  ctx.lineTo(x, scene.y1);
  ctx.stroke();
  for (const dot of cross.dots) {
    const alpha = scene.hot !== null && dot.id !== scene.hot ? 0.4 : 1;
    ctx.fillStyle = css(inks.ground, alpha);
    ctx.beginPath();
    ctx.arc(x, dot.y, 5.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = css(dot.colour, alpha);
    ctx.beginPath();
    ctx.arc(x, dot.y, 3.5, 0, TAU);
    ctx.fill();
  }
}

/** Where a row that hadn't started at the moment will start: a dotted hair in its colour, a ring on $0. */
function paintStart(
  ctx: CanvasRenderingContext2D,
  scene: SpendScene,
  start: { x: number; y: number; colour: Rgba },
  inks: SpendInks,
): void {
  const x = Math.round(start.x) + 0.5;
  ctx.save();
  ctx.strokeStyle = css(start.colour, 0.7);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x, scene.y0 - 4);
  ctx.lineTo(x, start.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = css(start.colour);
  ctx.lineWidth = 2;
  ctx.fillStyle = css(inks.ground);
  ctx.beginPath();
  ctx.arc(x, start.y, 4, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
