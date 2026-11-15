fn shadowWeatherSample(uv: vec2<f32>, lod: f32) -> vec4<f32> {
  let turns = params.shadowScale.x;
  let winding = floor(turns);
  let longitude = uv.x - 0.5;
  let center = 0.5 + params.shadowWeather.x;
  let low = textureSampleLevel(shadowWeatherMap, shadowWeatherSampler,
    vec2<f32>(fract(longitude * winding + center), uv.y), 0, lod);
  if (fract(turns) < 0.00001) { return low; }
  let high = textureSampleLevel(shadowWeatherMap, shadowWeatherSampler,
    vec2<f32>(fract(longitude * (winding + 1.0) + center), uv.y), 0, lod);
  return mix(low, high, fract(turns));
}

fn planetTerrainShadow(uv: vec2<f32>, ray: vec3<f32>, foreground: f32) -> f32 {
  let strength = params.shadowForward.w;
  if (strength <= 0.001 || foreground > 0.99) { return 0.0; }

  let dims = vec2<f32>(textureDimensions(terrain));
  let pixel = min(vec2<i32>(uv * dims), vec2<i32>(dims) - 1);
  let depth = textureLoad(terrain, pixel, 0);
  if (depth.g >= 0.0 || depth.a <= 0.0) { return 0.0; }

  let surface = params.shadowEye.xyz + normalize(ray) * depth.a;
  let radius = params.shadowEye.w;
  let surfaceRadius = length(surface);
  let gap = radius - surfaceRadius;
  let sun = params.shadowSun.xyz;
  let alongSun = dot(surface, sun);
  let incidence = alongSun / max(surfaceRadius, 0.001);
  if (gap <= 0.0 || incidence <= 0.0) { return 0.0; }
  // Keep low-angle shadows on the lit side and let atmospheric extinction
  // soften them as direct sunlight disappears.
  let sunlight = planetSunTransmission(incidence, 1.0, params.shadowWeather.z) *
    smoothstep(0.0, 0.085, incidence);

  // The weather map gives a soft shadow at cloud-bank scale. Project along
  // the sun ray and reuse the same longitude winding and animated flow.
  let shellDelta = gap * (radius + surfaceRadius);
  let travel = shellDelta / (sqrt(alongSun * alongSun + shellDelta) + alongSun);
  let point = (surface + sun * travel) / radius;
  let form = params.shadowForm.x;
  let tau = 6.283185307;
  let spin = params.shadowScale.zw;
  var direction = vec3<f32>(point.x * spin.y - point.z * spin.x,
    point.y, point.x * spin.x + point.z * spin.y);
  if (form >= 0.5 && params.shadowForm.y > 0.0 && params.shadowForm.z != 0.0) {
    let eddyStrength = params.shadowForm.y * 0.38 * select(1.0, 0.28, isTradeWindStreet(form));
    direction = planetFlowEddies(direction, eddyStrength, params.shadowForm.z);
  }
  let tilt = vec2<f32>(params.shadowRight.w, params.shadowUp.w);
  let offset = params.shadowWeather.y;
  var shifted = vec3<f32>(direction.x, direction.y * tilt.y - direction.z * tilt.x + offset,
    direction.y * tilt.x + direction.z * tilt.y);
  if (offset != 0.0) { shifted = normalize(shifted); }
  let longitude = fract(atan2(shifted.z, shifted.x) / tau);
  let latitude = acos(clamp(shifted.y, -1.0, 1.0)) / (0.5 * tau);
  let halfTexel = 0.5 / f32(textureDimensions(shadowWeatherMap).y);
  let v = clamp((latitude - 0.5) * params.shadowScale.y + 0.5, halfTexel, 1.0 - halfTexel);
  let polarBlend = 1.0 - smoothstep(0.025, 0.16, min(v, 1.0 - v));
  let lod = 1.6 + (1.0 - incidence) * 1.5 + polarBlend * 1.35;
  let coord = vec2<f32>(longitude, v);
  var weather = shadowWeatherSample(coord, lod);
  if (polarBlend > 0.001) {
    let left = shadowWeatherSample(coord - vec2<f32>(0.25, 0.0), lod);
    let right = shadowWeatherSample(coord + vec2<f32>(0.25, 0.0), lod);
    weather = mix(weather, (weather + left + right) / 3.0, polarBlend * 0.72);
  }

  let deck = clamp(weather.r + params.shadowWeather.w, 0.0, 1.0);
  let bank = mix(deck, weather.a, select(0.25, 0.85, form == 2.0));
  let threshold = mix(0.84, 0.34, clamp(params.shadowSun.w, 0.0, 1.0));
  return smoothstep(threshold, threshold + 0.30, bank) * depth.r * strength *
    sunlight * smoothstep(0.0, params.shadowForm.w * 0.30, gap);
}
