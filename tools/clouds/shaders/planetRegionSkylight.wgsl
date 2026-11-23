struct SkylightGrid {
  coreSide: u32,
  contextSide: u32,
  coreHalf: f32,
  contextHalf: f32,
  atlasHalf: f32,
  unitScale: f32,
}
@group(0) @binding(0) var<uniform> grid: SkylightGrid;
@group(0) @binding(1) var<storage, read> vertices: array<f32>;
@group(0) @binding(2) var atlas: texture_storage_2d<rgba8unorm, write>;

fn skylight_height_at(index: u32) -> f32 {
  return vertices[index * 6u + 1u];
}

fn skylight_height_grid(p: vec2<f32>, halfWidth: f32, side: u32, offset: u32) -> f32 {
  let xy = clamp(p / (2.0 * halfWidth) + .5, vec2<f32>(0.0), vec2<f32>(1.0)) * f32(side - 1u);
  let cell = min(vec2<u32>(xy), vec2<u32>(side - 2u));
  let f = xy - vec2<f32>(cell);
  let index = offset + cell.y * side + cell.x;
  let upper = f.x + f.y > 1.0;
  let corner = skylight_height_at(index + select(0u, side + 1u, upper));
  let east = skylight_height_at(index + 1u);
  let south = skylight_height_at(index + side);
  let weights = select(vec3<f32>(1.0 - f.x - f.y, f.x, f.y),
    vec3<f32>(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x), upper);
  return dot(vec3<f32>(corner, east, south), weights);
}

fn skylight_height(p: vec2<f32>) -> f32 {
  let extent = max(abs(p.x), abs(p.y));
  if (extent <= grid.coreHalf) {
    return skylight_height_grid(p, grid.coreHalf, grid.coreSide, 0u);
  }
  if (grid.contextSide < 2u || extent > grid.contextHalf) { return -1e6; }
  let context = skylight_height_grid(p, grid.contextHalf, grid.contextSide, grid.coreSide * grid.coreSide);
  let transition = 4.0 * grid.contextHalf / f32(grid.contextSide - 1u);
  if (extent >= grid.coreHalf + transition) { return context; }
  let edge = skylight_height_grid(p, grid.coreHalf, grid.coreSide, 0u);
  return mix(edge, context, smoothstep(0.0, transition, extent - grid.coreHalf));
}

// Cosine-weighted skylight above a horizon at a given elevation slope. The
// open-slope integral is the reference so a planar hillside stays unoccluded.
fn skylight_irradiance(slope: f32, alongNormal: f32, upNormal: f32) -> f32 {
  let inv = 1.0 / (1.0 + slope * slope);
  return max(0.0, alongNormal * (.78539816 - .5 * (atan(slope) + slope * inv)) + .5 * upNormal * inv);
}

@compute @workgroup_size(8, 8)
fn bake_region_skylight(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = textureDimensions(atlas);
  if (any(invocation.xy >= size)) { return; }
  let atlasPixel = vec2<i32>(invocation.xy);
  let p = ((vec2<f32>(invocation.xy) + .5) / vec2<f32>(size) * 2.0 - 1.0) * grid.atlasHalf;
  let maxExtent = select(grid.coreHalf, grid.contextHalf, grid.contextSide > 1u);
  let step = 2.0 * grid.coreHalf / f32(grid.coreSide - 1u);
  // Treat a map without surrounding geometry as open sky at the cut edge.
  let normalStep = step * 1.50;
  if (max(abs(p.x), abs(p.y)) > maxExtent - normalStep) {
    textureStore(atlas, atlasPixel, vec4<f32>(1.0));
    return;
  }
  let h = skylight_height(p);
  let dx = skylight_height(p + vec2<f32>(normalStep, 0.0)) - skylight_height(p - vec2<f32>(normalStep, 0.0));
  let dz = skylight_height(p + vec2<f32>(0.0, normalStep)) - skylight_height(p - vec2<f32>(0.0, normalStep));
  let n = normalize(vec3<f32>(-dx / (2.0 * normalStep), 1.0, -dz / (2.0 * normalStep)));
  let directions = array<vec2<f32>, 8>(
    vec2<f32>(1, 0), vec2<f32>(.7071068, .7071068), vec2<f32>(0, 1), vec2<f32>(-.7071068, .7071068),
    vec2<f32>(-1, 0), vec2<f32>(-.7071068, -.7071068), vec2<f32>(0, -1), vec2<f32>(.7071068, -.7071068));
  var unblocked = 0.0;
  var visible = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let dir = directions[i];
    let along = dot(dir, n.xz);
    let openSlope = max(0.0, -along / max(.015, n.y));
    var horizon = openSlope;
    var reach = max(step * 1.65, .18 * select(1.0, grid.unitScale, grid.unitScale > 0.0));
    for (var j = 0u; j < 11u; j++) {
      let sampleHeight = skylight_height(p + dir * reach);
      horizon = max(horizon, (sampleHeight - h - step * .075) / reach - .032);
      reach *= 1.58;
    }
    unblocked += skylight_irradiance(openSlope, along, n.y);
    visible += skylight_irradiance(horizon, along, n.y);
  }
  let sky = clamp(visible / max(.001, unblocked), 0.0, 1.0);
  textureStore(atlas, atlasPixel, vec4<f32>(sky, 0.0, 0.0, 1.0));
}
