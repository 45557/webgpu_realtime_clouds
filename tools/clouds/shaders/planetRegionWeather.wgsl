struct RegionWeatherProjection {
  up: vec3<f32>,
  east: vec3<f32>,
  south: vec3<f32>,
};
@group(1) @binding(20) var<uniform> regionWeather: RegionWeatherProjection;
@group(1) @binding(21) var<storage, read_write> regionWeatherPixels: array<u32>;

fn regionWeatherWidth() -> u32 {
  return u32(sqrt(f32(arrayLength(&regionWeatherPixels))));
}

fn regionWeatherDirection(pixel: vec2<u32>, width: u32) -> vec3<f32> {
  let offset = (vec2<f32>(pixel) + 0.5) / f32(width) - 0.5;
  return normalize(regionWeather.up + regionWeather.east * offset.x + regionWeather.south * offset.y);
}
