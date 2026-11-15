fn planetSunClearance(elevation: f32, groundToSample: f32) -> f32 {
  let dip = sqrt(max(0.0, 1.0 - groundToSample * groundToSample));
  return elevation + dip;
}

fn planetSunTransmission(clearance: f32, airDensity: f32) -> f32 {
  let visibility = smoothstep(-0.012, 0.016, clearance);
  // Grazing rays cross more of the atmosphere before they reach the cloud.
  let grazing = 1.0 - smoothstep(0.0, 0.12, clearance);
  return visibility * (1.0 - 0.66 * clamp(airDensity, 0.0, 1.2) * grazing);
}

fn planetSunTint(elevation: f32, clearance: f32, sky: vec4<f32>, dusk: vec4<f32>) -> vec3<f32> {
  let warm = vec3<f32>(1.08, 0.56, 0.31);
  let white = vec3<f32>(1.02, 0.99, 0.94);
  let air = mix(1.0, clamp(sky.w, 0.0, 1.0), dusk.w);
  let lowSun = mix(warm, dusk.rgb * 1.30, dusk.w * 0.44);
  // Solid ground sets visibility, while overlying air still reddens the light.
  let dip = max(0.0, clearance - elevation);
  let airClearance = elevation + dip * mix(0.20, 0.80, smoothstep(0.14, 0.52, dip));
  let grazing = (1.0 - smoothstep(-0.055, 0.43, airClearance)) * air;
  return mix(white, lowSun, grazing);
}

fn planetSkylight(elevation: f32, towardSun: f32, sky: vec4<f32>, dusk: vec4<f32>) -> vec3<f32> {
  let twilight = smoothstep(-0.26, 0.025, elevation);
  let daylight = smoothstep(-0.13, 0.37, elevation);
  let air = clamp(sky.w, 0.0, 1.0) * dusk.w;
  let skyGrade = mix(vec3<f32>(1.0), clamp(sky.rgb * 2.4, vec3<f32>(0.5), vec3<f32>(1.5)),
    air * (0.42 + 0.23 * twilight));
  let skyFill = skyGrade * (mix(vec3<f32>(0.048, 0.068, 0.11), vec3<f32>(0.53, 0.58, 0.76), twilight)
    + vec3<f32>(0.44, 0.45, 0.30) * daylight);
  let sunset = smoothstep(-0.22, -0.045, elevation) * (1.0 - smoothstep(0.035, 0.30, elevation));
  return skyFill + dusk.rgb * (0.40 * air * sunset * towardSun * towardSun);
}

fn planetCloudHighlightGain(light: vec3<f32>, compression: f32) -> f32 {
  let peak = max(max(light.r, light.g), light.b);
  return 1.0 / (1.0 + peak * compression);
}
