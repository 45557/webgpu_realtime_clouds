fn shaftBlocker(uv: vec2<f32>) -> f32 {
  let inside = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
  if (!inside) { return 0.0; }
  let a = sampleCloudOverlay(uv).a;
  let coverage = textureSampleLevel(terrain, samp, uv, 0.0).r;
  return max(smoothstep(max(0.02, params.alphaCutoff), 0.62, a), coverage);
}

fn planetSunShafts(uv: vec2<f32>, localAlpha: f32) -> f32 {
  if (params.shafts.x <= 0.001 || localAlpha >= 0.98) { return 0.0; }
  let dims = vec2<f32>(textureDimensions(terrain));
  let pixel = min(vec2<i32>(uv * dims), vec2<i32>(dims) - 1);
  // Fade partial coverage at the silhouette as the projected ridge moves.
  let terrainPixel = textureLoad(terrain, pixel, 0);
  let clearSky = 1.0 - terrainPixel.r;
  if (clearSky <= 0.001) { return 0.0; }
  let toSun = params.sun.xy - uv;
  let scaledToSun = toSun * vec2<f32>(params.sun.z, 1.0);
  let radialDistance = length(scaledToSun);
  let reach = params.shafts.y;
  if (radialDistance >= reach || radialDistance < 0.002) { return 0.0; }
  let direction = scaledToSun / radialDistance;
  let across = vec2<f32>(-direction.y / params.sun.z, direction.x);
  let footprint = across * clamp(radialDistance * 0.09, 0.008, 0.032);
  var blocked = vec3<f32>(0.0);
  for (var i = 0; i < 6; i++) {
    let t = (f32(i) + 0.5) / 6.0;
    let at = uv + toSun * t;
    let spread = footprint * mix(1.0, 0.25, t);
    let weight = (0.44 + 0.56 * t) / 4.32;
    blocked += vec3<f32>(shaftBlocker(at), shaftBlocker(at - spread), shaftBlocker(at + spread)) * weight;
  }
  // Airglow belongs in gaps beside cloud shadows. Subtract the neighboring
  // rays' visibility so a uniform cloud sheet cannot produce a luminous disc.
  let gap = max(mix(blocked.y, blocked.z, 0.5) - blocked.x, 0.0);
  let shaft = smoothstep(0.018, 0.22, gap) * (1.0 - smoothstep(0.42, 0.84, blocked.x));
  let falloff = pow(1.0 - radialDistance / reach, params.shafts.z);
  return clamp(params.shafts.x * shaft * falloff, 0.0, 0.48) * clearSky;
}
