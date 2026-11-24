// Scene <-> JSON. Only non-default fields are written; runtime components are skipped.
import { componentType, makeComponent } from '../ecs/world.js';

export const SCENE_FORMAT = 'clouds3-scene';
export const SCENE_VERSION = 1;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @param {import('../ecs/world.js').World} world */
export function saveScene(world) {
  const entities = [];
  for (const [id, uuid] of world.entities) {
    const components = {};
    for (const [name, store] of world.stores) {
      if (!store.has(id)) continue;
      const type = componentType(name);
      if (!type || type.runtime) continue;
      const value = store.get(id);
      const defaults = makeComponent(name);
      const out = {};
      for (const key of Object.keys(value)) if (!same(value[key], defaults[key])) out[key] = value[key];
      components[name] = out;
    }
    entities.push({ uuid, components });
  }
  return { format: SCENE_FORMAT, version: SCENE_VERSION, entities };
}

/**
 * Add the entities of a scene JSON to `world`. Returns the created ids.
 * @param {import('../ecs/world.js').World} world
 */
export function loadScene(world, scene) {
  if (scene?.format !== SCENE_FORMAT) throw new Error('Not a clouds3 scene file');
  if (scene.version > SCENE_VERSION) throw new Error(`Scene version ${scene.version} is newer than this engine`);
  const ids = [];
  for (const entry of scene.entities) {
    const id = world.create(entry.uuid);
    for (const [name, data] of Object.entries(entry.components ?? {})) {
      if (!componentType(name)) { console.warn(`Skipping unknown component ${name}`); continue; }
      world.add(id, name, data);
    }
    ids.push(id);
  }
  return ids;
}
