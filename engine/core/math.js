// Small vector / quaternion / matrix helpers. Arrays are plain JS arrays or
// Float32Arrays. Matrices are column-major 4x4 (WebGPU / WGSL order).
// World convention: +Y up, camera looks along +Z, +X is right (matches
// tools/clouds/cloudNavigation.js cameraBasis).

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Quaternion [x, y, z, w] from a rotation of `angle` radians about the Y axis. */
export function quatFromYaw(angle) {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/** Quaternion from yaw (Y), pitch (X) and roll (Z), radians, applied yaw * pitch * roll. */
export function quatFromEuler(yaw, pitch = 0, roll = 0) {
  return quatMul(quatMul(quatFromYaw(yaw), [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]), [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)]);
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate vector v by unit quaternion q. */
export function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const u = [x, y, z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}

export function mat4Identity() {
  const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m;
}

/** Column-major TRS matrix. */
export function mat4FromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = new Float32Array(16);
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

export function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

export function mat4TransformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Camera basis from yaw/pitch in degrees (same as cloudNavigation.cameraBasis). */
export function cameraBasis(yawDeg, pitchDeg) {
  const yaw = yawDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
  return {
    forward: [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)],
    right: [Math.cos(yaw), 0, -Math.sin(yaw)],
    up: [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), -Math.cos(yaw) * Math.sin(pitch)],
  };
}
