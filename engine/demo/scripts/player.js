// Third-person walker: WASD relative to the camera, Shift to sprint, Space to jump.
import { quatFromYaw } from '../../core/math.js';

export const params = {
  speed: { type: 'number', default: 5 },
  sprint: { type: 'number', default: 11 },
  jump: { type: 'number', default: 7.5 },
};

export function start(ctx) {
  const t = ctx.world.get(ctx.entity, 'Transform');
  ctx.state.spawn = [...t.position];
  ctx.state.facing = 0;
}

export function update(ctx) {
  if (ctx.engine.input.justPressed('Space')) ctx.state.wantJump = true;
}

export function fixedUpdate(ctx, dt) {
  const { engine, world, entity, params, state } = ctx;
  const input = engine.input;
  const yaw = world.resources.cameraYaw ?? 0;
  const [ax, ay] = input.moveAxis();
  const fwd = [Math.sin(yaw), 0, Math.cos(yaw)], right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  let v = [right[0] * ax + fwd[0] * ay, 0, right[2] * ax + fwd[2] * ay];
  const len = Math.hypot(v[0], v[2]);
  const speed = input.down('ShiftLeft') || input.down('ShiftRight') ? params.sprint : params.speed;
  if (len > 0) {
    v = [v[0] / len * speed, 0, v[2] / len * speed];
    const target = Math.atan2(v[0], v[2]);
    let d = target - state.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    state.facing += d * Math.min(1, dt * 12);
  }
  const { grounded } = engine.physics.moveCharacter(entity, v, dt, { jump: state.wantJump ? params.jump : 0 });
  state.wantJump = false;
  state.grounded = grounded;
  const t = world.get(entity, 'Transform');
  t.rotation = quatFromYaw(state.facing);
  if (t.position[1] < -60) { t.position = [...state.spawn]; engine.physics.teleport(entity); }
}
