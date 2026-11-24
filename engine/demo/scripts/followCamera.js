// Orbit camera that follows a target entity. Mouse (click to lock) looks around,
// the wheel zooms, and a ray keeps the camera out of the terrain.
import { quatMul, quatFromYaw, clamp } from '../../core/math.js';

export const params = {
  target: { type: 'string', default: 'player' },
  distance: { type: 'number', default: 5.5 },
  height: { type: 'number', default: 1.4 },
  sensitivity: { type: 'number', default: 0.0025 },
};

export function start(ctx) {
  ctx.state.yaw = 0;
  ctx.state.pitch = -0.15;
  ctx.state.distance = ctx.params.distance;
}

export function update(ctx, dt) {
  const { engine, world, params, state } = ctx;
  const target = world.find(params.target);
  if (target === undefined) return;
  const [dx, dy] = engine.input.mouseDelta;
  state.yaw += dx * params.sensitivity;
  state.pitch = clamp(state.pitch - dy * params.sensitivity, -1.1, 0.6);
  state.distance = clamp(state.distance * (1 + engine.input.wheel * 0.1), 2, 30);
  world.resources.cameraYaw = state.yaw;

  const p = world.get(target, 'Transform').position;
  const pivot = [p[0], p[1] + params.height, p[2]];
  const fwd = [Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), Math.cos(state.yaw) * Math.cos(state.pitch)];
  const back = [-fwd[0], -fwd[1], -fwd[2]];
  let distance = state.distance;
  const hit = engine.physics.raycast(pivot, back, distance + 0.3, target);
  if (hit) distance = Math.max(0.5, hit.distance - 0.3);
  // Smooth only the zoom-in caused by obstacles' removal, not the follow itself.
  state.smoothed = state.smoothed === undefined || distance < state.smoothed ? distance : state.smoothed + (distance - state.smoothed) * Math.min(1, dt * 4);
  const t = world.get(ctx.entity, 'Transform');
  t.position = [pivot[0] + back[0] * state.smoothed, pivot[1] + back[1] * state.smoothed, pivot[2] + back[2] * state.smoothed];
  const half = -state.pitch / 2;
  t.rotation = quatMul(quatFromYaw(state.yaw), [Math.sin(half), 0, 0, Math.cos(half)]);
}
