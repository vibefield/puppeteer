import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlyphAtlas } from './glyph-atlas.js';

// A PICTURE DECODES AFTER THE FRAME THAT ASKED FOR IT. On a field held still nothing draws again by itself, so the
// atlas says when one has landed. The platform's parts are fakes: a canvas that draws nowhere, and an image whose
// decode finishes when the test says.

class FakeImage {
  decoding = '';
  src = '';
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    images.push(this);
  }

  /** The decode lands. */
  land(): void {
    this.complete = true;
    this.naturalWidth = 24;
    this.onload?.();
  }
}

class FakeCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(): object {
    return { drawImage: () => {}, clearRect: () => {} };
  }
}

const images: FakeImage[] = [];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"/>';
const device = { createTexture: () => ({ destroy: () => {} }) } as unknown as GPUDevice;

function atlasSaying(ready: () => void): GlyphAtlas {
  // @ts-expect-error the fifth argument comes with the fix this row is red for
  return new GlyphAtlas(device, 1, undefined, undefined, ready);
}

beforeEach(() => {
  images.length = 0;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a sprite that decodes after the frame that asked for it', () => {
  it('is absent until it lands, says so when it does, and is there to draw after', () => {
    const ready = vi.fn();
    const atlas = atlasSaying(ready);
    expect(atlas.sprite('icon:profile:flask', SVG, 10.5)).toBeUndefined();
    expect(ready).not.toHaveBeenCalled();
    images[0]!.land();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(atlas.sprite('icon:profile:flask', SVG, 10.5)).toMatchObject({ width: 11, height: 11 });
  });

  it('asks once for a picture many frames wanted, and says nothing of one that failed to decode', () => {
    const ready = vi.fn();
    const atlas = atlasSaying(ready);
    atlas.sprite('icon:profile:flask', SVG, 10.5);
    atlas.sprite('icon:profile:flask', SVG, 10.5);
    expect(images).toHaveLength(1);
    images[0]!.onerror?.();
    expect(ready).not.toHaveBeenCalled();
  });
});
