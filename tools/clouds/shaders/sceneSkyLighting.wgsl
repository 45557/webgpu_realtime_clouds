// Shared daylight and sunset profile from Fluid Clouds. Radiance is linear.
fn sceneSolarColor(elevation: f32) -> vec3<f32> {
  return mix(vec3<f32>(1.83, 0.79, 0.32), vec3<f32>(1.42, 1.20, 0.93), smoothstep(0.085, 0.54, elevation));
}

fn sceneSkyGradient(height: f32, nearSun: f32, sunElevation: f32) -> vec3<f32> {
  let dusk = 1.0 - smoothstep(0.07, 0.44, sunElevation);
  let coolHaze = mix(vec3<f32>(0.34, 0.46, 0.61), vec3<f32>(0.24, 0.23, 0.35), dusk);
  let warmHaze = mix(vec3<f32>(0.63, 0.50, 0.39), vec3<f32>(0.65, 0.32, 0.21), dusk);
  let horizon = mix(coolHaze, warmHaze, pow(nearSun, 14.0));
  let blue = mix(vec3<f32>(0.105, 0.24, 0.42), vec3<f32>(0.064, 0.13, 0.26), dusk);
  return mix(horizon, blue, 1.0 - exp(-max(height, 0.0) * 5.2));
}

fn sceneSolarGlare(nearSun: f32) -> f32 {
  return 0.66 * pow(nearSun, 1400.0);
}

fn sceneSolarDisk(nearSun: f32) -> f32 {
  return smoothstep(0.999955, 0.999981, nearSun);
}

fn sceneSolarHalo(nearSun: f32) -> f32 {
  return 0.10 * pow(nearSun, 19.0) + 0.29 * pow(nearSun, 135.0) + sceneSolarGlare(nearSun);
}
