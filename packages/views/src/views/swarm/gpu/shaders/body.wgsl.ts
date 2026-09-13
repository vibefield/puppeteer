// The shader as a string module, so the package needs no bundler loader
// (esbuild in Godview, Vite in VibeField, tsc in both). `body.wgsl` beside it
// is the authoring copy; `shaders.test.ts` keeps the two identical.
export default `// One agent body: fill, the blocked flood, burn bars, rim (working border,
// hollow dash, running comet), context ring, the pane band, focus ring, and
// the stale treatment. Every layer is a coverage of the same distance to
// the rim, so nothing cracks.

const BODY_MARGIN: f32 = 8.0;

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> BodyVertex {
  return bodyQuad(vertex, instance, BODY_MARGIN, true);
}

@fragment
fn fs(in: BodyVertex) -> @location(0) vec4f {
  let body = bodies[in.index];
  let flags = body.flags.x;
  let r = body.posRadius.z * body.posRadius.w;
  let p = in.local;
  let dist = length(p);
  let d = dist - r;
  let inside = cov(d);
  // A mounted body wears its colour as a band a thirtieth of the radius wide
  // just outside the rim, the gutter; the light of the selected pane's body
  // starts where the band stops.
  let linked = has(flags, F_LINKED);
  let edge = select(0.0, r * LIGHT_GUTTER_RATIO, linked);
  let time = frame.viewport.w;
  var out = vec4f(0.0);

  // Fill. A hollow terminal has none; its rim says everything.
  if (!has(flags, F_HOLLOW)) {
    var fill = body.fill;
    fill.a = fill.a * frame.params.x;
    out = over(out, premul(fill) * inside);
  }

  // Blocked: the accent floods the body from the centre, a gaussian so strong
  // the circle is nearly the colour, thinning toward the rim so the ring and
  // the rim still read.
  if (has(flags, F_FLOOD)) {
    let reach = r * 1.6;
    let flood = exp(-(dist * dist) / (reach * reach) * 2.0);
    out = over(out, premul(vec4f(body.accent.rgb, 0.95 * body.accent.a)) * flood * inside);
  }

  // The burn bars: ten minutes of the UI ledger's steps, oldest left, as
  // rounded columns in the theme's ink either side of a baseline through the
  // middle of the band under the model line: output up, input down, each side
  // scaled so its tallest column fills its half of the band. Twenty bars of
  // thirty seconds, one sample each; the newest is the ink at full strength,
  // breathing, and never a colour.
  if (has(flags, F_GRAPH) && inside > 0.0) {
    let diameter = 2.0 * r;
    let top = body.graph.x;
    let bottom = body.graph.y;
    let bars = f32(GRAPH_SAMPLES);
    let halfSpan = r * BARS_SPAN;
    let pitch = 2.0 * halfSpan / bars;
    let half = pitch * 0.3;
    let x01 = clamp((p.x + halfSpan) / (2.0 * halfSpan), 0.0, 0.9999);
    let index = u32(floor(x01 * bars));
    let first = body.flags.y;
    let firstDown = first + GRAPH_SAMPLES;
    let up = samples[first + index];
    let down = samples[firstDown + index];
    let centre = (f32(index) + 0.5) * pitch - halfSpan;
    let baseline = 0.5 * (top + bottom) * diameter - r;
    let reach = 0.5 * (bottom - top) * diameter - 1.0;
    // Each side is a column with a semicircular far end, cut flat half a
    // pixel off the baseline; a silent side keeps a 1.5px stub.
    let upTop = baseline - max(up * reach, 1.5);
    let qUp = vec2f(abs(p.x - centre), (upTop + half) - p.y);
    let dUp = max(length(max(qUp, vec2f(0.0))) + min(max(qUp.x, qUp.y), 0.0) - half, p.y - (baseline - 0.5));
    let downEnd = baseline + max(down * reach, 1.5);
    let qDown = vec2f(abs(p.x - centre), p.y - (downEnd - half));
    let dDown = max(length(max(qDown, vec2f(0.0))) + min(max(qDown.x, qDown.y), 0.0) - half, (baseline + 0.5) - p.y);
    let barCoverage = max(cov(dUp), cov(dDown)) * step(abs(p.x), halfSpan);
    let newest = index == GRAPH_SAMPLES - 1u;
    let breathe = 0.5 + 0.5 * sin(time * TAU / 1.6 + body.motion.y);
    let alpha = select(0.45, mix(0.8, 1.0, breathe), newest) * body.motion.w;
    out = over(out, premul(vec4f(body.ink.rgb, alpha)) * barCoverage * inside);
    // The baseline itself, a hairline in the ink across the bars' span.
    let baselineCoverage = cov(abs(p.y - baseline) - 0.5) * step(abs(p.x), halfSpan);
    out = over(out, premul(vec4f(body.ink.rgb, 0.22 * body.motion.w)) * baselineCoverage * inside);
  }

  // A light at the centre in the accent, breathing with the mark: the one
  // place the accent shows inside a working body, so it is allowed to be seen.
  if (has(flags, F_CORE)) {
    let k = select(0.5, 0.5 - 0.5 * cos(time * TAU / 1.5 + body.motion.y), frame.params.y > 0.5);
    let reach = r * mix(0.5, 0.78, k);
    let core = exp(-(dist * dist) / (reach * reach) * 2.0);
    out = over(out, premul(vec4f(body.accent.rgb, mix(0.16, 0.34, k) * body.accent.a)) * core * inside);
  }

  // The rim. A working body wears a 1px border in the working border colour.
  if (has(flags, F_RIM)) {
    out = over(out, premul(body.rim) * cov(abs(d + 0.5) - 0.5));
  }

  // A hollow: dashed while empty, solid and faint with a comet while a job runs.
  if (has(flags, F_HOLLOW)) {
    let ringCoverage = cov(abs(d + 0.75) - 0.75);
    if (has(flags, F_RUNNING)) {
      out = over(out, premul(vec4f(body.rim.rgb, body.rim.a * 0.22)) * ringCoverage);
      // The comet: a conic sweep, transparent for the first 60%, rising to full
      // at the head, one lap every 1.4s, in a ring 1.5–2.5px inside the rim.
      let head = fract(time / 1.4);
      let u = fract(clockwise(p) - head + 1.0);
      let sweep = smoothstep(0.6, 1.0, u);
      let cometRing = cov(abs(d + 2.0) - 0.5);
      out = over(out, premul(vec4f(body.rim.rgb, body.rim.a)) * sweep * cometRing);
    } else {
      let arc = clockwise(p) * TAU * r;
      let dashOn = step(fract(arc / 7.5), 0.6);
      out = over(out, premul(vec4f(body.rim.rgb, body.rim.a * 0.52)) * ringCoverage * dashOn);
    }
  }

  // The context ring on the rim: a faint ink track and the gauge, a twelfth
  // of the radius wide (5px at 60), in the theme's ink at 55% (a mid grey
  // over either fill) whatever the state (the figure, not the gauge, turns
  // orange when hot), from twelve o'clock clockwise with round caps, its outer
  // edge on the rim. On a mounted body the pane-colour gutter sits just
  // outside it, before the light begins.
  if (has(flags, F_RING)) {
    let width = r * GAUGE_WIDTH_RATIO;
    let ringRadius = r - width * 0.5;
    let ringD = dist - ringRadius;
    let track = stroke(ringD, 1.0);
    out = over(out, premul(vec4f(body.ink.rgb, body.ring.z)) * track);
    let fraction = body.ring.x;
    if (fraction > 0.0) {
      let angle = clockwise(p);
      let endAngle = fraction * TAU;
      let capStart = length(p - vec2f(0.0, -ringRadius));
      let capEnd = length(p - vec2f(sin(endAngle) * ringRadius, -cos(endAngle) * ringRadius));
      // Signed distance to the arc with its round caps.
      let arcD = select(1.0e6, abs(ringD), angle <= fraction);
      let shape = min(arcD, min(capStart, capEnd)) - width * 0.5;
      out = over(out, premul(vec4f(body.ink.rgb, 0.55 * body.motion.w)) * cov(shape));
    }
  }

  // Mounted in a pane: the body's colour as the gutter band outside the rim;
  // the outer light (the glow pass) joins it only for the selected pane's body.
  if (linked) {
    out = over(out, premul(body.link) * cov(abs(d - edge * 0.5) - edge * 0.5));
  }

  // Keyboard focus: a 2px ring, 4px off the rim, in the theme's ink.
  if (has(flags, F_FOCUS)) {
    out = over(out, premul(vec4f(frame.holdInk.rgb, 1.0)) * cov(abs(d - edge - 5.0) - 1.0));
  }

  // Evidence went quiet: dim and desaturate, never recolour.
  if (has(flags, F_STALE)) {
    let grey = vec3f(luma(out.rgb));
    out = vec4f(mix(out.rgb, grey, 0.75), out.a) * 0.58;
  }

  return out;
}
`;
