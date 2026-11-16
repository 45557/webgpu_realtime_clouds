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

fn shadowTilt(point: vec3<f32>, tilt: vec2<f32>) -> vec3<f32> {
  return vec3<f32>(point.x, point.y * tilt.y - point.z * tilt.x, point.y * tilt.x + point.z * tilt.y);
}

fn shadowWeatherAt(point: vec3<f32>, lod: f32) -> vec4<f32> {
  let origin = normalize(point);
  let spin = params.shadowScale.zw;
  var direction = vec3<f32>(origin.x * spin.y - origin.z * spin.x,
    origin.y, origin.x * spin.x + origin.z * spin.y);
  let form = params.shadowForm.x;
  if (params.shadowForm.y > 0.0 && params.shadowForm.z != 0.0) {
    let eddyStrength = params.shadowForm.y * 0.38 * select(1.0, 0.28, isTradeWindStreet(form));
    direction = planetFlowEddies(direction, eddyStrength, params.shadowForm.z);
  }
  let shifted = normalize(shadowTilt(direction, vec2<f32>(params.shadowRight.w, params.shadowUp.w)) +
    vec3<f32>(0.0, params.shadowWeather.y, 0.0));
  let longitude = fract(atan2(shifted.z, shifted.x) / 6.283185307);
  let latitude = acos(clamp(shifted.y, -1.0, 1.0)) / 3.141592654;
  let halfTexel = 0.5 / f32(textureDimensions(shadowWeatherMap).y);
  let v = clamp((latitude - 0.5) * params.shadowScale.y + 0.5, halfTexel, 1.0 - halfTexel);
  let pole = 1.0 - smoothstep(0.035, 0.18, min(v, 1.0 - v));
  let coord = vec2<f32>(longitude, v);
  let level = lod + pole * 1.35;
  let weather = shadowWeatherSample(coord, level);
  if (pole <= 0.001) { return weather; }
  let left = shadowWeatherSample(coord - vec2<f32>(0.25, 0.0), level);
  let right = shadowWeatherSample(coord + vec2<f32>(0.25, 0.0), level);
  return mix(weather, (weather + left + right) / 3.0, pole * 0.72);
}

fn shellTravel(surfaceRadius: f32, alongSun: f32, shellRadius: f32) -> f32 {
  let shellDelta = max(0.0, (shellRadius - surfaceRadius) * (shellRadius + surfaceRadius));
  return shellDelta / max(sqrt(alongSun * alongSun + shellDelta) + alongSun, 0.0001);
}

fn planetTerrainShadow(uv: vec2<f32>, ray: vec3<f32>, foreground: f32) -> f32 {
  let strength = params.shadowForward.w;
  if (strength <= 0.001 || foreground > 0.99) { return 0.0; }
  let dims = vec2<f32>(textureDimensions(terrain));
  let pixel = min(vec2<i32>(uv * dims), vec2<i32>(dims) - 1);
  let depth = textureLoad(terrain, pixel, 0);
  if (depth.g >= 0.0 || depth.a <= 0.0) { return 0.0; }

  let surface = params.shadowEye.xyz + normalize(ray) * (depth.a + depth.b);
  let planetRadius = params.shadowEye.w;
  let surfaceRadius = length(surface);
  let sun = params.shadowSun.xyz;
  let alongSun = dot(surface, sun);
  let incidence = alongSun / max(surfaceRadius, 0.001);
  let bottom = planetRadius + params.shadowShell.x;
  let height = params.shadowForm.w;
  let top = bottom + height;
  if (surfaceRadius >= top || incidence <= 0.025) { return 0.0; }
  let sunlight = planetSunTransmission(incidence, params.shadowWeather.z) * smoothstep(0.025, 0.14, incidence);
  let first = shellTravel(surfaceRadius, alongSun, bottom);
  let last = shellTravel(surfaceRadius, alongSun, top);
  let interval = (last - first) / 3.0;
  let shapeScale = params.shadowShell.y;
  let shapeLod = clamp(log2(max(interval * shapeScale * f32(textureDimensions(shadowShapeMap).x) * 0.20, 1.0)), 0.0, 3.4);
  let weatherLod = mix(0.4, 1.55, 1.0 - incidence);
  let form = params.shadowForm.x;
  let coverage = clamp(params.shadowSun.w, 0.0, 1.0);
  let phase = params.shadowShell.w;
  var mass = 0.0;
  // Sample the sun ray through the same weather and shape fields as visible
  // clouds. A moist column by itself cannot cast a shadow.
  for (var i = 0; i < 3; i++) {
    let point = surface + sun * (first + interval * (f32(i) + 0.5));
    let pointRadius = length(point);
    let ph = clamp((pointRadius - bottom) / height, 0.0, 1.0);
    let weather = shadowWeatherAt(point, weatherLod);
    if (weather.b > 1.0) { continue; }
    var moved = planetWarpPosition(point, params.shadowShell.z, form, params.shadowForm.y, params.shadowForm.z);
    moved = shadowTilt(moved, params.shadowShapeTilt.xy);
    if (isLenticular(form)) { moved = normalize(moved) * planetRadius; }
    let domain = planetWeatherShapeDomain(moved * params.shadowAxes.xyz * shapeScale,
      weather, ph, form, planetRadius / pointRadius);
    let shape = textureSampleLevel(shadowShapeMap, shadowShapeSampler, planetEvolvingDomain(domain, phase), shapeLod);
    let geometry = planetWeatherVolumeForm(ph, weather, evolvePlanetCloudShape(shape, phase, form), coverage, form, phase);
    // Be conservative at unresolved rims so a thin wisp cannot darken a bank.
    mass += smoothstep(0.022, 0.17, geometry.x) * geometry.y;
  }
  let opacity = 1.0 - exp(-mass * interval * params.shadowWeather.w * 0.18 / height);
  return opacity * depth.r * strength * sunlight;
}
