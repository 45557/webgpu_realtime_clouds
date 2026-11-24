// glTF 2.0 (.glb / .gltf) to engine mesh data. Milestone 1 scope: static meshes,
// node transforms baked into vertices, base color factor + base color texture,
// vertex colors. glTF is right-handed; the engine is left-handed (+Z forward),
// so X is mirrored on import. Models keep facing +Z.
import { WebIO } from '@gltf-transform/core';
import { mat4Mul, mat4TransformPoint } from '../core/math.js';

/**
 * @typedef {{positions: Float32Array, normals: Float32Array, uvs: Float32Array|null, colors: Float32Array|null,
 *   indices: Uint32Array, baseColor: number[], baseColorImage: {data: Uint8Array, mimeType: string}|null}} MeshPrimitive
 */

const MIRROR_X = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Parse a glTF/GLB from bytes (GLB) or a URL. @returns {Promise<{primitives: MeshPrimitive[]}>} */
export async function loadGltf(source) {
  const io = new WebIO();
  const doc = typeof source === 'string' ? await io.read(source) : await io.readBinary(source);
  return gltfDocumentToMeshes(doc);
}

export function gltfDocumentToMeshes(doc) {
  const primitives = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const visit = (node, parentMatrix) => {
    const world = mat4Mul(parentMatrix, new Float32Array(node.getMatrix()));
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const out = convertPrimitive(prim, mat4Mul(MIRROR_X, world));
      if (out) primitives.push(out);
    }
    for (const child of node.listChildren()) visit(child, world);
  };
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const node of scene?.listChildren() ?? []) visit(node, identity);
  return { primitives };
}

function convertPrimitive(prim, matrix) {
  if (prim.getMode() !== 4) return null; // triangles only
  const pos = prim.getAttribute('POSITION');
  if (!pos) return null;
  const count = pos.getCount();
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const nrm = prim.getAttribute('NORMAL');
  const tmp = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    pos.getElement(i, tmp);
    positions.set(mat4TransformPoint(matrix, tmp), i * 3);
    if (nrm) {
      nrm.getElement(i, tmp);
      // Rotation/mirror part only; renormalized in the shader.
      normals.set([matrix[0] * tmp[0] + matrix[4] * tmp[1] + matrix[8] * tmp[2],
        matrix[1] * tmp[0] + matrix[5] * tmp[1] + matrix[9] * tmp[2],
        matrix[2] * tmp[0] + matrix[6] * tmp[1] + matrix[10] * tmp[2]], i * 3);
    }
  }
  const idx = prim.getIndices();
  const indices = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
  if (!nrm) computeNormals(positions, indices, normals);
  const uv = prim.getAttribute('TEXCOORD_0');
  const col = prim.getAttribute('COLOR_0');
  let colors = null;
  if (col) {
    colors = new Float32Array(count * 4);
    const c = [0, 0, 0, 1];
    for (let i = 0; i < count; i++) { c[3] = 1; col.getElement(i, c); colors.set(c, i * 4); }
  }
  const material = prim.getMaterial();
  const texture = material?.getBaseColorTexture();
  return {
    positions, normals, indices, colors,
    uvs: uv ? Float32Array.from(uv.getArray()) : null,
    baseColor: material ? material.getBaseColorFactor() : [1, 1, 1, 1],
    baseColorImage: texture ? { data: texture.getImage(), mimeType: texture.getMimeType() } : null,
  };
}

function computeNormals(positions, indices, normals) {
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
    const e1 = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]);
    const e2 = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v + k] += n[k];
  }
}
