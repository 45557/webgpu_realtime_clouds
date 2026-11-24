// Standalone composite (used when clouds are off): sky, distance fog, tonemap.
struct View {
  camPos: vec3<f32>, _p0: f32,
  right: vec3<f32>, _p1: f32,
  up: vec3<f32>, _p2: f32,
  fwd: vec3<f32>, _p3: f32,
  fovY: f32, aspect: f32, near: f32, _p4: f32,
  sunDir: vec3<f32>, _p5: f32,
  sunColor: vec3<f32>, _p6: f32,
};
struct Comp { exposure: f32, _a: f32, _b: f32, _c: f32, sky: vec4<f32> };
@group(0) @binding(0) var<uniform> C: Comp;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> CV: View;

struct BlitOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn blitVs(@builtin(vertex_index) i: u32) -> BlitOut {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: BlitOut;
  o.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  return o;
}
@fragment fn blitFs(v: BlitOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(sceneTex));
  let s = textureLoad(sceneTex, vec2<i32>(v.uv * dims), 0);
  let tanY = tan(CV.fovY * 0.5);
  let ndc = vec2<f32>(v.uv.x * 2.0 - 1.0, 1.0 - v.uv.y * 2.0);
  let dir = normalize(CV.fwd + CV.right * ndc.x * tanY * CV.aspect + CV.up * ndc.y * tanY);
  let horizon = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0);
  var sky = mix(C.sky.rgb, vec3<f32>(0.85, 0.88, 0.92), horizon);
  sky += vec3<f32>(1.0, 0.9, 0.7) * pow(max(dot(dir, normalize(CV.sunDir)), 0.0), 400.0) * 4.0;
  var color = sky;
  if (s.a > 0.0) {
    let fog = 1.0 - exp(-s.a * 0.0018);
    color = mix(s.rgb, sky, fog);
  }
  // Narkowicz ACES fit.
  let x = color * C.exposure;
  color = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(pow(color, vec3<f32>(1.0 / 2.2)), 1.0);
}
