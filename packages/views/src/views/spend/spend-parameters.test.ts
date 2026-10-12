import { describe, expect, it } from 'vitest';
import { parameterDefaults } from '@vibefield/puppeteer-view-sdk/testing';
import { SPEND_MANIFEST } from './index.js';
import { paintSpend, type Rgba, type SpendInks, type SpendScene } from './spend-paint.js';
import {
  DEFAULT_SPEND_PARAMETERS,
  normalizeSpendParameters,
  SPEND_PARAMETER_GROUPS,
  type SpendParameters,
} from './spend-parameters.js';

const GREY: Rgba = [0.5, 0.5, 0.5, 1];
const INKS: SpendInks = {
  dark: false,
  ground: [1, 1, 1, 1],
  ink: [0, 0, 0, 1],
  orange: GREY,
  blue: GREY,
  orangeInk: GREY,
  blueInk: GREY,
  greenInk: GREY,
  project: () => GREY,
};

/** A 2D context that keeps what was asked of it: each stroke's width, and how many washes were laid. */
function recorder() {
  const strokes: number[] = [];
  let washes = 0;
  const ctx = {
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '' as unknown,
    lineJoin: '',
    lineCap: '',
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    rect() {},
    clip() {},
    save() {},
    restore() {},
    setLineDash() {},
    arc() {},
    fill() {},
    fillRect() {},
    stroke() {
      strokes.push(ctx.lineWidth);
    },
    createLinearGradient() {
      washes += 1;
      return { addColorStop() {} };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, washes: () => washes };
}

/** One line climbing across the plot, pointed at or not; no grid, no heads: the now line, then the line. */
function scene(settings: SpendParameters, hot: string | null): SpendScene {
  return {
    width: 400,
    height: 200,
    ratio: 1,
    x0: 0,
    x1: 300,
    y0: 20,
    y1: 180,
    weight: settings.weight,
    wash: settings.wash,
    grid: [],
    nowX: 300,
    lines: [
      {
        id: 'a',
        colour: GREY,
        points: [
          [0, 180],
          [300, 60],
        ],
      },
    ],
    hot,
    fadeX: null,
    heads: [],
    waves: false,
    time: 0,
  };
}

describe('the spend tunables', () => {
  it('offers one group, LINES — line weight and lit wash — and the manifest declares it, revised', () => {
    expect(SPEND_MANIFEST.parameters).toBe(SPEND_PARAMETER_GROUPS);
    // Its own defaults from the start: a revision keeps the view off the legacy seed an unrevised view reads.
    expect(SPEND_MANIFEST.parametersRevision).toBe('2026-10-03');
    expect(SPEND_PARAMETER_GROUPS.map((group) => group.title)).toEqual(['LINES']);
    expect(SPEND_PARAMETER_GROUPS[0]!.controls).toEqual([
      { key: 'weight', label: 'Line weight', min: 1, max: 3, step: 0.25, defaultValue: 1.75 },
      { key: 'wash', label: 'Lit wash', min: 0, max: 2, step: 0.1, defaultValue: 1 },
    ]);
    expect(parameterDefaults(SPEND_MANIFEST)).toEqual(DEFAULT_SPEND_PARAMETERS);
  });

  it('normalizes: the defaults for anything missing or not a number, every value clamped to its control', () => {
    expect(normalizeSpendParameters(undefined)).toEqual({ weight: 1.75, wash: 1 });
    expect(normalizeSpendParameters('heavy')).toEqual(DEFAULT_SPEND_PARAMETERS);
    expect(normalizeSpendParameters({ weight: 9, wash: -1 })).toEqual({ weight: 3, wash: 0 });
    expect(normalizeSpendParameters({ weight: 2.5, wash: Number.NaN, glow: 4 })).toEqual({ weight: 2.5, wash: 1 });
  });

  it('paints a line at the weight set, the lit one 0.75 heavier, and lays the wash only when it is above 0', () => {
    const rest = recorder();
    paintSpend(rest.ctx, scene(normalizeSpendParameters({}), null), INKS);
    expect(rest.strokes).toEqual([1, 1.75]);
    const heavy = recorder();
    paintSpend(heavy.ctx, scene(normalizeSpendParameters({ weight: 3 }), null), INKS);
    expect(heavy.strokes.at(-1)).toBe(3);
    const lit = recorder();
    paintSpend(lit.ctx, scene(normalizeSpendParameters({ weight: 2 }), 'a'), INKS);
    expect(lit.strokes.at(-1)).toBe(2.75);
    expect(lit.washes()).toBe(1);
    const bare = recorder();
    paintSpend(bare.ctx, scene(normalizeSpendParameters({ wash: 0 }), 'a'), INKS);
    expect(bare.washes()).toBe(0);
  });
});
