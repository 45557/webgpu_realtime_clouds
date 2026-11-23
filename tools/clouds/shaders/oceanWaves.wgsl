// Surface ripples shared by the local ocean and the planet renderer.
fn oceanHash3(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.1031);
  let h = q + dot(q, q.yzx + 33.33);
  return fract((h.x + h.y) * h.z);
}

fn oceanNoise3(p: vec3<f32>) -> f32 {
  let cell = floor(p);
  let u = fract(p);
  let f = u * u * (3.0 - 2.0 * u);
  let a = mix(oceanHash3(cell), oceanHash3(cell + vec3<f32>(1,0,0)), f.x);
  let b = mix(oceanHash3(cell + vec3<f32>(0,1,0)), oceanHash3(cell + vec3<f32>(1,1,0)), f.x);
  let c = mix(oceanHash3(cell + vec3<f32>(0,0,1)), oceanHash3(cell + vec3<f32>(1,0,1)), f.x);
  let d = mix(oceanHash3(cell + vec3<f32>(0,1,1)), oceanHash3(cell + vec3<f32>(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

struct OceanWaves { slope: vec2<f32>, roll: f32 }

fn oceanWaves(position: vec2<f32>, time: f32, pixelSpan: f32) -> OceanWaves {
  let resolved = 1.0 - smoothstep(0.055, 0.22, pixelSpan);
  let rolls = oceanNoise3(vec3<f32>(position * 0.56, time * 0.14));
  var slope = vec2<f32>(0.0);
  if (resolved > 0.0) {
    let chop = oceanNoise3(vec3<f32>(position * 2.6 + vec2<f32>(time * 0.17, -time * 0.13), time * 0.32));
    let cross = oceanNoise3(vec3<f32>(position.yx * vec2<f32>(3.6, 1.75) + time * vec2<f32>(0.12, 0.17), rolls * 2.63));
    slope = vec2<f32>(chop - 0.5, cross - 0.5) * (0.12 + rolls * 0.12) * resolved;
  }
  if (pixelSpan < 0.067) {
    let ripples = position * vec2<f32>(7.4, 13.5) + vec2<f32>(time * 0.32, -time * 0.28);
    let fine = oceanNoise3(vec3<f32>(ripples, time * 0.45));
    let diagonal = oceanNoise3(vec3<f32>(ripples * vec2<f32>(1.24, 0.57) + 13.71, fine * 0.79));
    slope += vec2<f32>(fine - 0.5, diagonal - 0.5) * (0.075 * (1.0 - smoothstep(0.025, 0.067, pixelSpan)));
  }
  let swell = (rolls - 0.5) * vec2<f32>(0.018, 0.030);
  return OceanWaves(slope + swell, rolls);
}

fn oceanSurfaceLight(deep: vec3<f32>, reflectedSky: vec3<f32>, reflectionSun: f32,
    solar: vec3<f32>, clear: f32, fresnel: f32) -> vec3<f32> {
  let glint = solar * clear * (0.81 * pow(reflectionSun, 125.0) + 0.10 * pow(reflectionSun, 28.0));
  return mix(deep, reflectedSky * 0.39, 0.19 + 0.69 * fresnel) * (0.79 + 0.21 * clear) + glint;
}
