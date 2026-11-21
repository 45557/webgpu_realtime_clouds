import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEnvironment, createCellGrid, createEnvironment, createLifeSim, genomeTags, GENES, stormFactor,
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
  assert.equal(sim.lineageOf[record.cell], -1);
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
