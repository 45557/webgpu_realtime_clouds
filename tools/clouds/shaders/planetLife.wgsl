// Life layers on the globe. Reconstructs the terrain point under each pixel
// from the planet's depth buffer, then layers biomes, habitat chemistry,
// colonies, craters and fires from equirectangular data the simulation
// writes. Lightning and meteorites are drawn as short glowing segments that
// the terrain occludes.
struct Event {
  dirKind: vec4<f32>,   // xyz surface direction, w kind (1 lightning, 2 meteorite)
  timing: vec4<f32>,    // x age (s), y size, z seed, w side angle
}

struct LifeParams {
  camPos: vec3<f32>, radius: f32,
  right: vec3<f32>, tanX: f32,
  up: vec3<f32>, tanY: f32,
  forward: vec3<f32>, near: f32,
  sun: vec3<f32>, far: f32,
  layers: vec4<f32>,    // life, habitat, biomes, craters
  extra: vec4<f32>,     // fires, time, event count, cloud lift (+10 when the chemistry layer is on)
  events: array<Event, 8>,
}

@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(1) var lifeMap: texture_2d<f32>;
@group(0) @binding(2) var fxMap: texture_2d<f32>;
@group(0) @binding(3) var biomeMap: texture_2d<f32>;
@group(0) @binding(4) var mapSampler: sampler;
@group(0) @binding(5) var<uniform> params: LifeParams;
@group(0) @binding(6) var chemMap: texture_2d<f32>;

const PI = 3.14159265;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn noise3(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
        mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), hash3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), hash3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
        mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), hash3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

fn mapUv(n: vec3<f32>) -> vec2<f32> {
  return vec2<f32>(atan2(n.z, n.x) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / PI);
}

fn sampleMap(tex: texture_2d<f32>, n: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(tex, mapSampler, mapUv(n), 0.0);
}

// Closest approach between the view ray and a segment, limited to the part
// of the ray in front of the terrain. Returns (distance, segment t).
fn raySegment(dir: vec3<f32>, maxT: f32, a: vec3<f32>, b: vec3<f32>) -> vec2<f32> {
  let ab = b - a;
  let d1 = dot(dir, dir);
  let d2 = dot(ab, ab);
  let r = dot(dir, ab);
  let w = dot(dir, a);
  let v = dot(ab, a);
  let denom = d1 * d2 - r * r;
  var s = clamp((r * w - d1 * v) / max(denom, 1e-12), 0.0, 1.0);
  var t = (w + s * r) / d1;
  if (t > maxT || t < 0.0) { return vec2<f32>(1e30, s); }
  return vec2<f32>(length(dir * t - (a + ab * s)), s);
}

fn premultiply(base: vec4<f32>, layer: vec3<f32>, alpha: f32) -> vec4<f32> {
  return vec4<f32>(base.rgb * (1.0 - alpha) + layer * alpha, base.a * (1.0 - alpha) + alpha);
}

