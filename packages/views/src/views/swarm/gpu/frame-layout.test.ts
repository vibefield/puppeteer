import { describe, expect, it } from 'vitest';
import { SWARM_WEIGHT } from '../weight.js';
import {
  CLEARING_FLOATS,
  FRAME_FLOATS,
  FRAME_LAYOUT,
  HOLD_RING,
  HUB_RING,
  MAX_CLEARINGS,
  packFrame,
} from './frame-layout.js';
import common from './shaders/common.wgsl.js';
import type { SwarmClearing, SwarmFrame, SwarmTheme } from './swarm-renderer.js';

// The frame uniform's layout, without a GPU: the offsets the renderer packs at
// are the `Frame` struct's own, and each field of a frame lands where the
// shaders read it.

const INK: [number, number, number, number] = [0.07, 0.07, 0.07, 1];
const THEME: SwarmTheme = {
  surface: [0.9, 0.9, 0.9, 0.8],
  ink: INK,
  grid: [0, 0, 0, 0.05],
  orange: [1, 0.62, 0.04, 1],
  green: [0.2, 0.7, 0.3, 1],
  blue: [0.3, 0.56, 0.85, 1],
  stateInk: { orange: [0.8, 0.4, 0, 1], green: [0.1, 0.5, 0.2, 1], blue: [0.1, 0.3, 0.7, 1] },
  stateGlow: { orange: [1, 0.7, 0.2, 1], blue: [0.4, 0.6, 1, 1] },
  stateGround: { orange: [1, 0.9, 0.8, 1], blue: [0.85, 0.9, 1, 1] },
  shadow: [0, 0, 0, 0.16],
  shadowPeak: [0, 0, 0, 0.3],
};

function frameOf(overrides: Partial<SwarmFrame> = {}): SwarmFrame {
  return {
    time: 12.5,
    motion: true,
    fillOpacity: 0.9,
    gridPitch: 24,
    glow: { reach: 30, strength: 0.5, breath: 0.2 },
    stateGlow: { inner: 0.1, full: 0.9, strength: 0.8, count: 2, speed: 0.4, depth: 0.3 },
    theme: THEME,
    bodies: [],
    ...overrides,
  };
}

function pack(frame: SwarmFrame): Float32Array {
  const target = new Float32Array(FRAME_FLOATS).fill(Number.NaN);
  packFrame(target, frame, { width: 800, height: 600, dpr: 2, time: 12.5 });
  return target;
}

