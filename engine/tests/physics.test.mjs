import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../ecs/world.js';
import '../core/components.js';
import { Physics, initRapier } from '../physics/physics.js';
import { terrainHeight } from '../../tools/clouds/cloudTerrainMesh.js';

async function makeWorld() {
  await initRapier();
  const w = new World();
  const t = w.create('terrain');
  w.add(t, 'Terrain');
  const physics = new Physics(w);
  return { w, physics };
}

test('terrain collider follows the visible basin mesh', async () => {
  const { physics } = await makeWorld();
  physics.step(1 / 60);
  for (const [x, z] of [[0, 0], [40, 10], [-30, 55], [70, -70]]) {
    const hit = physics.raycast([x, 200, z], [0, -1, 0]);
    assert.ok(hit, `no ground at ${x},${z}`);
    assert.ok(Math.abs(hit.point[1] - terrainHeight(x, z)) < 1.5, `at ${x},${z}: ${hit.point[1]} vs ${terrainHeight(x, z)}`);
  }
});

test('a character falls onto the terrain, stands, walks and climbs a slope', async () => {
  const { w, physics } = await makeWorld();
  const p = w.create('player');
  w.add(p, 'Transform', { position: [0, 10, 0] });
  w.add(p, 'CharacterController');
  physics.sync();
  let grounded = false;
  for (let i = 0; i < 240; i++) { ({ grounded } = physics.moveCharacter(p, [0, 0, 0], 1 / 60)); physics.step(1 / 60); }
  const pos = w.get(p, 'Transform').position;
  const feet = pos[1] - 0.45 - 0.35;
  assert.ok(grounded, 'should be grounded');
  assert.ok(Math.abs(feet - terrainHeight(0, 0)) < 0.2, `feet ${feet}, ground ${terrainHeight(0, 0)}`);
  // Walk toward the rim for 6 seconds at 5 units/s.
  for (let i = 0; i < 360; i++) { physics.moveCharacter(p, [0, 0, 5], 1 / 60); physics.step(1 / 60); }
  const after = w.get(p, 'Transform').position;
  assert.ok(after[2] > 20, `moved to z=${after[2]}`);
  const ground = physics.raycast([after[0], after[1] + 5, after[2]], [0, -1, 0], 50, p);
  assert.ok(ground && after[1] - ground.point[1] < 1.2, 'stays on the ground while walking');
});

test('dynamic boxes fall and rest on the terrain', async () => {
  const { w, physics } = await makeWorld();
  const b = w.create('box');
  w.add(b, 'Transform', { position: [5, 5, 5] });
  w.add(b, 'RigidBody');
  w.add(b, 'Collider', { size: [0.5, 0.5, 0.5] });
  for (let i = 0; i < 300; i++) physics.step(1 / 60);
  const y = w.get(b, 'Transform').position[1];
  assert.ok(Math.abs(y - 0.5 - terrainHeight(5, 5)) < 0.3, `box y ${y}, ground ${terrainHeight(5, 5)}`);
});
