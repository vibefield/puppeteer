// The outer light in the pane's colour, which is the body's accent when the
// body is mounted: the mark of a mounted pane. Drawn after every body so it
// falls on neighbours the way light does. Two falloffs of the distance outside the rim: a tight photographic rim
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
  return premul(vec4f(body.accent.rgb, a));
}
