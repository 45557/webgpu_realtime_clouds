// Draws MeshRenderer entities (and optionally the basin terrain) with WebGPU.
// Works in two modes:
//  - with clouds: drawScene(pass) is called from inside the cloud renderer's
//    terrain raster pass, so meshes share its color + distance + depth targets;
//  - standalone: render() owns its targets and composites a simple sky.
import meshWGSL from './mesh.wgsl';
import compositeWGSL from './composite.wgsl';
import terrainWGSL from '../../tools/clouds/shaders/cloudTerrain.wgsl';
import { createTerrainMesh } from '../../tools/clouds/cloudTerrainMesh.js';
import { BUILTIN_MESHES } from './primitives.js';
import { loadGltf } from '../gltf/loadGltf.js';

const DRAW_STRIDE = 256;
const MAX_DRAWS = 1024;

export class MeshRenderer {
  /** @param {GPUDevice} device */
  constructor(device, { canvasFormat = navigator.gpu.getPreferredCanvasFormat() } = {}) {
    this.device = device;
    this.canvasFormat = canvasFormat;
    /** @type {Map<string, Promise<object[]>|object[]>} asset path -> GPU primitives */
    this.meshes = new Map();
    this.drawList = [];
    const module = device.createShaderModule({ label: 'engine mesh', code: terrainWGSL + '\n' + meshWGSL });
    this.viewBuffer = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawBuffer = device.createBuffer({ size: DRAW_STRIDE * MAX_DRAWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawData = new Float32Array(DRAW_STRIDE / 4 * MAX_DRAWS);
    const group0 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } },
    ] });
    this.materialLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ] });
    this.pipeline = device.createRenderPipeline({
      label: 'engine mesh',
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0, this.materialLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
      ] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rg8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    this.group0 = device.createBindGroup({ layout: group0, entries: [
      { binding: 0, resource: { buffer: this.viewBuffer } },
      { binding: 1, resource: { buffer: this.drawBuffer, size: 96 } },
    ] });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.defaultMaterial = this.materialGroup(white);
    this.module = module;
  }

  materialGroup(texture) {
    return this.device.createBindGroup({ layout: this.materialLayout, entries: [
      { binding: 0, resource: this.sampler }, { binding: 1, resource: texture.createView() },
    ] });
  }

  /** Upload CPU mesh data. */
  async uploadPrimitive(p) {
    const d = this.device;
    const n = p.positions.length / 3;
    const buffer = (data, usage) => {
      const b = d.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(b, 0, data);
      return b;
    };
    let material = this.defaultMaterial, hasTexture = 0;
    if (p.baseColorImage) {
      try {
        const bitmap = await createImageBitmap(new Blob([p.baseColorImage.data], { type: p.baseColorImage.mimeType }));
        const tex = d.createTexture({ size: [bitmap.width, bitmap.height], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        d.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, [bitmap.width, bitmap.height]);
        material = this.materialGroup(tex); hasTexture = 1;
      } catch (e) { console.warn('glTF texture failed to load', e); }
    }
    return {
      position: buffer(p.positions, GPUBufferUsage.VERTEX),
      normal: buffer(p.normals, GPUBufferUsage.VERTEX),
      uv: buffer(p.uvs ?? new Float32Array(n * 2), GPUBufferUsage.VERTEX),
      color: buffer(p.colors ?? new Float32Array(n * 4).fill(1), GPUBufferUsage.VERTEX),
      index: buffer(p.indices, GPUBufferUsage.INDEX),
      count: p.indices.length,
      baseColor: p.baseColor ?? [1, 1, 1, 1],
      hasTexture, material,
      terrain: !!p.terrain,
    };
  }

  /** Load (once) and return the GPU primitives for a MeshRenderer asset path. */
  mesh(path) {
    let entry = this.meshes.get(path);
    if (!entry) {
      entry = this.loadMesh(path).then((prims) => { this.meshes.set(path, prims); return prims; })
        .catch((e) => { console.error(`Failed to load mesh ${path}`, e); this.meshes.set(path, []); return []; });
      this.meshes.set(path, entry);
    }
    return Array.isArray(entry) ? entry : null;
  }

  async loadMesh(path) {
    if (path === 'builtin:terrain-basin') {
      const { vertices, indices } = createTerrainMesh();
      const n = vertices.length / 6, positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { positions.set(vertices.subarray(i * 6, i * 6 + 3), i * 3); normals.set(vertices.subarray(i * 6 + 3, i * 6 + 6), i * 3); }
      return [await this.uploadPrimitive({ positions, normals, indices, terrain: true })];
    }
    if (BUILTIN_MESHES[path]) return [await this.uploadPrimitive(BUILTIN_MESHES[path]())];
    const { primitives } = await loadGltf(path);
    return Promise.all(primitives.map((p) => this.uploadPrimitive(p)));
  }

  /**
   * Build the draw list and upload uniforms. Call before encoding the frame.
   * @param {import('../ecs/world.js').World} world
   * @param {{camPos:number[], right:number[], up:number[], fwd:number[], fovYDeg:number, aspect:number, sunDir:number[], sunColor?:number[]}} view
   */
  prepare(world, view, { includeTerrain = false } = {}) {
    const v = new Float32Array(28);
    v.set(view.camPos, 0); v.set(view.right, 4); v.set(view.up, 8); v.set(view.fwd, 12);
    v[16] = view.fovYDeg * Math.PI / 180; v[17] = view.aspect; v[18] = 0.02;
    v.set(view.sunDir, 20); v.set(view.sunColor ?? [1.05, 0.97, 0.87], 24);
    this.device.queue.writeBuffer(this.viewBuffer, 0, v);
    this.viewData = v;
    const list = [];
    const push = (matrix, color, prim) => {
      if (list.length >= MAX_DRAWS) return;
      const o = list.length * DRAW_STRIDE / 4;
      this.drawData.set(matrix, o);
      const c = prim.baseColor;
      this.drawData.set([color[0] * c[0], color[1] * c[1], color[2] * c[2], color[3] * c[3]], o + 16);
      this.drawData.set([prim.hasTexture, prim.terrain ? 1 : 0, 0, 0], o + 20);
      list.push(prim);
    };
    if (includeTerrain) {
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (const prim of this.mesh('builtin:terrain-basin') ?? []) push(identity, [1, 1, 1, 1], prim);
    }
    for (const id of world.query('MeshRenderer', 'WorldMatrix')) {
      const mr = world.get(id, 'MeshRenderer');
      if (!mr.visible || !mr.mesh) continue;
      const prims = this.mesh(mr.mesh);
      if (!prims) continue;
      const m = world.get(id, 'WorldMatrix').matrix;
      for (const prim of prims) push(m, mr.color, prim);
    }
    if (list.length) this.device.queue.writeBuffer(this.drawBuffer, 0, this.drawData, 0, list.length * DRAW_STRIDE / 4);
    this.drawList = list;
  }

  /** Encode draws into a pass that has the scene targets bound. */
  drawScene(pass) {
    if (!this.drawList.length) return;
    pass.setPipeline(this.pipeline);
    this.drawList.forEach((p, i) => {
      pass.setBindGroup(0, this.group0, [i * DRAW_STRIDE]);
      pass.setBindGroup(1, p.material);
      pass.setVertexBuffer(0, p.position); pass.setVertexBuffer(1, p.normal);
      pass.setVertexBuffer(2, p.uv); pass.setVertexBuffer(3, p.color);
      pass.setIndexBuffer(p.index, 'uint32');
      pass.drawIndexed(p.count);
    });
  }

  ensureTargets(width, height) {
    if (this.width === width && this.height === height) return;
    this.targets?.forEach((t) => t.destroy());
    const d = this.device;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const color = d.createTexture({ size: [width, height], format: 'rgba16float', usage });
    const water = d.createTexture({ size: [width, height], format: 'rg8unorm', usage });
    const depth = d.createTexture({ size: [width, height], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.targets = [color, water, depth];
    this.width = width; this.height = height;
    if (!this.blit) {
      this.blit = d.createRenderPipeline({ label: 'engine composite', layout: 'auto',
        vertex: { module: this.compositeModule ??= d.createShaderModule({ label: 'engine composite', code: compositeWGSL }), entryPoint: 'blitVs' },
        fragment: { module: this.compositeModule, entryPoint: 'blitFs', targets: [{ format: this.canvasFormat }] } });
      this.compBuffer = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this.blitGroup = d.createBindGroup({ layout: this.blit.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.compBuffer } }, { binding: 1, resource: color.createView() },
      { binding: 2, resource: { buffer: this.viewBuffer } },
    ] });
  }

  /** Standalone frame (no clouds): scene pass + sky composite to the canvas. */
  render(context, { exposure = 1.18, sky = [0.6, 0.75, 0.98] } = {}) {
    const tex = context.getCurrentTexture();
    this.ensureTargets(tex.width, tex.height);
    const d = this.device;
    d.queue.writeBuffer(this.compBuffer, 0, new Float32Array([exposure, 0, 0, 0, ...sky.slice(0, 3), 1]));
    const enc = d.createCommandEncoder();
    const [color, water, depth] = this.targets;
    const pass = enc.beginRenderPass({
      colorAttachments: [color, water].map((t) => ({ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } })),
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    this.drawScene(pass);
    pass.end();
    const blit = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    blit.setPipeline(this.blit);
    blit.setBindGroup(0, this.blitGroup);
    blit.draw(3);
    blit.end();
    d.queue.submit([enc.finish()]);
  }
}
