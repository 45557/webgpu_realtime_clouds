import test from 'node:test';
import assert from 'node:assert/strict';
import { createCellGrid, createEnvironment, createLifeSim, HABITATS } from '../life/planetLifeSim.js';
import { iceSheetVolume, moonDistance, riverWidth, seaLevelFromIce, tidalRange, WATER_UNIT_M_PER_YR } from '../life/planetWater.js';

const R = 262144;
// A planet in metres: two seas, continents with ridges, and (optionally) a
// closed bowl in the middle of a continent.
function world({ seed = 5, bowl = false, count = 1600 } = {}) {
  const grid = createCellGrid(count);
  const sample = ([x, y, z]) => {
    let h = Math.sin(3 * x + seed) * Math.cos(2 * y) + 0.5 * Math.sin(5 * z + 1.3 * seed) + 0.15 * Math.sin(17 * x + 9 * y) * Math.cos(13 * z);
    if (bowl) {
      // An island in a wide sea with a closed basin 600 m deep inside its rim.
      const d = Math.acos(Math.max(-1, Math.min(1, x * 0.6 + y * 0.5 + z * 0.62)));
      h = d > 0.6 ? -0.4 : d < 0.22 ? 0.3 + 0.2 * (d / 0.22) ** 2 : d < 0.32 ? 0.5 : 0.5 - 1.4 * (d - 0.32);
    }
    return { height: h * 3000, depth: h < 0.1 ? (0.1 - h) * 3000 : 0, volcanic: 0 };
  };
  const env = createEnvironment(grid, { sample, radius: R, climate: [0.1, 0.99, 0, 0.9], seed });
  return { grid, env };
}
const sum = a => a.reduce((s, v) => s + v, 0);
const lifeless = { abiogenesis: 0, meteorRate: 0, panspermia: 0 };

test('water balance: the planet rains out what evaporates, every step', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 3; t++) sim.step(1);
  for (let t = 0; t < 5; t++) {
    sim.step(1);
    const evaporation = sim.state.evaporation, rainfall = sim.state.rainfall;
    assert.ok(evaporation > 0.05);
    assert.ok(Math.abs(rainfall - evaporation) / evaporation < 0.01, `step ${t}: rain ${rainfall} vs evaporation ${evaporation}`);
  }
});

test('the water cycle settles within a step after a sudden change', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 10; t++) sim.step(1);
  // A sudden 15 °C warming (say, after a big impact's greenhouse).
  sim.setSettings({ temperature: 15 });
  sim.step(1);
  const first = Float32Array.from(sim.rain), ground = Float32Array.from(sim.groundwater);
  for (let t = 0; t < 30; t++) sim.step(1);
  const diff = (a, b) => sum(Array.from(a, (v, i) => Math.abs(v - b[i]))) / Math.max(1e-9, sum(Array.from(b)));
  assert.ok(diff(first, sim.rain) < 0.03, `rain still moving: ${diff(first, sim.rain)}`);
  assert.ok(diff(ground, sim.groundwater) < 0.05, `groundwater still moving: ${diff(ground, sim.groundwater)}`);
});

test('rivers: discharge grows downstream and reaches the sea', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 5; t++) sim.step(1);
  const { water } = sim;
  let checked = 0;
  for (let i = 0; i < grid.count; i++) {
    const r = water.receiver[i];
    if (env.ocean[i] || r < 0 || env.ocean[r] || water.lakeCover[r] > 0.5 || water.lakeCover[i] > 0.5) continue;
    if (water.lakes.some(l => l.pour === r)) continue;
    assert.ok(water.discharge[r] >= water.discharge[i] - 1e-6, `cell ${i} → ${r}`);
    checked++;
  }
  assert.ok(checked > 100);
  // The biggest river mouth carries real water: tens to thousands of m³/s.
  const biggest = Math.max(...water.mouth) * water.toM3s;
  assert.ok(biggest > 10 && biggest < 1e5, `largest mouth ${biggest} m³/s`);
  assert.ok(riverWidth(biggest) > 20);
  assert.ok(Math.abs(riverWidth(100) - 72) < 1e-9);
  assert.ok(WATER_UNIT_M_PER_YR > 1 && WATER_UNIT_M_PER_YR < 5);
});

test('lakes: a closed basin fills in a wet climate and turns to a salt lake in a dry one', () => {
  const run = settings => {
    const { grid, env } = world({ bowl: true });
    const sim = createLifeSim({ grid, env, seed: 3, settings: { ...lifeless, ...settings } });
    for (let t = 0; t < 20; t++) sim.step(1);
    const lake = sim.water.lakes.reduce((a, b) => (!a || b.cells.length > a.cells.length ? b : a), null);
    return { sim, env, lake };
  };
  const wet = run({ temperature: -12 });
  assert.ok(wet.lake && wet.lake.cells.length >= 5, 'the bowl should be a lake basin');
  const keys = Object.keys(HABITATS);
  const kinds = l => new Set(Array.from(l.cells, i => keys[l === wet.lake ? wet.env.habitat[i] : dry.env.habitat[i]]));
  const dry = run({ temperature: 22 });
  const wetFill = wet.lake.fill, dryFill = dry.lake.fill;
  assert.ok(wetFill > dryFill, `wet fill ${wetFill} should beat dry fill ${dryFill}`);
  if (wet.lake.open) assert.ok(kinds(wet.lake).has('lake'));
  assert.equal(dry.lake.open, false, 'a hot dry basin has no outlet');
  assert.ok(Math.max(...Array.from(dry.lake.cells, i => dry.sim.water.salt[i])) > 0.4, 'closed lakes grow salty');
});

