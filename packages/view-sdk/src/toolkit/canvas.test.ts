import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasRatio, sizeCanvas, watchDevicePixelRatio, type SizableCanvas } from './canvas.js';

function fakeCanvas(): SizableCanvas & { writes: number } {
  let width = 300;
  let height = 150;
  const canvas = {
    writes: 0,
    style: { width: '', height: '' },
    get width() {
      return width;
    },
    set width(value: number) {
      canvas.writes += 1;
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      canvas.writes += 1;
      height = value;
    },
  };
  return canvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the device ratio', () => {
  it("reads the display's ratio, 1 where there is none, capped when asked", () => {
    expect(canvasRatio()).toBe(1);
    vi.stubGlobal('devicePixelRatio', 3);
    expect(canvasRatio()).toBe(3);
    expect(canvasRatio(2)).toBe(2);
  });
});

describe('sizing a canvas', () => {
  it('sizes the backing store in device pixels and the element in CSS pixels', () => {
    const canvas = fakeCanvas();
    const sizing = sizeCanvas(canvas, 200.4, 99.6, { ratio: 2 });
    expect(sizing).toEqual({ width: 200, height: 100, ratio: 2, pixelWidth: 400, pixelHeight: 200, resized: true });
    expect([canvas.width, canvas.height]).toEqual([400, 200]);
    expect(canvas.style).toEqual({ width: '200px', height: '100px' });
  });

  it('does not write an unchanged size, which would clear the canvas', () => {
    const canvas = fakeCanvas();
    sizeCanvas(canvas, 200, 100, { ratio: 2 });
    const writes = canvas.writes;
    expect(sizeCanvas(canvas, 200, 100, { ratio: 2 }).resized).toBe(false);
    expect(canvas.writes).toBe(writes);
  });

  it("caps the display's ratio as the timeline does", () => {
    vi.stubGlobal('devicePixelRatio', 3);
    expect(sizeCanvas(fakeCanvas(), 10, 10, { maxRatio: 2 }).pixelWidth).toBe(20);
    expect(sizeCanvas(fakeCanvas(), 10, 10).pixelWidth).toBe(30);
  });

  it('rounds a fractional backing size, or floors it as the rain did', () => {
    expect(sizeCanvas(fakeCanvas(), 101, 101, { ratio: 1.5 }).pixelWidth).toBe(152);
    expect(sizeCanvas(fakeCanvas(), 101, 101, { ratio: 1.5, pixels: 'floor' }).pixelWidth).toBe(151);
  });

  it('never sizes below one pixel', () => {
    const sizing = sizeCanvas(fakeCanvas(), 0, -4, { ratio: 2 });
    expect([sizing.width, sizing.height, sizing.pixelWidth, sizing.pixelHeight]).toEqual([1, 1, 2, 2]);
  });
});

describe('watching the device ratio', () => {
  function fakeMatchMedia() {
    const queries: { query: string; listeners: Set<() => void> }[] = [];
    const matchMedia = (query: string) => {
      const entry = { query, listeners: new Set<() => void>() };
      queries.push(entry);
      return {
        addEventListener: (_type: string, listener: () => void) => entry.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => entry.listeners.delete(listener),
      };
    };
    return { matchMedia, queries };
  }

  it('calls back with the new ratio and re-arms on the new resolution', () => {
    const media = fakeMatchMedia();
    vi.stubGlobal('matchMedia', media.matchMedia);
    vi.stubGlobal('devicePixelRatio', 2);
    const seen: number[] = [];
    const stop = watchDevicePixelRatio((ratio) => seen.push(ratio));
    expect(media.queries.map((entry) => entry.query)).toEqual(['(resolution: 2dppx)']);

    vi.stubGlobal('devicePixelRatio', 1);
    for (const listener of [...media.queries[0]!.listeners]) listener();
    expect(seen).toEqual([1]);
    expect(media.queries[0]!.listeners.size).toBe(0);
    expect(media.queries[1]!.query).toBe('(resolution: 1dppx)');

    stop();
    expect(media.queries[1]!.listeners.size).toBe(0);
  });

  it('does nothing where there is no matchMedia', () => {
    const seen: number[] = [];
    watchDevicePixelRatio((ratio) => seen.push(ratio))();
    expect(seen).toEqual([]);
  });
});
