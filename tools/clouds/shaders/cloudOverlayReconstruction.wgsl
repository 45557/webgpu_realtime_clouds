// Group adjacent positive cubic weights into bilinear taps. Both radiance
// and opacity are premultiplied, so clear texels cannot introduce dark edges.
fn reconstructCloudOverlay(
  cloud: texture_2d_array<f32>, linearSampler: sampler, uv: vec2<f32>, shadingBlur: f32
) -> vec4<f32> {
  let size = vec2<f32>(textureDimensions(cloud, 0));
  let pixel = uv * size - 0.5;
  let base = floor(pixel);
  let f = fract(pixel);
  let g = 1.0 - f;
  let w0 = g * g * g / 6.0;
  let w1 = (4.0 + f * f * (3.0 * f - 6.0)) / 6.0;
  let w2 = (4.0 + g * g * (3.0 * g - 6.0)) / 6.0;
  let w3 = f * f * f / 6.0;
  let lowWeight = w0 + w1;
  let highWeight = w2 + w3;
  let low = (base - 0.5 + w1 / lowWeight) / size;
  let high = (base + 1.5 + w3 / highWeight) / size;

  let a = textureSampleLevel(cloud, linearSampler, low, 0, 0.0);
  let b = textureSampleLevel(cloud, linearSampler, vec2<f32>(high.x, low.y), 0, 0.0);
  let c = textureSampleLevel(cloud, linearSampler, vec2<f32>(low.x, high.y), 0, 0.0);
  let d = textureSampleLevel(cloud, linearSampler, high, 0, 0.0);
  let smoothCloud = (a * lowWeight.x + b * highWeight.x) * lowWeight.y
                  + (c * lowWeight.x + d * highWeight.x) * highWeight.y;
  let center = textureSampleLevel(cloud, linearSampler, uv, 0, 0.0);
  let minAlpha = min(min(a.a, b.a), min(c.a, d.a));
  let maxAlpha = max(max(a.a, b.a), max(c.a, d.a));

  // Preserve the coverage filter used by the aurora compositor.
  let mist = 1.0 - smoothstep(0.10, 0.62, center.a);
  let silhouette = smoothstep(0.025, 0.25, maxAlpha - minAlpha)
                 * (1.0 - smoothstep(0.45, 0.85, minAlpha));
  let coverageStrength = max(mix(0.36, 0.96, mist), 0.96 * silhouette);

  let alpha = mix(center.a, smoothCloud.a, coverageStrength);
  let interior = smoothstep(0.35, 0.86, minAlpha) *
                 (1.0 - smoothstep(0.05, 0.23, maxAlpha - minAlpha));
  if (shadingBlur <= 0.0 || interior <= 0.0) {
    return vec4<f32>(mix(center.rgb, smoothCloud.rgb, coverageStrength), alpha);
  }

  // In the cloud interior, the same taps distinguish coherent lighting
  // gradients from isolated bright or dark ray samples.
  let luma = vec3<f32>(0.2126, 0.7152, 0.0722);
  let light = vec4<f32>(dot(a.rgb, luma), dot(b.rgb, luma), dot(c.rgb, luma), dot(d.rgb, luma));
  let lightAcross = vec2<f32>(
    mix(light.y - light.x, light.w - light.z, highWeight.y),
    mix(light.z - light.x, light.w - light.y, highWeight.x)
  );
  let localLight = dot(smoothCloud.rgb, luma);
  let lightScale = max(localLight, 0.08);
  let edge = smoothstep(0.05, 0.19, length(lightAcross) / lightScale);
  let residual = abs(dot(center.rgb, luma) - localLight);
  let speckle = smoothstep(0.025, 0.11, residual / lightScale) * (1.0 - edge);
  let targetBlur = max(coverageStrength, mix(0.66, 0.36, edge) + 0.27 * speckle);
  let shadingStrength = mix(coverageStrength, targetBlur, min(1.0, interior * shadingBlur));
  let localColor = mix(center.rgb, smoothCloud.rgb, shadingStrength);
  // Gather lighting over a wider area at similar opacity. Normalize by the
  // neighbor alpha so the cloud's silhouette and mountain occlusion stay put.
  let distance = vec2<f32>(3.0) / size;
  let outerA = textureSampleLevel(cloud, linearSampler, uv - distance, 0, 0.0);
  let outerB = textureSampleLevel(cloud, linearSampler, uv + vec2<f32>(distance.x, -distance.y), 0, 0.0);
  let outerC = textureSampleLevel(cloud, linearSampler, uv + vec2<f32>(-distance.x, distance.y), 0, 0.0);
  let outerD = textureSampleLevel(cloud, linearSampler, uv + distance, 0, 0.0);
  let outerOpacity = vec4<f32>(outerA.a, outerB.a, outerC.a, outerD.a);
  let sameCloud = 1.0 - smoothstep(vec4<f32>(0.065), vec4<f32>(0.24),
    abs(outerOpacity - vec4<f32>(alpha)));
  let wideSum = outerA * sameCloud.x + outerB * sameCloud.y +
                outerC * sameCloud.z + outerD * sameCloud.w + vec4<f32>(localColor, alpha);
  let wideColor = wideSum.rgb * (alpha / max(wideSum.a, 0.0001));
  let shadingDenoise = min(0.92, interior * shadingBlur * mix(0.93, 0.51, edge));
  return vec4<f32>(mix(localColor, wideColor, shadingDenoise), alpha);
}
