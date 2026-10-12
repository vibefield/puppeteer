// The geometry audit, as a test: the orchestrator's rig (scratchpad
// sb/audit.mjs, run against the prototype in Chrome) ported to the pure
// machine. Open the bloom at every hold point of a grid, in every scenario,
// reach every desktop that blooms, and count what lands on what. The counts
// may not exceed the prototype's own residue on the same grid, measured with
// the same text measure (the prototype run headless with its canvas
// measureText replaced by this file's measure): the port is the audited
// geometry, so it can only match it or do better.

import { describe, expect, it } from 'vitest';
import { BLOOM, type BloomTextMeasure } from './constants.js';
import type { BloomPoint, BloomRect } from './geometry.js';
import { isInstant, openBloom, pointBloom, type BloomBud, type BloomState } from './model.js';
import { BLOOM_SCENARIOS } from './scenarios.js';

// characters × font px × 0.6, as every bloom test measures
const measure: BloomTextMeasure = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 0) * 0.6;

type ScenarioId = 'two' | 'three' | 'one-three';
const SCENARIOS: readonly ScenarioId[] = ['two', 'three', 'one-three'];

interface Stage {
  readonly field: { readonly w: number; readonly h: number };
  /** The rig's chrome, measured once before any scenario: holds on it are skipped, and a bud on it counts. */
  readonly skip: readonly BloomRect[];
  /** What the bloom keeps off in each scenario: the claims chip names the peers, so it widens with them. */
  readonly chrome: Readonly<Record<ScenarioId, readonly BloomRect[]>>;
  /** Holds and level-two openings the grid makes. */
  readonly poses: number;
  readonly l2poses: number;
  /** The prototype's residue on this grid (`…@corner`: of those, holds within 60 px of a corner). */
  readonly residue: Readonly<Record<string, number>>;
}

// The prototype's chrome, measured in Chrome: the usage column, and the claims
// chip ('4 managed agents', '… · 1 peer', '… · 2 peers' as the scenario grows).
const USAGE: BloomRect = { x: 12, y: 12, width: 112, height: 163 };
const claims = (x: number, width: number): BloomRect => ({ x, y: 12, width, height: 21 });
const CLAIMS_ONE = 123.34375;
const CLAIMS_TWO = 176.96875;
const CLAIMS_THREE = 182.921875;

/** The prototype's desktop stage (a 1280 px page) and the brief's narrow one (its phone stage, 370 wide, held at 470). */
const STAGES: Readonly<Record<string, Stage>> = {
  '1070×470': {
    field: { w: 1070, h: 470 },
    skip: [USAGE, claims(136, CLAIMS_ONE)],
    chrome: {
      two: [USAGE, claims(136, CLAIMS_TWO)],
      three: [USAGE, claims(136, CLAIMS_THREE)],
      'one-three': [USAGE, claims(136, CLAIMS_ONE)],
    },
    poses: 810,
    l2poses: 1080,
    // a profile label 13 px past the top edge and one into a sibling's hot
    // size (holds toward the top right); ring-two buds past the top and right
    // edges; ring-two buds on the usage column
    residue: {
      'L2:label-past-edge': 1,
      'L2:label-on-bud': 1,
      'L2:bud-past-edge': 26,
      'L2:bud-past-edge@corner': 2,
      'L2:bud-on-chrome': 5,
    },
  },
  '370×470': {
    field: { w: 370, h: 470 },
    // the usage column is hidden on the phone stage
    skip: [claims(12, CLAIMS_ONE)],
    chrome: {
      two: [claims(12, CLAIMS_TWO)],
      three: [claims(12, CLAIMS_THREE)],
      'one-three': [claims(12, CLAIMS_ONE)],
    },
    poses: 279,
    l2poses: 372,
    residue: {
      'L2:label-past-edge': 5,
      'L2:label-on-spoke': 1,
      'L2:bud-past-edge': 6,
      'L2:bud-past-edge@corner': 1,
      'L2:bud-on-chrome': 3,
      'L2:bud-on-bud': 1,
      'L2:bud-on-bud@corner': 1,
    },
  },
};

