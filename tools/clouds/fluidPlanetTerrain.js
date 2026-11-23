import { createPlanetRegionMesh, regionContextScale } from './cloudTerrainMesh.js';
import { SEA_LEVEL } from './fluidCloudShapes.js';
import { LOCAL_REGION_UNITS, REGION_CONTEXT_SCALE, REGION_WEATHER_SCALE, planetRegionFrame } from '../planet/planetRegion.js';

export const FLUID_MAP_FRACTION = .90;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));

function elevationAt(region, u, v, values = region.elevations, stride = 1, offset = 0) {
  const side = region.resolution;
  const x = clamp(u, 0, 1) * (side - 1), z = clamp(v, 0, 1) * (side - 1);
  const column = Math.min(side - 2, Math.floor(x)), row = Math.min(side - 2, Math.floor(z));
  const i = offset + (row * side + column) * stride;
  const a = x - column, b = z - row;
  const top = values[i], east = values[i + stride], south = values[i + side * stride];
  // Match the diagonal of the rendered heightfield. Evaluate relative to
  // one vertex to retain precision on high, nearly level tiles.
  if (a + b <= 1) return top + (east - top) * a + (south - top) * b;
  const corner = values[i + (side + 1) * stride];
  return corner + (east - corner) * (1 - b) + (south - corner) * (1 - a);
}

function planetWeatherMoisture(weather, gridSize) {
  if (!weather?.pixels || weather.resolution < 2) return undefined;
  const {pixels, resolution} = weather;
  const data = new Float32Array(gridSize * gridSize * 2);
  const coverage = clamp(weather.coverage ?? .65, 0, 1);
  const textureScale = FLUID_MAP_FRACTION * REGION_WEATHER_SCALE;
  const sample = (x, z) => {
    const i = (z * resolution + x) * 4;
    return (pixels[i] * .78 + pixels[i + 1] * .22) / 255;
  };
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const u = (.5 + ((x + .5) / gridSize - .5) / textureScale) * resolution - .5;
      const v = (.5 + ((z + .5) / gridSize - .5) / textureScale) * resolution - .5;
      const a = Math.floor(u), b = Math.floor(v), fx = u - a, fz = v - b;
      const north = sample(a, b) * (1 - fx) + sample(a + 1, b) * fx;
      const south = sample(a, b + 1) * (1 - fx) + sample(a + 1, b + 1) * fx;
      const humidity = north * (1 - fz) + south * fz;
      const cloud = clamp((humidity - (.61 - .41 * coverage)) / .42, 0, 1);
      const i = (z * gridSize + x) * 2;
      data[i] = cloud * cloud * (3 - 2 * cloud) * .84;
      data[i + 1] = .25 + .62 * humidity;
    }
  }
  return data;
}

