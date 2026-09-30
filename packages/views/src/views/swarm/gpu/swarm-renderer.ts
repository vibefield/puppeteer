/// <reference types="@webgpu/types" />
import { AGENT_MARK_ATLAS, agentMarkSvg, agentMarkTile } from '../../../icons/AgentIcon.js';
import type { SwarmBubbleModel } from '../bubble-model.js';
import {
  layoutCopy,
  leadAdvance,
  type CopyLayout,
  type CopyLead,
  type CopyTone,
  type TextStyle,
} from '../text-layout.js';
import type { Rgba } from './color.js';
import { GlyphAtlas } from './glyph-atlas.js';
import { climb, onField, SWARM_WEIGHT, WORKING_CORE_STRENGTH } from '../weight.js';
import bodyShader from './shaders/body.wgsl.js';
import commonShader from './shaders/common.wgsl.js';
import fieldShader from './shaders/field.wgsl.js';
import glowShader from './shaders/glow.wgsl.js';
import shadowShader from './shaders/shadow.wgsl.js';
import textShader from './shaders/text.wgsl.js';

// The swarm's renderer: one WebGPU canvas, one render pass, five pipelines in
// painter's order — field, shadows, bodies, light, type — and one upload of
// bodies and glyph quads per frame. It draws what it is given:
// positions and sizes belong to the physics in AgentSwarm, meaning belongs to
// bubble-model.ts, colour to the palette. Nothing here reads the DOM.

export interface RenderBody {
  model: SwarmBubbleModel;
  x: number;
  y: number;
  /** The eased visual radius, CSS px. */
  radius: number;
  /** The arrival curve's scale and opacity; 1 once landed. */
  scale: number;
  opacity: number;
  focus: boolean;
  /** A stable per-body phase so breathing bodies do not breathe in unison. */
  seed: number;
  accent: Rgba;
  link?: Rgba;
  /** This body's light instead of the frame's; the design lab weighs settings side by side. */
  glow?: { reach: number; strength: number; breath: number };
}

/** A mark drawn on its own, for the lab's contact sheet. */
export interface RenderMark {
  tile: { x: number; y: number };
  /** CSS px, centred on (x, y). */
  size: number;
  x: number;
  y: number;
  colour: Rgba;
  alpha: number;
}

/** Two colours and a ladder: see `weight.ts`. Nothing here is per-state, because
 * no state inverts the theme. */
export interface SwarmTheme {
  /** Every agent body's fill, in both themes. */
  surface: Rgba;
  /** The one ink every mark and every letter is drawn in. */
  ink: Rgba;
  grid: Rgba;
  /** The state colours at full chroma: what a body's LIGHT is made of. */
  orange: Rgba;
  green: Rgba;
  blue: Rgba;
  /** The same three, fit to be READ on this theme's surface — see `readable`. */
  stateInk: { orange: Rgba; green: Rgba; blue: Rgba };
  /** The light a blocked or unread body gives: the hue at this theme's hot end. */
  stateGlow: { orange: Rgba; blue: Rgba };
  /** The ground it gives that light over: the same hue at this theme's calm end. */
  stateGround: { orange: Rgba; blue: Rgba };
  /** The working body's drop shadow at rest and at its breathing peak. */
  shadow: Rgba;
  shadowPeak: Rgba;
}

export interface SwarmFrame {
  /** Seconds. Held still by the renderer while motion is off. */
  time: number;
  motion: boolean;
  fillOpacity: number;
  gridPitch: number;
  glow: { reach: number; strength: number; breath: number };
  /** The light a blocked or unread body gives: its shape, and how its waves travel. */
  stateGlow: { inner: number; full: number; strength: number; count: number; speed: number; depth: number };
  theme: SwarmTheme;
  bodies: readonly RenderBody[];
  /** Hold-to-create in flight: where, and how far along (0..1). `frozen`: the
   * spawn bloom's hub — the ring kept at full size, above everything the field
   * draws (clearings included), at `opacity` (1 by default) as it shrinks away. */
  hold?: { x: number; y: number; progress: number; frozen?: boolean; opacity?: number };
  /** The field's quiet while the spawn bloom is open: the grid is drawn at
   * (1 − veil). Bodies carry their own share in `RenderBody.opacity`. 0 or absent: none. */
  veil?: number;
  /** Solid ground cut out of everything drawn beneath (grid and bodies): where
   * the bloom and its words stand, so nothing on the field shows through them.
   * At most `MAX_CLEARINGS`; the rest are ignored. */
  clearings?: readonly SwarmClearing[];
  marks?: readonly RenderMark[];
}

