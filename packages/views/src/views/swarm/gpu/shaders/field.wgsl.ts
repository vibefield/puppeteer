// The shader as a string module, so the package needs no bundler loader
// (esbuild in Godview, Vite in VibeField, tsc in both). `field.wgsl` beside it
// is the authoring copy; `shaders.test.ts` keeps the two identical.
export default `// The ground of the swarm: the faint 24px grid under a radial mask, quieted by
// the veil while the spawn bloom is open. One triangle. The hold ring is drawn
// last, in its own pass (hub.wgsl), so nothing the field draws covers it.

struct FieldVertex {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> FieldVertex {
  var out: FieldVertex;
  let uv = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

fn lineCoverage(coordinate: f32, pitch: f32) -> f32 {
  // A 1px line at the start of every tile, box-filtered at the device pixel.
  let half = 0.5 / frame.viewport.z;
  let f = fract(coordinate / pitch) * pitch;
  let overlap = min(f + half, 1.0) - max(f - half, 0.0);
  return clamp(overlap * frame.viewport.z, 0.0, 1.0);
}

@fragment
fn fs(in: FieldVertex) -> @location(0) vec4f {
  let dpr = frame.viewport.z;
  let p = in.position.xy / dpr;
  let size = frame.viewport.xy;
  let centre = size * 0.5;

  let pitch = frame.params.z;
  let lines = max(lineCoverage(p.x, pitch), lineCoverage(p.y, pitch));
  // \`radial-gradient(circle at center, black 20%, transparent 82%)\`: the
  // circle reaches the farthest corner.
  let reach = length(centre);
  let mask = 1.0 - smoothstep(0.2, 0.82, length(p - centre) / reach);
  // The veil is the monitor's own ground laid over the field; over a canvas
  // the page composites, that is exactly the grid's alpha times (1 − veil).
  let veil = clamp(frame.params.w, 0.0, 1.0);
  return premul(vec4f(frame.grid.rgb, frame.grid.a * lines * mask * (1.0 - veil)));
}
`;
