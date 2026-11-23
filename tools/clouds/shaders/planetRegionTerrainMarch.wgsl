// Two cells straddle the terrain at every XZ sample. Their Y origins follow
// the slope, so a steep cliff needs the same three samples as a flat plain.
@group(2) @binding(0) var<storage, read_write> marchSamplesOut: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> marchVerticesOut: array<u32>;
@group(2) @binding(2) var<storage, read_write> marchVertexCount: atomic<u32>;
@group(2) @binding(3) var<storage, read> marchSamples: array<vec4<f32>>;
@group(2) @binding(4) var<storage, read> marchVertices: array<u32>;
@group(2) @binding(5) var<storage, read> table: array<u32>;

fn region_march_side() -> u32 {
  return detailWindow.cells * detailWindow.subdivisions +
    detailWindow.middleCells * (detailWindow.middleSubdivisions - detailWindow.subdivisions) +
    detailWindow.nearCells * (detailWindow.nearSubdivisions - detailWindow.middleSubdivisions) + 1u;
}

fn region_march_xz(grid: vec2<f32>, step: f32) -> vec2<f32> {
  return (vec2<f32>(detailWindow.origin) + grid - f32(detailWindow.side - 1u) * .5) * step;
}

@compute @workgroup_size(8, 8)
fn sample_region_march(@builtin(global_invocation_id) id: vec3<u32>) {
  let side = region_march_side();
  if (any(id.xy >= vec2<u32>(side))) { return; }
  let frame = region_refinement_frame();
  let step = frame.spacing / frame.metersPerUnit;
  let offset = region_detail_axis(id.xy);
  let xz = region_march_xz(offset, step);
  let coarse = region_coarse_surface(vec2<f32>(detailWindow.origin) + offset, 0.0);
  let border = min(offset, f32(detailWindow.cells) - offset);
  let blend = detailWindow.strength * smoothstep(0.0, 3.0, min(border.x, border.y));
  let footprints = region_detail_footprints(offset, frame.spacing);
  let surface = region_fine_surface(vec2<f32>(detailWindow.origin) + offset, xz, coarse, frame, blend);
  let water = region_refinement_water(coarse.water, surface.y, frame, blend, footprints);
  let height = region_refined_height(vec3<f32>(xz.x, surface.x, xz.y), coarse.normal,
    coarse.material.rgb, water, blend, footprints);
  let band = max(step / f32(detailWindow.nearSubdivisions), .08 / frame.verticalMeters);
  // An irregular seam between the two vertical cells follows the large
  // rock features, keeping their crossings coherent between columns.
  let center = height - clamp((height - coarse.height) * .27 + .12 * band, -.46 * band, .46 * band);
  marchSamplesOut[id.y * side + id.x] = vec4<f32>(height, center, band, surface.y);
}

fn region_march_value(surface: vec4<f32>, layer: u32) -> f32 {
  return (surface.x - surface.y) - (f32(layer) - 1.0) * surface.z;
}

fn region_march_corner(offset: vec3<u32>) -> u32 {
  return offset.x + offset.z * 2u;
}

fn region_march_edge(cell: vec3<u32>, a: vec3<u32>, b: vec3<u32>, va: vec4<f32>, vb: vec4<f32>) -> vec2<f32> {
  let fa = region_march_value(va, cell.y + a.y);
  let fb = region_march_value(vb, cell.y + b.y);
  return mix(vec2<f32>(cell.xz + a.xz), vec2<f32>(cell.xz + b.xz), mc33_edge_fraction(fa, fb));
}

fn region_march_bilinear(corners: array<vec4<f32>, 4>, f: vec2<f32>) -> vec4<f32> {
  return mix(mix(corners[0], corners[1], f.x), mix(corners[2], corners[3], f.x), f.y);
}

fn region_march_shore(cell: vec3<u32>, code: u32, corners: array<vec4<f32>, 4>) -> f32 {
  var f = vec2<f32>(.5);
  if (code < 12u) {
    let a = corner_offset(edge_corner_a(code));
    let b = corner_offset(edge_corner_b(code));
    f = region_march_edge(cell, a, b, corners[region_march_corner(a)], corners[region_march_corner(b)]) -
      vec2<f32>(cell.xz);
  }
  return region_march_bilinear(corners, f).w;
}

