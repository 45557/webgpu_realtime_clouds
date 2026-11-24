// Rapier physics bridge. Bodies are created lazily for entities that have
// RigidBody + Collider, CharacterController, or Terrain components.
import RAPIER from '@dimforge/rapier3d-compat';
import { createTerrainMesh } from '../../tools/clouds/cloudTerrainMesh.js';

let rapierReady = null;
export function initRapier() { return (rapierReady ??= RAPIER.init()); }

/** Collision geometry for a Terrain component: the exact triangles that are drawn. */
export function terrainCollisionMesh(terrain) {
  if (terrain.source !== 'flat-basin') throw new Error(`Unknown terrain source ${terrain.source}`);
  const { vertices, indices } = createTerrainMesh();
  const positions = new Float32Array(vertices.length / 2);
  for (let i = 0, j = 0; i < vertices.length; i += 6, j += 3) {
    positions[j] = vertices[i]; positions[j + 1] = vertices[i + 1]; positions[j + 2] = vertices[i + 2];
  }
  return { positions, indices };
}

export class Physics {
  /** @param {import('../ecs/world.js').World} world */
  constructor(world, { gravity = -18 } = {}) {
    this.world = world;
    this.rapier = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.gravity = gravity;
    /** @type {Map<number, {body?: any, collider: any, controller?: any, kind: string}>} */
    this.handles = new Map();
    this.colliderToEntity = new Map();
    this.events = new RAPIER.EventQueue(true);
    world.on('componentRemoved', ({ id, name }) => {
      if (['RigidBody', 'Collider', 'CharacterController', 'Terrain'].includes(name)) this.release(id);
    });
  }

  release(id) {
    const h = this.handles.get(id);
    if (!h) return;
    this.colliderToEntity.delete(h.collider.handle);
    if (h.controller) this.rapier.removeCharacterController(h.controller);
    if (h.body) this.rapier.removeRigidBody(h.body); else this.rapier.removeCollider(h.collider, false);
    this.handles.delete(id);
  }