@fragment
fn fragmentMain(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let depthSize = vec2<f32>(textureDimensions(sceneDepth));
  let canvasUv = frag.xy / depthSize;
  let depth = textureLoad(sceneDepth, vec2<i32>(frag.xy), 0);
  let ndc = vec2<f32>(canvasUv.x * 2.0 - 1.0, 1.0 - canvasUv.y * 2.0);
  // Camera-relative ray whose forward component is 1, so the view depth scales it.
  let ray = params.forward + params.right * ndc.x * params.tanX + params.up * ndc.y * params.tanY;
  var color = vec4<f32>(0.0);
  var hitT = 1e30;
  if (depth < 1.0) {
    let viewDepth = params.near / (1.0 - depth + depth * params.near / params.far);
    hitT = viewDepth;
    let world = params.camPos + ray * viewDepth;
    let n = normalize(world);
    let lit = 0.22 + 0.78 * smoothstep(-0.15, 0.35, dot(n, params.sun));
    // Organic edges: wobble the lookup by about a third of a cell.
    let wobble = vec3<f32>(noise3(n * 60.0), noise3(n * 60.0 + 17.0), noise3(n * 60.0 + 41.0)) - 0.5;
    let m = normalize(n + wobble * 0.03);
    let grain = 0.7 + 0.3 * noise3(n * 900.0);
    if (params.layers.z > 0.5) {
      let biome = sampleMap(biomeMap, m);
      color = premultiply(color, biome.rgb * lit, biome.a);
    }
    let fx = sampleMap(fxMap, m);
    if (params.layers.y > 0.5 && fx.b > 0.02) {
      let kind = fx.a * 5.0;
      var tint = vec3<f32>(1.0, 0.55, 0.24);
      if (kind > 1.5 && kind < 2.5) { tint = vec3<f32>(0.35, 0.86, 1.0); }
      if (kind > 2.5 && kind < 3.5) { tint = vec3<f32>(0.47, 1.0, 0.78); }
      if (kind > 3.5) { tint = vec3<f32>(1.0, 0.82, 0.35); }
      let pulse = 0.8 + 0.2 * sin(params.extra.y * 2.0 + noise3(n * 40.0) * 6.0);
      color = premultiply(color, tint * (0.5 + 0.5 * lit), clamp(fx.b, 0.0, 1.0) * 0.7 * pulse);
    }
    if (params.layers.x > 0.5) {
      let life = sampleMap(lifeMap, m);
      color = premultiply(color, life.rgb * lit * (0.85 + 0.3 * grain), life.a * grain);
    }
    if (params.extra.w > 5.0) {
      let chem = sampleMap(chemMap, m);
      color = premultiply(color, chem.rgb * (0.45 + 0.55 * lit), chem.a * 0.8);
    }
    if (params.layers.w > 0.5 && fx.g > 0.02) {
      color = premultiply(color, vec3<f32>(0.16, 0.1, 0.07) * lit, fx.g * 0.75);
    }
    if (params.extra.x > 0.5 && fx.r > 0.02) {
      let flicker = 0.6 + 0.4 * noise3(n * 300.0 + vec3<f32>(params.extra.y * 6.0));
      let fire = vec3<f32>(1.0, 0.45 + 0.3 * flicker, 0.1) * (1.4 * flicker);
      color = vec4<f32>(color.rgb + fire * fx.r, max(color.a, fx.r * flicker));
    }
    // Surface glow around fresh impacts and strikes, sized to stay visible from orbit.
    let view = length(params.camPos) / params.radius - 1.0;
    for (var e = 0u; e < u32(params.extra.z); e++) {
      let ev = params.events[e];
      let close = dot(n, ev.dirKind.xyz);
      if (ev.dirKind.w > 1.5) {
        let since = ev.timing.x - 0.8;
        if (since > 0.0) {
          let reach = (0.004 + 0.05 * ev.timing.y + 0.02 * view) * min(1.0, since + 0.3);
          let glow = exp(-pow(acos(clamp(close, -1.0, 1.0)) / reach, 2.0)) * exp(-since * 1.6);
          color = vec4<f32>(color.rgb + vec3<f32>(1.0, 0.6, 0.25) * glow * 2.0, max(color.a, min(1.0, glow)));
        }
      } else {
        let glow = exp(-pow(acos(clamp(close, -1.0, 1.0)) / (0.004 + 0.012 * view), 2.0)) * exp(-ev.timing.x * 9.0);
        color = vec4<f32>(color.rgb + vec3<f32>(0.75, 0.82, 1.0) * glow, max(color.a, min(1.0, glow)));
      }
    }
  }
  // Bolts and incoming meteorites, hidden behind terrain.
  for (var e = 0u; e < u32(params.extra.z); e++) {
    let ev = params.events[e];
    let ground = ev.dirKind.xyz * params.radius - params.camPos;
    let px = length(params.camPos - ev.dirKind.xyz * params.radius);
    let width = px * 0.004;
    if (ev.dirKind.w < 1.5) {
      let top = ev.dirKind.xyz * params.radius * (1.0 + fract(params.extra.w)) - params.camPos;
      let wiggle = cross(ev.dirKind.xyz, vec3<f32>(0.0, 1.0, 0.0)) * params.radius * 0.002 * sin(ev.timing.z * 9.0);
      let mid = (ground + top) * 0.5 + wiggle;
      let a = raySegment(ray, hitT, ground, mid);
      let b = raySegment(ray, hitT, mid, top);
      let d = min(a.x, b.x);
      let glow = exp(-pow(d / width, 2.0)) * exp(-ev.timing.x * 9.0);
      color = vec4<f32>(color.rgb + vec3<f32>(0.8, 0.86, 1.0) * glow * 1.5, max(color.a, min(1.0, glow)));
    } else if (ev.timing.x < 0.8) {
      let t = ev.timing.x / 0.8;
      let side = normalize(cross(ev.dirKind.xyz, vec3<f32>(cos(ev.timing.w), 0.3, sin(ev.timing.w))));
      let head = (ev.dirKind.xyz * (1.0 + 0.6 * (1.0 - t)) + side * 0.4 * (1.0 - t)) * params.radius - params.camPos;
      let tailT = max(0.0, t - 0.3);
      let tail = (ev.dirKind.xyz * (1.0 + 0.6 * (1.0 - tailT)) + side * 0.4 * (1.0 - tailT)) * params.radius - params.camPos;
      let hit = raySegment(ray, hitT, tail, head);
      let glow = exp(-pow(hit.x / (width * (1.0 + 2.0 * ev.timing.y)), 2.0)) * hit.y * hit.y;
      color = vec4<f32>(color.rgb + vec3<f32>(1.0, 0.8, 0.55) * glow * 2.0, max(color.a, min(1.0, glow)));
    }
  }
  return vec4<f32>(min(color.rgb, vec3<f32>(color.a * 1.5 + 0.5)), clamp(color.a, 0.0, 1.0));
}