/** A struct's members as common.wgsl declares them, in order. */
function wgslStruct(name: string): { name: string; type: string }[] {
  const body = new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\};`).exec(common)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => {
      const match = /^(\w+): (.+),$/.exec(line);
      if (!match) throw new Error(`unreadable ${name} member: ${line}`);
      return { name: match[1]!, type: match[2]! };
    });
}

/** Floats a member takes: a vec4, or an array of structs made of vec4s. */
function floatsOf(type: string): number {
  if (type === 'vec4f') return 4;
  const array = /^array<(\w+), (\d+)>$/.exec(type);
  if (!array) throw new Error(`unsized member type: ${type}`);
  return Number(array[2]) * wgslStruct(array[1]!).reduce((sum, member) => sum + floatsOf(member.type), 0);
}

function clearingOf(data: Float32Array, index: number): number[] {
  const offset = FRAME_LAYOUT.clearings + index * CLEARING_FLOATS;
  return [...data.slice(offset, offset + CLEARING_FLOATS)];
}

describe('the frame uniform', () => {
  it('packs at the Frame struct’s own offsets', () => {
    const members = wgslStruct('Frame');
    expect(members.map((member) => member.name)).toEqual(Object.keys(FRAME_LAYOUT));
    let offset = 0;
    for (const member of members) {
      expect(FRAME_LAYOUT[member.name as keyof typeof FRAME_LAYOUT], member.name).toBe(offset);
      offset += floatsOf(member.type);
    }
    expect(FRAME_FLOATS).toBe(offset);
    expect(floatsOf('array<Clearing, 1>')).toBe(CLEARING_FLOATS);
    expect(common).toContain(`clearings: array<Clearing, ${MAX_CLEARINGS}>,`);
    expect(common).toContain(`const MAX_CLEARINGS: u32 = ${MAX_CLEARINGS}u;`);
  });

  it('writes every float', () => {
    expect(pack(frameOf()).every((value) => Number.isFinite(value))).toBe(true);
  });

  it('carries the viewport, the clock and the field’s parameters', () => {
    const data = pack(frameOf({ motion: false }));
    expect([...data.slice(FRAME_LAYOUT.viewport, FRAME_LAYOUT.viewport + 4)]).toEqual([800, 600, 2, 12.5]);
    expect(data[FRAME_LAYOUT.params]).toBeCloseTo(0.9);
    expect(data[FRAME_LAYOUT.params + 1]).toBe(0);
    expect(data[FRAME_LAYOUT.params + 2]).toBe(24);
  });

  it('carries the veil in params.w, clamped, and none by default', () => {
    expect(pack(frameOf())[FRAME_LAYOUT.params + 3]).toBe(0);
    expect(pack(frameOf({ veil: 0.8 }))[FRAME_LAYOUT.params + 3]).toBeCloseTo(0.8);
    expect(pack(frameOf({ veil: 1.4 }))[FRAME_LAYOUT.params + 3]).toBe(1);
    expect(pack(frameOf({ veil: -0.2 }))[FRAME_LAYOUT.params + 3]).toBe(0);
  });

  it('draws no ring without a hold', () => {
    const data = pack(frameOf());
    expect([...data.slice(FRAME_LAYOUT.pointer, FRAME_LAYOUT.pointer + 4)]).toEqual([0, 0, 0, 0]);
  });

  it('carries a hold in flight at its progress, clamped, at full opacity', () => {
    const data = pack(frameOf({ hold: { x: 120, y: 80, progress: 0.4 } }));
    expect(data[FRAME_LAYOUT.pointer]).toBe(120);
    expect(data[FRAME_LAYOUT.pointer + 1]).toBe(80);
    expect(data[FRAME_LAYOUT.pointer + 2]).toBeCloseTo(0.4);
    expect(data[FRAME_LAYOUT.pointer + 3]).toBe(1);
    expect(pack(frameOf({ hold: { x: 0, y: 0, progress: 1.7 } }))[FRAME_LAYOUT.pointer + 2]).toBe(1);
    // In flight, the ring keeps today's weights: a 1 px rim and a 2 px dot.
    expect([...data.slice(FRAME_LAYOUT.holdShape, FRAME_LAYOUT.holdShape + 4)]).toEqual([1, 2, 0, 0]);
    expect(HOLD_RING).toEqual({ rim: 1, dot: 2 });
  });

  it('holds the frozen hub at the ring’s final look, faded by its opacity', () => {
    const open = pack(frameOf({ hold: { x: 50, y: 60, progress: 0.3, frozen: true } }));
    expect(open[FRAME_LAYOUT.pointer + 2]).toBe(1);
    expect(open[FRAME_LAYOUT.pointer + 3]).toBe(1);
    const closing = pack(frameOf({ hold: { x: 50, y: 60, progress: 1, frozen: true, opacity: 0.35 } }));
    expect(closing[FRAME_LAYOUT.pointer + 2]).toBe(1);
    expect(closing[FRAME_LAYOUT.pointer + 3]).toBeCloseTo(0.35);
    // The hub is drawn heavier, as the prototype's v2 does: a 1.5 px rim and a 2.5 px dot.
    expect([...open.slice(FRAME_LAYOUT.holdShape, FRAME_LAYOUT.holdShape + 4)]).toEqual([1.5, 2.5, 0, 0]);
    expect(HUB_RING).toEqual({ rim: 1.5, dot: 2.5 });
  });

  it('packs no clearing by default, and zeroes every slot', () => {
    const data = pack(frameOf());
    expect(data[FRAME_LAYOUT.clearing]).toBe(0);
    for (let index = 0; index < MAX_CLEARINGS; index += 1) {
      expect(clearingOf(data, index)).toEqual(new Array(CLEARING_FLOATS).fill(0));
    }
  });

  it('packs a circle by its centre and radius, and a rect by its centre and half extents', () => {
    const data = pack(
      frameOf({
        clearings: [
          { kind: 'circle', x: 200, y: 150, radius: 108, feather: 44 },
          { kind: 'rect', x: 40, y: 30, width: 300, height: 90, feather: 64, opacity: 0.5 },
        ],
      }),
    );
    expect(data[FRAME_LAYOUT.clearing]).toBe(2);
    expect(clearingOf(data, 0)).toEqual([200, 150, 108, 0, 44, 0, 1, 0]);
    expect(clearingOf(data, 1)).toEqual([190, 75, 150, 45, 64, 1, 0.5, 0]);
    expect(clearingOf(data, 2)).toEqual(new Array(CLEARING_FLOATS).fill(0));
  });

  it('keeps the first MAX_CLEARINGS clearings and clamps what cannot be drawn', () => {
    const many: SwarmClearing[] = Array.from({ length: MAX_CLEARINGS + 2 }, (_, index) => ({
      kind: 'circle',
      x: index,
      y: 0,
      radius: 10,
      feather: 5,
    }));
    const data = pack(frameOf({ clearings: many }));
    expect(data[FRAME_LAYOUT.clearing]).toBe(MAX_CLEARINGS);
    expect(clearingOf(data, MAX_CLEARINGS - 1)[0]).toBe(MAX_CLEARINGS - 1);
    const odd = pack(
      frameOf({ clearings: [{ kind: 'rect', x: 0, y: 0, width: -4, height: 8, feather: -1, opacity: 3 }] }),
    );
    expect(clearingOf(odd, 0)).toEqual([0, 4, 0, 4, 0, 1, 1, 0]);
  });

  it('paints the ring in the theme: surface at 74%, rim at the supporting weight, the ink', () => {
    const data = pack(frameOf());
    expect(data[FRAME_LAYOUT.holdFill + 3]).toBeCloseTo(0.8 * 0.74);
    expect([...data.slice(FRAME_LAYOUT.holdRim, FRAME_LAYOUT.holdRim + 3)]).toEqual(
      INK.slice(0, 3).map((value) => Math.fround(value)),
    );
    expect(data[FRAME_LAYOUT.holdRim + 3]).toBeCloseTo(SWARM_WEIGHT.supporting);
    expect(data[FRAME_LAYOUT.holdInk + 3]).toBe(1);
  });
});
