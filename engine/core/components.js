// Core component types. Importing this module registers them.
import { defineComponent } from '../ecs/world.js';

export const Name = defineComponent('Name', { value: { type: 'string', default: 'Entity' } });
export const Parent = defineComponent('Parent', { parent: { type: 'entity' } });
export const Transform = defineComponent('Transform', {
  position: { type: 'vec3', default: [0, 0, 0] },
  rotation: { type: 'quat', default: [0, 0, 0, 1] },
  scale: { type: 'vec3', default: [1, 1, 1] },
});
/** Computed every frame by the transform system. Not saved. */
export const WorldMatrix = defineComponent('WorldMatrix', { matrix: { type: 'json' } }, { runtime: true });

export const MeshRenderer = defineComponent('MeshRenderer', {
  /** Asset path of a .glb/.gltf, or a built-in mesh such as "builtin:capsule". */
  mesh: { type: 'asset', default: '' },
  color: { type: 'color', default: [1, 1, 1, 1] },
  visible: { type: 'bool', default: true },
});

export const Camera = defineComponent('Camera', {
  fovYDeg: { type: 'number', default: 60, min: 10, max: 120 },
  active: { type: 'bool', default: true },
});

export const DirectionalLight = defineComponent('DirectionalLight', {
  azimuthDeg: { type: 'number', default: 45 },
  elevationDeg: { type: 'number', default: 28, min: -10, max: 90 },
  color: { type: 'color', default: [1, 0.97, 0.9, 1] },
});

export const Terrain = defineComponent('Terrain', {
  source: { type: 'enum', default: 'flat-basin', options: ['flat-basin'] },
  collisionResolution: { type: 'int', default: 513, min: 33, max: 2049 },
});

export const CloudLayer = defineComponent('CloudLayer', {
  enabled: { type: 'bool', default: true },
  coverage: { type: 'number', default: 1, min: 0, max: 2 },
  density: { type: 'number', default: 1000, min: 0, max: 4000 },
  /** World height added to the cloud deck (FLAT_TERRAIN_CLOUD_LIFT is 6 in the demo). */
  heightOffset: { type: 'number', default: 6 },
  cloudScale: { type: 'number', default: 4, min: 1, max: 32 },
  /** Render scale divider: 1 = full resolution. */
  renderScale: { type: 'int', default: 3, min: 1, max: 6 },
  exposure: { type: 'number', default: 1.18 },
  sky: { type: 'color', default: [0.60, 0.75, 0.98, 1] },
});

export const RigidBody = defineComponent('RigidBody', {
  kind: { type: 'enum', default: 'dynamic', options: ['dynamic', 'kinematic', 'static'] },
  mass: { type: 'number', default: 1 },
  linearDamping: { type: 'number', default: 0.05 },
  angularDamping: { type: 'number', default: 0.05 },
});

export const Collider = defineComponent('Collider', {
  shape: { type: 'enum', default: 'box', options: ['box', 'sphere', 'capsule'] },
  /** box: half extents. sphere: [radius]. capsule: [radius, halfHeight]. */
  size: { type: 'vec3', default: [0.5, 0.5, 0.5] },
  friction: { type: 'number', default: 0.7 },
  restitution: { type: 'number', default: 0.1 },
  isTrigger: { type: 'bool', default: false },
});

export const CharacterController = defineComponent('CharacterController', {
  radius: { type: 'number', default: 0.35 },
  halfHeight: { type: 'number', default: 0.45 },
  maxSlopeDeg: { type: 'number', default: 50 },
  stepHeight: { type: 'number', default: 0.35 },
  snapToGround: { type: 'number', default: 0.4 },
});

export const Script = defineComponent('Script', {
  /** Registered script name (milestone 1) or project path (milestone 2). */
  name: { type: 'string', default: '' },
  params: { type: 'json', default: {} },
});
