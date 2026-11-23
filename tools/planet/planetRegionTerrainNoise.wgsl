fn region_lattice(cell: vec3<i32>, salt: u32) -> vec4<f32> {
  // Four XY corners of one lattice slice.
  let x = bitcast<vec4<u32>>(cell.x + vec4<i32>(0, 1, 0, 1));
  let y = bitcast<vec4<u32>>(cell.y + vec4<i32>(0, 0, 1, 1));
  var h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ vec4<u32>((bitcast<u32>(cell.z) * 0xcb1ab31fu) ^ (salt * 0x165667b1u));
  h = (h ^ (h >> vec4<u32>(16u))) * 0x7feb352du;
  h = (h ^ (h >> vec4<u32>(15u))) * 0x846ca68bu;
  return vec4<f32>(h ^ (h >> vec4<u32>(16u))) * (2.0 / 4294967295.0) - 1.0;
}

fn region_material_noise(p: vec3<f32>, salt: u32) -> vec4<f32> {
  let cell = vec3<i32>(floor(p));
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let slope = 6.0 * f * (1.0 - f);
  let lo = region_lattice(cell, salt);
  let hi = region_lattice(cell + vec3<i32>(0, 0, 1), salt);
  let corners = mix(lo, hi, w.z);
  let rows = mix(corners.xz, corners.yw, w.x);
  let vertical = mix((hi-lo).xz, (hi-lo).yw, w.x);
  return vec4<f32>(mix(rows.x, rows.y, w.y),
    mix(corners.y - corners.x, corners.w - corners.z, w.y) * slope.x,
    (rows.y - rows.x) * slope.y, mix(vertical.x, vertical.y, w.y) * slope.z);
}

// Local terrain keeps the planet's broad landforms and adds nested gullies,
// rock shelves and ground texture below the scale of the globe's recipe.
const regionDetailScales = array<f32, 9>(390.0, 172.0, 76.0, 34.0, 15.0, 6.2, 2.5, .92, .34);
const regionDetailAmplitudes = array<f32, 9>(32.0, 21.0, 11.5, 5.8, 2.5, .94, .34, .12, .04);
const regionDetailRotation = mat3x3<f32>(
  vec3<f32>(.36, .80, -.48), vec3<f32>(-.48, .60, .64), vec3<f32>(.80, 0.0, .60));

fn region_detail_weight(scale: f32, spacing: f32) -> f32 {
  return 1.0 - smoothstep(scale * .115, scale * .34, spacing);
}

// The return value is height in meters and its derivative in sphere space.
fn region_detail_band(point: vec3<f32>, i: u32, seed: u32) -> vec4<f32> {
  let scale = regionDetailScales[i];
  let amplitude = regionDetailAmplitudes[i];
  let ridges = 1.0 - smoothstep(2.0, 7.0, f32(i));
  let domain = mix(vec3<f32>(1.0), vec3<f32>(1.24, .81, 1.10), ridges);
  let flip = (i & 1u) != 0u;
  let rotated = select(point, regionDetailRotation * point, flip);
  let noise = region_material_noise(rotated * domain / scale, seed + 18461u + i * 1717u);
  let cut = length(vec2<f32>(noise.x, .055));
  let ravine = max(0.0, 1.0 - (cut - .055) / .57);
  let shape = mix(.62 * noise.x, .69 * noise.x + .092 - .36 * ravine * ravine * ravine, ridges);
  let slope = mix(.62, .69 + 1.08 * ravine * ravine * noise.x / (.57 * cut), ridges);
  let rotatedSlope = noise.yzw * domain;
  let gradient = select(rotatedSlope, transpose(regionDetailRotation) * rotatedSlope, flip);
  return vec4<f32>(amplitude * shape, (amplitude / scale) * slope * gradient);
}

fn region_detail_strength(steepness: f32) -> f32 {
  return mix(.40, 1.0, smoothstep(.12, .67, steepness));
}

fn region_detail_elevation(point: vec3<f32>, spacing: f32, seed: u32) -> f32 {
  var height = 0.0;
  for (var i = 0u; i < 9u; i++) {
    let weight = region_detail_weight(regionDetailScales[i], spacing);
    if (weight <= 0.0) { break; }
    height += region_detail_band(point, i, seed).x * weight;
  }
  return height;
}
