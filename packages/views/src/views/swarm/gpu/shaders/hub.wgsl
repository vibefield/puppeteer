// The hold ring, and the spawn bloom's hub: drawn LAST, above the bodies, their
// type and the clearings, so the press point is never lost under anything the
// field draws (record §2.8). 16px at the end of the hold, reached out-cubic from
// 55%; the theme's surface at 74%, a rim that climbs from the supporting ink to
// the full ink, and a dot. The frozen hub is the ring's final look (progress 1),
// drawn heavier (`holdShape`: a 1 px rim and 2 px dot in flight, 1.5 and 2.5 as
// the hub), and `pointer.w` scales all of it as the bloom closes. One quad.

const HUB_RADIUS: f32 = 16.0;
// Room past the ring for its rim's box filter.
const HUB_MARGIN: f32 = 2.0;

struct HubVertex {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> HubVertex {
  var out: HubVertex;
  out.local = quadCorner(vertex) * (HUB_RADIUS + HUB_MARGIN);
  out.position = cssToClip(frame.pointer.xy + out.local);
  return out;
}

@fragment
fn fs(in: HubVertex) -> @location(0) vec4f {
  let progress = clamp(frame.pointer.z, 0.0, 1.0);
  let rest = 1.0 - progress;
  let eased = 1.0 - rest * rest * rest;
  let radius = HUB_RADIUS * mix(0.55, 1.0, eased);
  let opacity = min(progress / 0.2, 1.0) * mix(0.8, 1.0, eased) * clamp(frame.pointer.w, 0.0, 1.0);
  let q = in.local;
  let d = length(q) - radius;
  let rim = mix(frame.holdRim, frame.holdInk, eased);
  // The rim is drawn inside the ring's edge, so a heavier one does not grow it.
  let half = frame.holdShape.x * 0.5;
  var out = vec4f(0.0);
  out = over(out, premul(frame.holdFill) * cov(d) * opacity);
  out = over(out, premul(rim) * cov(abs(d + half) - half) * opacity);
  out = over(out, premul(frame.holdInk) * cov(length(q) - frame.holdShape.y) * opacity);
  return out;
}
