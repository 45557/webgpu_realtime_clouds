// Built-in meshes (positions, normals, uvs, indices) for "builtin:*" MeshRenderer assets.

function build(rings, segments, point) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
    const { p, n } = point(r / rings, s / segments);
    positions.push(...p); normals.push(...n); uvs.push(s / segments, r / rings);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

export function sphereMesh(radius = 0.5, rings = 16, segments = 24) {
  return build(rings, segments, (v, u) => {
    const th = v * Math.PI, ph = u * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    return { p: n.map((c) => c * radius), n };
  });
}

/** Capsule along Y, centered on the origin: total height 2 * (halfHeight + radius). */
export function capsuleMesh(radius = 0.35, halfHeight = 0.45, segments = 24) {
  // An odd ring count leaves no vertex row on the equator, so shifting the two
  // hemispheres apart stretches the middle band into the cylinder.
  const mesh = sphereMesh(radius, 17, segments);
  for (let i = 1; i < mesh.positions.length; i += 3) mesh.positions[i] += mesh.positions[i] > 0 ? halfHeight : -halfHeight;
  return mesh;
}

export function boxMesh(hx = 0.5, hy = 0.5, hz = 0.5) {
  const positions = [], normals = [], uvs = [], indices = [];
  const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  const h = [hx, hy, hz];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...[0, 1, 2].map((i) => (n[i] + u[i] * a + v[i] * b) * h[i]));
      normals.push(...n); uvs.push((a + 1) / 2, (1 - b) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

export const BUILTIN_MESHES = {
  'builtin:box': () => boxMesh(),
  'builtin:sphere': () => sphereMesh(),
  'builtin:capsule': () => capsuleMesh(),
};
