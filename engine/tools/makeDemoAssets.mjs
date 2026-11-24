// Generates the milestone 1 demo assets (small .glb files) and the demo scene.
// Run from the repo root: node engine/tools/makeDemoAssets.mjs
import { Document, NodeIO } from '@gltf-transform/core';
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { terrainHeight } from '../../tools/clouds/cloudTerrainMesh.js';

const io = new NodeIO();

function addPrimitive(doc, mesh, { positions, normals, uvs, indices }, material) {
  const buffer = doc.getRoot().listBuffers()[0];
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(normals)))
    .setIndices(acc('SCALAR', new Uint16Array(indices)))
    .setMaterial(material);
  if (uvs) prim.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uvs)));
  mesh.addPrimitive(prim);
}

/** Cone / cylinder around +Y (glTF right-handed, CCW front faces). */
function lathe(profile, segments = 12, seedJitter = 0) {
  const positions = [], normals = [], indices = [];
  for (let r = 0; r < profile.length; r++) {
    const [radius, y, ny] = profile[r];
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const j = seedJitter ? 1 + seedJitter * Math.sin(a * 3 + r * 1.7) : 1;
      positions.push(Math.cos(a) * radius * j, y, Math.sin(a) * radius * j);
      const l = Math.hypot(1, ny);
      normals.push(Math.cos(a) / l, ny / l, Math.sin(a) / l);
    }
  }
  for (let r = 0; r < profile.length - 1; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return { positions, normals, indices };
}

function material(doc, name, color, texture) {
  const m = doc.createMaterial(name).setBaseColorFactor(color).setRoughnessFactor(0.9).setMetallicFactor(0);
  if (texture) m.setBaseColorTexture(texture);
  return m;
}

async function tree() {
  const doc = new Document();
  doc.createBuffer();
  const mesh = doc.createMesh('tree');
  addPrimitive(doc, mesh, lathe([[0.12, 0, 0], [0.09, 1.0, 0]], 8), material(doc, 'bark', [0.32, 0.22, 0.14, 1]));
  addPrimitive(doc, mesh, lathe([[0.75, 0.8, 0.6], [0.5, 1.6, 0.6], [0.62, 1.5, 0.6], [0.32, 2.3, 0.6], [0.42, 2.2, 0.6], [0.0, 3.1, 0.6]], 10, 0.08),
    material(doc, 'needles', [0.13, 0.30, 0.16, 1]));
  doc.createScene().addChild(doc.createNode('tree').setMesh(mesh));
  return io.writeBinary(doc);
}

