// The shader as a string module, so the package needs no bundler loader
// (esbuild in Godview, Vite in VibeField, tsc in both). `erase.wgsl` beside it
// is the authoring copy; `shaders.test.ts` keeps the two identical.
export default `// The spawn bloom's clearings (record §2.8): solid ground where the bloom and
// its words stand, cut out of everything drawn before them — the grid, the
// bodies and their type — so nothing on the field shows through. The pass
// ERASES: its blend is (zero, one-minus-src-alpha) on colour and alpha alike,
// so the canvas keeps (1 − coverage) of itself, and since the page composites
// the canvas premultiplied, what shows there is the monitor's own ground, as if
// that ground were painted over the frame at \`coverage\`. One triangle; the
// renderer skips it when there are none.

struct ClearingVertex {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> ClearingVertex {
  var out: ClearingVertex;
  let uv = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

/** A ring's clearing: solid to its radius, then the prototype's radial-gradient
 * stops — 0.62 at 45% of the feather, nothing at its end — piecewise linear. */
fn circleCoverage(distance: f32, radius: f32, feather: f32) -> f32 {
  let t = clamp((distance - radius) / feather, 0.0, 1.0);
  return select(0.62 * (1.0 - t) / 0.55, 1.0 - 0.38 * t / 0.45, t < 0.45);
}

/** The words' clearing: solid inside its box, then a smooth fall to nothing
 * over the feather, measured from the box (so its corners round off). */
fn rectCoverage(p: vec2f, centre: vec2f, half: vec2f, feather: f32) -> f32 {
  let outside = length(max(abs(p - centre) - half, vec2f(0.0)));
  return 1.0 - smoothstep(0.0, feather, outside);
}

@fragment
fn fs(in: ClearingVertex) -> @location(0) vec4f {
  let p = in.position.xy / frame.viewport.z;
  // A feather under a device pixel still antialiases the edge.
  let least = 1.0 / frame.viewport.z;
  let count = min(u32(frame.clearing.x), MAX_CLEARINGS);
  // Each clearing lays the ground over the last, as the prototype painted them.
  var keep = 1.0;
  for (var i = 0u; i < count; i = i + 1u) {
    let clearing = frame.clearings[i];
    let feather = max(clearing.edge.x, least);
    var coverage = 0.0;
    if (clearing.edge.y > 0.5) {
      coverage = rectCoverage(p, clearing.shape.xy, clearing.shape.zw, feather);
    } else {
      coverage = circleCoverage(length(p - clearing.shape.xy), clearing.shape.z, feather);
    }
    keep = keep * (1.0 - coverage * clamp(clearing.edge.z, 0.0, 1.0));
  }
  return vec4f(0.0, 0.0, 0.0, 1.0 - keep);
}
`;
