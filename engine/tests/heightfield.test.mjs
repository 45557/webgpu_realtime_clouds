import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { terrainHeight } from '../../tools/clouds/cloudTerrainMesh.js';
import { sampleHeightGrid, gridHeightAt, toRapierHeightfield } from '../physics/heightfield.js';

const grid = sampleHeightGrid((x, z) => terrainHeight(x, z, 1, 0.75), 192, 513);

const node = (i) => -192 + i * 0.75;

test('grid lookup is exact at nodes and between neighbours elsewhere', () => {
  for (const [i, j] of [[80, 333], [400, 21], [257, 257]]) {
    assert.ok(Math.abs(gridHeightAt(grid, node(i), node(j)) - terrainHeight(node(i), node(j), 1, 0.75)) < 1e-4);
    const h = gridHeightAt(grid, node(i) + 0.3, node(j) + 0.2);
    const around = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([a, b]) => grid.heights[b * 513 + a]);
    assert.ok(h >= Math.min(...around) - 1e-4 && h <= Math.max(...around) + 1e-4);
  }
});

test('Rapier heightfield layout matches the grid (rays hit the same height)', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const hf = toRapierHeightfield(grid);
  world.createCollider(RAPIER.ColliderDesc.heightfield(hf.nrows, hf.ncols, hf.heights, hf.scale));
  world.step();
  // Points away from the symmetric axes, so a transposed layout would fail.
  for (const [x, z] of [[80, 333], [400, 21], [150, 310], [33, 190]].map(([i, j]) => [node(i), node(j)])) {
    const ray = new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 400, true);
    assert.ok(hit, `no hit at ${x},${z}`);
    const y = 200 - hit.timeOfImpact;
    assert.ok(Math.abs(y - gridHeightAt(grid, x, z)) < 0.01, `at ${x},${z}: rapier ${y} grid ${gridHeightAt(grid, x, z)}`);
  }
});
