// Cut simulated meteorite impacts into the planet's terrain with the studio's
// own crater generator: createImpactHistory shapes a fresh crater from the
// ground it lands on and impactHeight gives the bowl, rim, terraces, central
// peak and ejecta apron. The height atlas is then re-uploaded so the
// renderer and sampleSurface both see the new ground.
import { createImpactHistory, impactHeight } from '../../noise/studio-impacts.js';
import { sampleStudioPlanetNoise } from '../../noise/studio.js';
import { studioHash } from '../../noise/studio-ocean.js';

// Seconds from a meteor's entry to its impact on screen.
export const METEOR_FLIGHT = 2.0;

// Crater angular radius for a simulated impactor size (0.05 to 1.5).
export function craterSize(size) {
  return 0.006 + 0.028 * Math.min(1.5, size);
}

const reliefCache = new WeakMap();
// Typical height variation of the atlas, so crater depth matches the world.
function atlasRelief(values) {
  let relief = reliefCache.get(values);
  if (relief === undefined) {
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < values.length; i += 97) { sum += values[i]; sq += values[i] * values[i]; n++; }
    relief = Math.sqrt(Math.max(1e-8, sq / n - (sum / n) ** 2));
    reliefCache.set(values, relief);
  }
  return relief;
}

// Everything needed to cut one crater, possibly in stages: the texels it
// reaches, their tangent-plane coordinates in crater radii and the ground
// they had before the impact.
export function prepareCrater(atlas, { dir, size, id = 0 }, seed = 1) {
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
  const indices = [], us = [], vs = [];
  for (let row = first; row <= last; row++) {
    const theta = row * Math.PI / span, st = Math.sin(theta), ct = Math.cos(theta);
    for (let col = 0; col < span; col++) {
      const phi = col * 2 * Math.PI / span;
      const p = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      const facing = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
      if (facing < Math.cos(reach)) continue;
      // Gnomonic tangent coordinates, in crater radii.
      indices.push(row * side + col);
      us.push((p[0] * east[0] + p[1] * east[1] + p[2] * east[2]) / (facing * radius));
      vs.push((p[0] * north[0] + p[1] * north[1] + p[2] * north[2]) / (facing * radius));
    }
  }
  const index = Int32Array.from(indices);
  const original = Float32Array.from(index, i => values[i]);
  return { index, u: Float32Array.from(us), v: Float32Array.from(vs), original, event, side, span, fraction: 0 };
}

// Dig a prepared crater to a fraction of its final size and depth (the bowl
// opening out as the impact excavates). The procedural mesh reads its
// relief from the atlas guide, so the same change goes there too.
export function digCrater(atlas, crater, fraction = 1) {
  const { values, guide } = atlas;
  const area = atlas.side * atlas.side;
  const { index, u, v, original, side, span } = crater;
  const f = Math.max(0.05, Math.min(1, fraction));
  const staged = { ...crater.event, size: crater.event.size * f, depth: crater.event.depth * f };
  let changed = 0;
  for (let n = 0; n < index.length; n++) {
    const i = index[n];
    const next = impactHeight(u[n], v[n], original[n], staged);
    const delta = next - values[i];
    if (!delta) continue;
    values[i] = next;
    if (guide?.length === 2 * area) guide[area + i] += delta;
    // The last column repeats the first.
    if (i % side === 0) {
      values[i + span] = next;
      if (guide?.length === 2 * area) guide[area + i + span] += delta;
    }
    changed++;
  }
  crater.fraction = f;
  return changed;
}

// Carve one fresh crater in place. Returns the number of atlas texels changed.
export function carveCrater(atlas, impact, seed = 1) {
  return digCrater(atlas, prepareCrater(atlas, impact, seed), 1);
}

// Apply impacts to an atlas in place. Returns the number of craters cut.
export function carveCraters(atlas, impacts, seed) {
  let baked = 0;
  for (const impact of impacts) if (carveCrater(atlas, impact, seed)) baked++;
  return baked;
}

// Send changed heights to the renderer. Cached terrain is baked from the
// atlas; procedural terrain evaluates its base at every vertex and adds the
// atlas guide, so that needs re-uploading as well.
export function refreshTerrain(world) {
  world.uploadStudioMap(world.studioMap, world.studioSeed);
  if (world.terrainSampling === 'procedural' && world.studioVertices?.pipeline && world.studioMap.guide && world.uploadProceduralWorld) {
    world.uploadProceduralWorld(world.studioVertices.pipeline, world.studioMap,
      { radius: world.radius, profile: world.profile, seed: world.studioSeed, detail: world.detail });
  }
}

// Excavation stages after the fireball lands: seconds and fraction dug.
const STAGES = [[0, 0.3], [0.25, 0.55], [0.55, 0.75], [0.95, 0.9], [1.5, 1]];

// Queue impacts from the simulation and dig them into the live planet in
// stages, so the crater visibly opens out after the strike.
export function createCraterQueue({ minimumSize = 0.08, interval = 0.2, landing = METEOR_FLIGHT } = {}) {
  const pending = [], digging = [];
  let last = -Infinity, total = 0, serial = 0;
  return {
    // Start digging when the fireball lands, not when the simulation logs it.
    add(record, now = 0) {
      if (record.size >= minimumSize) pending.push({ dir: record.dir, size: record.size, id: serial++, at: now + landing });
      // During heavy bombardment keep only the most recent strikes.
      if (pending.length > 24) pending.shift();
    },
    flush(world, sim, now) {
      const atlas = world?.studioMap;
      if ((!pending.length && !digging.length) || now - last < interval || !atlas?.values) return 0;
      for (let n = pending.length - 1; n >= 0; n--) {
        if (pending[n].at > now || digging.length >= 6) continue;
        const impact = pending.splice(n, 1)[0];
        digging.push({ impact, start: impact.at, stage: 0, atlas, crater: prepareCrater(atlas, impact, world.studioSeed) });
      }
      let changed = 0, finished = 0;
      for (let n = digging.length - 1; n >= 0; n--) {
        const dig = digging[n];
        if (dig.atlas !== atlas) { digging.splice(n, 1); continue; }
        let stage = dig.stage;
        while (stage < STAGES.length && now - dig.start >= STAGES[stage][0]) stage++;
        if (stage === dig.stage) continue;
        dig.stage = stage;
        changed += digCrater(atlas, dig.crater, STAGES[stage - 1][1]);
        if (stage === STAGES.length) {
          digging.splice(n, 1);
          total++;
          finished++;
          sim?.reshape(dig.impact.dir, 1.6 * craterSize(dig.impact.size));
        }
      }
      if (!changed) return 0;
      last = now;
      refreshTerrain(world);
      return finished || -1;
    },
    clear() { pending.length = 0; digging.length = 0; },
    get total() { return total; },
    get digging() { return digging.length; },
  };
}
