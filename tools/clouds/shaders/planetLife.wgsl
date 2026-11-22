// Seconds from a meteor's entry to impact (METEOR_FLIGHT in planetCraters.js).
const FLIGHT: f32 = 2.0;
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
  craters: array<vec4<f32>, 16>,   // xyz centre, w angular radius
  craterFade: array<vec4<f32>, 4>, // freshness of each crater, 1 new to 0 weathered
  origin: vec4<f32>,    // xyz a local origin near the camera (multiple of 1024 m), w radians per pixel
  camLocal: vec4<f32>,  // xyz camera position from that origin, w organisms on
  ground: vec4<f32>,    // x ground radius under the camera, y camera height above it
}

@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(1) var lifeMap: texture_2d<f32>;
@group(0) @binding(2) var fxMap: texture_2d<f32>;
@group(0) @binding(3) var biomeMap: texture_2d<f32>;
@group(0) @binding(4) var mapSampler: sampler;
@group(0) @binding(5) var<uniform> params: LifeParams;
@group(0) @binding(6) var chemMap: texture_2d<f32>;
// Per colony site: (body size m, form, density, speed) then (rgb, phase).
@group(0) @binding(7) var<storage, read> bodies: array<vec4<f32>>;
// The heatmap's texel-to-cell blend: three cells and two weights per texel.
@group(0) @binding(8) var<storage, read> texelCellIds: array<u32>;
@group(0) @binding(9) var<storage, read> texelWeights: array<vec2<f32>>;

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

fn over(base: vec4<f32>, layer: vec3<f32>, alpha: f32) -> vec4<f32> {
  return vec4<f32>(base.rgb * (1.0 - alpha) + layer * alpha, base.a + alpha * (1.0 - base.a));
}

fn glowAdd(base: vec4<f32>, light: vec3<f32>, amount: f32) -> vec4<f32> {
  return vec4<f32>(base.rgb + light * amount, max(base.a, min(1.0, amount)));
}

// Angle around a crater centre, for radial ejecta rays.
fn aroundAngle(n: vec3<f32>, c: vec3<f32>) -> f32 {
  var e = cross(vec3<f32>(0.0, 1.0, 0.0), c);
  if (dot(e, e) < 1e-6) { e = vec3<f32>(1.0, 0.0, 0.0); }
  e = normalize(e);
  let nn = cross(c, e);
  return atan2(dot(n, nn), dot(n, e));
}

fn rays(theta: f32, seed: f32, count: f32) -> f32 {
  let r = noise3(vec3<f32>(cos(theta) * count, sin(theta) * count, seed * 13.0));
  return smoothstep(0.45, 0.85, r);
}

fn premultiply(base: vec4<f32>, layer: vec3<f32>, alpha: f32) -> vec4<f32> {
  return vec4<f32>(base.rgb * (1.0 - alpha) + layer * alpha, base.a * (1.0 - alpha) + alpha);
}


// ---- Individual organisms, drawn once they are big enough to see ----------
// Each colony site has a body plan (planetLifeSim bodyPlan). Near the camera,
// individuals are scattered on a jittered grid in the plane of the cube face
// the ground faces, sized by a power of two of their spacing so the grid is
// stable, and ray-traced as spheres and capsules. All positions are kept
// relative to a local origin near the camera for float precision.
const MAP_W: u32 = 512u;
const MAP_H: u32 = 256u;
const SLOTS: u32 = 2u;
var<private> contactShade: f32 = 1.0;

fn pcg3(v: vec3<u32>) -> vec3<u32> {
  var x = v * 1664525u + 1013904223u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  x ^= x >> vec3<u32>(16u);
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  return x;
}

fn rand3(v: vec3<i32>) -> vec3<f32> {
  return vec3<f32>(pcg3(bitcast<vec3<u32>>(v)) >> vec3<u32>(8u)) / 16777216.0;
}

fn texelOf(n: vec3<f32>) -> u32 {
  let uv = mapUv(n);
  let x = min(u32(uv.x * f32(MAP_W)), MAP_W - 1u);
  let y = min(u32(max(uv.y, 0.0) * f32(MAP_H)), MAP_H - 1u);
  return y * MAP_W + x;
}

