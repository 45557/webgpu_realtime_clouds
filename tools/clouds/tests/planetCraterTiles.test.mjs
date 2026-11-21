import test from 'node:test';
import assert from 'node:assert/strict';
import { carveCrater, craterSize, uploadAroundCraters } from '../life/planetCraters.js';

function atlas(side = 513) {
  const values = new Float32Array(side * side);
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) {
    const t = r / (side - 1) * Math.PI, p = c / (side - 1) * 2 * Math.PI;
    values[r * side + c] = 0.02 * (Math.sin(3 * p) * Math.sin(2 * t) + 0.5 * Math.sin(7 * p + 1) * Math.cos(5 * t));
  }
  return { side, values };
}

const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

// uploadAroundCraters keeps tiles further than 3.5 crater radii (+0.01) from
// a crater, so carving must never change ground beyond that.
test('a carved crater stays inside the reach used to keep terrain tiles', () => {
  for (const [dir, size] of [[[0.3, 0.8, 0.52], 0.2], [[-0.7, -0.1, 0.7], 0.8], [[0.05, -0.99, 0.1], 1.2]]) {
    const map = atlas(), before = map.values.slice();
    const l = Math.hypot(...dir), c = dir.map(v => v / l);
    assert.ok(carveCrater(map, { dir: c, size, id: 3 }, 7) > 0);
    const reach = 3.5 * craterSize(size) + 0.01, span = map.side - 1;
    for (let row = 0; row < map.side; row++) for (let col = 0; col < map.side; col++) {
      const i = row * map.side + col;
      if (map.values[i] === before[i]) continue;
      const theta = row * Math.PI / span, phi = col * 2 * Math.PI / span;
      const p = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      assert.ok(angle(p, c) < reach, `texel ${row},${col} changed ${angle(p, c).toFixed(4)} rad from the crater (reach ${reach.toFixed(4)})`);
    }
  }
});

// A cube-face tile spans at most size·√2/2 radians from its centre.
test('cube tiles fit inside the tile reach', () => {
  const faceDir = (u, v) => { const l = Math.hypot(1, u, v); return [1 / l, u / l, v / l]; };
  for (const level of [0, 1, 3, 6]) {
    const size = 2 / 2 ** level;
    for (let x = 0; x < Math.min(2 ** level, 8); x++) {
      const u0 = x * size - 1, v0 = -1, centre = faceDir(u0 + size / 2, v0 + size / 2);
      for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
        assert.ok(angle(faceDir(u0 + size * a / 4, v0 + size * b / 4), centre) <= size * 0.75);
      }
    }
  }
});

test('only tiles near a crater are retired; their slots stay unique', () => {
  const slots = new Map([[1, 0], [2, 1], [3, 2], [4, 3]]);
  const cache = { slots, clear() { slots.clear(); } };
  const tiles = [
    { key: 1, dir: [0, 1, 0], size: 0.05 },
    { key: 2, dir: [1, 0, 0], size: 0.05 },
    { key: 3, dir: [0, 0, 1], size: 0.05 },
  ];
  let uploads = 0;
  const world = { tileCache: cache, state: tiles, studioMap: {}, studioSeed: 1, uploadStudioMap() { this.tileCache.clear(); this.state = null; uploads++; } };
  uploadAroundCraters(world, [{ dir: [0, 1, 0], reach: 0.05 }]);
  assert.equal(uploads, 1);
  assert.equal(slots.get(2), 1);
  assert.equal(slots.get(3), 2);
  assert.equal(slots.has(1), false, 'tile under the crater is rebuilt');
  assert.equal(slots.has(4), false, 'off-screen tile is retired');
  assert.deepEqual([...slots.values()].sort(), [0, 1, 2, 3]);
  cache.clear();
  assert.equal(slots.size, 0, 'the cache keeps its own clear()');
  // Without tile data it falls back to a full upload.
  const plain = { studioMap: {}, uploadStudioMap() { uploads++; } };
  uploadAroundCraters(plain, []);
  assert.equal(uploads, 2);
});
