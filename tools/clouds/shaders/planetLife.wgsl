// Meteors follow the impact physics in life/impactPhysics.js: entry at
// 110 km, real speed, angle and size, then an airburst or a crater.
const ENTRY_ALTITUDE: f32 = 110000.0;
const GRAVITY: f32 = 9.81;
// Life layers on the globe. Reconstructs the terrain point under each pixel
// from the planet's depth buffer, then layers biomes, habitat chemistry,
// colonies, craters and fires from equirectangular data the simulation
// writes. Lightning and meteorites are drawn as short glowing segments that
// the terrain occludes.
struct Event {
  dirKind: vec4<f32>,   // xyz surface direction times ground radius / planet radius, w kind (1 lightning, 2 meteorite)
  timing: vec4<f32>,    // x age (s), y impactor diameter (m), z seed, w side angle
  path: vec4<f32>,      // x flight time (s), y entry elevation (rad), z azimuth (rad), w slant distance from the ground to the airburst (m, 0 reaches the ground)
  effect: vec4<f32>,    // x crater rim radius (m), y fireball radius (m), z sea depth (m), w excavation time (s)
  wave: vec4<f32>,      // x sea cavity radius (m), y wave height at its rim (m), z entry speed, w final speed (m/s)
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
  ground: vec4<f32>,    // x ground radius under the camera, y camera height above it, z water layer on
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
// Surface water per cell (planetWater.js): rivers run from the cell to the
// one it drains to; lakes, salt and ice sheets cover it.
struct WaterCell {
  at: vec4<f32>,     // xyz cell direction, w river width (m), 0 for none
  down: vec4<f32>,   // xyz where the river runs to, w how big it is (0 to 1)
  still: vec4<f32>,  // x lake cover, y salt, z ice sheet thickness (m)
  up: vec4<f32>,     // xyz the main river flowing in, w its width (m)
}
@group(0) @binding(10) var<storage, read> waterCells: array<WaterCell>;

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

// Direction of travel along the ground for an azimuth (0 north, clockwise).
fn eventHeading(c: vec3<f32>, azimuth: f32) -> vec3<f32> {
  var e = cross(vec3<f32>(0.0, 1.0, 0.0), c);
  if (dot(e, e) < 1e-6) { e = vec3<f32>(1.0, 0.0, 0.0); }
  e = normalize(e);
  return normalize(cos(azimuth) * cross(c, e) + sin(azimuth) * e);
}

// Unit vector from the impact point back up the path toward entry.
fn eventBack(ev: Event) -> vec3<f32> {
  let c = normalize(ev.dirKind.xyz);
  let angle = max(ev.path.y, 0.05);
  return c * sin(angle) - eventHeading(c, ev.path.z) * cos(angle);
}

// Slant distance from the ground up to an altitude along the path.
fn slantTo(altitude: f32, angle: f32, radius: f32) -> f32 {
  let s = sin(max(angle, 0.05));
  let h = altitude / radius;
  return radius * (sqrt(s * s + 2.0 * h + h * h) - s);
}

// How long the fireball glows: seconds for small blasts, about half a minute for the largest.
fn fireballTime(radius: f32) -> f32 {
  return max(0.8, sqrt(radius) / 12.0);
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

// Sea impact: the cavity opens and refills, a curtain of spray rises at its
// rim and a tsunami wave train runs out at the shallow-water speed sqrt(g h),
// its height falling off as 1/r (Ward & Asphaug 2000).
fn seaImpact(base: vec4<f32>, ev: Event, n: vec3<f32>, dist: f32, pixelM: f32, since: f32, theta: f32, lit: f32) -> vec4<f32> {
  var color = base;
  let cavityR = ev.wave.x;
  if (cavityR <= 0.0) { return color; }
  let excavation = max(ev.effect.w, 0.5);
  let grow = clamp(since / excavation, 0.0, 1.0);
  let refill = clamp((since - excavation) / (1.5 * excavation), 0.0, 1.0);
  let cavity = cavityR * sqrt(grow) * (1.0 - refill * refill);
  let hole = 1.0 - smoothstep(cavity * 0.8, cavity, dist);
  let churn = 0.6 + 0.4 * noise3(n * 2000.0 + vec3<f32>(since));
  color = over(color, vec3<f32>(0.05, 0.08, 0.1) * churn * lit, hole * 0.9);
  // White water thrown out at the rim, falling back over a few excavation times.
  let curtainR = cavityR * (0.9 + 0.6 * sqrt(grow));
  let splash = exp(-pow((dist - curtainR) / (0.25 * cavityR + 2.0 * pixelM), 2.0)) * exp(-since / (2.0 * excavation + 4.0))
    * (0.5 + 0.5 * rays(theta, ev.timing.z * 31.0, 14.0));
  color = over(color, vec3<f32>(0.92, 0.95, 0.97) * (0.45 + 0.55 * lit), min(1.0, splash));
  // Foam where the collapsing cavity churns the surface.
  let foam = (1.0 - smoothstep(cavityR * 0.6, cavityR * 2.2, dist)) * refill * exp(-max(0.0, since - 2.5 * excavation) / (6.0 * excavation + 20.0));
  color = over(color, vec3<f32>(0.85, 0.9, 0.93) * (0.45 + 0.55 * lit), foam * 0.5 * churn);
  // Tsunami wave train.
  let speed = sqrt(GRAVITY * max(ev.effect.z, 1.0));
  let lead = cavityR + speed * max(0.0, since - 0.5 * excavation);
  let wavelength = max(2.0 * cavityR, 1.0);
  let behind = (lead - dist) / wavelength;
  if (behind > -0.5 && behind < 6.0) {
    let height = ev.wave.y * cavityR / max(dist, cavityR);
    let strength = sqrt(clamp(height / 4.0, 0.0, 1.0));
    let envelope = smoothstep(-0.1, 0.2, behind) * exp(-max(behind, 0.0) * 0.55);
    let crest = cos(6.2832 * behind) * envelope;
    // Crests and troughs where the waves are a few pixels long; a soft band where they are not.
    let resolved = smoothstep(1.5 * pixelM, 4.0 * pixelM, wavelength);
    let front = exp(-pow((dist - lead) / max(1.5 * pixelM, wavelength * 0.25), 2.0));
    let foamy = max(crest, 0.0) * resolved + (envelope * 0.5 + front * 0.6) * (1.0 - resolved * 0.6);
    color = over(color, vec3<f32>(0.85, 0.92, 0.97) * (0.45 + 0.55 * lit), clamp(foamy * strength * 0.7, 0.0, 0.85));
    color = over(color, vec3<f32>(0.01, 0.05, 0.1), clamp(max(-crest, 0.0) * resolved * strength * 0.45, 0.0, 0.6));
  }
  return color;
}

// What a meteor does to the ground: crater, ejecta, molten floor, flash and
// blast wave, all at the sizes impactPhysics.js gives.
fn meteorGround(base: vec4<f32>, ev: Event, n: vec3<f32>, world: vec3<f32>, dist: f32, pixelM: f32, lit: f32) -> vec4<f32> {
  var color = base;
  let since = ev.timing.x - ev.path.x;
  if (since <= 0.0) { return color; }
  let c = normalize(ev.dirKind.xyz);
  let groundR = length(ev.dirKind.xyz) * params.radius;
  let rim = ev.effect.x;
  let fireball = ev.effect.y;
  let excavation = max(ev.effect.w, 0.5);
  let glowTime = fireballTime(fireball);
  // Energy back from the fireball radius, then the reach of the heat pulse.
  let energy = pow(fireball / 0.002, 3.0);
  let thermal = sqrt(3e-3 * energy / 6.2832e6);
  if (ev.path.w > 0.0) {
    // Airburst: a heat flash and a blast wave on the ground below.
    let burst = c * groundR + eventBack(ev) * ev.path.w;
    let height = length(burst) - groundR;
    let d = length(n - normalize(burst)) * params.radius;
    let flash = exp(-pow(d / max(thermal, 3.0 * pixelM), 2.0)) * exp(-since / glowTime) * 1.6;
    color = glowAdd(color, vec3<f32>(1.0, 0.9, 0.75), flash);
    let reach = 380.0 * since;
    if (reach > height) {
      let front = sqrt(reach * reach - height * height);
      let width = max(2.0 * pixelM, 0.05 * front + 100.0);
      let fade = (1.0 - smoothstep(thermal * 1.5, thermal * 4.0, front)) * exp(-since / (glowTime * 10.0));
      let dust = exp(-pow((d - front) / width, 2.0)) * fade;
      color = over(color, vec3<f32>(0.62, 0.55, 0.46) * (0.4 + 0.6 * lit), dust * 0.6);
    }
    return color;
  }
  let theta = aroundAngle(n, c);
  let onWater = ev.effect.z > 0.0 && abs(length(world) - groundR) < max(40.0, 6.0 * pixelM);
  let open = sqrt(clamp(since / excavation, 0.0, 1.0));
  if (rim > 0.0 && !onWater) {
    // The bowl opens over the excavation time; its floor glows and cools.
    let r = rim * max(open, 0.05);
    let molten = (1.0 - smoothstep(0.55 * r, r, dist)) * exp(-since / (3.0 * excavation + 15.0)) * (0.7 + 0.3 * noise3(n * 900.0 + vec3<f32>(since)));
    let edge = rim * (1.0 + 1.6 * open);
    let curtain = (1.0 - smoothstep(edge * 0.7, edge, dist)) * step(r * 0.9, dist)
      * (0.35 + 0.65 * rays(theta, ev.timing.z * 50.0, 9.0)) * exp(-max(0.0, since - 2.0 * excavation) / (4.0 * excavation + 5.0));
    color = over(color, vec3<f32>(0.42, 0.33, 0.25) * (0.4 + 0.6 * lit), curtain * 0.85);
    color = glowAdd(color, vec3<f32>(1.0, 0.35, 0.08), molten * 1.4);
  }
  if (onWater) { color = seaImpact(color, ev, n, dist, pixelM, since, theta, lit); }
  // Blast wave racing out over the ground, then the fireball's flash.
  let front = max(fireball, rim) + 380.0 * since;
  let width = max(2.0 * pixelM, 0.05 * front + 50.0);
  let shock = exp(-pow((dist - front) / width, 2.0)) * (1.0 - smoothstep(thermal * 1.5, thermal * 4.0, front)) * exp(-since / (glowTime * 8.0));
  color = glowAdd(color, vec3<f32>(1.0, 0.85, 0.6), shock * 0.6);
  let flashR = max(fireball * (0.6 + 0.4 * min(since / glowTime, 1.0)), 3.0 * pixelM);
  color = glowAdd(color, vec3<f32>(1.0, 0.95, 0.85), exp(-pow(dist / flashR, 2.0)) * exp(-since / glowTime) * 4.0);
  return color;
}

// A meteor in the air: entry at 110 km on its real slant and speed, a plasma
// head and the rock itself at true size, a fading ionised train and dust
// trail, then the fireball (at altitude for an airburst) and, at sea, a
// column of spray and steam.
fn meteorSky(base: vec4<f32>, ev: Event, ray: vec3<f32>, hitT: f32, ground: vec3<f32>, groundRadius: f32) -> vec4<f32> {
  var color = base;
  let c = normalize(ev.dirKind.xyz);
  let back = eventBack(ev);
  let angle = max(ev.path.y, 0.05);
  let flight = max(ev.path.x, 0.1);
  let age = ev.timing.x;
  let entry = slantTo(ENTRY_ALTITUDE, angle, groundRadius);
  let endD = ev.path.w;
  // Steady deceleration from entry to final speed over the flight.
  let tt = min(age, flight);
  let travelled = ev.wave.z * tt + (ev.wave.w - ev.wave.z) * tt * tt / (2.0 * flight);
  let headD = max(endD, entry - travelled);
  let start = ground + back * entry;
  let head = ground + back * headD;
  let pix = params.origin.w * length(head);
  let diameter = max(ev.timing.y, 1.0);
  let scale = log2(1.0 + diameter / 20.0);
  let sunLit = max(dot(c, params.sun), 0.0);
  let headAlt = length(c * groundRadius + back * headD) - groundRadius;
  // Lights up near 100 km and brightens as the air thickens.
  let lum = 1.0 - exp(-exp((90000.0 - headAlt) / 8000.0));
  if (age < flight) {
    let wake = min(3000.0 + 40.0 * diameter, entry - headD);
    let trail = raySegment(ray, hitT, head, head + back * wake);
    let near = 1.0 - trail.y;
    let core = max(1.2 * pix, diameter * (1.5 + 2.0 * lum));
    let plasma = exp(-pow(trail.x / (core * (0.6 + 1.5 * trail.y)), 2.0)) * near * near * lum;
    let halo = exp(-pow(trail.x / (pix * (3.0 + 1.5 * scale)), 2.0)) * near * near * near * lum * 0.5;
    color = glowAdd(color, mix(vec3<f32>(1.0, 0.35, 0.1), vec3<f32>(1.0, 0.92, 0.75), near), plasma * 2.2 + halo);
    // The rock at its real size: its leading face glows from the air it rams.
    let rockRadius = diameter * 0.5;
    let rb = dot(ray, head);
    let ra = dot(ray, ray);
    let disc = rb * rb - ra * (dot(head, head) - rockRadius * rockRadius);
    var rockSeen = 0.0;
    if (disc > 0.0) {
      let rt = (rb - sqrt(disc)) / ra;
      if (rt > 0.0 && rt < hitT) {
        let normal = normalize(ray * rt - head);
        let spin = ev.timing.w + age * 3.0;
        let lumps = noise3(normal * 3.5 + vec3<f32>(spin, 0.0, -spin)) * 0.6 + noise3(normal * 9.0 + spin) * 0.4;
        let rock = vec3<f32>(0.23, 0.2, 0.18) * (0.35 + 0.65 * lumps) * (0.15 + 0.85 * max(dot(normal, params.sun), 0.0));
        let ram = smoothstep(0.1, 0.95, dot(normal, -back)) * lum;
        let heat = mix(vec3<f32>(1.0, 0.38, 0.08), vec3<f32>(1.0, 0.93, 0.8), ram * ram);
        color = over(color, rock + heat * ram * (1.2 + lumps), 1.0);
        rockSeen = 1.0;
      }
    }
    let bloom = raySegment(ray, hitT, head, head);
    color = glowAdd(color, vec3<f32>(1.0, 0.95, 0.85), exp(-pow(bloom.x / (pix * (2.4 + scale) + diameter), 2.0)) * (1.6 - 1.1 * rockSeen) * lum);
  }
  // The ionised train glows for seconds; the dust trail drifts and spreads for longer.
  let train = raySegment(ray, hitT, head, start);
  let trainPix = params.origin.w * length(mix(head, start, train.y));
  let spread = max(trainPix, diameter * 2.0 + 6.0 * age);
  let lit = smoothstep(0.0, 0.1, train.y + 0.1) * smoothstep(1.0, 0.85, train.y);
  let ion = exp(-pow(train.x / spread, 2.0)) * exp(-age / 6.0) * lit;
  color = glowAdd(color, vec3<f32>(0.6, 1.0, 0.75), ion * (0.2 + 0.08 * scale));
  let dust = exp(-pow(train.x / (spread * 1.5), 2.0)) * exp(-age / 45.0) * lit * min(0.5, 0.15 + 0.06 * scale);
  color = over(color, vec3<f32>(0.55, 0.52, 0.5) * (0.35 + 0.65 * sunLit), dust);
  let since = age - flight;
  if (since > 0.0) {
    // The fireball swells to its full radius, rises and cools to a dark cloud.
    let fireball = ev.effect.y;
    let glowTime = fireballTime(fireball);
    let grown = min(since / glowTime, 1.0);
    let centre = ground + back * endD + c * (fireball * (0.4 + 0.8 * min(since / glowTime, 4.0)) * select(1.0, 0.6, endD > 0.0));
    let ballPix = params.origin.w * length(centre);
    let radius = max(fireball * (0.5 + 0.5 * grown), 1.5 * ballPix);
    let toBall = raySegment(ray, hitT, centre, centre);
    let heat = exp(-since / glowTime);
    // A soft, billowing edge: the cooled fireball is a cloud, not a ball.
    let billow = noise3(normalize(ray) * 40.0 + vec3<f32>(since * 0.05, ev.timing.z * 9.0, 0.0));
    let disk = (1.0 - smoothstep(0.35 * radius, radius * (0.9 + 0.3 * billow), toBall.x)) * exp(-since / (glowTime * 8.0)) * (0.75 + 0.25 * billow);
    let hot = mix(vec3<f32>(1.0, 0.45, 0.12), vec3<f32>(1.0, 0.95, 0.85), heat);
    let ball = mix(vec3<f32>(0.3, 0.27, 0.24) * (0.35 + 0.65 * sunLit), hot * 1.6, min(1.0, heat * 1.5));
    color = over(color, ball, min(1.0, disk));
    color = glowAdd(color, vec3<f32>(1.0, 0.92, 0.8), exp(-pow(toBall.x / (radius + ballPix * (6.0 + 3.0 * scale)), 2.0)) * heat * 2.0);
    if (ev.wave.x > 0.0) {
      // Spray and steam thrown up from the sea, a few cavity widths high.
      let cavity = ev.wave.x;
      let excavation = max(ev.effect.w, 0.5);
      let rise = min(2.5 * cavity, 40000.0) * sqrt(clamp(since / excavation, 0.0, 1.0));
      let column = raySegment(ray, hitT, ground + c * 5.0, ground + c * (5.0 + rise));
      let w = max(1.5 * params.origin.w * length(ground), cavity * (0.5 + 0.6 * column.y));
      let steam = exp(-pow(column.x / w, 2.0)) * exp(-max(0.0, since - excavation) / (3.0 * excavation + 10.0)) * (1.0 - 0.5 * column.y);
      color = over(color, vec3<f32>(0.93, 0.95, 0.97) * (0.5 + 0.5 * sunLit), min(0.9, steam));
    }
  }
  return color;
}

// Distance from a point to a segment, both near the unit sphere.
fn segmentDistance(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return length(p - a - ab * t);
}

// Coverage of one river reach: its physical width up close, at least a
// pixel from afar, fading when thinner than a pixel unless it is a big river.
fn riverLine(q: vec3<f32>, a: vec3<f32>, b: vec3<f32>, width: f32, size: f32, pixelM: f32) -> f32 {
  let d = segmentDistance(q, a, b) * params.radius;
  let half = max(0.5 * width, 0.6 * pixelM);
  let edge = 1.0 - smoothstep(half, half + pixelM, d);
  return edge * clamp(max(width / pixelM, 0.25 + 0.75 * size), 0.0, 1.0);
}

// Rivers, lakes, salt flats and ice sheets, from the three cells that the
// heatmap blends at this texel. Rivers keep their physical width up close and
// stay at least a pixel wide from afar, fading with their size.
fn waterLayer(base: vec4<f32>, n: vec3<f32>, m: vec3<f32>, ray: vec3<f32>, pixelM: f32, lit: f32) -> vec4<f32> {
  let t = texelOf(m);
  let ids = vec3<u32>(texelCellIds[t * 3u], texelCellIds[t * 3u + 1u], texelCellIds[t * 3u + 2u]);
  let w2 = texelWeights[t];
  let w = vec3<f32>(w2, 1.0 - w2.x - w2.y);
  var color = base;
  var still = vec3<f32>(0.0);
  // Meanders: wobble the point before measuring to the river line, gently
  // enough (amplitude times frequency well under 1) that the line stays whole.
  let bend = (vec3<f32>(noise3(n * 40.0), noise3(n * 40.0 + 7.0), noise3(n * 40.0 + 19.0)) - 0.5) * 0.004;
  let q = n + bend;
  var river = 0.0;
  for (var k = 0u; k < 3u; k++) {
    let cell = waterCells[ids[k]];
    still += cell.still.xyz * w[k];
    // The river leaving this cell, and the main one coming in (so a river
    // stays whole wherever the nearest cell is either end of it).
    if (cell.at.w > 0.0) { river = max(river, riverLine(q, cell.at.xyz, cell.down.xyz, cell.at.w, cell.down.w, pixelM)); }
    if (cell.up.w > 0.0) { river = max(river, riverLine(q, cell.up.xyz, cell.at.xyz, cell.up.w, cell.still.w, pixelM)); }
  }
  let toEye = -normalize(ray);
  let glint = 0.6 * pow(max(dot(n, normalize(params.sun + toEye)), 0.0), 600.0) * smoothstep(0.0, 0.2, dot(n, params.sun));
  let waterRgb = vec3<f32>(0.05, 0.2, 0.32) * lit + vec3<f32>(0.9) * glint;
  color = premultiply(color, waterRgb, river * 0.9);
  // Ragged shores: the lake edge follows noise rather than the cell blend.
  let shore = still.x + 0.3 * (noise3(n * 220.0) - 0.5);
  let lake = smoothstep(0.42, 0.52, shore);
  let salty = clamp(still.y, 0.0, 1.0);
  // Salt lakes go green-turquoise to pink with brine life; dry salt pans are white.
  let lakeRgb = mix(vec3<f32>(0.06, 0.22, 0.34), vec3<f32>(0.35, 0.62, 0.6), salty) * lit + vec3<f32>(0.9) * glint;
  color = premultiply(color, lakeRgb, lake * 0.92);
  let pan = salty * (1.0 - lake) * smoothstep(0.02, 0.3, still.x + salty * 0.5);
  color = premultiply(color, vec3<f32>(0.93, 0.91, 0.86) * lit, pan * 0.8 * (0.8 + 0.2 * noise3(n * 600.0)));
  // Ice sheets: thicker ice is whiter and smoother.
  let ice = smoothstep(20.0, 400.0, still.z) * (0.85 + 0.15 * noise3(n * 300.0));
  color = premultiply(color, vec3<f32>(0.9, 0.95, 1.0) * (0.35 + 0.65 * lit), ice * 0.85);
  return color;
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
    let pixelM = params.origin.w * viewDepth * length(ray);
    if (params.ground.z > 0.5) { color = waterLayer(color, n, m, ray, pixelM, lit); }
    let fx = sampleMap(fxMap, m);
    if (params.layers.y > 0.5 && fx.b > 0.02) {
      let kind = fx.a * 7.0;
      var tint = vec3<f32>(1.0, 0.55, 0.24);
      if (kind > 1.5 && kind < 2.5) { tint = vec3<f32>(0.35, 0.86, 1.0); }
      if (kind > 2.5 && kind < 3.5) { tint = vec3<f32>(0.47, 1.0, 0.78); }
      if (kind > 3.5 && kind < 4.5) { tint = vec3<f32>(1.0, 0.82, 0.35); }
      if (kind > 5.5 && kind < 6.5) { tint = vec3<f32>(0.35, 0.62, 1.0); }
      if (kind > 6.5) { tint = vec3<f32>(0.94, 0.66, 0.86); }
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
    // Fresh strikes and impacts on the ground: meteors at their physical
    // size, never thinner than a couple of pixels.
    let view = length(params.camPos) / params.radius - 1.0;
    for (var e = 0u; e < u32(params.extra.z); e++) {
      let ev = params.events[e];
      let evDir = normalize(ev.dirKind.xyz);
      let chord = length(n - evDir);
      if (ev.dirKind.w > 1.5) {
        color = meteorGround(color, ev, n, world, chord * params.radius, pixelM, lit);
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
      color = meteorSky(color, ev, ray, hitT, ground, groundRadius);
    }
  }
  return vec4<f32>(min(color.rgb, vec3<f32>(color.a * 1.5 + 0.5)), clamp(color.a, 0.0, 1.0));
}
