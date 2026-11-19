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

describe("a host's colour picture", () => {
  const URL = 'data:image/png;base64,iVBORw0KGgo=';

  it('decodes a data URL as it is, never whitened, and places it once it lands', () => {
    const ready = vi.fn();
    const atlas = atlasSaying(ready);
    expect(atlas.picture('ada-face', URL, 14)).toBeUndefined();
    expect(atlas.picture('ada-face', URL, 14)).toBeUndefined();
    expect(images.map((image) => image.src)).toEqual([URL]);
    images[0]!.land();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(atlas.picture('ada-face', URL, 14)).toMatchObject({ width: 14, height: 14 });
    // a sprite of the same key is another picture
    expect(atlas.sprite('ada-face', SVG, 14)).toBeUndefined();
  });

  it('never decodes a string that is not a data URL, so a mark cannot make the swarm fetch', () => {
    const atlas = atlasSaying(vi.fn());
    expect(atlas.picture('ada-remote', 'https://example.com/face.png', 14)).toBeUndefined();
    expect(atlas.picture('ada-path', '/face.png', 14)).toBeUndefined();
    expect(images).toHaveLength(0);
  });

  it('draws a bitmap at once, as it is', () => {
    const drawn: unknown[] = [];
    class RecordingCanvas extends FakeCanvas {
      override getContext(): object {
        return { drawImage: (source: unknown) => drawn.push(source), clearRect: () => {} };
      }
    }
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const bitmap = { width: 28, height: 28 };
    const atlas = atlasSaying(vi.fn());
    expect(atlas.picture('ada-face', bitmap, 14)).toMatchObject({ width: 14, height: 14 });
    expect(drawn).toEqual([bitmap]);
    expect(images).toHaveLength(0);
  });
});
