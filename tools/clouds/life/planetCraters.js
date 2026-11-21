// Cut simulated meteorite impacts into the planet's terrain with the studio's
// own crater generator (bakePlanetImpacts with explicit basin sites), then
// re-upload the height atlas so the renderer and sampleSurface both see the
// new ground.
import { bakePlanetImpacts } from '../../noise/studio-impacts.js';
import { studioHash } from '../../noise/studio-ocean.js';

// Basin angular size for a simulated impactor size (0.05 to 1.5).
export function craterSize(size) {
  return 0.014 + 0.05 * Math.min(1.5, size);
}

// The studio bakes giant basins at full depth; small strikes keep a share
// of the original ground so they read as fresh craters, not ocean trenches.
export function craterStrength(size) {
  return Math.min(0.9, 0.25 + 0.45 * size);
}

export function basinSite(dir, size) {
  const length = Math.hypot(...dir) || 1;
  const center = dir.map(v => v / length);
  const longitude = (Math.atan2(center[2], center[0]) + 2 * Math.PI) % (2 * Math.PI);
  return { center, longitude, size: craterSize(size) };
}

// Apply impacts to an atlas in place. Returns the number of basins baked.
export function carveCraters(atlas, impacts, seed) {
  const { side, values } = atlas;
  let baked = 0;
  for (const impact of impacts) {
    const site = basinSite(impact.dir, impact.size);
    const shaped = Float32Array.from(values);
    const crater = studioHash(impact.id ?? 0, 29, 911, seed) >>> 0;
    if (!bakePlanetImpacts(shaped, side, crater, 0, 1, false, [site], 0)) continue;
    const strength = craterStrength(impact.size);
    for (let i = 0; i < values.length; i++) {
      if (shaped[i] !== values[i]) values[i] += strength * (shaped[i] - values[i]);
    }
    baked++;
  }
  return baked;
}

// Queue impacts from the simulation and cut them into the live planet a few
// at a time, so the terrain upload does not happen every frame.
export function createCraterQueue({ minimumSize = 0.12, interval = 2.5 } = {}) {
  const pending = [];
  let last = -Infinity, total = 0;
  return {
    add(record) {
      if (record.size >= minimumSize) pending.push({ dir: record.dir, size: record.size, id: total + pending.length });
      // During heavy bombardment keep only the most recent strikes.
      if (pending.length > 24) pending.shift();
    },
    flush(world, sim, now) {
      if (!pending.length || now - last < interval || !world?.studioMap?.values) return 0;
      last = now;
      const batch = pending.splice(0, 6);
      const baked = carveCraters(world.studioMap, batch, world.studioSeed);
      if (!baked) return 0;
      total += baked;
      world.uploadStudioMap(world.studioMap, world.studioSeed);
      for (const impact of batch) sim?.reshape(impact.dir, 2.2 * craterSize(impact.size));
      return baked;
    },
    clear() { pending.length = 0; },
    get total() { return total; },
  };
}
