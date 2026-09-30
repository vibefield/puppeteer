// Shared by every swarm pipeline; the renderer prepends this to each shader.
//
// All geometry is in CSS px with y down, the same space the physics and the
// pointer use; the device pixel ratio only enters through `cov`, the one-pixel
// box filter, so edges are one device pixel wide at any ratio. Colours are
// straight-alpha sRGB in the buffers and premultiplied on output, composited
// over the window's glass with (one, one-minus-src-alpha).

// One of the spawn bloom's clearings (erase.wgsl).
struct Clearing {
  // a circle's centre and radius (w: 0), or a rect's centre and half extents (CSS px)
  shape: vec4f,
  // feather (px), kind (0 circle, 1 rect), opacity (0..1), unused
  edge: vec4f,
};

const MAX_CLEARINGS: u32 = 4u;

struct Frame {
  // width, height (CSS px), device pixel ratio, time (s; frozen when motion is off)
  viewport: vec4f,
  // body fill opacity, motion (0/1), grid pitch (px), the veil (0..1: the grid
  // is drawn at 1 − veil while the spawn bloom is open)
  params: vec4f,
  grid: vec4f,
  // the theme's shadow colour; `a` is the resting alpha, `shadowPeak.a` the peak's
  shadow: vec4f,
  shadowPeak: vec4f,
  // hold-to-create, and the spawn bloom's hub: x, y, progress 0..1, opacity (0: none)
  pointer: vec4f,
  orange: vec4f,
  holdRim: vec4f,
  holdFill: vec4f,
  holdInk: vec4f,
  // the ring's rim width and dot radius (px): 1 and 2 while a hold is in flight,
  // 1.5 and 2.5 once it is the spawn bloom's hub; z/w unused
  holdShape: vec4f,
  // the state glow's shape: where it begins, where it is full, its strength, unused
  glowBand: vec4f,
  // and its motion: crests across the radius, crests a second, trough depth, unused
  glowWave: vec4f,
  // the spawn bloom's clearings: how many of `clearings` are set; y/z/w unused
  clearing: vec4f,
  clearings: array<Clearing, 4>,
};

struct Body {
  // x, y, radius, visual scale (arrival curve)
  posRadius: vec4f,
  fill: vec4f,
  ink: vec4f,
  // the inner light's colour — the STATE's, never the project's (see body.wgsl)
  core: vec4f,
  rim: vec4f,
  // x: flag bits; y/z/w unused
  flags: vec4u,
  // context ring: fraction 0..1, the weight it starts its climb at, the track's
  // weight, the weight a full ring would reach
  ring: vec4f,
  // the outer light: reach (px), strength, breath (0..1), phase seed
  glow: vec4f,
  // a pending body's dash turn (radians, clockwise), phase seed, stale mix (0/1), opacity
  motion: vec4f,
  link: vec4f,
};

const F_HOLLOW: u32 = 1u;
const F_RUNNING: u32 = 2u;
const F_GLOW: u32 = 8u;
const F_RIM: u32 = 16u;
const F_STALE: u32 = 32u;
const F_LINKED: u32 = 64u;
const F_FOCUS: u32 = 128u;
const F_RING_HOT: u32 = 512u;
const F_RING: u32 = 1024u;
const F_SHADOW: u32 = 2048u;
const F_CORE: u32 = 4096u;
const F_WAVES: u32 = 8192u;
const F_PENDING: u32 = 16384u;

const TAU: f32 = 6.28318530718;

// The context gauge's width and the light's gutter follow the body's radius:
// 5px and 2px on the 60px working body, thicker on a bigger one.
const GAUGE_WIDTH_RATIO: f32 = 5.0 / 60.0;
const LIGHT_GUTTER_RATIO: f32 = 2.0 / 60.0;

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;

fn has(flags: u32, bit: u32) -> bool {
  return (flags & bit) != 0u;
}

fn cssToClip(p: vec2f) -> vec4f {
  return vec4f(p.x / frame.viewport.x * 2.0 - 1.0, 1.0 - p.y / frame.viewport.y * 2.0, 0.0, 1.0);
}

fn quadCorner(vertex: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return corners[vertex];
}

fn premul(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

/** Source-over of premultiplied `src` on premultiplied `dst`. */
fn over(dst: vec4f, src: vec4f) -> vec4f {
  return src + dst * (1.0 - src.a);
}

/** Coverage of a signed distance (CSS px) under a one-device-pixel box filter. */
fn cov(d: f32) -> f32 {
  return clamp(0.5 - d * frame.viewport.z, 0.0, 1.0);
}

/** Coverage of a stroke of width `w` centred on the iso-line `d = 0`. */
fn stroke(d: f32, w: f32) -> f32 {
  return cov(abs(d) - w * 0.5);
}

// Abramowitz–Stegun 7.1.26: enough for a shadow.
fn erfA(x: f32) -> f32 {
  let s = sign(x);
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}

/** The disc blurred by a gaussian of `sigma`: what CSS `box-shadow` paints,
 * with sigma half the blur radius. */
fn occupancy(d: f32, sigma: f32) -> f32 {
  return 0.5 - 0.5 * erfA(d / max(sigma * 1.4142136, 0.0001));
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

/** Angle from twelve o'clock, clockwise, 0..1. */
fn clockwise(p: vec2f) -> f32 {
  return fract(atan2(p.x, -p.y) / TAU + 1.0);
}

struct BodyVertex {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) index: u32,
};

fn bodyQuad(vertex: u32, instance: u32, margin: f32, enabled: bool) -> BodyVertex {
  let body = bodies[instance];
  let radius = body.posRadius.z * body.posRadius.w;
  let extent = select(0.0, radius + margin, enabled);
  let corner = quadCorner(vertex);
  var out: BodyVertex;
  out.local = corner * extent;
  out.position = cssToClip(body.posRadius.xy + out.local);
  out.index = instance;
  return out;
}
