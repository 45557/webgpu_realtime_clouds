struct RegionRefinementFrame {
  up: vec3<f32>, radius: f32,
  east: vec3<f32>, metersPerUnit: f32,
  south: vec3<f32>, verticalMeters: f32,
  verticalOrigin: f32, datum: f32, spacing: f32, seed: u32,
  hasSea: u32,
  rock: RegionRockAnchor,
}

struct DetailWindow {
  origin: vec2<u32>, side: u32, cells: u32,
  middleOrigin: vec2<u32>, strength: f32, subdivisions: u32,
  nearOrigin: vec2<u32>, nearCells: u32, nearSubdivisions: u32,
  nearStrength: f32, middleCells: u32, middleSubdivisions: u32,
}
@group(1) @binding(0) var<storage, read> regionVertices: array<f32>;
@group(1) @binding(1) var<storage, read> regionMaterials: array<u32>;
@group(1) @binding(2) var<uniform> detailWindow: DetailWindow;

struct RegionSample {
  height: f32,
  normal: vec3<f32>,
  water: f32,
  material: vec4<f32>,
}

fn region_sample(index: u32) -> RegionSample {
  let base = index * 6u;
  let normal = vec3<f32>(regionVertices[base + 3u], regionVertices[base + 4u], regionVertices[base + 5u]);
  let rgba = unpack4x8unorm(regionMaterials[index]);
  return RegionSample(regionVertices[base + 1u], vec3<f32>(normal.x, min(abs(normal.y), 1.0), normal.z),
    select(0.0, 1.0, normal.y < 0.0), vec4<f32>(pow(rgba.rgb, vec3<f32>(2.2)), rgba.a));
}

fn region_coarse_surface(grid: vec2<f32>, landAlbedoBlend: f32) -> RegionSample {
  let cell = min(vec2<u32>(grid), vec2<u32>(detailWindow.side - 2u));
  let f = grid - vec2<f32>(cell);
  let upper = f.x + f.y > 1.0;
  let at = cell.y * detailWindow.side + cell.x;
  // Use the original mesh's diagonal and interpolate all of its attributes.
  let a = region_sample(at + select(0u, detailWindow.side + 1u, upper));
  let b = region_sample(at + 1u);
  let c = region_sample(at + detailWindow.side);
  let w = select(vec3<f32>(1.0 - f.x - f.y, f.x, f.y),
    vec3<f32>(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x), upper);
  let wet = vec3<f32>(a.water, b.water, c.water);
  let water = dot(wet, w);
  let land = 1.0 - water;
  // A wet sample supplies water depth; its ocean palette should not tint
  // the exposed rock when the contour crosses an otherwise mixed triangle.
  var weights = w;
  if (landAlbedoBlend > 0.0 && land > 1e-5 && water > 0.0) {
    weights = mix(w, w * (1.0 - wet) / land, landAlbedoBlend);
  }
  return RegionSample(dot(vec3<f32>(a.height, b.height, c.height), w),
    a.normal * w.x + b.normal * w.y + c.normal * w.z, water,
    a.material * weights.x + b.material * weights.y + c.material * weights.z);
}

fn region_terrain_slope(delta: f32, adjacent: f32) -> f32 {
  if (delta * adjacent <= 0.0) { return 0.0; }
  return 2.0 * delta * adjacent / (delta + adjacent);
}

fn region_terrain_curve(a: f32, b: f32, c: f32, d: f32, t: f32) -> f32 {
  let delta = c - b;
  let left = region_terrain_slope(delta, b - a);
  let right = region_terrain_slope(delta, d - c);
  return b + t * (left + t * (3.0 * delta - 2.0 * left - right + t * (left + right - 2.0 * delta)));
}

fn region_signed_elevation(cell: vec2<i32>, frame: RegionRefinementFrame) -> f32 {
  let bounded = vec2<u32>(clamp(cell, vec2<i32>(0), vec2<i32>(i32(detailWindow.side) - 1)));
  let i = (bounded.y * detailWindow.side + bounded.x) * 6u;
  let ny = regionVertices[i + 4u];
  if (frame.hasSea != 0u && ny < 0.0) {
    let pitch = frame.spacing / frame.verticalMeters;
    // Older tiles only carry the water flag. New tiles store signed depth.
    return select(ny + 1.0, -pitch * .26, ny == -1.0);
  }
  return regionVertices[i + 1u] - frame.verticalOrigin;
}

