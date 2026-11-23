struct RegionRockAnchor {
  cell: vec3<i32>,
  offset: vec3<f32>,
}

struct RegionRockSurface {
  color: vec3<f32>,
  slope: vec3<f32>,
  direct: f32,
  ambient: f32,
}

struct RegionStone {
  body: f32,
  slope: vec3<f32>,
  tone: f32,
  height: f32,
}

fn region_rock_hash(cell: vec3<i32>, seed: u32) -> u32 {
  let p = bitcast<vec3<u32>>(cell);
  var h = (p.x * 0x8da6b343u) ^ (p.y * 0xd8163841u) ^ (p.z * 0xcb1ab31fu) ^ (seed * 0x165667b1u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}

fn region_rock_random(bits: u32) -> f32 {
  return f32(bits & 1023u) / 1023.0;
}

// Relative spherical position, avoiding subtraction of two large radii in f32.
fn region_rock_point(p: vec3<f32>, up: vec3<f32>, east: vec3<f32>,
    south: vec3<f32>, radius: f32) -> vec3<f32> {
  let tangent = east * p.x + south * p.z;
  let slope2 = dot(p.xz / radius, p.xz / radius);
  let lengthRatio = sqrt(1.0 + slope2);
  let curvature = radius * slope2 / (lengthRatio * (1.0 + lengthRatio));
  return tangent * ((1.0 + p.y / radius) / lengthRatio) + up * (p.y / lengthRatio - curvature);
}

fn region_rock_weight(scale: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(scale * .075, scale * .31, footprint);
}

fn region_rock_patch_sample(point: vec3<f32>, anchor: RegionRockAnchor, octave: u32, seed: u32) -> vec4<f32> {
  let subdivisions = 1u << octave;
  let p = (point + anchor.offset) * (f32(subdivisions) / 128.0);
  let cell = vec3<i32>(floor(p)) + anchor.cell * i32(subdivisions);
  let t = fract(p);
  let f = t * t * (3.0 - 2.0 * t);
  let derivative = (6.0 * f32(subdivisions) / 128.0) * t * (1.0 - t);
  var sample = vec4<f32>(0.0);
  for (var i = 0u; i < 8u; i++) {
    let corner = vec3<i32>(i32(i & 1u), i32((i >> 1u) & 1u), i32(i >> 2u));
    let upper = corner != vec3<i32>(0);
    let w = select(1.0 - f, f, upper);
    let d = select(-derivative, derivative, upper);
    let value = region_rock_random(region_rock_hash(cell + corner, seed));
    sample += value * vec4<f32>(w.x * w.y * w.z, d.x * w.y * w.z, w.x * d.y * w.z, w.x * w.y * d.z);
  }
  return sample;
}

fn region_rock_patch(point: vec3<f32>, anchor: RegionRockAnchor, octave: u32, seed: u32) -> f32 {
  return region_rock_patch_sample(point, anchor, octave, seed).x;
}

// Compact support keeps individual stones continuous at lattice boundaries.
// Random position, size, orientation and facets break up the lattice pattern.
fn region_rock_stone(point: vec3<f32>, anchor: RegionRockAnchor, octave: u32, seed: u32) -> RegionStone {
  let subdivisions = 1u << octave;
  let scale = 128.0 / f32(subdivisions);
  let p = (point + anchor.offset) / scale;
  let cell = vec3<i32>(floor(p)) + anchor.cell * i32(subdivisions);
  let bits = region_rock_hash(cell, seed + octave * 6121u);
  let other = region_rock_hash(cell, bits ^ 16763u);
  let center = .5 + .18 * (vec3<f32>(region_rock_random(bits), region_rock_random(bits >> 10u),
    region_rock_random(bits >> 20u)) - .5);
  let stretch = vec3<f32>(1.0, 1.0 + .55 * region_rock_random(other), 1.10 + .44 * region_rock_random(other >> 10u));
  let stonePoint = (fract(p) - center) * stretch;
  let signFlip = select(-1.0, 1.0, (bits & 2048u) != 0u);
  let sideA = vec3<f32>(.8, .6 * signFlip, 0);
  let crossAxis = vec3<f32>(-.6 * signFlip, .8, 0);
  let sideB = crossAxis * .8 + vec3<f32>(0, 0, .6);
  let sideC = crossAxis * -.6 + vec3<f32>(0, 0, .8);
  let axes = vec3<f32>(dot(stonePoint, sideA), dot(stonePoint, sideB), dot(stonePoint, sideC));
  let face = abs(axes);
  let distance = sqrt(dot(stonePoint, stonePoint) + .00004);
  let facet = mix(.50, .92, region_rock_random(other >> 20u));
  let plane = max(face.x, max(face.y, face.z));
  let planeNormal = select(select(sign(axes.z) * sideC, sign(axes.y) * sideB, face.y >= face.z),
    sign(axes.x) * sideA, face.x >= max(face.y, face.z));
  let metric = mix(distance, plane * 1.15, facet);
  let size = mix(.19, .36, region_rock_random(bits >> 13u));
  let t = clamp((metric / size - .18) / .82, 0.0, 1.0);
  let body = 1.0 - t * t * (3.0 - 2.0 * t);
  let directionSlope = mix(stonePoint / distance, 1.15 * planeNormal, facet);
  let slope = -6.0 * t * (1.0 - t) / (.82 * size);
  // The weight also keeps the metric's deliberately flattened facets within
  // the cell, regardless of the randomized size.
  let rim = 1.0 - smoothstep(.285, .400, distance);
  let rimT = clamp((distance - .285) / .115, 0.0, 1.0);
  let rimSlope = -6.0 * rimT * (1.0 - rimT) / .115;
  let amplitude = mix(.07, .18, region_rock_random(other >> 7u));
  let bevel = amplitude * stretch * (directionSlope * slope * rim + body * rimSlope * stonePoint / distance);
  return RegionStone(body * rim, bevel, region_rock_random(other >> 17u), body * rim * amplitude);
}

fn region_rock_exposure(albedo: vec3<f32>, upNormal: f32, weathering: f32) -> f32 {
  let vegetation = smoothstep(.007, .075, albedo.g - max(albedo.r, albedo.b));
  let snow = smoothstep(.32, .72, min(albedo.r, min(albedo.g, albedo.b)));
  let cliffs = 1.0 - smoothstep(.43, .87, upNormal);
  let scree = 1.0 - smoothstep(.68, 1.0, upNormal);
  return clamp((.22 + .39 * weathering + .52 * cliffs + .23 * scree) * (1.0 - .70 * vegetation) *
    (1.0 - snow * (.75 - .33 * cliffs)), .06, 1.0);
}

struct RegionRockStrata {
  height: f32,
  slope: vec3<f32>,
  stain: f32,
  cavity: f32,
}

fn region_rock_strata_strength(exposure: f32, upNormal: f32) -> f32 {
  return exposure * (1.0 - smoothstep(.65, .97, upNormal));
}

// Value and derivative of a ramp. Two ramps build a wide face and a steeper lip.
fn region_strata_ramp(value: f32, lo: f32, hi: f32) -> vec2<f32> {
  let t = clamp((value - lo) / (hi - lo), 0.0, 1.0);
  return vec2<f32>(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / (hi - lo));
}

fn region_strata_groove(phase: f32, width: f32) -> vec2<f32> {
  let distance = fract(phase + .5) - .5;
  let ramp = region_strata_ramp(abs(distance), 0.0, width);
  return vec2<f32>(1.0 - ramp.x, -ramp.y * sign(distance));
}

fn region_rock_strata(point: vec3<f32>, anchor: RegionRockAnchor, seed: u32,
    footprint: f32, closeFootprint: f32, nearBlend: f32, strength: f32) -> RegionRockStrata {
  var strata = RegionRockStrata(0.0, vec3<f32>(0.0), 0.0, 0.0);
  if (strength <= 0.0) { return strata; }
  // Quarter-integer axes and dyadic scales keep the planar phase continuous
  // when the region's spherical anchor moves to another lattice cell.
  let dip = vec3<f32>(.25, .75, -.50);
  let strike = vec3<f32>(.75, -.25, .50);
  for (var octave = 2u; octave <= 6u; octave += 2u) {
    let scale = 128.0 / f32(1u << octave);
    let close = region_rock_weight(scale, closeFootprint);
    if (close <= 0.0) { break; }
    let weight = mix(region_rock_weight(scale, footprint), close, nearBlend) * strength;
    let crackScale = scale * .62;
    let cracks = mix(region_rock_weight(crackScale, footprint),
      region_rock_weight(crackScale, closeFootprint), nearBlend) * strength;
    let warp = region_rock_patch_sample(point, anchor, octave - 1u, seed + 36433u + octave * 4099u);
    // Smaller weathering pockets break the long faces and offset nearby beds.
    let weathered = region_rock_patch_sample(point, anchor, octave + 1u, seed + 54677u + octave * 3371u);
    let fault = region_strata_ramp(weathered.x, .45, .69);
    let p = (point + anchor.offset) / scale;
    let phase = dot(p, dip) + warp.x * .72 + fault.x * .19;
    let jointPhase = dot(p, strike) - warp.x * .55 + weathered.x * .31 + .30;
    let alongBed = dip / scale + warp.yzw * .72 + weathered.yzw * (.19 * fault.y);
    let acrossBed = strike / scale - warp.yzw * .55 + weathered.yzw * .31;
    let position = fract(phase);
    let lip = region_strata_ramp(position, .11, .63) - region_strata_ramp(position, .76, .98);
    let bedding = region_strata_groove(phase - .96, .13);
    let joint = region_strata_groove(jointPhase, .15);
    let bedWear = mix(warp, weathered, .63);
    let jointWear = mix(warp, vec4<f32>(1.0 - weathered.x, -weathered.yzw), .71);
    let erosion = region_strata_ramp(bedWear.x, .27, .62);
    let jointGate = region_strata_ramp(jointWear.x, .38, .67);
    let bank = (lip.x - .38) * weight * .052 - bedding.x * cracks * .028;
    let fissure = joint.x * cracks * .040;
    strata.height += scale * (bank * erosion.x - fissure * jointGate.x);
    strata.slope += scale * (
      alongBed * (lip.y * weight * .052 - bedding.y * cracks * .028) * erosion.x
      - acrossBed * joint.y * cracks * .040 * jointGate.x
      + bedWear.yzw * (bank * erosion.y) - jointWear.yzw * (fissure * jointGate.y));
    strata.stain += (lip.x - .38) * weight * erosion.x;
    strata.cavity = max(strata.cavity, cracks * max(bedding.x * erosion.x, joint.x * jointGate.x));
  }
  return strata;
}

// Trace the same procedural height that gives the stones their bevels.
// Samples follow the sun along the coarse surface; the ray rises away from it.
fn region_stone_shadow(point: vec3<f32>, anchor: RegionRockAnchor, octave: u32, seed: u32,
    lightAlongSurface: vec3<f32>, lightSlope: f32, scale: f32, height: f32, footprint: f32) -> f32 {
  let distances = array<f32, 3>(.085, .21, .43);
  let penumbra = max(.013, footprint / scale * .30);
  var shadow = 0.0;
  for (var i = 0u; i < 3u; i++) {
    let travel = distances[i];
    let relief = region_rock_stone(point + lightAlongSurface * (scale * travel), anchor, octave, seed).height;
    let clearance = relief - height - travel * lightSlope;
    shadow = max(shadow, smoothstep(.003 - penumbra, .020 + penumbra, clearance));
  }
  return shadow;
}

fn region_rock_material(point: vec3<f32>, anchor: RegionRockAnchor, seed: u32,
    footprint: f32, albedo: vec3<f32>, up: vec3<f32>, groundNormal: vec3<f32>,
    sunlight: vec3<f32>, receivesSun: bool) -> RegionRockSurface {
  let upNormal = dot(groundNormal, up);
  let skyAlongSurface = up - groundNormal * upNormal;
  let projected = max(footprint, max(abs(point.x), max(abs(point.y), abs(point.z))) * 1.4e-7);
  if (projected >= 39.68) { return RegionRockSurface(albedo, vec3<f32>(0.0), 1.0, 1.0); }
  let weathering = region_rock_patch(point, anchor, 0u, seed + 8119u);
  let exposure = region_rock_exposure(albedo, upNormal, weathering);
  let clusterWeight = region_rock_weight(16.0, projected);
  var cluster = 1.0;
  if (clusterWeight > 0.0) {
    let deposition = region_rock_patch(point, anchor, 3u, seed + 20347u);
    cluster = mix(1.0, mix(.24, 1.54, smoothstep(.24, .76, deposition)), clusterWeight);
  }
  let wavelengths = array<u32, 10>(0u, 2u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 12u);
  var color = albedo * mix(1.0, .76 + .48 * weathering, exposure * region_rock_weight(128.0, projected));
  var gradient = vec3<f32>(0.0);
  var direct = 1.0;
  var ambient = 1.0;
  var shadowBands = 0u;
  let facing = dot(groundNormal, sunlight);
  let tangentSun = sunlight - groundNormal * facing;
  let tangentLength = max(.001, length(tangentSun));
  let lightAlongSurface = tangentSun / tangentLength;
  let lightSlope = max(.015, facing / tangentLength);
  let lowSun = smoothstep(.012, .10, facing) * (1.0 - smoothstep(.37, .61, facing));
  let mineral = mix(vec3<f32>(.85, .93, 1.03), vec3<f32>(1.19, 1.06, .85), smoothstep(.21, .81, weathering));
  for (var i = 0u; i < 10u; i++) {
    let octave = wavelengths[i];
    let scale = 128.0 / f32(1u << octave);
    let weight = region_rock_weight(scale, projected);
    if (weight <= 0.0) { break; }
    let stone = region_rock_stone(point, anchor, octave, seed);
    let scatter = exposure * weight * select(.62, cluster, i >= 2u);
    let coverage = min(.92, stone.body * scatter);
    let value = mix(.65, 1.49, smoothstep(.15, .90, stone.tone));
    let rubble = color * mix(vec3<f32>(1.0), mineral, smoothstep(.26, .85, stone.tone)) * value;
    color = mix(color, rubble, coverage * .78);
    gradient += stone.slope * scatter;
    // On a slope, most sky light reaches the stone from uphill. Darken the
    // base where the relief rises toward that light.
    let baseContact = smoothstep(.025, .24, stone.body) * (1.0 - smoothstep(.35, .72, stone.body));
    let sheltered = smoothstep(.025, .24, dot(stone.slope, skyAlongSurface));
    let contactWeight = min(.36, scatter * .52) * mix(.60, 1.0, stone.tone);
    ambient = min(ambient, 1.0 - baseContact * contactWeight * mix(.13, 1.0, sheltered));
    // Very large stones already read at the mesh scale. Cap the number of
    // resolved bands traced per pixel when the camera approaches the ground.
    if (receivesSun && lowSun > .01 && i >= 1u && weight > .43 && scatter > .12 &&
        scale <= max(2.0, projected * 90.0) && shadowBands < 4u) {
      let blocker = region_stone_shadow(point, anchor, octave, seed, lightAlongSurface,
        lightSlope, scale, stone.height, projected);
      direct = min(direct, 1.0 - blocker * lowSun * min(.87, .34 + scatter * .73) * weight);
      shadowBands += 1u;
    }
  }
  let strata = region_rock_strata(point, anchor, seed, projected, projected, 0.0,
    region_rock_strata_strength(exposure, upNormal));
  let warmFace = vec3<f32>(1.28, 1.12, .93);
  color *= (1.0 + strata.stain * warmFace * .74) * (1.0 - strata.cavity * .39);
  ambient = min(ambient, 1.0 - strata.cavity * .49);
  gradient += strata.slope;
  return RegionRockSurface(color, gradient, direct, ambient);
}

fn region_rock_relief(point: vec3<f32>, anchor: RegionRockAnchor, seed: u32,
    coarse: f32, fine: f32, close: f32, nearBlend: f32, exposure: f32) -> f32 {
  var height = 0.0;
  // Smaller fragments can change the silhouette wherever the close mesh has
  // enough vertices to resolve them.
  for (var octave = 2u; octave <= 8u; octave++) {
    let scale = 128.0 / f32(1u << octave);
    let resolved = region_rock_weight(scale, close);
    if (resolved <= 0.0) { break; }
    let base = select(0.0, region_rock_weight(scale, fine), octave <= 5u);
    let gain = mix(base, resolved, nearBlend) * smoothstep(scale * .06, scale * .24, coarse);
    if (gain > 0.0) {
      let stone = region_rock_stone(point, anchor, octave, seed);
      let relief = mix(stone.body * .095, stone.height * 1.35, nearBlend);
      height += relief * scale * gain;
    }
  }
  return height * exposure;
}
