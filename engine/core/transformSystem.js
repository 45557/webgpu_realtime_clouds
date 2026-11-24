// Computes WorldMatrix for every Transform, parents first.
import { mat4FromTRS, mat4Mul } from './math.js';

/** @param {import('../ecs/world.js').World} world */
export function updateWorldMatrices(world) {
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return world.get(id, 'WorldMatrix')?.matrix;
    done.add(id);
    const t = world.get(id, 'Transform');
    let m = mat4FromTRS(t.position, t.rotation, t.scale);
    const parent = world.parentOf(id);
    if (parent !== undefined && world.has(parent, 'Transform')) m = mat4Mul(visit(parent), m);
    const wm = world.get(id, 'WorldMatrix');
    if (wm) wm.matrix = m; else world.add(id, 'WorldMatrix', { matrix: m });
    return m;
  };
  for (const id of world.query('Transform')) visit(id);
}