test('ice sheets: Earth\'s last glacial maximum lowers the sea about 120 m', () => {
  // North American (16 million km²) and Eurasian (7 million km²) sheets
  // over a 361 million km² ocean.
  const volume = iceSheetVolume(16e6) + iceSheetVolume(7e6);
  const drop = seaLevelFromIce(volume, 3.61e8);
  assert.ok(drop < -100 && drop > -140, `sea level change ${drop} m`);
  // Laurentide-sized sheets come out about 2 km thick on average.
  const thickness = iceSheetVolume(13e6) / 13e6;
  assert.ok(thickness > 1.5 && thickness < 3, `${thickness} km`);
});

test('a colder climate grows ice sheets and the sea falls; warming raises it', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 5; t++) sim.step(1);
  const start = sim.state.seaLevelM;
  sim.setSettings({ temperature: -20 });
  for (let t = 0; t < 10; t++) sim.step(1);
  assert.ok(sim.state.iceVolume > 0 && sim.state.iceSheetCells > 0);
  assert.ok(sim.state.seaLevelM < start - 5, `cold sea ${sim.state.seaLevelM} m vs ${start} m`);
  assert.ok(Math.max(...sim.water.ice) > 100, 'ice sheets are hundreds of metres thick');
  sim.setSettings({ temperature: 12 });
  for (let t = 0; t < 10; t++) sim.step(1);
  assert.ok(sim.state.seaLevelM > start, 'warm seas expand above the start');
});

test('tides: an early close moon raises big tides that strengthen tidal pools', () => {
  assert.ok(Math.abs(moonDistance(4500) - 60) < 1e-6);
  assert.ok(Math.abs(tidalRange(4500) - 1.5) < 1e-6);
  assert.ok(tidalRange(0) > 20, `early tides ${tidalRange(0)} m`);
  assert.ok(tidalRange(500) > 2 * tidalRange(4500));
  assert.ok(tidalRange(4500, 0) < 0.6, 'without a moon only the sun\'s tide is left');
});

test('upwelling on trade-wind coasts brings up nutrients and cools the sea', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  sim.step(1);
  const { water } = sim;
  const up = [], calm = [];
  for (let i = 0; i < grid.count; i++) {
    if (!env.ocean[i] || env.latitude[i] < 0.1 || env.latitude[i] > 0.5) continue;
    (water.upwelling[i] > 0.5 ? up : calm).push(i);
  }
  assert.ok(up.length > 3, 'some coasts upwell');
  const mean = (cells, a) => sum(cells.map(i => a[i])) / cells.length;
  assert.ok(mean(up, water.nutrient) > mean(calm, water.nutrient) + 0.2);
});

test('a sea impact leaves a hydrothermal system and its water vapour warms after the dust', () => {
  const { grid, env } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 5; t++) sim.step(1);
  const cell = Array.from({ length: grid.count }, (_, i) => i).filter(i => env.ocean[i]).sort((a, b) => env.depth[b] - env.depth[a])[0];
  const dir = Array.from(grid.dirs.subarray(cell * 3, cell * 3 + 3));
  const base = sim.state.globalTemperature;
  // A Chicxulub-class body: 12 km of stone at 20 km/s.
  const record = sim.impact({ dir, impactor: { diameter: 12000, density: 3000, velocity: 20000, angle: Math.PI / 4, type: 'stony', label: 'Stony' } });
  assert.ok(record.physics.craterDiameter > 50000);
  assert.ok(env.hydro[cell] > 0.5, 'the crater floor is hot');
  assert.equal(Object.keys(HABITATS)[env.habitat[cell]], 'vent');
  assert.ok(sim.state.impactVapour > 1);
  sim.step(1);
  assert.ok(sim.state.globalTemperature < base, 'impact winter first');
  for (let t = 0; t < 40; t++) sim.step(1);
  assert.ok(sim.state.impactVapour > 1, 'the vapour lingers after the dust');
  assert.equal(env.hydro[cell], 0, 'the crater has cooled after a few lifetimes');
});

test('a world with no sea still keeps a water cycle going from its ponds and springs', () => {
  const grid = createCellGrid(1600);
  const sample = ([x, y, z]) => ({ height: 3000 * (Math.sin(3 * x + 5) * Math.cos(2 * y) + 0.5 * Math.sin(5 * z + 6.5)), depth: 0, volcanic: Math.max(0, Math.sin(11 * x + 4 * z)) });
  const env = createEnvironment(grid, { sample, radius: R, climate: [0.1, 0.99, 0, 0.9], seed: 5 });
  assert.equal(env.anyOcean, false);
  const sim = createLifeSim({ grid, env, seed: 3, settings: lifeless });
  for (let t = 0; t < 20; t++) sim.step(1);
  assert.ok(sim.state.rainfall > 0.02, `rain ${sim.state.rainfall}`);
  assert.ok(sim.state.groundwater > 0.1);
});