fn region_terrain_row(cell: vec2<i32>, at: f32, frame: RegionRefinementFrame) -> f32 {
  return region_terrain_curve(
    region_signed_elevation(cell - vec2<i32>(1, 0), frame), region_signed_elevation(cell, frame),
    region_signed_elevation(cell + vec2<i32>(1, 0), frame),
    region_signed_elevation(cell + vec2<i32>(2, 0), frame), at);
}

fn region_fine_surface(grid: vec2<f32>, xz: vec2<f32>, coarse: RegionSample,
    frame: RegionRefinementFrame, blend: f32) -> vec2<f32> {
  if (blend <= 0.0 && frame.hasSea == 0u) { return vec2<f32>(coarse.height, 1.0); }
  let cell = min(vec2<i32>(grid), vec2<i32>(i32(detailWindow.side) - 2));
  let f = grid - vec2<f32>(cell);
  let signed = region_terrain_curve(
    region_terrain_row(cell - vec2<i32>(0, 1), f.x, frame), region_terrain_row(cell, f.x, frame),
    region_terrain_row(cell + vec2<i32>(0, 1), f.x, frame),
    region_terrain_row(cell + vec2<i32>(0, 2), f.x, frame), f.y);
  var contour = signed;
  let shoreWidth = clamp(frame.spacing * .48, 1.1, 18.0) / frame.verticalMeters;
  if (frame.hasSea != 0u && blend > 0.0 && coarse.water > 0.0 && coarse.water < 1.0 && abs(signed) < shoreWidth) {
    // Anchor the fine variation to the seabed and fade it out at saved
    // grid points. Cap the offset in meters so it cannot pull a cliff sideways.
    let coast = smoothstep(0.0, .22, coarse.water) * (1.0 - smoothstep(.78, 1.0, coarse.water));
    let point = region_rock_point(vec3<f32>(xz.x * frame.metersPerUnit, frame.datum, xz.y * frame.metersPerUnit),
      frame.up, frame.east, frame.south, frame.radius);
    let octave = u32(clamp(floor(log2(128.0 / frame.spacing)), 0.0, 6.0));
    let roughness = region_rock_patch(point, frame.rock, octave, frame.seed ^ 883u) * 2.0 - 1.0;
    let amplitude = min(frame.spacing * .24, 2.2) / frame.verticalMeters;
    contour += roughness * amplitude * coast * blend * (1.0 - smoothstep(0.0, shoreWidth, abs(signed)));
  }
  let height = frame.verticalOrigin + select(contour, max(0.0, contour), frame.hasSea != 0u);
  // Return to the original triangles at the edge of the replacement mesh,
  // but keep the signed height so that rasterization can find the crossing.
  // A dry vertex can sit exactly at sea level in saved tiles.
  let dryContour = select(contour, max(contour, 4e-7), coarse.water <= 0.0 && contour >= 0.0);
  let shore = select(1.0, dryContour, frame.hasSea != 0u);
  return vec2<f32>(mix(coarse.height, height, blend), shore);
}

fn region_detail_border(offset: vec2<f32>, origin: vec2<u32>, cells: u32) -> f32 {
  let within = offset - vec2<f32>(origin);
  let border = min(within, f32(cells) - within);
  return min(border.x, border.y);
}

fn region_detail_footprints(offset: vec2<f32>, spacing: f32) -> vec3<f32> {
  let middle = smoothstep(0.0, 4.0, region_detail_border(offset, detailWindow.middleOrigin, detailWindow.middleCells));
  let near = detailWindow.nearStrength * smoothstep(0.0, .85, region_detail_border(offset, detailWindow.nearOrigin, detailWindow.nearCells));
  let pitch = mix(spacing / f32(detailWindow.subdivisions), spacing / f32(detailWindow.middleSubdivisions), middle);
  return vec3<f32>(pitch, spacing / f32(detailWindow.nearSubdivisions), near);
}

