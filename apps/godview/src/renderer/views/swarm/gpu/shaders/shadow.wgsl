// Under the bodies: a working body's resting drop shadow, breathing between a
// rest and a peak layer over three seconds, a gaussian occupancy of the disc,
// which is what CSS box-shadow is.

const SHADOW_MARGIN: f32 = 40.0;

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> BodyVertex {
  let flags = bodies[instance].flags.x;
  return bodyQuad(vertex, instance, SHADOW_MARGIN, has(flags, F_SHADOW));
}

@fragment
fn fs(in: BodyVertex) -> @location(0) vec4f {
  let body = bodies[in.index];
  let flags = body.flags.x;
  let r = body.posRadius.z * body.posRadius.w;
  let p = in.local;
  let time = frame.viewport.w;
  var out = vec4f(0.0);

  if (has(flags, F_SHADOW)) {
    let k = (0.5 - 0.5 * cos(time * TAU / 3.0 + body.motion.y)) * frame.params.y;
    let opacity = body.motion.w;
    let rest = occupancy(length(p - vec2f(0.0, 8.0)) - r, 2.5) * frame.shadow.a * (1.0 - k) * opacity;
    let peak = occupancy(length(p - vec2f(0.0, 12.0)) - r, 4.25) * frame.shadowPeak.a * k * opacity;
    out = over(out, premul(vec4f(frame.shadow.rgb, rest)));
    out = over(out, premul(vec4f(frame.shadow.rgb, peak)));
  }

  return out;
}
