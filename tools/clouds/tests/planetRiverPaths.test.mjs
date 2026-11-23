import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiverPaths, indexRiverCells, meanderAmplitude, RIVER_SLOTS, PATH_POINTS, PATH_VEC4, reachPoint, riverNode, traceReach, writeRiverPath } from '../life/planetRiverPaths.js';
import { createCellGrid, createEnvironment, createLifeSim } from '../life/planetLifeSim.js';
import { riverWidth } from '../life/planetWater.js';

const R = 262144;
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const angle = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));

// Two points 18 km apart on the equator, and a valley that bows north of the
// straight line between them by up to 4 km.
const A = unit([1, 0, 0]);
const B = unit([Math.cos(18000 / R), 0, Math.sin(18000 / R)]);
const valleyLat = lon => (4000 / R) * Math.sin(Math.PI * lon / (18000 / R));
const valley = ([x, y, z]) => {
  const lon = Math.atan2(z, x), lat = Math.asin(y);
  return 1000 * Math.min(1, Math.abs(lat - valleyLat(lon)) * R / 3000) - 20 * lon * R / 1000;
};

test('a reach follows the valley floor, not the straight line between cells', () => {
  const offsets = traceReach(A, B, valley, 1000);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[PATH_POINTS - 1], 0);
  let straight = 0, traced = 0, worst = 0;
  for (let k = 1; k < PATH_POINTS - 1; k++) {
    const t = k / (PATH_POINTS - 1);
    const p = reachPoint(A, B, t, offsets[k]);
    straight += valley(reachPoint(A, B, t, 0));
    traced += valley(p);
    worst = Math.max(worst, Math.abs(Math.asin(p[1]) - valleyLat(Math.atan2(p[2], p[0]))) * R);
  }
  assert.ok(traced < 0.35 * straight, `traced ${traced} vs straight ${straight}`);
  // Within about one lane (1.1 km) of the valley line everywhere.
  assert.ok(worst < 1300, `${worst} m off the valley`);
});

test('a river node moves to the lowest ground near its cell', () => {
  const pit = unit([1, 0.01, 0.003]);
  const height = d => angle(d, pit);
  const node = riverNode(unit([1, 0, 0]), 0.02, height);
  assert.ok(angle(node, pit) < angle(unit([1, 0, 0]), pit));
  assert.ok(angle(node, [1, 0, 0]) <= 0.02 + 1e-9);
});

test('meanders are widest on flat ground and fade on steep ground', () => {
  assert.ok(meanderAmplitude(100, 0.0005) > 110);
  assert.ok(meanderAmplitude(100, 0.05) < 40);
  assert.ok(meanderAmplitude(100, NaN) > 0);
});

function world(count = 1600) {
  const grid = createCellGrid(count);
  const sample = ([x, y, z]) => {
    const h = Math.sin(3 * x + 5) * Math.cos(2 * y) + 0.5 * Math.sin(5 * z + 6.5) + 0.15 * Math.sin(17 * x + 9 * y) * Math.cos(13 * z);
    return { height: h * 3000, depth: h < 0.1 ? (0.1 - h) * 3000 : 0, volcanic: 0 };
  };
  const env = createEnvironment(grid, { sample, radius: R, climate: [0.1, 0.99, 0, 0.9], seed: 5 });
  const height = d => { const s = sample(d); return s.height - s.depth; };
  return { grid, env, height };
}

test('traced rivers join end to end and every reach meanders whole wavelengths', () => {
  const { grid, env, height } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: { abiogenesis: 0, meteorRate: 0, panspermia: 0 } });
  for (let t = 0; t < 4; t++) sim.step(1);
  const { water } = sim;
  const drawn = i => !env.ocean[i] && water.lakeCover[i] <= 0.5 && water.shown[i] >= 0 && water.discharge[i] * water.toM3s >= 5;
  const rivers = i => drawn(i) ? water.shown[i] : -1;
  const sea = i => !!env.ocean[water.shown[i]];
  const paths = createRiverPaths({ budgetMs: 1e9 });
  paths.update({ grid, rivers, sea, height, relief: env.relief });
  const out = new Float32Array(grid.count * PATH_VEC4 * 4);
  let reaches = 0, joined = 0;
  for (let i = 0; i < grid.count; i++) {
    if (!drawn(i)) continue;
    reaches++;
    const r = water.shown[i];
    writeRiverPath(paths, out, i, r, sea(i), riverWidth(water.discharge[i] * water.toM3s), R);
    const o = i * PATH_VEC4 * 4;
    const turns = out[o + (PATH_POINTS - 1) * 4 + 3] / (2 * Math.PI);
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-3 && turns >= 1, `reach ${i} phase ${turns} turns`);
    assert.equal(out[o + 3], 0);
    // Every point lies inside the bounding radius.
    for (let k = 0; k < PATH_POINTS; k++) {
      const d = Math.hypot(out[o + k * 4] - out[o + PATH_POINTS * 4], out[o + k * 4 + 1] - out[o + PATH_POINTS * 4 + 1], out[o + k * 4 + 2] - out[o + PATH_POINTS * 4 + 2]);
      assert.ok(d <= out[o + PATH_POINTS * 4 + 3] + 1e-6);
    }
    if (!sea(i) && drawn(r)) {
      writeRiverPath(paths, out, r, water.shown[r], sea(r), 10, R);
      const e = o + (PATH_POINTS - 1) * 4, s = r * PATH_VEC4 * 4;
      assert.ok(Math.hypot(out[e] - out[s], out[e + 1] - out[s + 1], out[e + 2] - out[s + 2]) < 1e-6, 'reaches meet at the node');
      joined++;
    }
  }
  assert.ok(reaches > 20, `${reaches} rivers`);
  assert.ok(joined > 5);
});

