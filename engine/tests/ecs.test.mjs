import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../ecs/world.js';
import '../core/components.js';
import { saveScene, loadScene } from '../scene/serialize.js';
import { updateWorldMatrices } from '../core/transformSystem.js';
import { quatFromYaw, mat4TransformPoint } from '../core/math.js';

test('components get schema defaults', () => {
  const w = new World();
  const e = w.create();
  const t = w.add(e, 'Transform', { position: [1, 2, 3] });
  assert.deepEqual(t.position, [1, 2, 3]);
  assert.deepEqual(t.scale, [1, 1, 1]);
  assert.throws(() => w.add(e, 'NoSuchComponent'));
});

test('queries track membership changes', () => {
  const w = new World();
  const a = w.create(), b = w.create();
  w.add(a, 'Transform'); w.add(b, 'Transform'); w.add(b, 'MeshRenderer');
  assert.deepEqual(w.query('Transform', 'MeshRenderer'), [b]);
  w.add(a, 'MeshRenderer');
  assert.deepEqual(w.query('Transform', 'MeshRenderer').sort(), [a, b]);
  w.remove(b, 'Transform');
  assert.deepEqual(w.query('Transform', 'MeshRenderer'), [a]);
  w.destroy(a);
  assert.deepEqual(w.query('Transform', 'MeshRenderer'), []);
});

test('destroying a parent destroys its children', () => {
  const w = new World();
  const p = w.create('p'), c = w.create('c');
  w.add(c, 'Parent', { parent: 'p' });
  assert.deepEqual(w.children(p), [c]);
  w.destroy(p);
  assert.equal(w.alive(c), false);
});

test('scene JSON round trip keeps only non-default fields', () => {
  const w = new World();
  const e = w.create('player');
  w.add(e, 'Name', { value: 'Player' });
  w.add(e, 'Transform', { position: [0, 5, 0] });
  w.add(e, 'Script', { name: 'player', params: { speed: 6 } });
  updateWorldMatrices(w);
  const json = saveScene(w);
  assert.deepEqual(json.entities[0].components.Transform, { position: [0, 5, 0] });
  assert.equal(json.entities[0].components.WorldMatrix, undefined);
  const w2 = new World();
  loadScene(w2, JSON.parse(JSON.stringify(json)));
  const id = w2.find('player');
  assert.deepEqual(w2.get(id, 'Transform').position, [0, 5, 0]);
  assert.deepEqual(w2.get(id, 'Script').params, { speed: 6 });
  assert.deepEqual(saveScene(w2), json);
});

test('world matrices compose parent and child transforms', () => {
  const w = new World();
  const p = w.create('p'), c = w.create('c');
  w.add(p, 'Transform', { position: [10, 0, 0], rotation: quatFromYaw(Math.PI / 2) });
  w.add(c, 'Transform', { position: [0, 0, 1] });
  w.add(c, 'Parent', { parent: 'p' });
  updateWorldMatrices(w);
  const point = mat4TransformPoint(w.get(c, 'WorldMatrix').matrix, [0, 0, 0]);
  // Yaw +90 degrees turns +Z into +X in this convention.
  assert.ok(Math.abs(point[0] - 11) < 1e-5 && Math.abs(point[2]) < 1e-5, String(point));
});
