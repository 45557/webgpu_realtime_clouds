// Protogenesis on a planet cell grid. Nothing here scripts a species or a
// stage: cells carry chemistry, colonies carry a genome of primitive traits
// (copy speed, copy fidelity, energy harvesting, tolerances, adhesion, ...),
// and replication, mutation, competition and the environment decide what
// survives. The timeline and genealogy only record what happens.
import { studioHash } from '../../noise/studio-ocean.js';

export const GENES = Object.freeze([
  'replicate', 'fidelity', 'chemo', 'photo', 'hetero', 'heatOpt',
  'tolerance', 'membrane', 'oxyTol', 'adhesion', 'motility',
]);
const G = GENES.length;
const [REP, FID, CHEMO, PHOTO, HETERO, HEAT, TOL, MEMB, OXY, ADH, MOT] = GENES.keys();

export const HABITATS = Object.freeze({
  ocean: 'Open ocean', vent: 'Hydrothermal vent', tidal: 'Tidal pool', pond: 'Warm pond',
  spring: 'Hot spring', land: 'Dry land',
});
const HABITAT_KEYS = Object.keys(HABITATS);

export const DEFAULT_LIFE_SETTINGS = Object.freeze({
  // First Life habitat
  vents: true, lightningChemistry: true, uvChemistry: true, meteorDelivery: true,
  richness: 1, abiogenesis: 1,
  // Lifeforms
  mutation: 1, speciation: 1,
  // Climate and biomes
  temperature: 0, greenhouse: 1, volcanism: 1, erosion: 1,
  // Meteorites
  meteorRate: 4, meteorSize: 0.45, panspermia: 0.15,
  // Lightning and wildfires
  storms: 1, wildfires: true, dryness: 0.5,
});

// Storm frequency for the active cloud weather preset.
export function stormFactor(style, enabled = true) {
  if (!enabled) return 0.3;
  if (/anvil|ember|fissure/.test(style ?? '')) return 2.5;
  if (/cumulus|tower|frontal|mixed|storybook|blob|diorama/.test(style ?? '')) return 1.4;
  if (/ice|frost|cirrus|lenticular|ripples/.test(style ?? '')) return 0.35;
  return 1;
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export function createRandom(seed) {
  let state = (studioHash(seed | 0, 911, 37, 0x51f3) || 1) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

// Evenly spread cells and their nearest neighbours.
export function createCellGrid(count = 2600, neighbours = 6) {
  const dirs = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    dirs.set([r * Math.cos(a), y, r * Math.sin(a)], i * 3);
  }
  const spacing = Math.sqrt(4 * Math.PI / count);
  const size = spacing * 1.6;
  const buckets = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < count; i++) {
    const k = key(...[0, 1, 2].map(c => Math.floor(dirs[i * 3 + c] / size)));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  const near = new Int32Array(count * neighbours);
  for (let i = 0; i < count; i++) {
    const [bx, by, bz] = [0, 1, 2].map(c => Math.floor(dirs[i * 3 + c] / size));
    const found = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of buckets.get(key(bx + dx, by + dy, bz + dz)) ?? []) {
        if (j === i) continue;
        const d = (dirs[i * 3] - dirs[j * 3]) ** 2 + (dirs[i * 3 + 1] - dirs[j * 3 + 1]) ** 2 + (dirs[i * 3 + 2] - dirs[j * 3 + 2]) ** 2;
        found.push([d, j]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    for (let n = 0; n < neighbours; n++) near[i * neighbours + n] = found[n]?.[1] ?? i;
  }
  return { count, dirs, near, neighbours, spacing };
}

// Build the environment from a surface sampler. `sample(dir)` returns
// { height, depth, volcanic } in the planet's units (the planet demo passes
// its own sampleSurface/sampleLandforms); `climate` is studioClimate(seed).
// Elevation is kept separately from the sea surface so the sea can rise and
// fall, and terrain edits (craters) can be re-sampled in place.
export function createEnvironment(grid, { sample, radius = 1, climate = [0, 1, 0, 1], seed = 1 }) {
  const { count, dirs } = grid;
  const elevation = new Float32Array(count), volcanic = new Float32Array(count);
  let seaLevel = null;
  for (let i = 0; i < count; i++) {
    const s = sample([dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]]);
    elevation[i] = (s.height ?? 0) - (s.depth ?? 0);
    volcanic[i] = s.volcanic ?? 0;
    if (s.depth > 0) seaLevel = s.height;
  }
  const land = [...elevation].filter(h => seaLevel === null || h >= seaLevel).sort((a, b) => a - b);
  const low = land[Math.floor(land.length * 0.1)] ?? 0;
  const high = land[Math.floor(land.length * 0.98)] ?? 1;
  const axis = climate[3] === 0 || Math.hypot(climate[0], climate[1], climate[2]) === 0 ? [0, 1, 0] : climate;
  const latitude = new Float32Array(count), light = new Float32Array(count), flow = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const x = dirs[i * 3], y = dirs[i * 3 + 1], z = dirs[i * 3 + 2];
    latitude[i] = Math.abs(x * axis[0] + y * axis[1] + z * axis[2]);
    light[i] = 0.25 + 0.75 * Math.sqrt(1 - latitude[i] * latitude[i]);
  }
  const env = {
    count, radius, seed, sample, elevation, volcanic, latitude, light, flow, low, high,
    seaLevel0: seaLevel, seaLevel, anyOcean: seaLevel !== null, relief: Math.max(1e-6, high - low),
    ocean: new Uint8Array(count), water: new Uint8Array(count), habitat: new Uint8Array(count),
    vent: new Float32Array(count), altitude: new Float32Array(count), coast: new Uint8Array(count),
    moisture: new Float32Array(count), height: new Float32Array(count), depth: new Float32Array(count),
    // Warm planets have no snowline; a higher snowline means a warmer world.
    baseTemperature: climate[3] === 0 ? 22 : climate[0] === 0 && climate[1] === 0 ? 12 : 4 + 10 * (climate[3] - 0.65) / 0.48,
  };
  windAndCurrents(grid, env, axis);
  classifyEnvironment(grid, env);
  for (let i = 0; i < count; i++) env.moisture[i] = env.water[i] ? 1 : 0.3;
  return env;
}