/** One clearing: solid out to its edge (a circle's radius, a rect's box), then
 * fading back to nothing over `feather` px. CSS px, y down, like the bodies. */
export type SwarmClearing =
  | { kind: 'circle'; x: number; y: number; radius: number; feather: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; feather: number };

export const MAX_CLEARINGS = 4;

export interface SwarmRenderer {
  resize(width: number, height: number, dpr: number): void;
  render(frame: SwarmFrame): void;
  measure(text: string, style: TextStyle): number;
  /** Resolves when the device is lost; the owner builds a new renderer. */
  readonly lost: Promise<GPUDeviceLostInfo>;
  destroy(): void;
}

export type SwarmRendererResult = { ok: true; renderer: SwarmRenderer } | { ok: false; reason: string };

const F_HOLLOW = 1;
const F_RUNNING = 2;
const F_GLOW = 8;
const F_RIM = 16;
const F_STALE = 32;
const F_LINKED = 64;
const F_FOCUS = 128;
const F_RING_HOT = 512;
const F_RING = 1024;
const F_SHADOW = 2048;
const F_CORE = 4096;
const F_WAVES = 8192;

const FRAME_FLOATS = 48;
const BODY_FLOATS = 40;
const GLYPH_FLOATS = 16;
const INITIAL_BODIES = 32;
const INITIAL_GLYPHS = 2048;

/** The context figure and the total: one size, the same margin in from the rim. */
const FIGURE_STYLE: TextStyle = { size: 10.5, weight: 800, letterSpacing: 0.02 };
const FIGURE_MARGIN = 7;
/** The burn row keeps this much clear of the model line above and of the total below. */
const BAND_MARGIN_TOP = 4;
const BAND_MARGIN_BOTTOM = 8;

// Stroke icons, 24-box, from the proposals record.
const ICON_SVG: Record<string, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  tool: '<path d="M5 7l5 5-5 5M12 17h7"/>',
  responding: '<path d="M4 20l4.5-1L19 8.5l-3.5-3.5L5 15.5z"/>',
  reasoning:
    '<circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  delegating:
    '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v2c0 3 6 3 6 6M18 8v2c0 3-6 3-6 6"/>',
  compacting: '<path d="M5 6h14M7 12h10M10 18h4"/>',
  starting: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  permission: '<circle cx="8" cy="8" r="3.5"/><path d="M10.5 10.5L19 19M15.5 15.5l2-2M13 13l2-2"/>',
  question:
    '<path d="M9 9.5a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.8v.5"/><circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
  failure: '<path d="M12 5v9"/><circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
  message: '<path d="M20 14a2 2 0 0 1-2 2H9l-4.5 3.5V6a2 2 0 0 1 2-2h11.5a2 2 0 0 1 2 2z"/>',
  // The same silhouette filled: the project's mark once its name has stepped back.
  'folder-solid': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};

/** Marks drawn as a silhouette rather than a stroke. */
const FILLED_ICONS = new Set(['folder-solid']);

function iconSvg(name: string): string | undefined {
  const inner = ICON_SVG[name];
  if (!inner) return undefined;
  const paint = FILLED_ICONS.has(name)
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${paint}>${inner}</svg>`;
}

/** The burn mark: a leaning flame with a sharp tip, so it reads as fire and not
 * as a droplet at thirteen pixels. Filled when lit, outlined where there is no
 * price to read. */
const FLAME_PATH =
  'M12.2 1.8C14.6 5.6 18 8.6 18 13.4a6 6 0 0 1-12 0c0-2.7 1.1-4.5 2.5-5.8.2 1.8 1 2.9 2.1 3.3C9.3 7.5 10.1 4.1 12.2 1.8z';
const FLAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${FLAME_PATH}" fill="currentColor"/></svg>`;
const FLAME_HOLLOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${FLAME_PATH}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;

/** The ladder's own geometry: four marks, the gap between them, and the alphas. */
const FLAME_SIZE = 13;
const FLAME_GAP = 3;

const DOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="currentColor"/></svg>';

async function compile(device: GPUDevice, label: string, source: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label, code: `${commonShader}\n${source}` });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === 'error');
  if (errors.length > 0) {
    throw new Error(
      `${label}: ${errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('; ')}`,
    );
  }
  return module;
}