// A split vertex retains the two edge codes it cuts between. Keep the land
// endpoint first so that adjacent triangles compute the same crossing.
const shoreCutShift = 28u;
const shoreCutMask = (1u << shoreCutShift) - 1u;

fn region_march_cut(a: u32, b: u32, aWet: bool) -> u32 {
  let wet = select(b, a, aWet);
  let land = select(a, b, aWet);
  return land | ((wet + 1u) << shoreCutShift);
}

fn region_march_triangle(cell: vec3<u32>, corners: array<vec4<f32>, 4>, triangle: vec3<u32>,
    crossesShore: bool, codes: ptr<function, array<u32, 36>>, first: u32) -> u32 {
  if (crossesShore) {
    let wet = vec3<bool>(region_march_shore(cell, triangle.x, corners) < 0.0,
      region_march_shore(cell, triangle.y, corners) < 0.0, region_march_shore(cell, triangle.z, corners) < 0.0);
    if (any(wet) && !all(wet)) {
      var t = triangle;
      var loneWet = wet.x;
      if (wet.z == wet.x) {
        t = triangle.yzx;
        loneWet = wet.y;
      } else if (wet.x == wet.y) {
        t = triangle.zxy;
        loneWet = wet.z;
      }
      let p = region_march_cut(t.x, t.y, loneWet);
      let q = region_march_cut(t.x, t.z, loneWet);
      (*codes)[first] = t.x;
      (*codes)[first + 1u] = p;
      (*codes)[first + 2u] = q;
      (*codes)[first + 3u] = p;
      (*codes)[first + 4u] = t.y;
      (*codes)[first + 5u] = t.z;
      (*codes)[first + 6u] = p;
      (*codes)[first + 7u] = t.z;
      (*codes)[first + 8u] = q;
      return 9u;
    }
  }
  (*codes)[first] = triangle.x;
  (*codes)[first + 1u] = triangle.y;
  (*codes)[first + 2u] = triangle.z;
  return 3u;
}

@compute @workgroup_size(8, 8)
fn extract_region_march(@builtin(global_invocation_id) id: vec3<u32>) {
  let side = region_march_side();
  if (any(id.xy >= vec2<u32>(side - 1u))) { return; }
  let start = id.y * side + id.x;
  let corners = array(marchSamplesOut[start], marchSamplesOut[start + 1u],
    marchSamplesOut[start + side], marchSamplesOut[start + side + 1u]);
  let wet = vec4<f32>(corners[0].w, corners[1].w, corners[2].w, corners[3].w) < vec4<f32>(0.0);
  let crossesShore = any(wet) && !all(wet);
  for (var layer = 0u; layer < 2u; layer++) {
    let cell = vec3<u32>(id.x, layer, id.y);
    var field: array<f32, 8>;
    for (var i = 0u; i < 8u; i++) {
      let offset = corner_offset(i);
      field[i] = region_march_value(corners[region_march_corner(offset)], layer + offset.y);
    }
    let values = CubeVals(field[0], field[1], field[2], field[3], field[4], field[5], field[6], field[7]);
    let mask = cube_index(values);
    if (mask == 0u || mask == 255u) { continue; }
    let pattern = pattern_info(mask, values);
    // Only the middle slice can change sign. These MC33 cases generate
    // at most four triangles per layer, each of which may split into three.
    var codes: array<u32, 36>;
    var count = 0u;
    for (var index = pattern.pcase; index < 2310u && count < 36u; index++) {
      let word = table[index];
      let a = word & 15u;
      let b = (word >> 4u) & 15u;
      let c = (word >> 8u) & 15u;
      if (a <= 12u && b <= 12u && c <= 12u && a != b && b != c && c != a) {
        let triangle = vec3<u32>(a, select(b, c, pattern.reverse), select(c, b, pattern.reverse));
        count += region_march_triangle(cell, corners, triangle, crossesShore, &codes, count);
      }
      if ((word & 0x1000u) == 0u) { break; }
    }
    if (count == 0u) { continue; }
    let first = atomicAdd(&marchVertexCount, count);
    let packed = (((id.y * side + id.x) * 2u + layer) << 4u);
    for (var i = 0u; i < count; i++) {
      marchVerticesOut[first + i] = packed | codes[i];
    }
  }
}

