fn shaftBlocker(uv: vec2<f32>) -> f32 {
  let alpha = sampleCloudOverlay(uv).a * params.opacity;
  return smoothstep(.015, .70, alpha);
}

fn planetSunShafts(uv: vec2<f32>, localAlpha: f32) -> f32 {
  if (params.shafts.x <= .001 || localAlpha >= .98) { return 0.0; }
  let aspect = vec2<f32>(params.sun.z, 1.0);
  let fromSun = (uv - params.sun.xy) * aspect;
  let distance = length(fromSun);
  let span = params.shafts.y;
  if (distance < .002 || distance >= span) { return 0.0; }

  // Depth at the receiver keeps terrain silhouettes out of the shaft mask.
  let clearSky = 1.0 - textureSampleLevel(terrain, samp, uv, 0.0).r;
  if (clearSky <= .001) { return 0.0; }

  let direction = fromSun / distance;
  let along = direction / aspect;
  let across = vec2<f32>(-direction.y, direction.x) / aspect;
  let pixels = vec2<f32>(textureDimensions(tex, 0));
  let pixelWidth = 2.0 / max(length(across * pixels), 1.0);

  // Find where this radial line enters the viewport for an off-screen sun.
  let toSun = params.sun.xy - uv;
  let edge = select(uv, 1.0 - uv, toSun > vec2<f32>(0.0));
  let limit = edge / max(abs(toSun), vec2<f32>(.0001));
  let entry = distance * (1.0 - min(1.0, min(limit.x, limit.y)));
  let rayLength = max(distance - entry, .001);
  var transmission = 1.0;
  var scatter = 0.0;
  var cloudVariation = 0.0;
  var previousOcclusion = 0.0;

  // As in the flat renderer, the segments are anchored at the sun. Each
  // segment averages samples across a widening footprint, for soft edges.
  // Six segments of four taps retain the previous maximum of 24 alpha reads.
  for (var i = 0u; i < 6u; i++) {
    let t0 = f32(i) / 6.0;
    let t1 = f32(i + 1u) / 6.0;
    let begin = max(entry, span * t0 * t0);
    let end = span * t1 * t1;
    let segment = min(distance, end) - begin;
    if (segment > 0.0) {
      let center = (begin + end) * .5;
      let at = params.sun.xy + along * center;
      let offset = along * (end - begin) * .288675;
      let width = max(pixelWidth, mix(.008, .05, sqrt(center / span)));
      let shoulder = across * width;
      let near = (shaftBlocker(at - offset - shoulder) + shaftBlocker(at - offset + shoulder)) * .5;
      let far = (shaftBlocker(at + offset - shoulder) + shaftBlocker(at + offset + shoulder)) * .5;
      let occlusion = (near + far) * .5;
      let radialEdge = abs(near - previousOcclusion) * smoothstep(entry, entry + .035, begin);
      // Openings need room to develop a beam. Fade nearby silhouettes and
      // let only the integrated length vary as a receiver crosses a segment.
      let separation = smoothstep(.018, .11, distance - center);
      cloudVariation += (abs(far - near) * .65 + radialEdge * .35) * separation;
      let extinction = occlusion * segment * 8.0;
      let segmentTransmission = 1.0 / (1.0 + extinction);
      scatter += transmission * (1.0 - occlusion) * segment * (.5 + .5 * segmentTransmission);
      transmission *= segmentTransmission;
      previousOcclusion = far;
    }
  }
  // Only cloud openings make a visible beam. Uniform sky contributes no glow.
  let openings = smoothstep(.03, .55, cloudVariation);
  let beam = scatter / rayLength * openings * sqrt(transmission);
  let radial = distance / span;
  let falloff = (1.0 - smoothstep(.64, 1.0, radial)) / (1.0 + params.shafts.z * radial * radial);
  let cloudFade = mix(1.0, .22, smoothstep(.02, .48, localAlpha)) * (1.0 - localAlpha);
  let strength = params.shafts.x * beam * falloff * smoothstep(.005, .06, distance)
    * (rayLength / distance) * clearSky * cloudFade;
  return strength / (1.0 + 2.5 * strength);
}
