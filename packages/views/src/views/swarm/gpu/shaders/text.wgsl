// Glyphs and marks, one quad each, tinted by the instance. Type comes from the
// rasterised atlas as coverage; vendor marks come from the signed-distance
// atlas and are reconstructed at any size from the field.

struct Glyph {
  // x, y, width, height (CSS px)
  rect: vec4f,
  uv: vec4f,
  color: vec4f,
  // x: 0 = coverage from the glyph atlas, 1 = signed distance from the marks;
  // y: the field's px range on screen (pxRange × quad px / tile texels)
  params: vec4f,
};

@group(1) @binding(0) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(1) var atlas: texture_2d<f32>;
@group(1) @binding(2) var atlasSampler: sampler;
@group(1) @binding(3) var marks: texture_2d<f32>;

struct GlyphVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) index: u32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GlyphVertex {
  let glyph = glyphs[instance];
  let corner = quadCorner(vertex) * 0.5 + 0.5;
  var out: GlyphVertex;
  out.position = cssToClip(glyph.rect.xy + corner * glyph.rect.zw);
  out.uv = mix(glyph.uv.xy, glyph.uv.zw, corner);
  out.index = instance;
  return out;
}

@fragment
fn fs(in: GlyphVertex) -> @location(0) vec4f {
  let glyph = glyphs[in.index];
  // Both taps stay in uniform control flow; the select picks one.
  let alpha = textureSample(atlas, atlasSampler, in.uv).a;
  let field = textureSample(marks, atlasSampler, in.uv).r;
  let fromField = clamp(glyph.params.y * (field - 0.5) + 0.5, 0.0, 1.0);
  let coverage = select(alpha, fromField, glyph.params.x > 0.5);
  return premul(glyph.color) * coverage;
}
