// The shader as a string module, so the package needs no bundler loader
// (esbuild in Godview, Vite in VibeField, tsc in both). `glow.wgsl` beside it
// is the authoring copy; `shaders.test.ts` keeps the two identical.
export default `// The outer light in the body's own colour: the mark of the body mounted in
// the SELECTED pane. Every other mounted body wears the band alone. Drawn
// after every body so it falls on neighbours the way light does. Two falloffs of the distance outside the rim: a tight photographic rim
// and a designer halo (power 2.65, the fit from the glow study), scaled by the
// tunable reach and strength, breathing if asked.

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> BodyVertex {
  let body = bodies[instance];
  return bodyQuad(vertex, instance, body.glow.x + 6.0, has(body.flags.x, F_GLOW));
}

@fragment
fn fs(in: BodyVertex) -> @location(0) vec4f {
  let body = bodies[in.index];
  let r = body.posRadius.z * body.posRadius.w;
  let d = length(in.local) - r;
  // The light starts a thirtieth of the radius off the rim (2px at 60), where
  // the pane-colour gutter band stops.
  let gutter = r * LIGHT_GUTTER_RATIO;
  let outside = clamp((d - gutter) * frame.viewport.z + 0.5, 0.0, 1.0);
  let reach = max(body.glow.x, 1.0);
  let strength = body.glow.y;
  let breath = body.glow.z * frame.params.y;
  let time = frame.viewport.w;
  let breathe = 1.0 - breath * 0.62 * (0.5 - 0.5 * cos(time * TAU / 1.2 + body.glow.w));
  let outer = max(d - gutter, 0.0);
  let rim = exp(-outer / 6.0);
  let halo = pow(clamp(1.0 - outer / reach, 0.0, 1.0), 2.65);
  let a = clamp(strength * (0.45 * rim + 0.6 * halo), 0.0, 1.0) * breathe * outside;
  // The light beyond the band is the pane's, like the band: the colour of the
  // pane the body is worked in, not the project's.
  return premul(vec4f(body.link.rgb, a));
}
`;