// Prevailing winds and surface currents: easterly trades near the equator,
// westerlies at mid latitudes, polar easterlies. Each cell stores the
// neighbour lying most nearly downstream.
function windAndCurrents(grid, env, axis) {
  const { count, dirs, near, neighbours } = grid;
  for (let i = 0; i < count; i++) {
    const p = [dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]];
    let east = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
    const length = Math.hypot(...east) || 1;
    east = east.map(v => v / length);
    const lat = env.latitude[i];
    const sign = lat < 0.5 ? -1 : lat < 0.86 ? 1 : -1;
    let best = near[i * neighbours], score = -Infinity;
    for (let n = 0; n < neighbours; n++) {
      const j = near[i * neighbours + n];
      const step = [dirs[j * 3] - p[0], dirs[j * 3 + 1] - p[1], dirs[j * 3 + 2] - p[2]];
      const along = sign * (step[0] * east[0] + step[1] * east[1] + step[2] * east[2]) / (Math.hypot(...step) || 1);
      if (along > score) { score = along; best = j; }
    }
    env.flow[i] = best;
  }
}

// Sort cells into habitats for the current sea surface. Called again when
// the sea rises or falls, or when a crater changes the ground.
export function classifyEnvironment(grid, env) {
  const { count, near, neighbours } = grid;
  const { elevation, volcanic, seaLevel } = env;
  const deep = seaLevel === null ? 1 : Math.max(1e-6, ...Array.from(elevation, h => seaLevel - h));
  for (let i = 0; i < count; i++) {
    env.ocean[i] = seaLevel !== null && elevation[i] < seaLevel ? 1 : 0;
    env.depth[i] = env.ocean[i] ? seaLevel - elevation[i] : 0;
    env.height[i] = env.ocean[i] ? seaLevel : elevation[i];
  }
  for (let i = 0; i < count; i++) {
    env.coast[i] = 0;
    for (let n = 0; n < neighbours; n++) if (env.ocean[near[i * neighbours + n]] !== env.ocean[i]) env.coast[i] = 1;
  }
  for (let i = 0; i < count; i++) {
    env.altitude[i] = env.ocean[i] ? 0 : clamp((elevation[i] - env.low) / env.relief, 0, 1);
    const ridge = studioHash(i, 17, 3, env.seed) / 4294967296;
    let kind = 'land';
    env.vent[i] = 0;
    if (env.ocean[i]) {
      const v = Math.max(volcanic[i], env.depth[i] / deep > 0.35 && ridge < 0.08 ? 0.55 : 0);
      env.vent[i] = v > 0.25 ? v : 0;
      kind = env.vent[i] ? 'vent' : env.coast[i] ? 'tidal' : 'ocean';
    } else if (volcanic[i] > 0.5) {
      env.vent[i] = 0.5 * volcanic[i];
      kind = 'spring';
    } else if ((env.anyOcean && env.coast[i] && env.altitude[i] < 0.35) || (!env.anyOcean && elevation[i] <= env.low) ||
        (env.crater?.[i] > 0 && env.altitude[i] < 0.6) || env.wet?.[i]) {
      // Shore lowlands, dry-world basins, crater floors and high water tables hold ponds.
      kind = 'pond';
    }
    env.habitat[i] = HABITAT_KEYS.indexOf(kind);
    env.water[i] = kind === 'land' ? 0 : 1;
  }
}

// Re-read the ground for the given cells, e.g. after a crater is cut.
export function resampleEnvironment(grid, env, cells) {
  env.crater ??= new Uint8Array(env.count);
  for (const i of cells) {
    const s = env.sample([grid.dirs[i * 3], grid.dirs[i * 3 + 1], grid.dirs[i * 3 + 2]]);
    env.elevation[i] = (s.height ?? 0) - (s.depth ?? 0);
    env.crater[i] = 1;
  }
  classifyEnvironment(grid, env);
}