test('tracing keeps to its time budget and finishes over later updates', () => {
  const { grid, env, height } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: { abiogenesis: 0, meteorRate: 0, panspermia: 0 } });
  for (let t = 0; t < 3; t++) sim.step(1);
  const { water } = sim;
  const rivers = i => !env.ocean[i] && water.shown[i] >= 0 && water.discharge[i] * water.toM3s >= 5 ? water.shown[i] : -1;
  const sea = i => !!env.ocean[water.shown[i]];
  let calls = 0;
  // A fake clock that ticks 0.1 ms per call.
  const paths = createRiverPaths({ budgetMs: 1, clock: () => (calls++) * 0.1 });
  let total = 0, updates = 0, n;
  do { n = paths.update({ grid, rivers, sea, height, relief: env.relief }); total += n; updates++; } while (n > 0 && updates < 500);
  assert.ok(updates > 2, 'spread over several updates');
  const want = Array.from({ length: grid.count }, (_, i) => rivers(i) >= 0).filter(Boolean).length;
  assert.equal(total, want);
  // Nothing left to trace: unchanged rivers are not traced again.
  assert.equal(paths.update({ grid, rivers, sea, height, relief: env.relief }), 0);
});

test('every reach is listed at the cells along its course', () => {
  const { grid, env, height } = world();
  const sim = createLifeSim({ grid, env, seed: 3, settings: { abiogenesis: 0, meteorRate: 0, panspermia: 0 } });
  for (let t = 0; t < 4; t++) sim.step(1);
  const { water } = sim;
  const drawn = i => !env.ocean[i] && water.lakeCover[i] <= 0.5 && water.shown[i] >= 0 && water.discharge[i] * water.toM3s >= 5;
  const sea = i => !!env.ocean[water.shown[i]];
  const paths = createRiverPaths({ budgetMs: 1e9 });
  paths.update({ grid, rivers: i => drawn(i) ? water.shown[i] : -1, sea, height, relief: env.relief });
  const out = new Float32Array(grid.count * PATH_VEC4 * 4);
  const reaches = [];
  for (let i = 0; i < grid.count; i++) if (drawn(i)) { writeRiverPath(paths, out, i, water.shown[i], sea(i), 20, R); reaches.push(i); }
  // A coarse texel map: the three nearest cells of each texel centre.
  const W = 128, H = 64, cells = new Uint32Array(W * H * 3), d = grid.dirs;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI, lat = (0.5 - (y + 0.5) / H) * Math.PI;
    const p = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
    const near = Array.from({ length: grid.count }, (_, j) => [-(d[j * 3] * p[0] + d[j * 3 + 1] * p[1] + d[j * 3 + 2] * p[2]), j]).sort((a, b) => a[0] - b[0]);
    for (let n = 0; n < 3; n++) cells[(y * W + x) * 3 + n] = near[n][1];
  }
  indexRiverCells(out, reaches, water.discharge, cells, W, H, grid.count);
  const listed = c => Array.from(out.subarray((c * PATH_VEC4 + PATH_POINTS + 2) * 4, (c + 1) * PATH_VEC4 * 4));
  let found = 0;
  for (const i of reaches) {
    // The texel under the middle of the course lists it in one of its cells.
    const m = i * PATH_VEC4 * 4 + 5 * 4;
    const u = Math.atan2(out[m + 2], out[m]) / (2 * Math.PI) + 0.5, v = 0.5 - Math.asin(out[m + 1]) / Math.PI;
    const t = Math.floor(v * H) * W + Math.min(W - 1, Math.floor(u * W));
    if ([0, 1, 2].some(n => listed(cells[t * 3 + n]).includes(i))) found++;
  }
  assert.ok(found >= 0.97 * reaches.length, `${found} of ${reaches.length}`);
  assert.equal(listed(0).length, RIVER_SLOTS);
});
