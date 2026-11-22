import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atlasLod, atlasLodState, createAtlasLodCache } from '../life/planetAtlasLod.js';
import { carveCrater } from '../life/planetCraters.js';

// The renderer's own low-detail builder, taken from the vendored bundle.
function rendererLod() {
  const bundle = readFileSync(new URL('../../planet/planet-approach.esm.js', import.meta.url), 'utf8');
  const start = bundle.indexOf('function ar({side:i,values:e})');
  assert.ok(start >= 0, 'renderer low-detail builder not found');
  const source = bundle.slice(start, bundle.indexOf('return s}', start) + 9);
  return new Function(`${source}; return ar;`)();
}

function atlas(side) {
  const values = new Float32Array(side * side);
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) {
    const t = r / (side - 1) * Math.PI, p = c / (side - 1) * 2 * Math.PI;
    values[r * side + c] = 0.02 * (Math.sin(3 * p) * Math.sin(2 * t) + 0.5 * Math.sin(7 * p + 1) * Math.cos(5 * t)) + 0.001 * Math.sin(r * 13.1 + c * 7.7);
  }
  return { side, values };
}

test('the low-detail grid matches the renderer exactly', () => {
  const ar = rendererLod();
  for (const side of [129, 513, 1025]) {
    const map = atlas(side);
    assert.deepEqual(atlasLod(map), ar(map));
  }
});

test('updating only the crater rows gives the same grid as a full rebuild', () => {
  const ar = rendererLod(), map = atlas(513), cache = createAtlasLodCache();
  cache.get(map, 0, map.side - 1);
  for (const [dir, size] of [[[0.3, 0.8, 0.52], 0.5], [[0.05, -0.99, 0.1], 1.2], [[0.01, 0.9999, 0], 0.9]]) {
    const before = map.values.slice();
    carveCrater(map, { dir: dir.map(v => v / Math.hypot(...dir)), size, id: 2 }, 5);
    let first = map.side, last = -1;
    for (let i = 0; i < before.length; i++) if (before[i] !== map.values[i]) { const row = Math.floor(i / map.side); first = Math.min(first, row); last = Math.max(last, row); }
    assert.ok(last >= first);
    assert.deepEqual(cache.get(map, first, last), ar(map));
  }
});

test('an atlas changed outside the given rows is rebuilt in full', () => {
  const ar = rendererLod(), map = atlas(257), cache = createAtlasLodCache();
  cache.get(map, 0, 0);
  // A broad edit elsewhere (the fingerprint samples every 8th row).
  for (let i = 96 * 257; i < 106 * 257; i++) map.values[i] += 0.01;
  assert.deepEqual(cache.get(map, 5, 6), ar(map));
  const state = atlasLodState(map);
  assert.equal(cache.set(map, state.lod, state.rows), state.lod);
  map.values[3 * 257 + 4] += 0.5;
  assert.deepEqual(cache.get(map, 3, 3), ar(map));
});