fn region_march_sample(grid: vec2<f32>, side: u32) -> vec4<f32> {
  let pos = clamp(grid, vec2<f32>(0.0), vec2<f32>(f32(side - 1u)));
  let cell = min(vec2<u32>(pos), vec2<u32>(side - 2u));
  let f = pos - vec2<f32>(cell);
  let index = cell.y * side + cell.x;
  return region_march_bilinear(array(marchSamples[index], marchSamples[index + 1u],
    marchSamples[index + side], marchSamples[index + side + 1u]), f);
}

fn region_march_axis(grid: vec2<f32>, side: u32) -> vec2<f32> {
  let pos = clamp(grid, vec2<f32>(0.0), vec2<f32>(f32(side - 1u)));
  return mix(region_detail_axis(vec2<u32>(floor(pos))), region_detail_axis(vec2<u32>(ceil(pos))), fract(pos));
}

fn region_march_vertex_grid(cell: vec3<u32>, code: u32, side: u32) -> vec2<f32> {
  if (code == 12u) { return vec2<f32>(cell.xz) + .5; }
  let a = corner_offset(edge_corner_a(code));
  let b = corner_offset(edge_corner_b(code));
  let start = cell.z * side + cell.x;
  return region_march_edge(cell, a, b, marchSamples[start + a.z * side + a.x], marchSamples[start + b.z * side + b.x]);
}

@vertex fn region_march_vertex(@builtin(vertex_index) index: u32) -> TerrainVertex {
  let side = region_march_side();
  let packed = marchVertices[index];
  let base = (packed & shoreCutMask) >> 5u;
  let layer = (packed >> 4u) & 1u;
  let cell = vec3<u32>(base % side, layer, base / side);
  let cutCode = packed >> shoreCutShift;
  let isCut = cutCode != 0u;
  var grid = region_march_vertex_grid(cell, packed & 15u, side);
  var crossingHeight = 0.0;
  if (isCut) {
    let wetGrid = region_march_vertex_grid(cell, cutCode - 1u, side);
    let land = region_march_sample(grid, side);
    let wet = region_march_sample(wetGrid, side);
    let fraction = mc33_edge_fraction(land.w, wet.w);
    grid = mix(grid, wetGrid, fraction);
    crossingHeight = mix(land.x, wet.x, fraction);
  }
  let frame = region_refinement_frame();
  let step = frame.spacing / frame.metersPerUnit;
  let offset = region_march_axis(grid, side);
  let surface = region_march_sample(grid, side);
  let border = min(offset, f32(detailWindow.cells) - offset);
  let blend = detailWindow.strength * smoothstep(0.0, 3.0, min(border.x, border.y));
  let coarse = region_coarse_surface(vec2<f32>(detailWindow.origin) + offset, blend);
  let xz = region_march_xz(offset, step);
  let east = vec2<f32>(.75, 0.0);
  let south = vec2<f32>(0.0, .75);
  let reach = vec2<f32>(.75);
  let run = (region_march_axis(grid + reach, side) - region_march_axis(grid - reach, side)) * step;
  let hx = region_march_sample(grid + east, side).x - region_march_sample(grid - east, side).x;
  let hz = region_march_sample(grid + south, side).x - region_march_sample(grid - south, side).x;
  let fine = normalize(vec3<f32>(-hx / max(run.x, 1e-7), 1.0, -hz / max(run.y, 1e-7)));
  let contour = select(surface.w, 0.0, isCut);
  let footprints = region_detail_footprints(offset, frame.spacing);
  let water = region_refinement_water(coarse.water, contour, frame, blend, footprints);
  let normal = normalize(mix(coarse.normal, fine, blend * (1.0 - smoothstep(.08, .65, water))));
  let shore = vec3<f32>(coarse.water, contour, select(0.0, blend, frame.hasSea != 0u));
  // Bend the triangle at sea level. Fade back to the old straight edge at
  // the LOD boundary so the refined mesh still meets its coarse neighbor.
  let height = select(surface.x, mix(crossingHeight, frame.verticalOrigin, blend), isCut);
  return terrain_vertex(vec3<f32>(xz.x, height, xz.y), normal, coarse.material, shore, coarse.height);
}