export function genomeTags(g) {
  const tags = [];
  if (g[CHEMO] > 0.5) tags.push('chemotroph');
  if (g[PHOTO] > 0.5) tags.push('phototroph');
  if (g[HETERO] > 0.5) tags.push('predator');
  if (g[ADH] > 0.6) tags.push('multicellular');
  if (g[MEMB] > 0.6) tags.push('hardy');
  if (g[OXY] > 0.6) tags.push('aerobic');
  if (g[MOT] > 0.6) tags.push('motile');
  if (g[HEAT] > 0.72) tags.push('thermophile');
  else if (g[HEAT] < 0.22) tags.push('cryophile');
  return tags;
}

// Complexity: how many costly capabilities the genome expresses at once.
const COSTLY = [CHEMO, PHOTO, HETERO, MEMB, OXY, MOT];
export function genomeComplexity(g) {
  let score = 0;
  for (const i of COSTLY) score += clamp((g[i] - 0.35) / 0.4, 0, 1);
  return score + 2 * clamp((g[ADH] - 0.3) / 0.5, 0, 1) + clamp((g[FID] - 0.5) / 0.4, 0, 1);
}

// genomeComplexity and genomeTags for the genome at genome[o..o+G), without
// making a subarray and a tag list for every cell in every census.
function complexityAt(genome, o) {
  let score = 0;
  for (const i of COSTLY) score += clamp((genome[o + i] - 0.35) / 0.4, 0, 1);
  return score + 2 * clamp((genome[o + ADH] - 0.3) / 0.5, 0, 1) + clamp((genome[o + FID] - 0.5) / 0.4, 0, 1);
}

function countTags(genome, o, tagCells) {
  if (genome[o + CHEMO] > 0.5) tagCells.chemotroph = (tagCells.chemotroph ?? 0) + 1;
  if (genome[o + PHOTO] > 0.5) tagCells.phototroph = (tagCells.phototroph ?? 0) + 1;
  if (genome[o + HETERO] > 0.5) tagCells.predator = (tagCells.predator ?? 0) + 1;
  if (genome[o + ADH] > 0.6) tagCells.multicellular = (tagCells.multicellular ?? 0) + 1;
  if (genome[o + MEMB] > 0.6) tagCells.hardy = (tagCells.hardy ?? 0) + 1;
  if (genome[o + OXY] > 0.6) tagCells.aerobic = (tagCells.aerobic ?? 0) + 1;
  if (genome[o + MOT] > 0.6) tagCells.motile = (tagCells.motile ?? 0) + 1;
  if (genome[o + HEAT] > 0.72) tagCells.thermophile = (tagCells.thermophile ?? 0) + 1;
  else if (genome[o + HEAT] < 0.22) tagCells.cryophile = (tagCells.cryophile ?? 0) + 1;
}

