/// <reference types="@webgpu/types" />
import type { TextStyle } from '../text-layout.js';

// The swarm's type, rasterised once per glyph and drawn as instanced quads.
//
// Glyphs come from Canvas2D at the device pixel ratio, in the same monospace
// stack the shell uses, so the swarm's 7–14px labels are the OS rasteriser's
// own pixels — the reference the design was approved against. A distance-field
// atlas was considered and rejected: it needs a font file (the shell's face is
// the OS's, not shipped), and at 7px hinting beats reconstruction. Pictures
// (the provider mark, the activity and blocker glyphs, the folder) rasterise
// into the same atlas from inline SVG, so text and marks share one draw.

export interface AtlasRegion {
  /** Texture coordinates, 0..1. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Bitmap size in CSS px. */
  width: number;
  height: number;
  /** Bitmap origin relative to the pen (glyph) or the box (sprite), CSS px. */
  left: number;
  top: number;
  /** Pen advance in CSS px, before letter spacing. */
  advance: number;
}

export interface FontMetrics {
  ascent: number;
  descent: number;
}

const FONT_STACK = "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Monaco, Consolas, monospace";
const PADDING = 1;

function fontFor(style: TextStyle, dpr: number): string {
  return `${style.italic ? 'italic ' : ''}${style.weight} ${(style.size * dpr).toFixed(2)}px ${FONT_STACK}`;
}

function styleKey(style: TextStyle): string {
  return `${style.weight}|${style.italic ? 'i' : 'n'}|${style.size}`;
}

export class GlyphAtlas {
  readonly texture: GPUTexture;
  readonly size: number;
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private readonly regions = new Map<string, AtlasRegion>();
  private readonly metrics = new Map<string, FontMetrics>();
  private readonly pendingSprites = new Set<string>();
  private readonly spriteImages = new Map<string, HTMLImageElement>();
  private shelfX = PADDING;
  private shelfY = PADDING;
  private shelfHeight = 0;
  private dirty = false;
  private generation = 0;
  dpr: number;