struct OrganismHit { t: f32, cover: f32, normal: vec3<f32>, albedo: vec3<f32> }

// Ray against a capsule (a sphere when a == b), relative to the camera.
fn capsule(hit: ptr<function, OrganismHit>, rd: vec3<f32>, maxT: f32, a: vec3<f32>, b: vec3<f32>, r: f32,
           pixel: f32, albedo: vec3<f32>) {
  let seg = raySegment(rd, maxT + r, a, b);
  if (seg.x > r + pixel * maxT) { return; }
  let axis = a + (b - a) * seg.y;
  let tc = dot(rd, axis);
  let t = tc - sqrt(max(r * r - seg.x * seg.x, 0.0));
  if (t <= 0.0 || t > maxT + 0.05 * r || t > (*hit).t) { return; }
  let footprint = max(pixel * tc, 1e-6);
  // Fade out bodies thinner than a pixel instead of letting them sparkle.
  let cover = clamp((r - seg.x) / footprint + 0.5, 0.0, 1.0) * clamp(2.0 * r / footprint, 0.0, 1.0);
  if (cover < 0.02) { return; }
  (*hit).t = t;
  (*hit).cover = cover;
  (*hit).normal = normalize(rd * t - axis);
  (*hit).albedo = albedo;
}

fn axisOf(n: vec3<f32>) -> u32 {
  let a = abs(n);
  if (a.x >= a.y && a.x >= a.z) { return 0u; }
  if (a.y >= a.z) { return 1u; }
  return 2u;
}

// Distance along the ray to where it passes `y` metres above a sphere of
// radius ground.x, or -1 when it does not. Stable for a camera near the ground.
fn heightCrossing(rd: vec3<f32>, up: vec3<f32>, y: f32) -> f32 {
  let r = params.ground.x + y;
  let h = params.ground.y - y;
  if (h <= 0.0) { return 0.0; }
  let b = dot(rd, up) * (params.ground.x + params.ground.y);
  let c = h * (2.0 * r + h);
  let disc = b * b - c;
  if (b >= 0.0 || disc < 0.0) { return -1.0; }
  return c / (-b + sqrt(disc));
}

// Form-specific shape: the horizontal reach (in body sizes) bounds how far
// an individual may sit from its cell centre, so it stays inside its cell
// column and a walk over the cells under the ray finds it.
fn formReach(form: f32) -> f32 {
  if (form < 1.5) { return 0.54; }
  if (form < 2.5) { return 0.27; }
  if (form < 3.5) { return 0.43; }
  return 0.7;
}

// Moves a base point onto the ground the planet actually drew, read from
// the depth buffer where the base appears on screen.
fn snapToGround(base: vec3<f32>, up: vec3<f32>, h: f32) -> vec3<f32> {
  let z = dot(base, params.forward);
  if (z <= params.near) { return base; }
  let ndc = vec2<f32>(dot(base, params.right) / (z * params.tanX), dot(base, params.up) / (z * params.tanY));
  if (any(abs(ndc) >= vec2<f32>(1.0))) { return base; }
  let size = vec2<f32>(textureDimensions(sceneDepth));
  let px = vec2<i32>((ndc * vec2<f32>(0.5, -0.5) + 0.5) * size);
  let depth = textureLoad(sceneDepth, px, 0);
  if (depth >= 1.0) { return base; }
  let viewDepth = params.near / (1.0 - depth + depth * params.near / params.far);
  let ray = params.forward + params.right * ndc.x * params.tanX + params.up * ndc.y * params.tanY;
  let ground = ray * viewDepth;
  let lift = dot(ground - base, up);
  return select(base, base + up * lift, abs(lift) < 1.5 * h);
}