  sync() {
    const w = this.world;
    for (const id of w.query('Terrain')) {
      if (this.handles.has(id)) continue;
      const { positions, indices } = terrainCollisionMesh(w.get(id, 'Terrain'));
      const collider = this.rapier.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(0.9));
      this.track(id, { collider, kind: 'terrain' });
    }
    for (const id of w.query('Transform', 'CharacterController')) {
      if (this.handles.has(id)) continue;
      const t = w.get(id, 'Transform'), c = w.get(id, 'CharacterController');
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...t.position));
      const collider = this.rapier.createCollider(RAPIER.ColliderDesc.capsule(c.halfHeight, c.radius), body);
      const controller = this.rapier.createCharacterController(0.02);
      controller.setMaxSlopeClimbAngle(c.maxSlopeDeg * Math.PI / 180);
      controller.setMinSlopeSlideAngle(c.maxSlopeDeg * Math.PI / 180);
      controller.enableAutostep(c.stepHeight, c.radius * 0.5, false);
      controller.enableSnapToGround(c.snapToGround);
      controller.setApplyImpulsesToDynamicBodies(true);
      this.track(id, { body, collider, controller, kind: 'character', velocityY: 0, grounded: false });
    }
    for (const id of w.query('Transform', 'RigidBody', 'Collider')) {
      if (this.handles.has(id)) continue;
      const t = w.get(id, 'Transform'), rb = w.get(id, 'RigidBody'), col = w.get(id, 'Collider');
      const desc = rb.kind === 'static' ? RAPIER.RigidBodyDesc.fixed()
        : rb.kind === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
      desc.setTranslation(...t.position).setRotation({ x: t.rotation[0], y: t.rotation[1], z: t.rotation[2], w: t.rotation[3] })
        .setLinearDamping(rb.linearDamping).setAngularDamping(rb.angularDamping);
      const body = this.rapier.createRigidBody(desc);
      const s = col.size;
      const shape = col.shape === 'sphere' ? RAPIER.ColliderDesc.ball(s[0])
        : col.shape === 'capsule' ? RAPIER.ColliderDesc.capsule(s[1], s[0]) : RAPIER.ColliderDesc.cuboid(s[0], s[1], s[2]);
      shape.setFriction(col.friction).setRestitution(col.restitution).setSensor(col.isTrigger)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      if (rb.kind === 'dynamic') shape.setMass(rb.mass);
      const collider = this.rapier.createCollider(shape, body);
      this.track(id, { body, collider, kind: rb.kind });
    }
  }

  track(id, handle) {
    this.handles.set(id, handle);
    this.colliderToEntity.set(handle.collider.handle, id);
  }

  /**
   * Move a character by a horizontal velocity (units/second) this step.
   * Gravity and jumping are handled here. Returns {grounded}.
   */
  moveCharacter(id, velocity, dt, { jump = 0 } = {}) {
    const h = this.handles.get(id);
    if (!h?.controller) return { grounded: false };
    if (h.grounded && jump > 0) h.velocityY = jump;
    h.velocityY = h.grounded && h.velocityY <= 0 ? -1 : h.velocityY + this.gravity * dt;
    h.controller.computeColliderMovement(h.collider, { x: velocity[0] * dt, y: h.velocityY * dt, z: velocity[2] * dt });
    const m = h.controller.computedMovement();
    h.grounded = h.controller.computedGrounded();
    if (h.grounded && h.velocityY < 0) h.velocityY = 0;
    const p = h.body.translation();
    const next = { x: p.x + m.x, y: p.y + m.y, z: p.z + m.z };
    h.body.setNextKinematicTranslation(next);
    const t = this.world.get(id, 'Transform');
    t.position = [next.x, next.y, next.z];
    return { grounded: h.grounded };
  }

  /** Teleport an entity's body to its Transform (respawn, editor moves). */
  teleport(id) {
    const h = this.handles.get(id), t = this.world.get(id, 'Transform');
    if (!h?.body || !t) return;
    h.body.setTranslation({ x: t.position[0], y: t.position[1], z: t.position[2] }, true);
    h.body.setLinvel?.({ x: 0, y: 0, z: 0 }, true);
    if (h.kind === 'character') h.velocityY = 0;
  }

  /** @returns {{entity: number|undefined, distance: number, point: number[]} | null} */
  raycast(origin, dir, maxDistance = 1000, excludeEntity) {
    const exclude = excludeEntity !== undefined ? this.handles.get(excludeEntity)?.collider : undefined;
    const hit = this.rapier.castRay(new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] }),
      maxDistance, true, undefined, undefined, exclude);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return { entity: this.colliderToEntity.get(hit.collider.handle), distance: d, point: [origin[0] + dir[0] * d, origin[1] + dir[1] * d, origin[2] + dir[2] * d] };
  }

  step(dt) {
    this.sync();
    const w = this.world;
    for (const [id, h] of this.handles) {
      if (h.kind !== 'kinematic') continue;
      const t = w.get(id, 'Transform');
      h.body.setNextKinematicTranslation({ x: t.position[0], y: t.position[1], z: t.position[2] });
      h.body.setNextKinematicRotation({ x: t.rotation[0], y: t.rotation[1], z: t.rotation[2], w: t.rotation[3] });
    }
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
    for (const [id, h] of this.handles) {
      if (h.kind !== 'dynamic') continue;
      const t = w.get(id, 'Transform'), p = h.body.translation(), r = h.body.rotation();
      t.position = [p.x, p.y, p.z];
      t.rotation = [r.x, r.y, r.z, r.w];
    }
    this.events.drainCollisionEvents((a, b, started) => {
      const ea = this.colliderToEntity.get(a), eb = this.colliderToEntity.get(b);
      w.emit(started ? 'collisionStart' : 'collisionEnd', { a: ea, b: eb });
    });
  }
}