async function rock() {
  const doc = new Document();
  doc.createBuffer();
  const mesh = doc.createMesh('rock');
  const positions = [], normals = [], indices = [];
  const rings = 8, segments = 12;
  for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
    const th = (r / rings) * Math.PI, ph = (s / segments) * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    const k = 0.5 * (1 + 0.18 * Math.sin(ph * 3 + th * 2) + 0.12 * Math.cos(ph * 5 - th * 3));
    positions.push(n[0] * k * 1.3, n[1] * k * 0.7, n[2] * k); normals.push(...n);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  addPrimitive(doc, mesh, { positions, normals, indices }, material(doc, 'stone', [0.42, 0.41, 0.40, 1]));
  doc.createScene().addChild(doc.createNode('rock').setMesh(mesh));
  return io.writeBinary(doc);
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function crate() {
  const doc = new Document();
  doc.createBuffer();
  const image = png(64, 64, (x, y) => {
    const edge = x < 5 || y < 5 || x > 58 || y > 58 || Math.abs(x - y) < 3;
    const grain = 18 * Math.sin(y * 0.9 + Math.sin(x * 0.3) * 2);
    return edge ? [92, 60, 34, 255] : [176 + grain, 128 + grain, 72 + grain * 0.5, 255].map((v) => Math.max(0, Math.min(255, v | 0)));
  });
  const texture = doc.createTexture('crate').setImage(new Uint8Array(image)).setMimeType('image/png');
  const mesh = doc.createMesh('crate');
  const positions = [], normals = [], uvs = [], indices = [];
  const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...[0, 1, 2].map((i) => (n[i] + u[i] * a + v[i] * b) * 0.5));
      normals.push(...n); uvs.push((a + 1) / 2, (1 - b) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  addPrimitive(doc, mesh, { positions, normals, uvs, indices }, material(doc, 'wood', [1, 1, 1, 1], texture));
  doc.createScene().addChild(doc.createNode('crate').setMesh(mesh));
  return io.writeBinary(doc);
}

function scene() {
  const ground = (x, z) => terrainHeight(x, z);
  const rand = (() => { let s = 7; return () => ((s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 4294967296); })();
  const entities = [];
  const add = (uuid, components) => entities.push({ uuid, components });
  add('environment', {
    Name: { value: 'Environment' },
    DirectionalLight: { azimuthDeg: 40, elevationDeg: 24 },
    CloudLayer: {},
  });
  add('terrain', { Name: { value: 'Mountain basin' }, Terrain: {} });
  add('player', {
    Name: { value: 'Player' },
    Transform: { position: [0, ground(0, -8) + 2, -8] },
    MeshRenderer: { mesh: 'builtin:capsule', color: [0.85, 0.35, 0.22, 1] },
    CharacterController: {},
    Script: { name: 'player', params: { speed: 5, sprint: 11, jump: 7.5 } },
  });
  add('camera', {
    Name: { value: 'Camera' },
    Transform: { position: [0, ground(0, -14) + 4, -14] },
    Camera: { fovYDeg: 62 },
    Script: { name: 'followCamera', params: { target: 'player', distance: 5.5, height: 1.4 } },
  });
  for (let i = 0; i < 70; i++) {
    const a = rand() * Math.PI * 2, r = 14 + rand() * 46;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = ground(x, z);
    if (y > 14) continue;
    const s = 0.8 + rand() * 0.9;
    add(`tree-${i}`, {
      Name: { value: `Tree ${i}` },
      Transform: { position: [x, y - 0.15, z], rotation: [0, Math.sin(a), 0, Math.cos(a)], scale: [s, s * (0.9 + rand() * 0.4), s] },
      MeshRenderer: { mesh: 'assets/engine/tree.glb' },
      RigidBody: { kind: 'static' },
      Collider: { shape: 'capsule', size: [0.25 * s, 0.6 * s, 0] },
    });
  }
  for (let i = 0; i < 18; i++) {
    const a = rand() * Math.PI * 2, r = 8 + rand() * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, s = 0.6 + rand() * 1.4;
    add(`rock-${i}`, {
      Name: { value: `Rock ${i}` },
      Transform: { position: [x, ground(x, z) - 0.1 * s, z], scale: [s, s, s] },
      MeshRenderer: { mesh: 'assets/engine/rock.glb' },
      RigidBody: { kind: 'static' },
      Collider: { shape: 'sphere', size: [0.42 * s, 0, 0] },
    });
  }
  for (let i = 0; i < 6; i++) {
    const x = -3 + (i % 3) * 1.1, z = -2 + Math.floor(i / 3) * 1.1;
    add(`crate-${i}`, {
      Name: { value: `Crate ${i}` },
      Transform: { position: [x, ground(x, z) + 0.6 + Math.floor(i / 3) * 0.05, z] },
      MeshRenderer: { mesh: 'assets/engine/crate.glb' },
      RigidBody: { kind: 'dynamic', mass: 2 },
      Collider: { shape: 'box', size: [0.5, 0.5, 0.5] },
    });
  }
  return { format: 'clouds3-scene', version: 1, entities };
}

await writeFile('assets/engine/tree.glb', await tree());
await writeFile('assets/engine/rock.glb', await rock());
await writeFile('assets/engine/crate.glb', await crate());
await writeFile('engine/demo/walk-scene.json', JSON.stringify(scene(), null, 1) + '\n');
console.log('wrote assets/engine/{tree,rock,crate}.glb and engine/demo/walk-scene.json');