export function prepareFluidPlanetTerrain(region, domainWidth, gridSize) {
  const mapWidth = domainWidth * FLUID_MAP_FRACTION;
  const relief = Math.max(1, region.peak - region.min);
  const visibleRelief = relief * mapWidth / region.span;
  const field = new Float32Array(gridSize * gridSize * 2);
  const step = domainWidth / gridSize;
  const context = region.context;
  const sample = step / mapWidth * .28;
  const height = (u, v) => {
    if (!context || (u >= 0 && u <= 1 && v >= 0 && v <= 1)) return elevationAt(region, u, v) - region.min;
    return elevationAt(context, (u - .5) / REGION_CONTEXT_SCALE + .5,
      (v - .5) / REGION_CONTEXT_SCALE + .5) - region.min;
  };
  const heights = [];
  for (let z = 0; z < gridSize; z++) {
    const v = ((z + .5) * step - domainWidth * .5) / mapWidth + .5;
    for (let x = 0; x < gridSize; x++) {
      const u = ((x + .5) * step - domainWidth * .5) / mapWidth + .5;
      const tileMargin = Math.min(u, 1 - u, v, 1 - v) * mapWidth / step;
      if (tileMargin < 0 && !context) continue;
      const a = height(u - sample, v - sample), b = height(u + sample, v - sample);
      const c = height(u - sample, v + sample), d = height(u + sample, v + sample);
      const h = Math.max(0, ((a + b + c + d) * .19 + .24 * Math.max(a, b, c, d)) / relief);
      const domainMargin = Math.min(x + .5, z + .5, gridSize - x - .5, gridSize - z - .5);
      const coverage = context ? clamp((domainMargin - 1.5) / 3, 0, 1) : clamp(tileMargin / 2, 0, 1);
      field[(z * gridSize + x) * 2] = h;
      field[(z * gridSize + x) * 2 + 1] = coverage;
      if (tileMargin >= 2) heights.push(h);
    }
  }
  heights.sort((a, b) => a - b);
  const preferred = heights[Math.floor(heights.length * .79)] ?? .5;
  const cutoff = region.min + clamp(preferred < .09 ? .36 : preferred, .24, .88) * relief;
  // Flow needs the simulation field, while the 3D view and off-tile flight
  // queries share a single copy of the rendered terrain.
  let mesh;
  function getRenderMesh() {
    if (mesh) return mesh;
    const built = createPlanetRegionMesh(region);
    const horizontal = mapWidth / LOCAL_REGION_UNITS;
    const vertical = visibleRelief / relief * region.span / LOCAL_REGION_UNITS;
    const {vertices} = built;
    for (let i = 0; i < vertices.length; i += 6) {
      vertices[i] *= horizontal;
      vertices[i + 1] = SEA_LEVEL + vertices[i + 1] * vertical;
      vertices[i + 2] *= horizontal;
      if (vertices[i + 4] < -1) vertices[i + 4] = -1 + (vertices[i + 4] + 1) * vertical;
      vertices[i + 3] *= vertical / horizontal;
      vertices[i + 5] *= vertical / horizontal;
    }
    mesh = built;
    return mesh;
  }
  const worldHeight = elevation => SEA_LEVEL + (elevation - region.min) / relief * visibleRelief;
  let waterLevel;
  for (const tile of [region, region.context]) {
    const water = tile?.water.indexOf(1) ?? -1;
    if (water < 0) continue;
    waterLevel = worldHeight(tile.elevations[water]);
    break;
  }
  const radius = (region.radius ?? 0) * mapWidth / region.span;
  const seaRadius = radius > 0 && Number.isFinite(waterLevel)
    ? radius + (waterLevel - SEA_LEVEL) + region.min * mapWidth / region.span : 0;
  function contextHeightAt(x, z) {
    const rendered = context && getRenderMesh();
    const surroundings = rendered?.context;
    const maxAxis = Math.max(Math.abs(x), Math.abs(z));
    const width = mapWidth * REGION_CONTEXT_SCALE;
    if (surroundings && radius <= 0 && maxAxis <= width * .5) {
      return worldHeight(elevationAt(surroundings, x / width + .5, z / width + .5));
    }
    if (surroundings && radius > 0) {
      // Invert the curved mesh projection in the same direction as the
      // camera. Interpolate the rendered heights, including the seam fade.
      const ux = x / maxAxis, uz = z / maxAxis;
      const transition = width * 4 / (surroundings.resolution - 1);
      const projected = distance => {
        const tx = ux * distance, tz = uz * distance;
        const elevation = elevationAt(surroundings, tx / width + .5, tz / width + .5);
        return distance * regionContextScale(tx, tz, elevation * mapWidth / region.span,
          radius, mapWidth * .5, transition);
      };
      if (maxAxis <= projected(width * .5)) {
        let lo = 0, hi = width * .5;
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) * .5;
          if (projected(mid) < maxAxis) lo = mid;
          else hi = mid;
        }
        const center = (lo + hi) * .5 / width;
        return elevationAt(surroundings, ux * center + .5, uz * center + .5, rendered.vertices, 6,
          region.resolution ** 2 * 6 + 1);
      }
    }
    if (!Number.isFinite(waterLevel)) return SEA_LEVEL;
    const distance = Math.hypot(x, z);
    if (seaRadius <= 0) return waterLevel;
    const drop = Math.min(distance, seaRadius) ** 2 / (Math.sqrt(Math.max(0, seaRadius ** 2 - distance ** 2)) + seaRadius);
    return waterLevel - drop;
  }
  const rock = region.direction && region.radius > 0 ? {
    ...planetRegionFrame(region.direction), radius:region.radius, seed:region.seed, datum:region.min,
    horizontalMeters:region.span / mapWidth, verticalMeters:relief / visibleRelief,
  } : null;
  return {
    field, cutoff, waterLevel, seaRadius, rock, detailRegion:region,
    get mesh() { return getRenderMesh(); },
    initialMoisture:planetWeatherMoisture(region.weather, gridSize),
    surfaceHeightAt(x, z) {
      const u = x / mapWidth + .5, v = z / mapWidth + .5;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return worldHeight(elevationAt(region, u, v));
      return contextHeightAt(x, z);
    },
    minCutoff:region.min + relief * .06, maxCutoff:region.peak + relief * .12 + 1,
    normalizedCutoff: elevation => Math.max(.03, (elevation - region.min) / relief),
    layerHeight: worldHeight,
  };
}