function rectDist(r: { x: number; y: number; w: number; h: number }, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** The rig's own segment test: 61 samples along it. */
function segRect(r: { x: number; y: number; w: number; h: number }, a: BloomPoint, b: BloomPoint): number {
  let best = Infinity;
  for (let i = 0; i <= 60; i += 1) {
    const t = i / 60;
    best = Math.min(best, rectDist(r, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }
  return best;
}

function runAudit(stage: Stage) {
  const { field, skip } = stage;
  const hits: Record<string, number> = {};
  let poses = 0;
  let l2poses = 0;
  let P: BloomPoint = { x: 0, y: 0 };
  const nearCorner = () =>
    Math.min(
      Math.hypot(P.x, P.y),
      Math.hypot(field.w - P.x, P.y),
      Math.hypot(P.x, field.h - P.y),
      Math.hypot(field.w - P.x, field.h - P.y),
    ) <= 60;
  const bump = (key: string) => {
    hits[key] = (hits[key] ?? 0) + 1;
    if (nearCorner()) hits[key + '@corner'] = (hits[key + '@corner'] ?? 0) + 1;
  };
  const audit = (s: BloomState, lvl: 'L1' | 'L2') => {
    const buds: BloomBud[] = [...s.l1, ...s.l2];
    buds.forEach((b, i) => {
      buds.forEach((o, j) => {
        if (j > i && Math.hypot(b.x - o.x, b.y - o.y) < b.d / 2 + o.d / 2) bump(lvl + ':bud-on-bud');
      });
      if (Math.hypot(b.x - s.P.x, b.y - s.P.y) < b.d / 2 + BLOOM.hubR) bump(lvl + ':bud-on-hub');
      if (Math.max(b.d / 2 - b.x, b.d / 2 - b.y, b.x + b.d / 2 - field.w, b.y + b.d / 2 - field.h) > 0) {
        bump(lvl + ':bud-past-edge');
      }
      for (const c of skip) {
        if (rectDist({ x: c.x, y: c.y, w: c.width, h: c.height }, b.x, b.y) < b.d / 2) bump(lvl + ':bud-on-chrome');
      }
    });
    const labels = buds.filter((b) => !b.gone).map((b) => ({ b, r: b.box }));
    labels.forEach(({ b, r }, i) => {
      for (const o of buds) {
        if (o !== b && rectDist(r, o.x, o.y) < (o.d / 2) * BLOOM.hot) bump(lvl + ':label-on-bud');
      }
      if (rectDist(r, s.P.x, s.P.y) < BLOOM.hubR + 3) bump(lvl + ':label-on-hub');
      if (s.open && segRect(r, s.P, s.open.pos) < 1.5) bump(lvl + ':label-on-spoke');
      labels.forEach((q, j) => {
        if (j <= i) return;
        const ix = Math.min(r.x + r.w, q.r.x + q.r.w) - Math.max(r.x, q.r.x);
        const iy = Math.min(r.y + r.h, q.r.y + q.r.h) - Math.max(r.y, q.r.y);
        if (ix > 0 && iy > 0) bump(lvl + ':label-on-label');
      });
      if (Math.max(-r.x, -r.y, r.x + r.w - field.w, r.y + r.h - field.h) > 0) bump(lvl + ':label-past-edge');
    });
  };
  for (const id of SCENARIOS) {
    const env = { field, chrome: stage.chrome[id], measure, now: 1000 };
    for (let y = 24; y <= field.h - 24; y += 38) {
      for (let x = 24; x <= field.w - 24; x += 44) {
        if (skip.some((c) => x >= c.x - 4 && x <= c.x + c.width + 4 && y >= c.y - 4 && y <= c.y + c.height + 4))
          continue;
        P = { x, y };
        const opened = openBloom(env, P, 'sticky', BLOOM_SCENARIOS[id]);
        if (isInstant(opened)) throw new Error(`${id} did not bloom`);
        poses += 1;
        audit(opened, 'L1');
        const devices = opened.l1.filter(
          (b) =>
            b.item.kind === 'device' && b.item.device.state === 'ready' && (b.item.device.profiles ?? []).length >= 2,
        );
        let s = opened;
        for (const d of devices) {
          s = pointBloom(env, s, { x: P.x + (d.x - P.x) * 1.02, y: P.y + (d.y - P.y) * 1.02 });
          if (!s.open) bump('no-level-two');
          else {
            l2poses += 1;
            audit(s, 'L2');
          }
          s = pointBloom(env, s, P);
          if (s.open || s.l2.length) bump('no-collapse');
          for (const b of s.l1) {
            if (b.gone || b.box.x !== b.home.box.x || b.box.y !== b.home.box.y || b.short !== b.home.short) {
              bump('not-home');
            }
          }
        }
      }
    }
  }
  return { hits, poses, l2poses };
}

describe('the geometry audit (the prototype’s rig, over the pure machine)', () => {
  for (const [name, stage] of Object.entries(STAGES)) {
    it(`${name}: every hold of the grid, every desktop reached — no worse than the prototype`, () => {
      const { hits, poses, l2poses } = runAudit(stage);
      expect([poses, l2poses]).toEqual([stage.poses, stage.l2poses]);
      for (const [key, count] of Object.entries(hits)) {
        expect({ key, count }).toEqual({ key, count: Math.min(count, stage.residue[key] ?? 0) });
      }
      // the rules the audit holds everywhere: a bud never on another bud or the hub
      // (but for the one phone-corner hold the prototype shares), a label never on
      // another label or the hub, every ring collapsing with its words back home
      expect(hits['L1:bud-on-hub'] ?? 0).toBe(0);
      expect(hits['L2:bud-on-hub'] ?? 0).toBe(0);
      expect(hits['L1:label-on-label'] ?? 0).toBe(0);
      expect(hits['L2:label-on-label'] ?? 0).toBe(0);
      expect(hits['L1:label-on-hub'] ?? 0).toBe(0);
      expect(hits['L2:label-on-hub'] ?? 0).toBe(0);
      expect(hits['no-level-two'] ?? 0).toBe(0);
      expect(hits['no-collapse'] ?? 0).toBe(0);
      expect(hits['not-home'] ?? 0).toBe(0);
      // ring one never puts a label on anything, anywhere on the grid
      for (const key of Object.keys(hits)) if (key.startsWith('L1:label')) expect(key).toBe('none');
    }, 120_000);
  }
});
