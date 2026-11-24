// Engine mesh pass. Writes the cloud renderer's scene contract:
// target 0 rgba16float = (lit linear color, ray distance), target 1 rg8unorm = (water, sun visibility).
struct View {
  camPos: vec3<f32>, _p0: f32,
  right: vec3<f32>, _p1: f32,
  up: vec3<f32>, _p2: f32,
  fwd: vec3<f32>, _p3: f32,
  fovY: f32, aspect: f32, near: f32, _p4: f32,
  sunDir: vec3<f32>, _p5: f32,
  sunColor: vec3<f32>, _p6: f32,
};
struct Draw {
  model: mat4x4<f32>,
  color: vec4<f32>,
  // x: base color texture, y: terrain shading, z: unlit
  flags: vec4<f32>,
};
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<uniform> D: Draw;
@group(1) @binding(0) var baseSampler: sampler;
@group(1) @binding(1) var baseTexture: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) c: vec4<f32>) -> VSOut {
  let world = (D.model * vec4<f32>(p, 1.0)).xyz;
  let q = world - V.camPos;
  let tanY = tan(V.fovY * 0.5);
  var o: VSOut;
  // Infinite reverse-Z perspective, identical to the cloud terrain raster.
  o.clip = vec4<f32>(dot(q, V.right) / (V.aspect * tanY), dot(q, V.up) / tanY, V.near, dot(q, V.fwd));
  o.world = world;
  o.normal = (D.model * vec4<f32>(n, 0.0)).xyz;
  o.uv = uv;
  o.color = c;
  return o;
}

struct FSOut { @location(0) surface: vec4<f32>, @location(1) water: vec2<f32> };

@fragment fn fs(v: VSOut, @builtin(front_facing) front: bool) -> FSOut {
  var n = normalize(v.normal);
  if (!front) { n = -n; }
  let sun = normalize(V.sunDir);
  var color: vec3<f32>;
  if (D.flags.y > 0.5) {
    color = cloudTerrainColor(v.world, n, sun);
  } else {
    var albedo = D.color * v.color;
    if (D.flags.x > 0.5) {
      let t = textureSample(baseTexture, baseSampler, v.uv);
      albedo = albedo * vec4<f32>(pow(t.rgb, vec3<f32>(2.2)), t.a);
    }
    if (albedo.a < 0.5) { discard; }
    let ambient = mix(vec3<f32>(0.23, 0.29, 0.37), vec3<f32>(0.38, 0.43, 0.50), n.y * 0.5 + 0.5);
    let direct = V.sunColor * max(dot(n, sun), 0.0) * 0.9;
    color = select(albedo.rgb * (ambient + direct), albedo.rgb, D.flags.z > 0.5);
  }
  return FSOut(vec4<f32>(color, length(v.world - V.camPos)), vec2<f32>(0.0, 1.0));
}