  constructor(
    private readonly device: GPUDevice,
    dpr: number,
    size = 2048,
  ) {
    this.size = size;
    this.dpr = dpr;
    this.canvas =
      typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
    if (!(this.canvas instanceof OffscreenCanvas)) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const context = this.canvas.getContext('2d', { willReadFrequently: false }) as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error('glyph atlas: no 2D context');
    this.context = context;
    this.texture = device.createTexture({
      label: 'swarm glyph atlas',
      size: { width: size, height: size },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Bumped whenever the atlas is emptied, so cached quads know to relayout. */
  get epoch(): number {
    return this.generation;
  }

  setDpr(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.reset();
  }

  private reset(): void {
    this.context.clearRect(0, 0, this.size, this.size);
    this.regions.clear();
    this.metrics.clear();
    this.shelfX = PADDING;
    this.shelfY = PADDING;
    this.shelfHeight = 0;
    this.generation += 1;
    this.dirty = true;
  }

  private allocate(width: number, height: number): { x: number; y: number } | undefined {
    if (this.shelfX + width + PADDING > this.size) {
      this.shelfX = PADDING;
      this.shelfY += this.shelfHeight + PADDING;
      this.shelfHeight = 0;
    }
    if (this.shelfY + height + PADDING > this.size) return undefined;
    const slot = { x: this.shelfX, y: this.shelfY };
    this.shelfX += width + PADDING;
    this.shelfHeight = Math.max(this.shelfHeight, height);
    return slot;
  }

  fontMetrics(style: TextStyle): FontMetrics {
    const key = styleKey(style);
    const known = this.metrics.get(key);
    if (known) return known;
    this.context.font = fontFor(style, this.dpr);
    this.context.textBaseline = 'alphabetic';
    const measured = this.context.measureText('Hg');
    const metrics = {
      ascent: (measured.fontBoundingBoxAscent ?? style.size * this.dpr * 0.8) / this.dpr,
      descent: (measured.fontBoundingBoxDescent ?? style.size * this.dpr * 0.2) / this.dpr,
    };
    this.metrics.set(key, metrics);
    return metrics;
  }

  /** The glyph, rasterised on first sight. Undefined only when the atlas is full. */
  glyph(character: string, style: TextStyle): AtlasRegion | undefined {
    const key = `g|${styleKey(style)}|${character}`;
    const known = this.regions.get(key);
    if (known) return known;
    const context = this.context;
    context.font = fontFor(style, this.dpr);
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    const measured = context.measureText(character);
    const left = Math.ceil(measured.actualBoundingBoxLeft);
    const right = Math.ceil(measured.actualBoundingBoxRight);
    const ascent = Math.ceil(measured.actualBoundingBoxAscent);
    const descent = Math.ceil(measured.actualBoundingBoxDescent);
    const width = Math.max(1, left + right + 2);
    const height = Math.max(1, ascent + descent + 2);
    const slot = this.allocate(width, height);
    if (!slot) return undefined;
    context.fillStyle = '#ffffff';
    context.fillText(character, slot.x + left + 1, slot.y + ascent + 1);
    const region: AtlasRegion = {
      u0: slot.x / this.size,
      v0: slot.y / this.size,
      u1: (slot.x + width) / this.size,
      v1: (slot.y + height) / this.size,
      width: width / this.dpr,
      height: height / this.dpr,
      left: (-left - 1) / this.dpr,
      top: (-ascent - 1) / this.dpr,
      advance: measured.width / this.dpr,
    };
    this.regions.set(key, region);
    this.dirty = true;
    return region;
  }

  /** CSS `letter-spacing` semantics: spacing follows every character. */
  measure(text: string, style: TextStyle): number {
    let width = 0;
    const spacing = (style.letterSpacing ?? 0) * style.size;
    for (const character of text) {
      const region = this.glyph(character, style);
      width += (region?.advance ?? 0) + spacing;
    }
    return width;
  }

  /**
   * A picture at a CSS size, from an SVG string whose `currentColor` becomes
   * white so the shader tints it. Decoding is asynchronous; the sprite is
   * absent until it lands, then present for the atlas's lifetime.
   */
  sprite(key: string, svg: string, size: number): AtlasRegion | undefined {
    const regionKey = `s|${key}|${size}`;
    const known = this.regions.get(regionKey);
    if (known) return known;
    const devicePx = Math.max(1, Math.round(size * this.dpr));
    const image = this.spriteImages.get(key);
    if (image?.complete && image.naturalWidth > 0) {
      const slot = this.allocate(devicePx, devicePx);
      if (!slot) return undefined;
      this.context.drawImage(image, slot.x, slot.y, devicePx, devicePx);
      const region: AtlasRegion = {
        u0: slot.x / this.size,
        v0: slot.y / this.size,
        u1: (slot.x + devicePx) / this.size,
        v1: (slot.y + devicePx) / this.size,
        width: devicePx / this.dpr,
        height: devicePx / this.dpr,
        left: 0,
        top: 0,
        advance: devicePx / this.dpr,
      };
      this.regions.set(regionKey, region);
      this.dirty = true;
      return region;
    }
    if (!image && !this.pendingSprites.has(key)) {
      this.pendingSprites.add(key);
      const element = new Image();
      element.decoding = 'async';
      element.onload = () => {
        this.spriteImages.set(key, element);
        this.pendingSprites.delete(key);
      };
      element.onerror = () => this.pendingSprites.delete(key);
      const white = svg.replaceAll('currentColor', '#ffffff');
      element.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(white)}`;
    }
    return undefined;
  }

  /** Upload what changed since the last frame. One copy of the whole canvas:
   * additions are rare after the first seconds, and a partial copy is not
   * cheaper than a whole one on this path. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.device.queue.copyExternalImageToTexture(
      { source: this.canvas },
      { texture: this.texture, premultipliedAlpha: true },
      { width: this.size, height: this.size },
    );
  }

  destroy(): void {
    this.texture.destroy();
  }
}
