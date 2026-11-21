import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyPlan, BODY_FORMS, classifyEnvironment, createCellGrid, createEnvironment, createLifeSim, genomeTags, GENES, stormFactor,
} from '../life/planetLifeSim.js';

// A small synthetic planet: oceans, coasts, volcanic sea floor and dry land.
function world(seed = 5, count = 1200) {
  const grid = createCellGrid(count);
  const sample = ([x, y, z]) => {
    const h = Math.sin(3 * x + seed) * Math.cos(2 * y) + 0.5 * Math.sin(5 * z + 1.3 * seed);
    return { height: h, depth: h < 0.1 ? 0.1 - h : 0, volcanic: Math.max(0, Math.sin(11 * x + 4 * z)) };
  };
  const env = createEnvironment(grid, { sample, climate: [0.1, 0.99, 0, 0.9], seed });
  return { grid, env };
}

test('body plans: single cells are invisible, multicellular life grows into plants and animals', () => {
  const g = (traits) => Float32Array.from(GENES, k => traits[k] ?? 0.2);
  assert.equal(bodyPlan(g({})).form, BODY_FORMS.none);
  const mat = bodyPlan(g({ photo: 0.8 }));
  assert.equal(mat.form, BODY_FORMS.mound);
  assert.ok(mat.size > 0.1 && mat.size < 0.5);
  const sprout = bodyPlan(g({ photo: 0.8, adhesion: 0.6 }));
  const tree = bodyPlan(g({ photo: 0.9, adhesion: 1, membrane: 0.9, oxyTol: 0.9, fidelity: 0.9, chemo: 0.8 }));
  assert.equal(tree.form, BODY_FORMS.plant);
  assert.ok(tree.size > 5 * sprout.size && tree.size < 40, `tree ${tree.size} m, sprout ${sprout.size} m`);
  const grazer = bodyPlan(g({ hetero: 0.8, motility: 0.9, adhesion: 0.9 }));
  assert.equal(grazer.form, BODY_FORMS.animal);
  assert.ok(grazer.speed > 1);
  assert.equal(bodyPlan(g({ adhesion: 0.8 })).form, BODY_FORMS.sessile);
});

test('cell grid gives every cell distinct nearby neighbours', () => {
  const grid = createCellGrid(500);
  for (let i = 0; i < grid.count; i++) {
    const near = new Set(grid.near.subarray(i * grid.neighbours, (i + 1) * grid.neighbours));
    assert.equal(near.has(i), false);
    assert.equal(near.size, grid.neighbours);
  }
});

test('habitats come from the sampled terrain', () => {
  const { env } = world();
  const kinds = new Set(env.habitat);
  assert.ok(kinds.size >= 4, 'expected vents, pools, ponds and land');
  for (let i = 0; i < env.water.length; i++) if (env.ocean[i]) assert.equal(env.water[i], 1);
});

test('life emerges from chemistry, diversifies and is recorded with ancestry', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 9 });
  for (let t = 0; t < 600; t++) sim.step(1);
  assert.ok(sim.lineages.some(l => l.parent === null), 'no origin of life');
  assert.ok(sim.lineages.some(l => l.parent !== null), 'no descendant lineages');
  assert.ok(sim.events.some(e => e.kind === 'origin'));
  const child = sim.lineages.find(l => l.parent !== null);
  const path = sim.lineagePath(child.id);
  assert.equal(path[0].id, child.id);
  assert.equal(path.at(-1).parent, null);
  assert.ok(path.every((l, n) => n === 0 || path[n - 1].parent === l.id));
});

test('the same seed replays the same history', () => {
  const run = () => {
    const { grid, env } = world(3, 800);
    const sim = createLifeSim({ grid, env, seed: 4 });
    for (let t = 0; t < 300; t++) sim.step(1);
    return [sim.lineages.length, sim.state.o2, sim.state.impacts];
  };
  assert.deepEqual(run(), run());
});

test('meteorites clear a crater and can seed hardy life', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 2, settings: { panspermia: 1, meteorRate: 0 } });
  let record;
  for (let n = 0; n < 10 && record?.seeded == null; n++) record = sim.impact({ dir: [0, 0, 1], size: 0.6 });
  for (let k = 0; k < sim.slots; k++) assert.equal(sim.lineageOf[record.cell * sim.slots + k], -1);
  assert.ok(record.seeded !== null, 'panspermia never seeded a lineage');
  const seeded = sim.lineages[record.seeded];
  assert.equal(seeded.origin, 'meteorite');
  assert.ok(seeded.founder[GENES.indexOf('membrane')] > 0.5);
});

test('traits are described from the genome, and storms follow cloud weather', () => {
  const g = new Float32Array(GENES.length).fill(0.1);
  g[GENES.indexOf('photo')] = 0.9;
  g[GENES.indexOf('adhesion')] = 0.8;
  assert.deepEqual(genomeTags(g), ['phototroph', 'multicellular', 'cryophile']);
  assert.ok(stormFactor('anvil_thunderstorms') > stormFactor('realistic'));
  assert.ok(stormFactor('ice_filaments') < 1);
});