fn region_refinement_water(coarse: f32, shore: f32, frame: RegionRefinementFrame, blend: f32, footprints: vec3<f32>) -> f32 {
  if (frame.hasSea == 0u || blend <= 0.0 || (coarse <= 0.0 && shore >= 0.0)) { return coarse; }
  let width = max(.55, mix(footprints.x, footprints.y, footprints.z) * .22) / frame.verticalMeters;
  return mix(coarse, 1.0 - smoothstep(-width, width, shore), blend);
}

fn region_refined_height(p: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>, water: f32,
    blend: f32, footprints: vec3<f32>) -> f32 {
  if (blend <= 0.0 || water >= .22) { return p.y; }
  let frame = region_refinement_frame();
  let ground = vec3<f32>(p.x * frame.metersPerUnit,
    (p.y - frame.verticalOrigin) * frame.verticalMeters, p.z * frame.metersPerUnit);
  let radial = normalize(frame.up + (frame.east * ground.x + frame.south * ground.z) / frame.radius);
  let footprint = footprints.x;
  let nearBlend = footprints.z;
  let finest = select(footprint, footprints.y, nearBlend > 0.0);
  let scaleNormal = frame.verticalMeters / frame.metersPerUnit;
  let physicalNormal = normalize(vec3<f32>(normal.x * scaleNormal, normal.y, normal.z * scaleNormal));
  let steepness = length(physicalNormal.xz);
  let shore = select(1.0, smoothstep(0.0, 24.0, ground.y), frame.hasSea != 0u) *
    (1.0 - smoothstep(0.0, .22, water));
  var delta = 0.0;
  for (var i = 0u; i < 9u; i++) {
    let scale = regionDetailScales[i];
    let close = region_detail_weight(scale, finest);
    if (close <= 0.0) { break; }
    let fine = mix(region_detail_weight(scale, footprint), close, nearBlend);
    let weight = fine - region_detail_weight(scale, frame.spacing);
    if (weight > 0.0) {
      let point = radial * (frame.radius + (frame.datum + ground.y) * select(0.0, .75, i >= 5u));
      delta += region_detail_band(point, i, frame.seed).x * weight;
    }
  }
  let point = region_rock_point(vec3<f32>(ground.x, frame.datum + ground.y, ground.z),
    frame.up, frame.east, frame.south, frame.radius);
  let weathering = region_rock_patch(point, frame.rock, 0u, frame.seed + 8119u);
  let upNormal = physicalNormal.y;
  let exposure = region_rock_exposure(albedo, upNormal, weathering);
  let rock = region_rock_relief(point, frame.rock, frame.seed, frame.spacing, footprint, finest, nearBlend, exposure);
  let strata = region_rock_strata(point, frame.rock, frame.seed, footprint, finest, nearBlend,
    region_rock_strata_strength(exposure, upNormal));
  return p.y + (delta * region_detail_strength(steepness) + rock + strata.height) * blend * shore / frame.verticalMeters;
}

// Each nested pitch starts and ends on a saved grid line. The outer
// perimeter still lies on the baked mesh.
fn region_detail_axis(index: vec2<u32>) -> vec2<f32> {
  let before = min(index, detailWindow.middleOrigin * detailWindow.subdivisions);
  let middleCount = detailWindow.middleCells * detailWindow.middleSubdivisions +
    detailWindow.nearCells * (detailWindow.nearSubdivisions - detailWindow.middleSubdivisions);
  let inner = min(index - before, vec2<u32>(middleCount));
  let after = index - before - inner;
  let middleBefore = min(inner, (detailWindow.nearOrigin - detailWindow.middleOrigin) * detailWindow.middleSubdivisions);
  let near = min(inner - middleBefore, vec2<u32>(detailWindow.nearCells * detailWindow.nearSubdivisions));
  return vec2<f32>(before + after) / f32(detailWindow.subdivisions) +
    vec2<f32>(inner - near) / f32(detailWindow.middleSubdivisions) + vec2<f32>(near) / f32(detailWindow.nearSubdivisions);
}
