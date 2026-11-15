fn shaftBlocker(uv: vec2<f32>) -> f32 {
  let alpha = sampleCloudOverlay(uv).a * params.opacity;
  return smoothstep(0.015, 0.7, alpha);
}

fn planetSunShafts(uv: vec2<f32>, localAlpha: f32) -> f32 {
  if (params.shafts.x <= 0.001 || localAlpha >= 0.98) { return 0.0; }
  let toSun = params.sun.xy - uv;
  let scaledToSun = toSun * vec2<f32>(params.sun.z, 1.0);
  let radialDistance = length(scaledToSun);
  let reach = params.shafts.y;
  if (radialDistance >= reach || radialDistance < 0.002) { return 0.0; }

  // Terrain occludes the light at this pixel. Sampling the screen silhouette
  // along the shaft would project copies of the mountains into empty sky.
  let clearSky = 1.0 - textureSampleLevel(terrain, samp, uv, 0.0).r;
  if (clearSky <= 0.001) { return 0.0; }
  let direction = scaledToSun / radialDistance;
  let across = vec2<f32>(-direction.y / params.sun.z, direction.x);
  let minimumSpread = 2.0 / f32(textureDimensions(tex, 0).y);
  let footprint = max(minimumSpread, clamp(radialDistance * 0.10, 0.012, 0.040));

  // Stop at the last visible point if the sun is beyond the viewport.
  let edge = select(uv, 1.0 - uv, toSun > vec2<f32>(0.0));
  let limit = edge / max(abs(toSun), vec2<f32>(0.0001));
  let visibleFraction = min(1.0, min(limit.x, limit.y));

  var blocked = vec2<f32>(0.0);
  var weights = 0.0;
  for (var i = 0; i < 12; i++) {
    let t = (f32(i) + 0.5) / 12.0;
    let at = uv + toSun * (t * visibleFraction);
    // Stagger the sides along the ray to soften the penumbra within two reads per step.
    let side = select(-1.0, 1.0, (i & 1) == 0);
    let spread = across * side * max(minimumSpread, footprint * mix(1.0, 0.25, t));
    let weight = 0.35 + 0.65 * t;
    blocked += vec2<f32>(shaftBlocker(at), shaftBlocker(at + spread)) * weight;
    weights += weight;
  }
  blocked /= weights;
  let gap = max(blocked.y - blocked.x, 0.0);
  let shaft = smoothstep(0.018, 0.22, gap) * (1.0 - smoothstep(0.35, 0.78, blocked.x));
  let falloff = pow(1.0 - radialDistance / reach, params.shafts.z);
  let sunFade = smoothstep(0.002, 0.04, radialDistance);
  return clamp(params.shafts.x * shaft * falloff * visibleFraction * sunFade, 0.0, 0.4) * clearSky;
}
