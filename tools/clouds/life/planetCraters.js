// Cut simulated meteorite impacts into the planet's terrain with the studio's
// own crater generator: createImpactHistory shapes a fresh crater from the
// ground it lands on and impactHeight gives the bowl, rim, terraces, central
// peak and ejecta apron. The height atlas is then re-uploaded so the
// renderer and sampleSurface both see the new ground.
import { createImpactHistory, impactHeight } from '../../noise/studio-impacts.js';
import { sampleStudioPlanetNoise } from '../../noise/studio.js';
import { studioHash } from '../../noise/studio-ocean.js';
import { createAtlasLodCache } from './planetAtlasLod.js';

// Low-detail atlas grids for uploadStudioMap, updated only where craters cut.
export const terrainLod = createAtlasLodCache();
let craterUploads = 0;
// How many crater uploads have happened, so the erosion worker can tell
// whether its low-detail grid is still current.
export const craterUploadCount = () => craterUploads;

// Crater angular radius for a simulated impactor size (0.05 to 1.5).
export function craterSize(size) {
  return 0.006 + 0.028 * Math.min(1.5, size);
}

const reliefCache = new WeakMap();
// Typical height variation of the atlas, so crater depth matches the world.
export function atlasRelief(values) {
  let relief = reliefCache.get(values);
  if (relief === undefined) {
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < values.length; i += 97) { sum += values[i]; sq += values[i] * values[i]; n++; }
    relief = Math.sqrt(Math.max(1e-8, sq / n - (sum / n) ** 2));
    reliefCache.set(values, relief);
  }
  return relief;
}

// Carve one fresh crater in place. Returns the number of atlas texels changed.
export function carveCrater(atlas, { dir, size, id = 0 }, seed = 1) {
  const { side, values } = atlas;
  const span = side - 1;
  const length = Math.hypot(...dir) || 1;
  const c = dir.map(v => v / length);
  const radius = craterSize(size);
  let east = [-c[2], 0, c[0]];
  const el = Math.hypot(...east);
  east = el > 1e-6 ? east.map(v => v / el) : [1, 0, 0];
  const north = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
  const at = (x, z) => {
    const p = [0, 1, 2].map(k => c[k] + radius * (x * east[k] + z * north[k]));
    const l = Math.hypot(...p);
    return p.map(v => v / l);
  };
  const [shape] = createImpactHistory(studioHash(id, 31, 977, seed) >>> 0, (x, z) => sampleStudioPlanetNoise(atlas, at(x, z)), true);
  // A fresh, sharp crater whose depth scales with the impactor and the world's relief.
  const event = { ...shape, wear: 0.06, depth: atlasRelief(values) * (0.5 + 1.1 * Math.min(1.2, size)) };
  const reach = Math.min(Math.PI / 2, radius * 1.53 * event.size * (1.021 + event.warp));
  const colatitude = Math.acos(Math.max(-1, Math.min(1, c[1])));
  const first = Math.max(0, Math.floor((colatitude - reach) / Math.PI * span));
  const last = Math.min(span, Math.ceil((colatitude + reach) / Math.PI * span));
  let changed = 0;
  for (let row = first; row <= last; row++) {
    const theta = row * Math.PI / span, st = Math.sin(theta), ct = Math.cos(theta);
    for (let col = 0; col < span; col++) {
      const phi = col * 2 * Math.PI / span;
      const p = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      const facing = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
      if (facing < Math.cos(reach)) continue;
      // Gnomonic tangent coordinates, in crater radii.
      const u = (p[0] * east[0] + p[1] * east[1] + p[2] * east[2]) / (facing * radius);
      const v = (p[0] * north[0] + p[1] * north[1] + p[2] * north[2]) / (facing * radius);
      const index = row * side + col;
      const next = impactHeight(u, v, values[index], event);
      if (next !== values[index]) { values[index] = next; changed++; }
    }
    values[row * side + span] = values[row * side];
  }
  return changed;
}

// Apply impacts to an atlas in place. Returns the number of craters cut.
export function carveCraters(atlas, impacts, seed) {
  let baked = 0;
  for (const impact of impacts) if (carveCrater(atlas, impact, seed)) baked++;
  return baked;
}