fn organisms(rd: vec3<f32>, tGround: f32, hasGround: bool) -> vec4<f32> {
  var hit = OrganismHit(1e30, 0.0, vec3<f32>(0.0), vec3<f32>(0.0));
  let camL = params.camLocal.xyz;
  let origin = params.origin.xyz;
  let pixel = params.origin.w;
  let camUp = normalize(origin + camL);
  var tRef = tGround;
  var missed = false;
  if (!hasGround) {
    tRef = heightCrossing(rd, camUp, 0.0);
    if (tRef < 0.0) {
      // Over the horizon: the ray is closest to the ground here.
      // (or at the camera, for a ray that climbs away from the ground).
      tRef = max(0.0, -dot(rd, camUp) * (params.ground.x + params.ground.y));
      missed = true;
    }
  }
  let refLocal = camL + rd * tRef;
  let up = normalize(origin + refLocal);
  // The local ground plane under the ray.
  var plane = refLocal;
  if (missed) { plane -= up * (length(origin + refLocal) - params.ground.x); }
  let groundRadius = length(origin + plane);
  let camHeight = dot(camL - plane, up);
  let climb = dot(rd, up);
  let refTexel = texelOf(up);
  let axis = axisOf(up);
  let ia = (axis + 1u) % 3u;
  let ja = (axis + 2u) % 3u;
  let sunLit = smoothstep(-0.15, 0.35, dot(up, params.sun));
  let maxT = select(1e30, tGround, hasGround);
  for (var slot = 0u; slot < SLOTS; slot++) {
    let refBody = bodies[(texelCellIds[refTexel * 3u] * SLOTS + slot) * 2u];
    let size = refBody.x;
    if (refBody.y < 0.5 || refBody.z <= 0.0) { continue; }
    let level = clamp(ceil(log2(size * 1.6)), -7.0, 10.0);
    let cellSize = exp2(level);
    let top = 1.4 * size;
    // The stretch of ray that runs between the ground and the tallest body.
    var t0 = 0.0;
    var t1 = tRef;
    if (missed) {
      let lowest = length(origin + refLocal) - params.ground.x;
      if (lowest >= top) { continue; }
      let half = sqrt(2.0 * groundRadius * (top - lowest));
      t0 = max(0.0, tRef - half);
      t1 = tRef + half;
      if (tRef <= 0.0) {
        // Climbing from inside the band: leave it where the ray passes `top`.
        let b = dot(rd, camUp) * (params.ground.x + params.ground.y);
        let c = (params.ground.y - top) * (2.0 * (params.ground.x + top) + params.ground.y - top);
        t1 = -b + sqrt(max(b * b - c, 0.0));
      }
    } else {
      let fall = min(climb, -0.03);
      t0 = max(0.0, (camHeight - top) / -fall);
      t1 = select(tRef, min(tRef, camHeight / -fall), climb < -0.03);
      if (hasGround) { t1 = tGround; }
    }
    // Only as far as one of them still covers a pixel.
    t1 = min(t1, size / pixel);
    if (t1 <= t0) { continue; }
    // Its track on the ground, in the cube-face plane coordinates.
    let p0 = camL + rd * t0 - up * (camHeight + climb * t0);
    let p1 = camL + rd * t1 - up * (camHeight + climb * t1);
    let a = vec2<f32>(p0[ia], p0[ja]) / cellSize;
    let span = vec2<f32>(p1[ia], p1[ja]) / cellSize - a;
    let originCell = vec2<i32>(i32(origin[ia] / cellSize), i32(origin[ja] / cellSize));
    let salt = i32(level) + 64 * i32(slot) + 512 * i32(axis);
    // The three blended cells' colonies in this slot, read once for the walk.
    let texel = texelOf(normalize(origin + (p0 + p1) * 0.5));
    let w = texelWeights[texel];
    var kinds: array<vec4<f32>, 3>;
    var looks: array<vec4<f32>, 3>;
    for (var k = 0u; k < 3u; k++) {
      let site = texelCellIds[texel * 3u + k] * SLOTS + slot;
      kinds[k] = bodies[site * 2u];
      looks[k] = bodies[site * 2u + 1u];
    }
    var c = vec2<i32>(floor(a));
    let stepDir = vec2<i32>(sign(span));
    let safe = select(span, vec2<f32>(1e-9), abs(span) < vec2<f32>(1e-9));
    let delta = abs(1.0 / safe);
    var next = (vec2<f32>(c) + select(vec2<f32>(0.0), vec2<f32>(1.0), span > vec2<f32>(0.0)) - a) / safe;
    next = select(next, vec2<f32>(1e30), abs(span) < vec2<f32>(1e-9));
    // Walk the cells under the ray front to back (Amanatides and Woo).
    for (var walk = 0; walk < 32; walk++) {
      let r = rand3(vec3<i32>(c + originCell, salt));
      // Pick one of the blended cells, so neighbouring populations interleave.
      let pick = select(select(2u, 1u, r.z < w.x + w.y), 0u, r.z < w.x);
      let body = kinds[pick];
      // A different species (another size class) is drawn on its own grid.
      if (body.y > 0.5 && r.y < body.z && ceil(log2(body.x * 1.6)) == level) {
        let look = looks[pick];
        let r2 = rand3(vec3<i32>(c + originCell, salt + 7919));
        let h = body.x * (0.8 + 0.4 * r2.x);
        let room = max(0.22, 0.5 - formReach(body.y) * 1.2 * body.x / cellSize);
        let spot = (vec2<f32>(c) + 0.5 + (vec2<f32>(r.x, r2.z) - 0.5) * 2.0 * room) * cellSize;
        var offset = vec3<f32>(0.0);
        offset[ia] = spot.x - plane[ia];
        offset[ja] = spot.y - plane[ja];
        offset[axis] = -(up[ia] * offset[ia] + up[ja] * offset[ja]) / up[axis];
        // Follow the planet's curve, then settle on the drawn terrain.
        offset -= up * dot(offset, offset) / (2.0 * groundRadius);
        var base = plane + offset - camL;
        var heading = normalize(cross(up, vec3<f32>(r2.y - 0.5, 0.31, r.x - 0.5)));
        if (body.y > 3.5) {
          // Animals pace a small loop at their own speed.
          let pace = 0.1 * cellSize;
          let phase = params.extra.y * body.w * h / pace + 6.2832 * r2.y;
          let e1 = normalize(cross(up, vec3<f32>(0.0, 0.0, 1.0) + up.yzx * 0.01));
          let e2 = cross(up, e1);
          base += (e1 * cos(phase) + e2 * sin(phase)) * pace;
          heading = normalize(e2 * cos(phase) - e1 * sin(phase));
        }
        // Cheap bounds before the shape tests: a loose one that allows for
        // the ground under the base, then a tight one once it is settled.
        var mid = base + up * 0.5 * h;
        var tc = dot(rd, mid);
        var near = tc > 0.0 && length(mid - rd * tc) < 2.4 * h + pixel * tc;
        if (near) {
          base = snapToGround(base, up, h);
          mid = base + up * 0.5 * h;
          tc = dot(rd, mid);
          near = tc > 0.0 && length(mid - rd * tc) < 0.9 * h + pixel * tc;
        }
        if (near) {
          if (hasGround) {
            // Contact shade on the ground around the base.
            let g = rd * tGround - base;
            let flat = length(g - up * dot(g, up));
            contactShade = min(contactShade, 1.0 - 0.4 * exp(-pow(flat / (0.45 * h), 2.0)));
          }
          let tone = look.rgb * (0.8 + 0.4 * r2.y);
          if (body.y < 1.5) {
            // Microbial mound: a low dome of mat and trapped sediment.
            capsule(&hit, rd, maxT, base - up * 0.25 * h, base - up * 0.25 * h, 0.45 * h, pixel,
              mix(vec3<f32>(0.5, 0.46, 0.4), tone, 0.55));
          } else if (body.y < 2.5) {
            capsule(&hit, rd, maxT, base, base + up * 0.55 * h, 0.22 * h, pixel, tone);
          } else if (body.y < 3.5) {
            let lean = heading * 0.08 * h;
            capsule(&hit, rd, maxT, base, base + up * 0.62 * h + lean, 0.05 * h, pixel, vec3<f32>(0.3, 0.21, 0.13));
            capsule(&hit, rd, maxT, base + up * 0.62 * h + lean, base + up * 0.88 * h + lean * 1.3, 0.26 * h, pixel, tone);
          } else {
            let torso = base + up * 0.4 * h;
            let head = torso + heading * 0.45 * h + up * 0.08 * h;
            capsule(&hit, rd, maxT, torso - heading * 0.25 * h, torso + heading * 0.25 * h, 0.17 * h, pixel, tone);
            capsule(&hit, rd, maxT, head, head, 0.12 * h, pixel, tone * 0.7);
            capsule(&hit, rd, maxT, torso - heading * 0.15 * h, base - heading * 0.18 * h, 0.04 * h, pixel, tone * 0.6);
            capsule(&hit, rd, maxT, torso + heading * 0.15 * h, base + heading * 0.18 * h, 0.04 * h, pixel, tone * 0.6);
          }
        }
      }
      let leave = min(next.x, next.y);
      if (leave >= 1.0 || hit.t < t0 + leave * (t1 - t0)) { break; }
      if (next.x < next.y) { c.x += stepDir.x; next.x += delta.x; } else { c.y += stepDir.y; next.y += delta.y; }
    }
  }
  if (hit.cover <= 0.0) { return vec4<f32>(0.0); }
  let sunOn = max(dot(hit.normal, params.sun), 0.0);
  let sky = 0.5 + 0.5 * dot(hit.normal, up);
  let light = 0.12 + sunLit * (0.25 * sky + 0.75 * sunOn);
  return vec4<f32>(hit.albedo * light, hit.cover);
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
    // Crater marks: a shadowed bowl, a bright rim and rays of fresh ejecta
    // that weather away over geological time.
    if (params.layers.w > 0.5) {
      for (var k = 0u; k < 16u; k++) {
        let crater = params.craters[k];
        if (crater.w <= 0.0) { continue; }
        let d = length(n - crater.xyz) / crater.w;
        if (d > 4.0) { continue; }
        let fresh = params.craterFade[k / 4u][k % 4u];
        let theta = aroundAngle(n, crater.xyz);
        let rim = exp(-pow((d - 1.0) / 0.16, 2.0));
        let bowl = 1.0 - smoothstep(0.75, 1.0, d);
        let ejecta = rays(theta, f32(k), 7.0) * (1.0 - smoothstep(1.1, 3.8, d)) * step(1.0, d);
        let apron = (1.0 - smoothstep(1.0, 1.7, d)) * step(1.0, d);
        // Light the bowl from the sun: the side facing away from it is in shadow.
        let toSun = dot(normalize(n - crater.xyz + vec3<f32>(1e-6)), params.sun);
        color = over(color, vec3<f32>(0.08, 0.06, 0.05), bowl * (0.35 + 0.25 * toSun) * (0.4 + 0.6 * fresh));
        color = over(color, vec3<f32>(0.8, 0.76, 0.7) * lit, (rim * 0.5 + apron * 0.25 + ejecta * 0.3) * fresh);
      }
    }
    if (params.extra.x > 0.5 && fx.r > 0.02) {
      let flicker = 0.6 + 0.4 * noise3(n * 300.0 + vec3<f32>(params.extra.y * 6.0));
      let fire = vec3<f32>(1.0, 0.45 + 0.3 * flicker, 0.1) * (1.4 * flicker);
      color = vec4<f32>(color.rgb + fire * fx.r, max(color.a, fx.r * flicker));
    }
    // Fresh strikes and impacts on the ground, sized to stay visible from orbit.
    let view = length(params.camPos) / params.radius - 1.0;
    for (var e = 0u; e < u32(params.extra.z); e++) {
      let ev = params.events[e];
      let evDir = normalize(ev.dirKind.xyz);
      let chord = length(n - evDir);
      if (ev.dirKind.w > 1.5) {
        let since = ev.timing.x - FLIGHT;
        if (since > 0.0) {
          let size = ev.timing.y;
          let r = 0.006 + 0.028 * min(size, 1.5);
          let theta = aroundAngle(n, evDir);
          // White-hot flash, then a molten floor that cools to dark red.
          let flash = exp(-pow(chord / (r * (2.5 + 6.0 * since)), 2.0)) * exp(-since * 7.0) * 4.0;
          let molten = (1.0 - smoothstep(0.5, 1.0, chord / r)) * exp(-since / 3.5) * (0.7 + 0.3 * noise3(n * 900.0 + vec3<f32>(since)));
          // A shock front races outward and a ray-streaked ejecta curtain follows.
          let front = r * (1.0 + 10.0 * sqrt(since));
          let shock = exp(-pow((chord - front) / (r * 0.35 + 0.002 * view), 2.0)) * exp(-since * 1.1);
          let curtainEdge = r * (1.0 + 3.6 * sqrt(min(since, 3.0)));
          let curtain = (1.0 - smoothstep(curtainEdge * 0.7, curtainEdge, chord)) * step(r * 0.9, chord)
            * (0.35 + 0.65 * rays(theta, ev.timing.z * 50.0, 9.0)) * smoothstep(0.0, 0.25, since) * exp(-max(0.0, since - 2.0) / 2.5);
          color = over(color, vec3<f32>(0.42, 0.33, 0.25) * (0.4 + 0.6 * lit), curtain * 0.85);
          color = glowAdd(color, vec3<f32>(1.0, 0.85, 0.6), shock * 0.9);
          color = glowAdd(color, vec3<f32>(1.0, 0.35, 0.08), molten * 1.4);
          color = glowAdd(color, vec3<f32>(1.0, 0.95, 0.85), flash);
        }
      } else {
        let glow = exp(-pow(chord / (0.004 + 0.012 * view), 2.0)) * exp(-ev.timing.x * 9.0);
        color = glowAdd(color, vec3<f32>(0.75, 0.82, 1.0), glow);
      }
    }
  }
  // Individual organisms near the camera, in front of the ground and against the sky.
  if (params.camLocal.w > 0.5 && params.ground.y < 50000.0) {
    let reach = length(ray);
    let organism = organisms(ray / reach, hitT * reach, depth < 1.0);
    color = over(color, vec3<f32>(0.0), 1.0 - contactShade);
    color = over(color, organism.rgb, organism.a);
  }
  // Bolts and incoming meteorites, hidden behind terrain.
  for (var e = 0u; e < u32(params.extra.z); e++) {
    let ev = params.events[e];
    // The event direction's length is the ground radius there (terrain or
    // sea surface), as a fraction of the planet radius.
    let evDir = normalize(ev.dirKind.xyz);
    let groundRadius = length(ev.dirKind.xyz) * params.radius;
    let ground = evDir * groundRadius - params.camPos;
    let px = length(ground);
    let width = px * 0.004;
    if (ev.dirKind.w < 1.5) {
      let top = evDir * (groundRadius + params.radius * fract(params.extra.w)) - params.camPos;
      let wiggle = cross(evDir, vec3<f32>(0.0, 1.0, 0.0)) * params.radius * 0.002 * sin(ev.timing.z * 9.0);
      let mid = (ground + top) * 0.5 + wiggle;
      let a = raySegment(ray, hitT, ground, mid);
      let b = raySegment(ray, hitT, mid, top);
      let d = min(a.x, b.x);
      let glow = exp(-pow(d / width, 2.0)) * exp(-ev.timing.x * 9.0);
      color = vec4<f32>(color.rgb + vec3<f32>(0.8, 0.86, 1.0) * glow * 1.5, max(color.a, min(1.0, glow)));
    } else {
      // Fireball: comes in on a shallow slant, accelerates, and leaves a
      // glowing ionised trail that cools into a drifting smoke streak.
      let size = ev.timing.y;
      let side = normalize(cross(evDir, vec3<f32>(cos(ev.timing.w), 0.35, sin(ev.timing.w))));
      let start = evDir * (groundRadius + 0.22 * params.radius) + side * 0.5 * params.radius - params.camPos;
      let t = clamp(ev.timing.x / FLIGHT, 0.0, 1.0);
      let travel = t * t * (0.6 + 0.4 * t);
      let head = mix(start, ground, travel);
      let core = width * (0.5 + 0.9 * size);
      if (ev.timing.x < FLIGHT) {
        let tail = mix(start, ground, max(0.0, travel - 0.6));
        let trail = raySegment(ray, hitT, tail, head);
        let along = trail.y * trail.y;
        let plasma = exp(-pow(trail.x / (core * (0.5 + 1.2 * along)), 2.0)) * (0.25 + 0.75 * along);
        let halo = exp(-pow(trail.x / (core * 5.0), 2.0)) * along * 0.35;
        color = glowAdd(color, mix(vec3<f32>(1.0, 0.35, 0.1), vec3<f32>(1.0, 0.92, 0.75), along), plasma * 2.2 + halo);
        // The impactor itself: a tumbling rock whose leading face glows
        // white-hot from the air it rams through, lit by the sun behind.
        let rockRadius = core * (2.4 + 1.4 * size);
        let rb = dot(ray, head);
        let ra = dot(ray, ray);
        let disc = rb * rb - ra * (dot(head, head) - rockRadius * rockRadius);
        var rockSeen = 0.0;
        if (disc > 0.0) {
          let rt = (rb - sqrt(disc)) / ra;
          if (rt > 0.0 && rt < hitT) {
            let normal = normalize(ray * rt - head);
            let heading = normalize(ground - start);
            let spin = ev.timing.w + ev.timing.x * 3.0;
            let lumps = noise3(normal * 3.5 + vec3<f32>(spin, 0.0, -spin)) * 0.6 + noise3(normal * 9.0 + spin) * 0.4;
            let sunLit = max(dot(normal, params.sun), 0.0);
            let rock = vec3<f32>(0.23, 0.2, 0.18) * (0.35 + 0.65 * lumps) * (0.15 + 0.85 * sunLit);
            // Ablation heat on the face pointing along the path, stronger near the ground.
            let ram = smoothstep(0.1, 0.95, dot(normal, heading)) * (0.45 + 0.55 * t);
            let heat = mix(vec3<f32>(1.0, 0.38, 0.08), vec3<f32>(1.0, 0.93, 0.8), ram * ram);
            color = over(color, rock + heat * ram * (1.2 + lumps), 1.0);
            rockSeen = 1.0;
          }
        }
        let bloom = raySegment(ray, hitT, head, head);
        color = glowAdd(color, vec3<f32>(1.0, 0.95, 0.85), exp(-pow(bloom.x / (core * 2.4), 2.0)) * (1.6 - 1.1 * rockSeen) * (0.4 + 0.6 * t));
      }
      // Smoke trail: hangs where the fireball passed, then fades.
      let smokeAge = ev.timing.x - 0.3;
      if (smokeAge > 0.0) {
        let smoke = raySegment(ray, hitT, start, head);
        let spread = core * (1.5 + 2.5 * smokeAge);
        let haze = exp(-pow(smoke.x / spread, 2.0)) * smoothstep(0.1, 0.6, smoke.y) * exp(-smokeAge / 2.5) * 0.45;
        color = over(color, vec3<f32>(0.55, 0.52, 0.5), haze);
      }
      // Bloom from the impact flash, seen through the air.
      let since = ev.timing.x - FLIGHT;
      if (since > 0.0) {
        // Visible when the impact site faces the camera; the bloom then spills over the horizon.
        let facing = dot(evDir, -ground) > 0.0;
        let flashPoint = raySegment(ray, select(0.0, 1e30, facing), ground, ground);
        color = glowAdd(color, vec3<f32>(1.0, 0.9, 0.75), exp(-pow(flashPoint.x / (core * (8.0 + 30.0 * size)), 2.0)) * exp(-since * 5.0) * 2.0);
      }
    }
  }
  return vec4<f32>(min(color.rgb, vec3<f32>(color.a * 1.5 + 0.5)), clamp(color.a, 0.0, 1.0));
}
