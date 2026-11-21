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
  assert.ok(values[at] < before[at] - 0.05, 'crater floor should be lower than the old ground');
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