const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

async function loadMarks(device: GPUDevice): Promise<GPUTexture> {
  const texture = device.createTexture({
    label: 'swarm marks',
    size: { width: AGENT_MARK_ATLAS.width, height: AGENT_MARK_ATLAS.height },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  try {
    const image = new Image();
    image.src = AGENT_MARK_ATLAS.url;
    await image.decode();
    const bitmap = await createImageBitmap(image, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      { width: bitmap.width, height: bitmap.height },
    );
    bitmap.close();
  } catch (error) {
    // An undecodable atlas leaves an empty field: every mark falls back to nothing
    // rather than to garbage, and the letter marks still come from the glyph atlas.
    console.warn('[swarm] vendor marks atlas did not load', error);
  }
  return texture;
}

/** A light in a STATE's own colour, as against the ink a working body is lit with. */
function isStateLight(light: SwarmBubbleModel['light']): boolean {
  return light === 'orange' || light === 'blue';
}

/** The ground a body wears when it needs the user, or nothing for the rest. A
 * working body's light is the ink itself and fills nothing. */
function stateGroundOf(theme: SwarmTheme, light: SwarmBubbleModel['light']): Rgba | undefined {
  if (light === 'orange') return theme.stateGround.orange;
  if (light === 'blue') return theme.stateGround.blue;
  return undefined;
}

/** The same colour at another alpha: every rung of the ladder is one ink at a weight. */
function withAlpha(colour: Rgba, alpha: number): Rgba {
  return [colour[0], colour[1], colour[2], alpha];
}

function writeRgba(target: Float32Array, offset: number, colour: Rgba, alphaScale = 1): void {
  target[offset] = colour[0];
  target[offset + 1] = colour[1];
  target[offset + 2] = colour[2];
  target[offset + 3] = colour[3] * alphaScale;
}

export async function createSwarmRenderer(canvas: HTMLCanvasElement): Promise<SwarmRendererResult> {
  if (typeof navigator === 'undefined' || !navigator.gpu)
    return { ok: false, reason: 'WebGPU is not available in this window' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false, reason: 'No WebGPU adapter on this GPU' };
  // The canvas is the window, or in the lab a whole document: ask for the
  // adapter's real texture limit instead of the 8192 default.
  const device = await adapter.requestDevice({
    label: 'godview swarm',
    requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
  });
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    return { ok: false, reason: 'The canvas has no WebGPU context' };
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });
  device.addEventListener('uncapturederror', (event) => {
    console.error('[swarm] WebGPU error', (event as GPUUncapturedErrorEvent).error.message);
  });

  const [fieldModule, shadowModule, bodyModule, glowModule, textModule] = await Promise.all([
    compile(device, 'swarm field', fieldShader),
    compile(device, 'swarm shadow', shadowShader),
    compile(device, 'swarm body', bodyShader),
    compile(device, 'swarm glow', glowShader),
    compile(device, 'swarm text', textShader),
  ]);

  const sceneLayout = device.createBindGroupLayout({
    label: 'swarm scene',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });
  const textLayout = device.createBindGroupLayout({
    label: 'swarm text',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const scenePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout] });
  const textPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, textLayout] });

  const pipeline = (label: string, module: GPUShaderModule, layout: GPUPipelineLayout): Promise<GPURenderPipeline> =>
    device.createRenderPipelineAsync({
      label,
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: PREMULTIPLIED_OVER }] },
      primitive: { topology: 'triangle-list' },
    });
  const [fieldPipeline, shadowPipeline, bodyPipeline, glowPipeline, textPipeline] = await Promise.all([
    pipeline('swarm field', fieldModule, scenePipelineLayout),
    pipeline('swarm shadow', shadowModule, scenePipelineLayout),
    pipeline('swarm body', bodyModule, scenePipelineLayout),
    pipeline('swarm glow', glowModule, scenePipelineLayout),
    pipeline('swarm text', textModule, textPipelineLayout),
  ]);

  const frameBuffer = device.createBuffer({
    label: 'swarm frame',
    size: FRAME_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const atlas = new GlyphAtlas(device, Math.max(1, window.devicePixelRatio || 1));
  const marks = await loadMarks(device);

  let bodyCapacity = INITIAL_BODIES;
  let glyphCapacity = INITIAL_GLYPHS;
  let bodyBuffer: GPUBuffer | undefined;
  let glyphBuffer: GPUBuffer | undefined;
  let sceneBindGroup: GPUBindGroup | undefined;
  let textBindGroup: GPUBindGroup | undefined;
  let bodyData = new Float32Array(0);
  let bodyFlags = new Uint32Array(0);
  let glyphData = new Float32Array(0);
  const frameData = new Float32Array(FRAME_FLOATS);

  const allocateBodies = (capacity: number): void => {
    bodyCapacity = capacity;
    bodyBuffer?.destroy();
    bodyBuffer = device.createBuffer({
      label: 'swarm bodies',
      size: capacity * BODY_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    bodyData = new Float32Array(capacity * BODY_FLOATS);
    bodyFlags = new Uint32Array(bodyData.buffer);
    sceneBindGroup = device.createBindGroup({
      layout: sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: bodyBuffer } },
      ],
    });
  };
  const allocateGlyphs = (capacity: number): void => {
    glyphCapacity = capacity;
    glyphBuffer?.destroy();
    glyphBuffer = device.createBuffer({
      label: 'swarm glyphs',
      size: capacity * GLYPH_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    glyphData = new Float32Array(capacity * GLYPH_FLOATS);
    textBindGroup = device.createBindGroup({
      layout: textLayout,
      entries: [
        { binding: 0, resource: { buffer: glyphBuffer } },
        { binding: 1, resource: atlas.texture.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: marks.createView() },
      ],
    });
  };
  allocateBodies(bodyCapacity);
  allocateGlyphs(glyphCapacity);

  let width = 1;
  let height = 1;
  let dpr = atlas.dpr;
  let heldTime = 0;
  let glyphCount = 0;
  let destroyed = false;

  const toneColour = (tone: CopyTone, body: RenderBody, ink: Rgba, theme: SwarmTheme): Rgba => {
    switch (tone) {
      // Words and marks take the readable variant; only the body's light is the
      // full hue.
      case 'orange':
        return theme.stateInk.orange;
      case 'green':
        return theme.stateInk.green;
      case 'blue':
        return theme.stateInk.blue;
      case 'accent':
        return body.accent;
      default:
        return ink;
    }
  };

  const pushGlyph = (
    x: number,
    y: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    colour: Rgba,
    alpha: number,
    field = 0,
  ): void => {
    if (glyphCount >= glyphCapacity) {
      const previous = glyphData;
      allocateGlyphs(glyphCapacity * 2);
      glyphData.set(previous);
    }
    const offset = glyphCount * GLYPH_FLOATS;
    glyphData[offset] = x;
    glyphData[offset + 1] = y;
    glyphData[offset + 2] = w;
    glyphData[offset + 3] = h;
    glyphData[offset + 4] = u0;
    glyphData[offset + 5] = v0;
    glyphData[offset + 6] = u1;
    glyphData[offset + 7] = v1;
    glyphData[offset + 8] = colour[0];
    glyphData[offset + 9] = colour[1];
    glyphData[offset + 10] = colour[2];
    glyphData[offset + 11] = colour[3] * alpha;
    glyphData[offset + 12] = field > 0 ? 1 : 0;
    glyphData[offset + 13] = field;
    glyphData[offset + 14] = 0;
    glyphData[offset + 15] = 0;
    glyphCount += 1;
  };

  /** A tile from the signed-distance atlas, `size` CSS px, centred on (cx, cy). */
  const pushTile = (
    tile: { x: number; y: number },
    size: number,
    cx: number,
    cy: number,
    colour: Rgba,
    alpha: number,
  ): void => {
    const { width, height, tile: texels, pxRange } = AGENT_MARK_ATLAS;
    const screenPxRange = (pxRange * size * dpr) / texels;
    pushGlyph(
      cx - size / 2,
      cy - size / 2,
      size,
      size,
      tile.x / width,
      tile.y / height,
      (tile.x + texels) / width,
      (tile.y + texels) / height,
      colour,
      alpha,
      screenPxRange,
    );
  };

  /** A provider's mark, or false when it has only a letter. */
  const pushMark = (providerId: string, size: number, cx: number, cy: number, colour: Rgba, alpha: number): boolean => {
    const tile = agentMarkTile(providerId);
    if (!tile) return false;
    pushTile(tile, size, cx, cy, colour, alpha);
    return true;
  };

  const pushSprite = (
    key: string,
    svg: string | undefined,
    size: number,
    cx: number,
    cy: number,
    colour: Rgba,
    alpha: number,
  ): void => {
    if (!svg) return;
    const region = atlas.sprite(key, svg, size);
    if (!region) return;
    pushGlyph(
      cx - region.width / 2,
      cy - region.height / 2,
      region.width,
      region.height,
      region.u0,
      region.v0,
      region.u1,
      region.v1,
      colour,
      alpha,
    );
  };

  const pushText = (text: string, style: TextStyle, x: number, baseline: number, colour: Rgba, alpha: number): void => {
    const spacing = (style.letterSpacing ?? 0) * style.size;
    let pen = x;
    for (const character of text) {
      const region = atlas.glyph(character, style);
      if (!region) return;
      if (character !== ' ') {
        pushGlyph(
          pen + region.left,
          baseline + region.top,
          region.width,
          region.height,
          region.u0,
          region.v0,
          region.u1,
          region.v1,
          colour,
          alpha,
        );
      }
      pen += region.advance + spacing;
    }
  };

  const copyLayoutOf = (body: RenderBody): CopyLayout =>
    layoutCopy(body.model.copy, {
      radius: body.radius * body.scale,
      measure: (text, style) => atlas.measure(text, style),
      maxWidthRatio: body.model.copyMaxWidthRatio,
    });

  /** The burn row's centre, relative to the body's own centre: midway between a
   * margin under the model line and a margin above the total figure, so the
   * flames stand where the chart used to, whatever the radius. */
  const burnRowOf = (body: RenderBody, layout: CopyLayout): number => {
    const radius = body.radius * body.scale;
    const modelLine = layout.lines.find((line) => line.key === 'model');
    const under = modelLine ? modelLine.y + modelLine.height / 2 : layout.bottom;
    const top = under + BAND_MARGIN_TOP;
    const floor = Math.max(top + 4, radius - FIGURE_MARGIN - FIGURE_STYLE.size - BAND_MARGIN_BOTTOM);
    return (top + floor) / 2;
  };

  /**
   * The burn ladder: as many flames as the rate has lit, and no empty slots
   * (2026-09-18). A calm session draws nothing at all, which is the honest thing
   * for a body with nothing to say. The one exception is a session nobody can
   * price: it draws a single hollow flame, because an absent reading must never
   * look like a calm one (RFC 008). The last lit flame breathes on the newest
   * bucket's rhythm, as the newest column used to. Ink only — a colour here would
   * collide with the states' own (record §10).
   */
  const emitBurn = (
    body: RenderBody,
    ink: Rgba,
    time: number,
    motion: boolean,
    layout: CopyLayout,
    dim: number,
    rung: (weight: number) => number,
  ): void => {
    const burn = body.model.burn;
    if (!burn) return;
    const drawn = burn.priced ? burn.lit : 1;
    if (drawn === 0) return;
    const rowY = body.y + burnRowOf(body, layout);
    const span = drawn * FLAME_SIZE + (drawn - 1) * FLAME_GAP;
    const breath = motion ? 0.5 - 0.5 * Math.cos((time * 2 * Math.PI) / 1.6 + body.seed) : 0.5;
    for (let slot = 0; slot < drawn; slot += 1) {
      const x = body.x - span / 2 + FLAME_SIZE / 2 + slot * (FLAME_SIZE + FLAME_GAP);
      // Each flame climbs the range the gauge climbs: the first sits low, the
      // fourth reaches the title's own weight, because a body burning that hard is
      // the most important thing on the stage. The last one breathes.
      const alpha = burn.priced
        ? climb(slot / 3) * (slot === burn.lit - 1 ? 0.82 + 0.18 * breath : 1)
        : SWARM_WEIGHT.absent;
      pushSprite(
        burn.priced ? 'flame' : 'flame-hollow',
        burn.priced ? FLAME_SVG : FLAME_HOLLOW_SVG,
        FLAME_SIZE,
        x,
        rowY,
        ink,
        rung(alpha) * dim,
      );
    }
  };

  const emitBodyText = (
    body: RenderBody,
    ink: Rgba,
    theme: SwarmTheme,
    time: number,
    motion: boolean,
    layout: CopyLayout,
  ): void => {
    const { model } = body;
    const radius = body.radius * body.scale;
    const dim = body.opacity * (model.stale ? 0.58 : 1);
    // A coloured ground gives the ink less room, so the ladder starts higher on it.
    const rung = stateGroundOf(theme, model.light) === undefined ? (weight: number) => weight : onField;
    if (radius < 12) return;
    if (model.watermark) {
      // The ignition's breath, kept from the DOM: a working mark swells from
      // 0.92 to 1.08 and brightens from 8% to 24% every 1.5s.
      const breathing = motion && model.appearance === 'working';
      const k = breathing ? 0.5 - 0.5 * Math.cos((time * 2 * Math.PI) / 1.5 + body.seed) : 0.5;
      const size = (radius <= 40 ? 46 : 58) * (breathing ? 0.92 + 0.16 * k : 1);
      const opacity = (breathing ? 0.08 + 0.16 * k : model.watermark.opacity) * dim;
      const cx = body.x;
      // Lifted above the copy's centre so the branch line clears its densest part.
      const cy = body.y - 0.27 * radius;
      if (!pushMark(model.watermark.sprite, size, cx, cy, ink, opacity)) {
        pushSprite(
          `mark:${model.watermark.sprite}`,
          agentMarkSvg(model.watermark.sprite),
          Math.round(size),
          cx,
          cy,
          ink,
          opacity,
        );
      }
    }
    for (const line of layout.lines) {
      const colour = toneColour(line.tone, body, ink, theme);
      const alpha = rung(line.opacity) * dim;
      const lineY = body.y + line.y;
      let pen = body.x - line.width / 2;
      const mark = (lead: CopyLead): void => {
        const leadColour = toneColour(lead.tone ?? line.tone, body, ink, theme);
        const leadAlpha = rung(lead.opacity ?? line.opacity) * dim;
        const leadCentreX = pen + leadAdvance(lead) / 2;
        if (lead.kind === 'dot') pushSprite('dot', DOT_SVG, lead.size, leadCentreX, lineY - 0.5, leadColour, leadAlpha);
        else
          pushSprite(
            `icon:${lead.icon}`,
            iconSvg(lead.icon ?? ''),
            lead.size,
            leadCentreX,
            lineY,
            leadColour,
            leadAlpha,
          );
        pen += leadAdvance(lead) + lead.gap;
      };
      if (line.lead) mark(line.lead);
      if (line.text.length === 0) continue;
      const metrics = atlas.fontMetrics(line.style);
      const baseline = lineY + (metrics.ascent - metrics.descent) / 2;
      pushText(line.text, line.style, pen, baseline, colour, alpha);
    }
    const figure = (item: { text: string; hot: boolean; none: boolean }, centreY: number): void => {
      // The gauge's own climb already says a context is nearly spent; the figure
      // beside it needs no second alarm, and orange now means one thing only.
      const colour = ink;
      const alpha = rung(item.none ? SWARM_WEIGHT.absent : SWARM_WEIGHT.secondary) * dim;
      const textWidth = atlas.measure(item.text, FIGURE_STYLE);
      const metrics = atlas.fontMetrics(FIGURE_STYLE);
      pushText(
        item.text,
        FIGURE_STYLE,
        body.x - textWidth / 2,
        centreY + (metrics.ascent - metrics.descent) / 2,
        colour,
        alpha,
      );
    };
    // The context figure on the top chord and the total on the bottom one,
    // under the burn row, each the same distance in from the rim.
    const figureInset = FIGURE_MARGIN + FIGURE_STYLE.size / 2;
    if (model.figures?.top) figure(model.figures.top, body.y - radius + figureInset);
    if (model.figures?.bottom) figure(model.figures.bottom, body.y + radius - figureInset);
    emitBurn(body, ink, time, motion, layout, dim, rung);
  };

  const packBody = (index: number, body: RenderBody, frame: SwarmFrame): Rgba => {
    const { model } = body;
    const theme = frame.theme;
    const offset = index * BODY_FLOATS;
    // One surface, one ink, in both themes (2026-09-18). A body's edge is the
    // faintest rung of the ladder; a hollow terminal's dashed rim and a working
    // body's border earn a little more.
    const rimWeight = model.hollow
      ? SWARM_WEIGHT.rim
      : model.appearance === 'working'
        ? SWARM_WEIGHT.edge
        : SWARM_WEIGHT.hairline;
    // A body that needs the user is filled with the state's own colour, and its
    // words are still the theme's ink — light on dark, dark on light, the same
    // direction every other body follows.
    const fill = stateGroundOf(theme, model.light) ?? theme.surface;
    const colours = { fill, ink: theme.ink, rim: withAlpha(theme.ink, rimWeight) };
    // The light inside the body is the STATE's colour — the theme's own ink while
    // working, orange while blocked, blue for an unread reply. The project's colour
    // reaches the body only as the folder before its name (2026-09-16). The ink is
    // held back: on a light theme it can only darken, so it reads as density at the
    // centre rather than as a glow.
    // The light itself: the state's own glow over the ground it sits on, or the
    // theme's ink for a working body, which is a density and not a colour.
    const lightColour: Rgba =
      model.light === undefined
        ? [0, 0, 0, 0]
        : model.light === 'orange'
          ? theme.stateGlow.orange
          : model.light === 'blue'
            ? theme.stateGlow.blue
            : withAlpha(theme.ink, WORKING_CORE_STRENGTH);
    let flags = 0;
    if (model.hollow) flags |= F_HOLLOW;
    if (model.running) flags |= F_RUNNING;
    if (model.light) flags |= F_CORE;
    // A body that needs the user glows in waves rather than breathing.
    if (isStateLight(model.light)) flags |= F_WAVES;
    // The outer light: only on the body whose pane is the selected one. Every
    // other mounted body wears its colour as the band alone.
    if (body.link && model.active) flags |= F_GLOW;
    if (model.appearance === 'working' && !model.hollow) flags |= F_RIM | F_SHADOW;
    if (model.stale) flags |= F_STALE;
    if (body.link) flags |= F_LINKED;
    if (body.focus) flags |= F_FOCUS;
    if (model.ring) flags |= F_RING;
    if (model.ring?.hot) flags |= F_RING_HOT;

    bodyData[offset] = body.x;
    bodyData[offset + 1] = body.y;
    bodyData[offset + 2] = body.radius;
    bodyData[offset + 3] = body.scale;
    writeRgba(bodyData, offset + 4, colours.fill, body.opacity);
    writeRgba(bodyData, offset + 8, colours.ink);
    writeRgba(bodyData, offset + 12, lightColour, body.opacity);
    writeRgba(bodyData, offset + 16, colours.rim, body.opacity);
    bodyFlags[offset + 20] = flags;
    bodyFlags[offset + 21] = 0;
    bodyFlags[offset + 22] = 0;
    bodyFlags[offset + 23] = 0;
    bodyData[offset + 24] = model.ring ? model.ring.percent / 100 : 0;
    // The gauge climbs as it goes round; the track behind it stays the faintest rung.
    bodyData[offset + 25] = climb(0);
    bodyData[offset + 26] = SWARM_WEIGHT.hairline * body.opacity;
    bodyData[offset + 27] = climb(1);
    const glow = body.glow ?? frame.glow;
    bodyData[offset + 28] = glow.reach;
    bodyData[offset + 29] = glow.strength * body.opacity;
    bodyData[offset + 30] = glow.breath;
    bodyData[offset + 31] = body.seed;
    bodyData[offset + 32] = 0;
    bodyData[offset + 33] = body.seed;
    bodyData[offset + 34] = model.stale ? 1 : 0;
    bodyData[offset + 35] = body.opacity;
    writeRgba(bodyData, offset + 36, body.link ?? [0, 0, 0, 0], body.opacity);
    return colours.ink;
  };

  const lost = device.lost;

  const renderer: SwarmRenderer = {
    lost,
    resize(nextWidth, nextHeight, nextDpr) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      dpr = Math.max(1, nextDpr);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      atlas.setDpr(dpr);
    },
    measure(text, style) {
      return atlas.measure(text, style);
    },
    render(frame) {
      if (destroyed) return;
      const bodies = frame.bodies;
      if (bodies.length > bodyCapacity) {
        let capacity = bodyCapacity;
        while (capacity < bodies.length) capacity *= 2;
        allocateBodies(capacity);
      }
      if (frame.motion) heldTime = frame.time;
      const time = heldTime;
      const theme = frame.theme;

      glyphCount = 0;
      for (let index = 0; index < bodies.length; index += 1) {
        const body = bodies[index]!;
        const layout = copyLayoutOf(body);
        const ink = packBody(index, body, frame);
        emitBodyText(body, ink, theme, time, frame.motion, layout);
      }
      for (const mark of frame.marks ?? []) pushTile(mark.tile, mark.size, mark.x, mark.y, mark.colour, mark.alpha);
      atlas.flush();

      frameData[0] = width;
      frameData[1] = height;
      frameData[2] = dpr;
      frameData[3] = time;
      frameData[4] = frame.fillOpacity;
      frameData[5] = frame.motion ? 1 : 0;
      frameData[6] = frame.gridPitch;
      frameData[7] = 0;
      writeRgba(frameData, 8, theme.grid);
      writeRgba(frameData, 12, theme.shadow, frame.fillOpacity);
      writeRgba(frameData, 16, theme.shadowPeak, frame.fillOpacity);
      frameData[20] = frame.hold?.x ?? 0;
      frameData[21] = frame.hold?.y ?? 0;
      frameData[22] = frame.hold?.progress ?? 0;
      frameData[23] = frame.hold ? 1 : 0;
      writeRgba(frameData, 24, theme.orange);
      writeRgba(frameData, 28, withAlpha(theme.ink, SWARM_WEIGHT.supporting));
      writeRgba(frameData, 32, theme.surface, 0.74);
      writeRgba(frameData, 36, theme.ink);
      frameData[40] = frame.stateGlow.inner;
      frameData[41] = frame.stateGlow.full;
      frameData[42] = frame.stateGlow.strength;
      frameData[43] = 0;
      frameData[44] = frame.stateGlow.count;
      frameData[45] = frame.stateGlow.speed;
      frameData[46] = frame.stateGlow.depth;
      frameData[47] = 0;

      device.queue.writeBuffer(frameBuffer, 0, frameData);
      if (bodies.length > 0) {
        device.queue.writeBuffer(bodyBuffer!, 0, bodyData, 0, bodies.length * BODY_FLOATS);
      }
      if (glyphCount > 0) device.queue.writeBuffer(glyphBuffer!, 0, glyphData, 0, glyphCount * GLYPH_FLOATS);

      const encoder = device.createCommandEncoder({ label: 'swarm frame' });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setBindGroup(0, sceneBindGroup!);
      pass.setPipeline(fieldPipeline);
      pass.draw(3);
      if (bodies.length > 0) {
        pass.setPipeline(shadowPipeline);
        pass.draw(6, bodies.length);
        pass.setPipeline(bodyPipeline);
        pass.draw(6, bodies.length);
        pass.setPipeline(glowPipeline);
        pass.draw(6, bodies.length);
      }
      if (glyphCount > 0) {
        pass.setPipeline(textPipeline);
        pass.setBindGroup(1, textBindGroup!);
        pass.draw(6, glyphCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      atlas.destroy();
      marks.destroy();
      bodyBuffer?.destroy();
      glyphBuffer?.destroy();
      frameBuffer.destroy();
      // The canvas context is shared by every renderer ever made for this
      // canvas (React's development double-mount makes two in a row), so it is
      // left configured; destroying the device is what releases this one.
      device.destroy();
    },
  };
  return { ok: true, renderer };
}