// Re-upload the atlas after craters were cut, rebuilding only the terrain
// tiles around them. The renderer's uploadStudioMap empties its whole tile
// cache, so every tile on screen would be rebuilt for one small crater. For
// that call the cache's clear() is swapped for one that keeps each visible
// tile that no crater can reach (visible tiles carry a centre and size) and
// retires the rest. A retired tile keeps its slot under a placeholder key, so
// slot numbers stay unique, and is rebuilt the next time it is needed.
let retiredTiles = 0;
const lastVisible = new WeakMap();
// A cube-face tile of side `size` spans at most size·√2/2 radians from its
// centre; pad it a little for the normals sampled across tile edges.
export const tileReach = tile => tile.size * 0.75;

export function uploadAroundCraters(world, spots, lod) {
  return uploadKeepingTiles(world, tile => spots.some(({ dir, reach }) => {
    const dot = tile.dir[0] * dir[0] + tile.dir[1] * dir[1] + tile.dir[2] * dir[2];
    return Math.acos(Math.max(-1, Math.min(1, dot))) < tileReach(tile) + reach;
  }), lod);
}

// Upload the atlas, rebuilding only visible tiles for which touched(tile) is
// true (and anything off screen). lod: the low-detail grid, if already made.
export function uploadKeepingTiles(world, touched, lod) {
  const upload = () => lod ? world.uploadStudioMap(world.studioMap, world.studioSeed, lod) : world.uploadStudioMap(world.studioMap, world.studioSeed);
  const cache = world.tileCache;
  // Between an upload and the renderer's next tile selection its state is
  // empty; the tiles it last selected are still the ones in the cache.
  if (Array.isArray(world.state)) lastVisible.set(world, world.state);
  const visible = world.state ?? lastVisible.get(world);
  const usable = cache?.slots instanceof Map && typeof cache.clear === 'function' && Array.isArray(visible) &&
    visible.every(tile => tile && tile.key !== undefined && tile.dir?.length === 3 && tile.size > 0);
  if (!usable) return upload();
  const keep = new Set();
  for (const tile of visible) if (!touched(tile)) keep.add(tile.key);
  const ownClear = Object.hasOwn(cache, 'clear') ? cache.clear : null;
  cache.clear = function () {
    for (const [key, slot] of [...this.slots]) {
      if (keep.has(key)) continue;
      this.slots.delete(key);
      this.slots.set(`retired:${retiredTiles++}`, slot);
    }
  };
  try {
    return upload();
  } finally {
    if (ownClear) cache.clear = ownClear;
    else delete cache.clear;
  }
}

// Queue impacts from the simulation and cut them into the live planet a few
// at a time, so the terrain upload does not happen every frame.
export function createCraterQueue({ minimumSize = 0.08, interval = 1, landing = 1.2 } = {}) {
  const pending = [];
  let last = -Infinity, total = 0;
  return {
    // Cut the crater when the fireball lands, not when the simulation logs it.
    add(record, now = 0) {
      if (record.size >= minimumSize) pending.push({ dir: record.dir, size: record.size, id: total + pending.length, at: now + landing });
      // During heavy bombardment keep only the most recent strikes.
      if (pending.length > 24) pending.shift();
    },
    flush(world, sim, now) {
      if (!pending.length || now - last < interval || !world?.studioMap?.values) return 0;
      const ready = pending.filter(p => p.at <= now).slice(0, 6);
      if (!ready.length) return 0;
      last = now;
      for (const p of ready) pending.splice(pending.indexOf(p), 1);
      const batch = ready;
      const baked = carveCraters(world.studioMap, batch, world.studioSeed);
      if (!baked) return 0;
      total += baked;
      const length = d => Math.hypot(...d) || 1;
      const spots = batch.map(impact => ({
        dir: impact.dir.map(v => v / length(impact.dir)),
        // Bowl, rim and ejecta apron reach about 2.6 crater radii; keep a margin.
        reach: 3.5 * craterSize(impact.size) + 0.01,
      }));
      // Atlas rows the craters can have changed, for the low-detail grid.
      const map = world.studioMap, span = map.side - 1;
      let rowFirst = span, rowLast = 0;
      for (const { dir, reach } of spots) {
        const colatitude = Math.acos(Math.max(-1, Math.min(1, dir[1])));
        rowFirst = Math.min(rowFirst, Math.floor((colatitude - reach) / Math.PI * span) - 1);
        rowLast = Math.max(rowLast, Math.ceil((colatitude + reach) / Math.PI * span) + 1);
      }
      uploadAroundCraters(world, spots, terrainLod.get(map, rowFirst, rowLast));
      craterUploads++;
      for (const impact of batch) sim?.reshape(impact.dir, 1.6 * craterSize(impact.size));
      return baked;
    },
    clear() { pending.length = 0; },
    get total() { return total; },
  };
}
