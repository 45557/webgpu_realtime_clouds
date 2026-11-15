fn planetSunTransmission(elevation: f32, groundToSample: f32, airDensity: f32) -> f32 {
  let dip = sqrt(max(0.0, 1.0 - groundToSample * groundToSample));
  let clearance = elevation + dip;
  let visibility = smoothstep(-0.012, 0.016, clearance);
  // Rays that graze the atmosphere cross more air before reaching the cloud.
  let grazing = 1.0 - smoothstep(0.0, 0.12, clearance);
  return visibility * (1.0 - 0.66 * clamp(airDensity, 0.0, 1.2) * grazing);
}

fn planetSunTint(elevation: f32, sky: vec4<f32>, dusk: vec4<f32>) -> vec3<f32> {
  let warm = vec3<f32>(1.08, 0.56, 0.31);
  let white = vec3<f32>(1.02, 0.99, 0.94);
  let air = mix(1.0, clamp(sky.w, 0.0, 1.0), dusk.w);
  let lowSun = mix(warm, dusk.rgb * 1.30, dusk.w * 0.44);
  return mix(white, mix(lowSun, white, smoothstep(-0.07, 0.42, elevation)), air);
}

fn planetSkylight(elevation: f32, sky: vec4<f32>, dusk: vec4<f32>) -> vec3<f32> {
  let twilight = smoothstep(-0.26, 0.025, elevation);
  let daylight = smoothstep(-0.13, 0.37, elevation);
  // Scale the authored shadow hue gently with the local sky's color.
  let skyGrade = mix(vec3<f32>(1.0), clamp(sky.rgb * 2.4, vec3<f32>(0.5), vec3<f32>(1.5)),
    dusk.w * min(sky.w, 1.0) * (0.42 + 0.23 * twilight));
  return skyGrade * (mix(vec3<f32>(0.048, 0.068, 0.11), vec3<f32>(0.53, 0.58, 0.76), twilight)
    + vec3<f32>(0.44, 0.45, 0.30) * daylight);
}
