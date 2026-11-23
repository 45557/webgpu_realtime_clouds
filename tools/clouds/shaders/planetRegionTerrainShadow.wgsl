struct RegionShadowFrame {
  right: vec4<f32>,
  up: vec4<f32>,
  depth: vec4<f32>,
  sampling: vec4<f32>, // UV texel, world texel, depth per world unit, valid
}

fn region_shadow_clip(frame: RegionShadowFrame, position: vec3<f32>) -> vec4<f32> {
  let p = vec4<f32>(position, 1.0);
  return vec4<f32>(dot(frame.right, p), dot(frame.up, p), dot(frame.depth, p), 1.0);
}

fn region_shadow_visibility(frame: RegionShadowFrame, depth: texture_depth_2d,
    compare: sampler_comparison, position: vec3<f32>, normal: vec3<f32>, sun: vec3<f32>) -> f32 {
  if (frame.sampling.w < .5) { return 1.0; }
  let n = normalize(normal);
  let facing = max(0.0, dot(n, sun));
  let texel = frame.sampling.y;
  let projected = region_shadow_clip(frame, position + n * texel * (.55 + .85 * (1.0 - facing)));
  let uv = projected.xy * vec2<f32>(.5, -.5) + .5;
  let border = min(uv, 1.0 - uv);
  let edge = smoothstep(0.0, .04, min(border.x, border.y));
  if (edge <= 0.0 || projected.z < 0.0 || projected.z > 1.0) { return 1.0; }
  let receiver = projected.z - texel * frame.sampling.z * (.26 + .65 * (1.0 - facing));
  let r = frame.sampling.x * mix(1.05, 1.8, 1.0 - smoothstep(.12, .48, sun.y));
  let center = textureSampleCompareLevel(depth, compare, uv, receiver);
  let diagonal = vec2<f32>(.82, .57) * r;
  let perpendicular = vec2<f32>(-diagonal.y, diagonal.x);
  let ring = textureSampleCompareLevel(depth, compare, uv + diagonal, receiver) +
    textureSampleCompareLevel(depth, compare, uv - diagonal, receiver) +
    textureSampleCompareLevel(depth, compare, uv + perpendicular, receiver) +
    textureSampleCompareLevel(depth, compare, uv - perpendicular, receiver);
  let lit = .28 * center + .18 * ring;
  let aboveHorizon = smoothstep(.015, .065, sun.y);
  return mix(1.0, lit, edge * aboveHorizon);
}