export function genomeHue(g) {
  const sum = g[CHEMO] + g[PHOTO] + g[HETERO] + 1e-6;
  // chemo orange (30), photo green (125), hetero magenta (320).
  const x = (g[CHEMO] * Math.cos(0.52) + g[PHOTO] * Math.cos(2.18) + g[HETERO] * Math.cos(5.59)) / sum;
  const y = (g[CHEMO] * Math.sin(0.52) + g[PHOTO] * Math.sin(2.18) + g[HETERO] * Math.sin(5.59)) / sum;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function distance(a, ai, b) {
  let d = 0;
  for (let k = 0; k < G; k++) d += (a[ai + k] - b[k]) ** 2;
  return Math.sqrt(d);
}

export function createLifeSim({ grid, env, seed = 1, settings = {}, onImpact }) {
  const random = createRandom(seed);
  const { count, near, neighbours } = grid;
  const s = { ...DEFAULT_LIFE_SETTINGS, ...settings };
  const organics = new Float32Array(count), scratch = new Float32Array(count);
  const biomass = new Float32Array(count), lineageOf = new Int32Array(count).fill(-1);
  const genome = new Float32Array(count * G), temperature = new Float32Array(count);
  const fire = new Float32Array(count), scar = new Float32Array(count);
  // Tracked chemistry: hydrogen from vents and serpentinising rock, fixed
  // nitrogen from lightning and volcanoes, local oxygen from photosynthesis.
  const hydrogen = new Float32Array(count), nitrogen = new Float32Array(count), oxygen = new Float32Array(count);
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  const lineages = [];
  // Lineages not yet extinct; extinct ones never come back, so the census
  // only walks these.
  let living = [];
  const events = [];
  const impacts = [];
  const strikes = [];
  const milestones = new Set();
  const state = {
    time: 0, o2: 0.002, iron: 2, seaOffset: 0, co2: 12, globalTemperature: 0, winter: 0, biomass: 0,
    alive: 0, maxComplexity: 0, strikes: 0, fires: 0, impacts: 0, ice: 0, landCover: 0,
    aliveHistory: [],
  };

  function log(kind, text, extra = {}) {
    events.push({ time: state.time, kind, text, ...extra });
    if (events.length > 400) events.splice(0, events.length - 400);
  }

  function newLineage(parent, g, origin, cell) {
    const lineage = {
      id: lineages.length, parent: parent?.id ?? null, origin, born: state.time, extinct: null,
      founder: Float32Array.from(g), cells: 0, peak: 0, biomass: 0, children: [], cell,
      hue: genomeHue(g), tags: genomeTags(g), complexity: genomeComplexity(g),
    };
    lineages.push(lineage);
    living.push(lineage);
    parent?.children.push(lineage.id);
    return lineage;
  }

  function place(cell, lineage, g, mass) {
    lineageOf[cell] = lineage.id;
    genome.set(g, cell * G);
    biomass[cell] = mass;
  }

  function primitiveGenome(spore = false) {
    // A crude replicator: fast, error-prone copying and a little of everything.
    const g = new Float32Array(G);
    for (let k = 0; k < G; k++) g[k] = clamp(0.12 + 0.18 * random(), 0, 1);
    g[REP] = 0.45 + 0.2 * random();
    g[FID] = 0.2 + 0.15 * random();
    g[CHEMO] = 0.35 + 0.25 * random();
    g[HEAT] = 0.45 + 0.45 * random();
    if (spore) g[MEMB] = 0.55 + 0.3 * random();
    return g;
  }

  function spawn(cell, origin, spore = false) {
    if (lineageOf[cell] >= 0) return null;
    const g = primitiveGenome(spore);
    const lineage = newLineage(null, g, origin, cell);
    place(cell, lineage, g, 0.25);
    return lineage;
  }

  function mutateInto(from, to) {
    const parent = lineages[lineageOf[from]];
    lineageOf[to] = parent.id;
    // Copying errors: low fidelity copies make more mistakes.
    const errors = 0.35 * s.mutation * (1.1 - genome[from * G + FID]);
    if (random() >= errors) {
      genome.copyWithin(to * G, from * G, from * G + G);
      return;
    }
    for (let k = 0; k < G; k++) {
      genome[to * G + k] = clamp(genome[from * G + k] + (random() < 0.4 ? 0.07 * gaussian(random) : 0), 0, 1);
    }
    if (distance(genome, to * G, parent.founder) > 0.55 * s.speciation) {
      const child = newLineage(parent, genome.subarray(to * G, to * G + G), 'split', to);
      lineageOf[to] = child.id;
    }
  }

  function kill(cell) {
    lineageOf[cell] = -1;
    biomass[cell] = 0;
  }

  function neighbour(i) {
    return near[i * neighbours + Math.floor(random() * neighbours)];
  }

  function nearestCell(dir) {
    let best = 0, score = -2;
    for (let i = 0; i < count; i++) {
      const d = grid.dirs[i * 3] * dir[0] + grid.dirs[i * 3 + 1] * dir[1] + grid.dirs[i * 3 + 2] * dir[2];
      if (d > score) { score = d; best = i; }
    }
    return best;
  }

  function randomDir() {
    const y = 2 * random() - 1, a = 2 * Math.PI * random(), r = Math.sqrt(1 - y * y);
    return [r * Math.cos(a), y, r * Math.sin(a)];
  }

  function impact({ dir = randomDir(), size = clamp(s.meteorSize * (0.4 + 1.2 * random() ** 2), 0.05, 1.5) } = {}) {
    const cell = nearestCell(dir);
    const reach = Math.cos(grid.spacing * (0.8 + 5 * size));
    const rim = Math.cos(grid.spacing * (1.6 + 7 * size));
    let killed = 0;
    for (let i = 0; i < count; i++) {
      const d = grid.dirs[i * 3] * dir[0] + grid.dirs[i * 3 + 1] * dir[1] + grid.dirs[i * 3 + 2] * dir[2];
      if (d > reach) {
        if (lineageOf[i] >= 0) killed++;
        kill(i);
        scar[i] = 1;
        fire[i] = 0;
      } else if (d > rim && s.meteorDelivery && env.water[i]) {
        // Shocked rock and fresh hydrothermal circulation around the crater.
        organics[i] = Math.min(3, organics[i] + 0.6 * size);
      }
    }
    state.winter += 14 * size * size;
    state.co2 += 0.6 * size;
    state.impacts++;
    const record = { time: state.time, dir, size, cell, killed, seeded: null };
    if (random() < s.panspermia) {
      // Hardy spores ride the impactor in and settle just outside the crater.
      let target = -1;
      for (let tries = 0; tries < 40 && target < 0; tries++) {
        const j = neighbour(neighbour(neighbour(cell)));
        if (lineageOf[j] < 0 && env.water[j]) target = j;
      }
      if (target >= 0) {
        const lineage = spawn(target, 'meteorite', true);
        if (lineage) record.seeded = lineage.id;
      }
    }
    impacts.push(record);
    if (impacts.length > 200) impacts.shift();
    onImpact?.(record);
    const label = size > 1 ? 'Giant impact' : size > 0.7 ? 'Large impact' : 'Impact';
    log('impact', `${label}${killed ? `, ${killed} colonies lost` : ''}${record.seeded !== null ? `, seeded lineage L${record.seeded}` : ''}`,
      { lineage: record.seeded, cell, size });
    return record;
  }

  function lightning(cell) {
    state.strikes++;
    strikes.push({ time: state.time, cell });
    if (strikes.length > 64) strikes.shift();
    if (s.lightningChemistry && env.water[cell]) organics[cell] = Math.min(3, organics[cell] + 0.5);
    nitrogen[cell] = Math.min(2, nitrogen[cell] + 0.5);
    // Dry vegetated land can catch fire.
    const l = lineageOf[cell];
    if (s.wildfires && l >= 0 && !env.water[cell] && genome[cell * G + PHOTO] > 0.4 && biomass[cell] > 0.25 &&
        random() < s.dryness * (1.2 - env.moisture[cell])) {
      fire[cell] = 1;
      state.fires++;
      if (!milestones.has('fire')) {
        milestones.add('fire');
        log('milestone', 'First wildfire, lightning in land vegetation', { cell });
      }
    }
  }

  function updateClimate() {
    state.winter *= 0.9;
    state.globalTemperature = env.baseTemperature + s.temperature - state.winter +
      6 * s.greenhouse * Math.log2(Math.max(0.05, state.co2) / 4);
    let ice = 0, landIce = 0, landCells = 0;
    for (let i = 0; i < count; i++) {
      const t = state.globalTemperature + 18 - 48 * env.latitude[i] ** 2 - 34 * env.altitude[i] + 22 * env.vent[i];
      temperature[i] = t;
      if (t < -2) ice++;
      if (!env.ocean[i]) { landCells++; if (t < -2) landIce++; }
    }
    state.ice = ice / count;
    // Sea level: ice sheets on land lock up water; warm oceans expand.
    if (env.anyOcean) {
      const target = env.relief * (-0.22 * (landCells ? landIce / landCells : 0) + 0.004 * clamp(state.globalTemperature - 15, -20, 20));
      state.seaOffset += 0.08 * (target - state.seaOffset);
      if (Math.abs(state.seaOffset - (env.seaLevel - env.seaLevel0)) > env.relief * 0.01) {
        env.seaLevel = env.seaLevel0 + state.seaOffset;
        classifyEnvironment(grid, env);
      }
    }
  }

  // Water cycle. Warm water evaporates into vapour; prevailing winds carry
  // the vapour; it rains out over mountains, in cold air and as the air
  // fills up; rain soaks into the ground as groundwater, which seeps
  // downhill, feeds plants and springs, and evaporates again.
  const vapor = new Float32Array(count), rain = new Float32Array(count), groundwater = new Float32Array(count);
  const carried = new Float32Array(count), arrivals = new Float32Array(count);
  const downhill = new Int32Array(count).fill(-1);
  env.groundwater = groundwater;
  function findDownhill() {
    for (let i = 0; i < count; i++) {
      let best = -1, low = env.elevation[i];
      for (let k = 0; k < neighbours; k++) {
        const j = near[i * neighbours + k];
        if (env.elevation[j] < low) { low = env.elevation[j]; best = j; }
      }
      downhill[i] = best;
    }
  }
  findDownhill();
  let wetChanged = false;
  function waterCycle() {
    carried.fill(0);
    arrivals.fill(0);
    let evaporation = 0, rainfall = 0, stored = 0, landCells = 0;
    for (let i = 0; i < count; i++) {
      const t = temperature[i];
      const frozen = t < -2;
      // Evaporation rises steeply with temperature.
      const warmth = clamp((t + 10) / 35, 0, 1.4) ** 1.5;
      let evap = 0;
      if (env.water[i]) evap = (frozen ? 0.1 : 1) * 0.5 * warmth;
      else {
        // Soil and plants give water back (plants pull it up from deeper).
        const plants = lineageOf[i] >= 0 ? genome[i * G + PHOTO] * Math.min(1, biomass[i]) : 0;
        evap = Math.min(groundwater[i], 0.12 * warmth * (0.4 + plants));
        groundwater[i] -= evap;
      }
      vapor[i] += evap;
      evaporation += evap;
      // Rain-out: mountains lift the air, cold air holds less, full air saturates.
      const capacity = 0.6 + 1.4 * warmth;
      const chance = clamp(0.12 + 0.6 * env.altitude[i] + 0.3 * clamp((5 - t) / 25, 0, 1) + 0.5 * Math.max(0, vapor[i] / capacity - 0.7), 0, 0.95);
      rain[i] = vapor[i] * chance;
      vapor[i] -= rain[i];
      rainfall += rain[i];
      if (!env.water[i]) {
        landCells++;
        groundwater[i] = Math.min(3, groundwater[i] + 0.7 * rain[i]);
        // Groundwater seeps toward lower ground and into the sea.
        const j = downhill[i];
        const seep = 0.06 * groundwater[i];
        groundwater[i] -= seep;
        if (j >= 0 && !env.water[j]) groundwater[j] += seep;
        stored += groundwater[i];
      }
      // Wind carries most of the vapour on.
      const moved = 0.75 * vapor[i];
      vapor[i] -= moved;
      carried[env.flow[i]] += moved;
      arrivals[env.flow[i]]++;
    }
    for (let i = 0; i < count; i++) {
      vapor[i] = Math.min(4, vapor[i] + carried[i] / Math.max(1, arrivals[i]) * Math.min(arrivals[i], 2));
      if (env.water[i]) { env.moisture[i] = env.ocean[i] && temperature[i] < -2 ? 0.3 : 1; continue; }
      env.moisture[i] = clamp(0.45 * groundwater[i] + 1.5 * rain[i], 0, 1);
      // A full water table in low ground surfaces as springs and ponds.
      const wet = groundwater[i] > 1.4 && env.altitude[i] < 0.5;
      if (wet !== !!env.wet?.[i]) wetChanged = true;
    }
    state.evaporation = evaporation / count;
    state.rainfall = rainfall / count;
    state.groundwater = landCells ? stored / landCells : 0;
    if (wetChanged && state.time % 10 === 0) {
      env.wet ??= new Uint8Array(count);
      for (let i = 0; i < count; i++) env.wet[i] = !env.ocean[i] && groundwater[i] > 1.4 && env.altitude[i] < 0.5 ? 1 : 0;
      classifyEnvironment(grid, env);
      wetChanged = false;
    }
  }

  function chemistry() {
    const ozone = clamp(state.o2 * 6, 0, 1);
    for (let i = 0; i < count; i++) {
      oxygen[i] *= 0.8;
      if (!env.water[i]) { organics[i] *= 0.9; continue; }
      const t = temperature[i];
      let make = 0;
      if (s.vents) make += 0.05 * env.vent[i];
      hydrogen[i] = Math.min(2, hydrogen[i] * 0.9 + 0.12 * env.vent[i] * (s.vents ? 1 : 0.3)) * (1 - 0.5 * state.o2);
      nitrogen[i] = Math.min(2, nitrogen[i] * 0.985 + 0.004 * s.volcanism * env.vent[i]);
      if (s.uvChemistry) make += 0.012 * env.light[i] * (1 - ozone) * (t > -2 ? 1 : 0.2);
      // Wet-dry cycles concentrate monomers at shores and in ponds.
      const concentrate = env.habitat[i] === 2 || env.habitat[i] === 3 || env.habitat[i] === 4 ? 1.8 : 1;
      organics[i] = Math.min(3, organics[i] + make * s.richness * concentrate);
      organics[i] *= 1 - (0.012 + 0.0004 * Math.max(0, t)) - 0.25 * state.o2;
    }
    scratch.set(organics);
    for (let i = 0; i < count; i++) {
      if (!env.ocean[i]) continue;
      let sum = 0, n = 0;
      for (let k = 0; k < neighbours; k++) {
        const j = near[i * neighbours + k];
        if (env.ocean[j]) { sum += scratch[j]; n++; }
      }
      if (n) organics[i] = 0.85 * scratch[i] + 0.15 * sum / n;
    }
    // Surface currents carry a share of each ocean cell's organics downstream.
    for (let i = 0; i < count; i++) {
      const j = env.flow[i];
      if (!env.ocean[i] || !env.ocean[j] || temperature[i] < -2) continue;
      const moved = 0.12 * organics[i];
      organics[i] -= moved;
      organics[j] = Math.min(3, organics[j] + moved);
    }
    if (state.o2 > 0.05) return;
    for (let i = 0; i < count; i++) {
      if (lineageOf[i] >= 0 || !env.water[i] || temperature[i] < -5) continue;
      const bonus = env.vent[i] ? 2 : env.habitat[i] >= 2 && env.habitat[i] <= 4 ? 2.5 : 1;
      const p = 0.00007 * s.abiogenesis * bonus * Math.max(0, organics[i] - 0.4) ** 2;
      if (random() < p) {
        const lineage = spawn(i, HABITATS[HABITAT_KEYS[env.habitat[i]]].toLowerCase());
        if (lineage) log('origin', `Self-copying chemistry became life in a ${lineage.origin} (L${lineage.id})`, { lineage: lineage.id, cell: i });
      }
    }
  }

  function organisms() {
    const ozone = clamp(state.o2 * 6, 0, 1);
    const co2Factor = clamp(state.co2 / 2, 0.1, 1);
    let photosynthesis = 0, respiration = 0;
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (const i of order) {
      const l = lineageOf[i];
      if (l < 0) continue;
      const o = i * G;
      const g = (k) => genome[o + k];
      const land = !env.water[i];
      const frozen = temperature[i] < -2;
      const light = env.light[i] * (frozen ? 0.15 : 1) * (env.ocean[i] && !env.coast[i] ? 0.75 : 1);
      const optimum = -15 + 115 * g(HEAT);
      const thermal = Math.exp(-(((temperature[i] - optimum) / (8 + 30 * g(TOL))) ** 2));
      let prey = 0;
      if (g(HETERO) > 0.05) {
        for (let k = 0; k < neighbours; k++) {
          const j = near[i * neighbours + k];
          if (lineageOf[j] >= 0 && lineageOf[j] !== l) {
            const bite = Math.min(biomass[j], 0.12 * g(HETERO) * biomass[i] / (1 + genome[j * G + ADH]));
            biomass[j] -= bite;
            prey += bite;
          }
        }
      }
      // Metabolic machinery is shared: a generalist splits it between pathways.
      const machinery = 1.4 / (0.4 + g(CHEMO) + g(PHOTO) + g(HETERO));
      const chem = g(CHEMO) * machinery * (0.5 * organics[i] + 0.6 * env.vent[i]);
      const photo = g(PHOTO) * machinery * light * 0.7 * co2Factor;
      const aerobic = 1 + 1.5 * Math.min(1, state.o2) * g(OXY);
      // Thick walls protect but slow uptake.
      const intake = ((chem + 2 * prey * machinery * g(HETERO)) * aerobic + photo) * thermal * (1 - 0.45 * g(MEMB));
      // Upkeep grows with colony size and with every trait the cells maintain.
      const upkeep = 0.03 + 0.02 * (g(CHEMO) + g(PHOTO) + g(HETERO)) + 0.02 * g(MEMB) + 0.035 * g(ADH) +
        0.02 * g(MOT) + 0.02 * g(TOL) + 0.01 * g(REP) + 0.015 * g(FID) + 0.015 * g(OXY);
      const cost = 0.02 + upkeep * biomass[i];
      const uv = light * (1 - ozone) * (land ? 1 : env.coast[i] ? 0.35 : 0.06);
      const damage = 0.5 * state.o2 * (1 - g(OXY)) + (land ? 0.8 * (1 - g(MEMB)) ** 2 * (1 - 0.6 * env.moisture[i]) : 0) +
        0.6 * uv * (1 - 0.8 * g(MEMB)) ** 2 + (frozen && !env.vent[i] ? 0.05 : 0);
      // Large bodies need dense energy: oxygen lets sticky cells build bigger colonies.
      const capacity = 1 + 4 * g(ADH) ** 2 * (0.25 + Math.min(1, state.o2));
      biomass[i] = Math.min(capacity, biomass[i] + 0.6 * (0.5 + g(REP)) * (intake - cost - damage));
      organics[i] = Math.max(0, organics[i] - 0.25 * chem);
      hydrogen[i] = Math.max(0, hydrogen[i] - 0.1 * g(CHEMO) * biomass[i]);
      nitrogen[i] = Math.max(0, nitrogen[i] - 0.01 * biomass[i]);
      oxygen[i] += photo * thermal * biomass[i] * 0.5;
      photosynthesis += photo * thermal * biomass[i];
      respiration += (chem + prey) * biomass[i];
      if (fire[i] > 0) biomass[i] -= 0.6 * fire[i];
      if (biomass[i] < 0.03) { kill(i); continue; }
      if (biomass[i] > 0.35 * capacity && random() < 0.25 + 0.6 * g(REP)) {
        const tries = 1 + (random() < g(MOT) ? 2 : 0);
        for (let n = 0; n < tries; n++) {
          // Ocean colonies drift with the current; others spread at random.
          let j = env.ocean[i] && random() < 0.45 ? env.flow[i] : neighbour(i);
          if (g(MOT) > 0.5 && random() < g(MOT) - 0.4) j = neighbour(j);
          if (lineageOf[j] < 0) {
            mutateInto(i, j);
            biomass[j] = 0.25 * biomass[i];
            biomass[i] *= 0.8;
            break;
          }
          if (lineageOf[j] !== l) {
            const attack = biomass[i] * (1 + g(ADH) + 0.8 * g(HETERO)) * (0.6 + 0.8 * random());
            const defend = biomass[j] * (1 + genome[j * G + ADH] + 0.4 * genome[j * G + MEMB]) * 1.25;
            if (attack > defend) {
              mutateInto(i, j);
              biomass[j] = 0.3 * biomass[i];
              biomass[i] *= 0.75;
              break;
            }
          }
        }
      }
    }
    // Gases: photosynthesis splits water for oxygen; volcanoes and rusting iron sink it.
    let oxygenMade = photosynthesis * 0.012 / count;
    const rust = Math.min(oxygenMade, state.iron, 0.004);
    state.iron -= rust;
    oxygenMade -= rust;
    state.o2 = clamp(state.o2 + oxygenMade - 0.0006 * s.volcanism * (state.o2 > 0.001 ? 1 : 0) - 0.006 * state.o2, 0, 2);
    const weathering = 0.004 * state.co2 * clamp((state.globalTemperature + 10) / 30, 0, 2);
    state.co2 = clamp(state.co2 + 0.03 * s.volcanism + (respiration - photosynthesis) * 0.5 / count - weathering, 0.05, 40);
  }

  function burn() {
    let burning = 0;
    for (let i = 0; i < count; i++) {
      if (fire[i] <= 0) continue;
      burning++;
      fire[i] -= 0.3 + 0.4 * env.moisture[i];
      state.co2 += 0.01;
      for (let k = 0; k < neighbours; k++) {
        const j = near[i * neighbours + k];
        if (fire[j] <= 0 && !env.water[j] && biomass[j] > 0.3 && random() < 0.35 * s.dryness * (1.1 - env.moisture[j])) fire[j] = 1;
      }
      if (fire[i] < 0) fire[i] = 0;
    }
    state.burning = burning;
  }

  function weather(stormFactor) {
    const strikesPerMyr = 2.5 * s.storms * stormFactor;
    let n = Math.floor(strikesPerMyr) + (random() < strikesPerMyr % 1 ? 1 : 0);
    for (let tries = 0; n > 0 && tries < n * 6; tries++) {
      const i = Math.floor(random() * count);
      // Storms grow over warm water and warm land.
      if (random() < clamp((temperature[i] + 5) / 35, 0.05, 1)) { lightning(i); n--; }
    }
    const meteors = s.meteorRate / 100 * (1 + 5 * Math.exp(-state.time / 300));
    if (random() < meteors) impact();
  }

  function census() {
    for (const lineage of living) { lineage.cells = 0; lineage.biomass = 0; }
    let total = 0, landCells = 0, landTotal = 0, maxComplexity = 0;
    const tagCells = {};
    for (let i = 0; i < count; i++) {
      if (!env.water[i]) landTotal++;
      scar[i] *= 0.985;
      const l = lineageOf[i];
      if (l < 0) continue;
      const lineage = lineages[l];
      lineage.cells++;
      lineage.biomass += biomass[i];
      total += biomass[i];
      if (!env.water[i]) landCells++;
      const c = complexityAt(genome, i * G);
      if (c > maxComplexity) maxComplexity = c;
      countTags(genome, i * G, tagCells);
    }
    let alive = 0;
    const stillLiving = [];
    for (const lineage of living) {
      if (lineage.cells === 0) {
        lineage.extinct = state.time;
        if (lineage.peak >= 25) log('extinction', `L${lineage.id} died out after ${Math.round(state.time - lineage.born)} Myr`, { lineage: lineage.id });
      } else {
        alive++;
        lineage.peak = Math.max(lineage.peak, lineage.cells);
        stillLiving.push(lineage);
      }
    }
    living = stillLiving;
    state.biomass = total;
    state.alive = alive;
    state.maxComplexity = maxComplexity;
    state.landCover = landTotal ? landCells / landTotal : 0;
    state.tagCells = tagCells;
    const history = state.aliveHistory;
    history.push(alive);
    if (history.length > 30) history.shift();
    const before = Math.max(...history);
    if (before >= 8 && alive <= before * 0.4 && state.time - (state.lastMassExtinction ?? -100) > 40) {
      state.lastMassExtinction = state.time;
      log('milestone', `Mass extinction: living lineages fell from ${before} to ${alive}`);
    }
    // Firsts are detected from what the genomes do, not scheduled.
    const firsts = [
      ['phototroph', 'First sunlight-harvesting colonies'],
      ['predator', 'First colonies that feed on other life'],
      ['multicellular', 'First cells that stick together (multicellular)'],
      ['aerobic', 'First oxygen-breathing colonies'],
    ];
    for (const [tag, text] of firsts) {
      if (!milestones.has(tag) && (tagCells[tag] ?? 0) >= 8) { milestones.add(tag); log('milestone', text); }
    }
    if (!milestones.has('land') && landCells >= Math.max(10, 0.15 * landTotal)) { milestones.add('land'); log('milestone', 'Life spread onto dry land'); }
    if (!milestones.has('oxygen') && state.o2 > 0.1) { milestones.add('oxygen'); log('milestone', 'Oxygen built up in the air (great oxidation)'); }
    if (!milestones.has('snowball') && state.ice > 0.8) { milestones.add('snowball'); log('milestone', 'The planet froze over (snowball)'); }
  }

  function step(stormFactor = 1) {
    state.time += 1;
    updateClimate();
    waterCycle();
    weather(stormFactor);
    chemistry();
    organisms();
    burn();
    census();
  }

  function lineagePath(id) {
    const path = [];
    for (let l = lineages[id]; l; l = l.parent === null ? null : lineages[l.parent]) path.push(l);
    return path;
  }

  return {
    grid, env, settings: s, state, lineages, events, impacts, strikes,
    organics, biomass, lineageOf, genome, temperature, fire, scar, hydrogen, nitrogen, oxygen, vapor, rain, groundwater,
    step, impact, lightning, lineagePath, nearestCell,
    setSettings(next) { Object.assign(s, next); },
    // Re-read the ground near a point after the terrain changed there.
    reshape(dir, angle) {
      const limit = Math.cos(angle), cells = [];
      for (let i = 0; i < count; i++) {
        if (grid.dirs[i * 3] * dir[0] + grid.dirs[i * 3 + 1] * dir[1] + grid.dirs[i * 3 + 2] * dir[2] > limit) cells.push(i);
      }
      if (cells.length) { resampleEnvironment(grid, env, cells); findDownhill(); }
      return cells.length;
    },
    genomeOf(cell) { return genome.subarray(cell * G, cell * G + G); },
  };
}