test('meteorite craters are cut with the studio crater generator', async () => {
  const { carveCraters, craterSize } = await import('../life/planetCraters.js');
  const side = 257;
  const values = new Float32Array(side * side);
  for (let row = 0; row < side; row++) for (let col = 0; col < side; col++) {
    values[row * side + col] = 0.2 * Math.sin(col / 9) * Math.cos(row / 7);
  }
  const before = Float32Array.from(values);
  const dir = [Math.cos(0.4), 0, Math.sin(0.4)]; // equator, longitude 0.4 rad
  assert.equal(carveCraters({ side, values }, [{ dir, size: 0.8 }], 7), 1);
  const span = side - 1;
  const at = Math.round(span / 2) * side + Math.round(0.4 / (2 * Math.PI) * span);
  assert.ok(values[at] < before[at] - 0.03, 'crater floor should be lower than the old ground');
  const rimAt = Math.round(span / 2) * side + Math.round((0.4 + craterSize(0.8) * 1.05) / (2 * Math.PI) * span);
  assert.ok(values[rimAt] > values[at], 'the rim stands above the floor');
  const far = Math.round(span / 2) * side + Math.round(span / 2 + 0.4 / (2 * Math.PI) * span) % span;
  assert.equal(values[far], before[far], 'the far side is untouched');
  assert.ok(craterSize(1) > craterSize(0.1));
});

test('a rising sea floods low ground and changes habitats', () => {
  const { grid, env } = world();
  const count = () => env.ocean.reduce((a, b) => a + b, 0);
  const before = count();
  env.seaLevel = env.seaLevel0 + env.relief * 0.3;
  classifyEnvironment(grid, env);
  assert.ok(count() > before);
  for (let i = 0; i < env.count; i++) if (env.ocean[i]) assert.equal(env.water[i], 1);
});

test('cyclones form over warm tropical sea, move, and fade over land', async () => {
  const { createStormSystem, stormCategory } = await import('../life/planetStorms.js');
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 6, settings: { temperature: 20 } });
  sim.step(1);
  const system = createStormSystem({ random: createRandomForTest(4) });
  for (let n = 0; n < 400 && !system.formed; n++) system.update(sim, 0.5, 3);
  assert.ok(system.formed > 0, 'no cyclone formed');
  const storm = system.storms[0];
  assert.ok(sim.env.ocean[sim.nearestCell(storm.dir)]);
  const start = [...storm.dir];
  system.update(sim, 2, 0);
  assert.notDeepEqual(storm.dir, start);
  const [cloud] = system.forClouds();
  assert.equal(cloud.axis[0], -storm.dir[0]);
  assert.ok(cloud.eye > 0 && cloud.eye < 0.2);
  assert.equal(stormCategory(0.2), 0);
  assert.equal(stormCategory(1), 5);
});

function createRandomForTest(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('rain-weighted erosion cuts more where more rain falls', async () => {
  const { erodeSphericalTerrain } = await import('../../noise/studio-erosion.js');
  const side = 257, width = side - 1;
  const base = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    base[y * side + x] = 0.3 * Math.sin(Math.PI * y / width) + 0.04 * Math.sin(x * 0.4) * Math.cos(y * 0.3);
  }
  const uniform = erodeSphericalTerrain(base.slice(), side, 0.5);
  const rain = new Float32Array(width * (side - 2));
  for (let i = 0; i < rain.length; i++) rain[i] = (i % width) < width / 2 ? 3 : 0.05;
  const weighted = erodeSphericalTerrain(base.slice(), side, 0.5, rain);
  const change = (values, wet) => {
    let sum = 0;
    for (let y = 1; y < width; y++) for (let x = 0; x < width; x++) {
      if ((x < width / 2) === wet) sum += Math.abs(values[y * side + x] - base[y * side + x]);
    }
    return sum;
  };
  assert.ok(change(weighted, true) > change(weighted, false) * 1.5, 'wet half should erode more than the dry half');
  assert.ok(change(uniform, true) > 0, 'uniform rain still erodes');
});

test('impacts raise a dust plume that drifts, cools and darkens, then clears', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 4, settings: { meteorRate: 0 } });
  for (let t = 0; t < 20; t++) sim.step(1);
  const before = sim.state.globalTemperature;
  const record = sim.impact({ dir: [1, 0, 0], size: 1.2 });
  assert.ok(sim.dust[record.cell] > 1, 'plume over the crater');
  const cell = record.cell, cold = sim.temperature[cell];
  sim.step(1);
  assert.ok(sim.temperature[cell] < cold, 'dust cools the ground beneath it');
  assert.ok(sim.state.globalTemperature < before, 'veil cools the planet');
  const spread = Array.from(sim.dust).filter(v => v > 0.01).length;
  sim.step(1);
  assert.ok(Array.from(sim.dust).filter(v => v > 0.01).length >= spread * 0.8, 'wind carries the dust on');
  for (let t = 0; t < 60; t++) sim.step(1);
  assert.ok(sim.state.dust < 0.002 && sim.state.veil < 0.01, 'dust settles out');
});

