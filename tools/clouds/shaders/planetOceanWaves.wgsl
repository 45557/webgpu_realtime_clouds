// The three Cartesian projections blend smoothly without a longitude seam.
const planetWaveUnitsPerMeter = .014;

fn planetOceanRippleWeight(pixel: f32) -> f32 {
  return 1.0 - smoothstep(.055,.26,pixel * planetWaveUnitsPerMeter);
}

fn planetOceanNormal(radial: vec3<f32>, pixel: f32) -> vec3<f32> {
  let pixelSpan = pixel * planetWaveUnitsPerMeter;
  let detail = 1.0 - smoothstep(.20,.58,pixelSpan);
  if (detail <= 0.0) { return radial; }

  let position = radial * (frame.eye.w * planetWaveUnitsPerMeter);
  let time = frame.ocean.x;
  let mask = max(abs(radial) - .45, vec3<f32>(0.0));
  let weights = mask * mask;
  var slope = vec3<f32>(0.0);
  if (weights.x > 0.0) {
    let waves = oceanWaves(position.zy, time, pixelSpan);
    slope += vec3<f32>(0.0,waves.slope.y,waves.slope.x) * weights.x;
  }
  if (weights.y > 0.0) {
    let waves = oceanWaves(position.xz, time, pixelSpan);
    slope += vec3<f32>(waves.slope.x,0.0,waves.slope.y) * weights.y;
  }
  if (weights.z > 0.0) {
    let waves = oceanWaves(position.xy, time, pixelSpan);
    slope += vec3<f32>(waves.slope.x,waves.slope.y,0.0) * weights.z;
  }
  let tangentSlope = slope - radial * dot(radial, slope);
  return normalize(radial + tangentSlope * (detail / (weights.x + weights.y + weights.z)));
}
