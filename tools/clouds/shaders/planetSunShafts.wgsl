fn shaftBlocker(uv: vec2<f32>) -> f32 {
  let rawAlpha = sampleCloudOverlay(uv).a;
  let cloud = clamp(cloudOverlayOpacity(rawAlpha, params.alphaCutoff,
    params.alphaPower, params.opacity), 0.0, 1.0);
  let ground = textureSampleLevel(terrain, samp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  return 1.0 - (1.0 - cloud) * (1.0 - ground);
}

fn planetSunShafts(uv: vec2<f32>, localAlpha: f32) -> f32 {
  if (params.shafts.x <= 0.001 || localAlpha >= 0.98) { return 0.0; }
  let toSun = params.sun.xy - uv;
  let scaledToSun = toSun * vec2<f32>(params.sun.z, 1.0);
  let radialDistance = length(scaledToSun);
  let reach = params.shafts.y;
  if (radialDistance >= reach || radialDistance < 0.002) { return 0.0; }

  let clearSky = 1.0 - textureSampleLevel(terrain, samp, uv, 0.0).r;
  if (clearSky <= 0.001) { return 0.0; }
  let direction = scaledToSun / radialDistance;
  let across = vec2<f32>(-direction.y / params.sun.z, direction.x);
  let minimumSpread = 2.0 / f32(textureDimensions(tex, 0).y);
  let footprint = max(minimumSpread, clamp(radialDistance * 0.09, 0.008, 0.032));

  // Stop at the visible portion of the sun ray. Samples beyond the viewport
  // would otherwise look like a clear gap when a cloud crosses the edge.
  let edge = select(uv, 1.0 - uv, toSun > vec2<f32>(0.0));
  let limit = edge / max(abs(toSun), vec2<f32>(0.0001));
  let visibleFraction = min(1.0, min(limit.x, limit.y));

  var blocked = vec3<f32>(0.0);
  for (var i = 0; i < 4; i++) {
    let t = (f32(i) + 0.5) * 0.25;
    let at = uv + toSun * (t * visibleFraction);
    let spread = across * max(minimumSpread, footprint * mix(1.0, 0.25, t));
    let weight = (0.44 + 0.56 * t) / 2.88;
    blocked += vec3<f32>(shaftBlocker(at), shaftBlocker(at - spread), shaftBlocker(at + spread)) * weight;
  }
  // Compare the center ray to its neighbors. Uniform clear sky or an unbroken
  // cloud deck has no contrast to scatter into a beam.
  let gap = max(mix(blocked.y, blocked.z, 0.5) - blocked.x, 0.0);
  let shaft = smoothstep(0.014, 0.17, gap) * (1.0 - smoothstep(0.38, 0.81, blocked.x));
  let falloff = pow(1.0 - radialDistance / reach, params.shafts.z);
  return clamp(params.shafts.x * shaft * falloff * visibleFraction, 0.0, 0.48) * clearSky;
}
