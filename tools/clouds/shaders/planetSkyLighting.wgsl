// Fade the shared near-surface sky into the native globe atmosphere at altitude.
struct PlanetSkyLook {
  sky: vec3<f32>,
  solar: vec3<f32>,
  weight: f32,
  solarWeight: f32,
}

fn planetTwilightSun(elevation: f32) -> vec3<f32> {
  let tinted = sceneSolarColor(elevation) * frame.solarLook.rgb;
  return mix(tinted, tinted.r * vec3<f32>(1.0, .86, .69), .26);
}

fn planetSkyLook(ray: vec3<f32>, up: vec3<f32>, air: f32, visible: f32,
    sunElevation: f32, dip: f32, pixel: f32) -> PlanetSkyLook {
  let nearSun = max(dot(ray, sun()), 0.0);
  let atmosphere = clamp(air, 0.0, 1.0);
  let horizonLight = smoothstep(-.15, .03, sunElevation + dip);
  let twilight = 1.0 - smoothstep(.14, .62, sunElevation);
  let look = clamp(frame.skyLook.w, 0.0, 1.0);
  let weight = .86 * look * smoothstep(.04, .62, atmosphere) * mix(twilight, 1.0, look) * horizonLight;
  let gradient = sceneSkyGradient(dot(up, ray), nearSun, sunElevation) * frame.skyLook.rgb;
  let solarTint = planetTwilightSun(sunElevation);
  let bloom = clamp(frame.solarLook.w, 0.0, 2.0);
  let glare = sceneSolarHalo(nearSun) * bloom / .18 * horizonLight * atmosphere;
  let chord = sqrt(max(0.0, 2.0 * (1.0 - nearSun)));
  let edge = max(.0016, pixel);
  let disk = 1.0 - smoothstep(max(0.0, .008 - edge), .008 + edge, chord);
  let light = solarTint * (min(glare * .82, 1.4) + 2.2 * disk * visible);
  return PlanetSkyLook(gradient * (air * weight), light, weight,
    smoothstep(.035, .42, atmosphere) * mix(.64, 1.0, look));
}

struct PlanetWaterLighting {
  sky: vec3<f32>,
  sun: vec3<f32>,
}

fn planetWaterLighting(radial: vec3<f32>, reflected: vec3<f32>, day: f32,
    nativeSky: vec3<f32>, nativeSun: vec3<f32>) -> PlanetWaterLighting {
  let altitude = max(0.0, length(frame.eye.xyz) - frame.eye.w);
  let air = exp(-altitude / 18000.0) * frame.air.w;
  let daylight = smoothstep(-.10,.04,day);
  let weight = frame.skyLook.w * smoothstep(.04,.62,air) * daylight;
  if (weight == 0.0) { return PlanetWaterLighting(nativeSky, nativeSun); }

  let nearSun = max(dot(reflected,sun()),0.0);
  let gradient = sceneSkyGradient(dot(reflected,radial),nearSun,day) * frame.skyLook.rgb;
  let solar = planetTwilightSun(day);
  let haze = (sceneSolarHalo(nearSun) - sceneSolarGlare(nearSun)) * frame.solarLook.w * 1.2;
  return PlanetWaterLighting(mix(nativeSky,gradient * .66 + solar * haze,weight * .78),
    mix(nativeSun,solar,weight * .41));
}