test('lightning strikes only where storms or impact plumes are', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 6, settings: { meteorRate: 0, storms: 3 } });
  for (let t = 0; t < 200; t++) sim.step(1);
  const before = sim.state.strikes;
  const rainAtStrike = [];
  for (let t = 0; t < 200; t++) {
    const seen = sim.state.strikes;
    sim.step(1);
    for (const strike of sim.strikes.slice(-(sim.state.strikes - seen) || sim.strikes.length)) if (strike.time === sim.state.time) rainAtStrike.push(sim.rain[strike.cell]);
  }
  assert.ok(sim.state.strikes > before, 'storms still strike');
  const mean = Array.from(sim.rain).reduce((a, b) => a + b, 0) / sim.rain.length;
  const struck = rainAtStrike.reduce((a, b) => a + b, 0) / rainAtStrike.length;
  assert.ok(struck > 1.5 * mean, `strikes fall under heavy rain (${struck.toFixed(3)} vs mean ${mean.toFixed(3)})`);
  assert.ok(rainAtStrike.every(r => r > 0), 'no strikes from a clear sky');
});

test('different lifeforms can share a place and density varies', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 9 });
  for (let t = 0; t < 800; t++) sim.step(1);
  let shared = 0, occupied = 0;
  const totals = [];
  for (let c = 0; c < grid.count; c++) {
    const here = [];
    for (let k = c * sim.slots; k < (c + 1) * sim.slots; k++) if (sim.lineageOf[k] >= 0) here.push(sim.lineageOf[k]);
    if (here.length) { occupied++; totals.push(sim.cellBiomass(c)); }
    if (here.length > 1) {
      shared++;
      assert.notEqual(here[0], here[1], 'one lineage never fills two slots of a place');
    }
  }
  assert.ok(shared > 0.05 * occupied, `overlapping colonies (${shared} of ${occupied})`);
  totals.sort((a, b) => a - b);
  assert.ok(totals.at(-1) > 3 * totals[Math.floor(totals.length * 0.1)], 'dense and sparse places both exist');
});

test('craters dig in stages and carry into the procedural guide', async () => {
  const { prepareCrater, digCrater } = await import('../life/planetCraters.js');
  const side = 513, area = side * side;
  const values = new Float32Array(area);
  for (let i = 0; i < area; i++) values[i] = 0.02 * Math.sin(i * 0.37) + 0.1;
  const atlas = { side, values, guide: new Float32Array(2 * area) };
  const crater = prepareCrater(atlas, { dir: [0.3, 0.2, 0.93], size: 0.9, id: 3 }, 7);
  // Volume removed from the crater footprint.
  const depthAt = () => { let sum = 0; crater.index.forEach((i, n) => { sum += values[i] - crater.original[n]; }); return sum; };
  digCrater(atlas, crater, 0.3);
  const shallow = depthAt();
  digCrater(atlas, crater, 1);
  const deep = depthAt();
  assert.ok(deep < shallow, 'the bowl deepens as it is dug');
  let drift = 0;
  for (let n = 0; n < crater.index.length; n++) {
    const i = crater.index[n];
    drift = Math.max(drift, Math.abs(atlas.guide[area + i] - (values[i] - crater.original[n])));
  }
  assert.ok(drift < 1e-5, 'the procedural guide gets the same change as the heights');
});

test('only mutants that take hold count as species, and the run keeps a population history', () => {
  const { grid, env } = world(3);
  const sim = createLifeSim({ grid, env, seed: 4 });
  for (let t = 0; t < 400; t++) sim.step(1);
  const living = sim.lineages.filter(l => l.extinct === null);
  assert.equal(sim.state.alive, living.filter(l => l.established).length);
  assert.ok(sim.state.established < sim.lineages.length, 'one-colony mutants should not count');
  for (const l of sim.lineages) if (l.established && l.parent !== null) assert.ok(l.peak >= 3);
  const { history } = sim.state;
  assert.ok(history.length >= 40);
  const last = history.at(-1);
  assert.ok(last.colonies > 0 && last.biomass > 0 && last.alive > 0);
  assert.ok(last.traits.photo >= 0 && last.traits.photo <= 1);
  assert.equal(sim.state.colonies, sim.lineageOf.filter(l => l >= 0).length);
});

test('a giant impact crashes the population, which then recovers', () => {
  const { grid, env } = world(3);
  const sim = createLifeSim({ grid, env, seed: 4 });
  for (let t = 0; t < 500; t++) sim.step(1);
  const before = sim.state.colonies;
  sim.impact({ size: 1.5 });
  let low = Infinity;
  for (let t = 0; t < 15; t++) { sim.step(1); low = Math.min(low, sim.state.colonies); }
  for (let t = 0; t < 150; t++) sim.step(1);
  assert.ok(low < 0.8 * before, `crash ${before} -> ${low}`);
  assert.ok(sim.state.colonies > 1.3 * low, `recovery ${low} -> ${sim.state.colonies}`);
});
