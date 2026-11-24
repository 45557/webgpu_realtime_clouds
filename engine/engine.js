// Engine runtime: owns the world, physics, scripts, input and rendering loop.
import { World } from './ecs/world.js';
import './core/components.js';
import { loadScene } from './scene/serialize.js';
import { updateWorldMatrices } from './core/transformSystem.js';
import { quatRotate } from './core/math.js';
import { Physics, initRapier } from './physics/physics.js';
import { ScriptSystem } from './core/scripts.js';
import { Input } from './core/input.js';
import { MeshRenderer } from './render/meshRenderer.js';

const FIXED_DT = 1 / 60;

export class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{clouds?: boolean, maxFrames?: number}} [options]
   */
  constructor(canvas, { clouds = true, maxFrames = Infinity, offscreen = false, cloudTextureSizes } = {}) {
    this.cloudTextureSizes = cloudTextureSizes;
    this.canvas = canvas;
    this.offscreen = offscreen;
    this.useClouds = clouds;
    this.maxFrames = maxFrames;
    this.world = new World();
    this.frame = 0;
    this.time = 0;
    this.stats = { fps: 0, frameMs: 0 };
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    // Keep the adapter referenced: some Chromium builds lose the device if it is collected.
    const adapter = this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const want = ['maxBufferSize', 'maxStorageBufferBindingSize'];
    this.device = await adapter.requestDevice({ requiredLimits: Object.fromEntries(want.map((k) => [k, adapter.limits[k]])) });
    this.device.addEventListener('uncapturederror', (e) => console.error('[engine] GPU error:', e.error.message));
    await initRapier();
    this.physics = new Physics(this.world);
    this.scripts = new ScriptSystem(this);
    this.input = new Input(this.canvas);
    this.world.resources = { engine: this, physics: this.physics, input: this.input };
    this.renderer = new MeshRenderer(this.device);
    this.resize();
    if (this.useClouds) {
      const { CloudBridge } = await import('./render/cloudBridge.js');
      // Offscreen mode hands the cloud compositor a canvas stand-in so tests can read frames back.
      this.cloudCanvas = this.offscreen ? this.offscreenCanvas() : this.canvas;
      this.clouds = new CloudBridge(this.device, this.cloudCanvas, this.cloudTextureSizes ? { sizes: this.cloudTextureSizes } : {});
      await this.clouds.init();
      this.clouds.drawScene = (pass) => this.renderer.drawScene(pass);
    } else {
      this.context = this.offscreen ? this.offscreenContext() : this.canvas.getContext('webgpu');
      this.context.configure?.({ device: this.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    }
    addEventListener('resize', () => this.resize());
  }

  /** A stand-in for a canvas context that renders into a readable texture (tests, thumbnails). */
  offscreenContext(format = navigator.gpu.getPreferredCanvasFormat()) {
    const ctx = {
      configure: (config) => { format = config.format; },
      getCurrentTexture: () => {
        const { width, height } = this.canvas;
        if (ctx.texture?.width !== width || ctx.texture?.height !== height) {
          ctx.texture?.destroy();
          ctx.texture = this.device.createTexture({ size: [width, height], format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        }
        return ctx.texture;
      },
    };
    return ctx;
  }

  offscreenCanvas() {
    const canvas = this.canvas;
    const context = this.offscreenContext();
    return {
      context,
      get clientWidth() { return canvas.clientWidth; },
      get clientHeight() { return canvas.clientHeight; },
      get width() { return canvas.width; }, set width(v) { canvas.width = v; },
      get height() { return canvas.height; }, set height(v) { canvas.height = v; },
      getContext: () => context,
    };
  }

  /** Read the last offscreen frame back as a PNG data URL. */
  async capture() {
    const tex = (this.clouds ? this.cloudCanvas.context : this.context)?.texture;
    if (!tex) throw new Error('capture() needs { offscreen: true }');
    const { width, height } = tex, bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow }, [width, height]);
    this.device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    const bgra = tex.format.startsWith('bgra');
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * bytesPerRow + x * 4, o = (y * width + x) * 4;
      pixels[o] = src[i + (bgra ? 2 : 0)]; pixels[o + 1] = src[i + 1]; pixels[o + 2] = src[i + (bgra ? 0 : 2)]; pixels[o + 3] = 255;
    }
    buffer.unmap(); buffer.destroy();
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    out.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return out.toDataURL('image/png');
  }

  resize() {
    // Whole-number ratio, matching the cloud compositor's canvas sizing.
    const dpr = Math.max(1, Math.floor(devicePixelRatio || 1));
    this.canvas.width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
  }

  /** Load a scene JSON object (or URL). */
  async load(scene) {
    if (typeof scene === 'string') scene = await (await fetch(scene)).json();
    loadScene(this.world, scene);
    updateWorldMatrices(this.world);
    this.physics.sync();
  }

  /** The active camera's view, or a default looking across the basin. */
  cameraView() {
    const w = this.world;
    const id = w.query('Camera', 'Transform').find((e) => w.get(e, 'Camera').active);
    const aspect = this.canvas.width / this.canvas.height;
    if (id === undefined) return { camPos: [0, 0, -40], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], fovYDeg: 60, aspect };
    const t = w.get(id, 'Transform');
    return {
      camPos: [...t.position], right: quatRotate(t.rotation, [1, 0, 0]), up: quatRotate(t.rotation, [0, 1, 0]),
      fwd: quatRotate(t.rotation, [0, 0, 1]), fovYDeg: w.get(id, 'Camera').fovYDeg, aspect,
    };
  }

  sunDirection() {
    const w = this.world;
    const id = w.query('DirectionalLight')[0];
    const l = id !== undefined ? w.get(id, 'DirectionalLight') : { azimuthDeg: 45, elevationDeg: 21 };
    const az = l.azimuthDeg * Math.PI / 180, el = l.elevationDeg * Math.PI / 180;
    return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  }

  cloudLayer() {
    const id = this.world.query('CloudLayer')[0];
    return id !== undefined ? this.world.get(id, 'CloudLayer') : null;
  }

  start() {
    let last = performance.now(), acc = 0;
    const tick = async () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 5) {
        this.scripts.run('fixedUpdate', FIXED_DT);
        this.physics.step(FIXED_DT);
        acc -= FIXED_DT; steps++;
      }
      if (steps === 5) acc = 0;
      this.time += dt;
      this.scripts.run('update', dt);
      updateWorldMatrices(this.world);
      try { await this.render(dt); } catch (e) { console.error('[engine] render failed', e); }
      this.input.endFrame();
      const ms = performance.now() - now;
      this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
      this.stats.fps = this.stats.fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
      this.frame++;
      if (this.frame < this.maxFrames) requestAnimationFrame(tick);
      else this.stopped = true;
    };
    requestAnimationFrame(tick);
  }

  async render(dt = 0) {
    const view = { ...this.cameraView(), sunDir: this.sunDirection() };
    const layer = this.cloudLayer();
    if (this.clouds) {
      this.renderer.prepare(this.world, view);
      if (layer) this.clouds.applyLayerFromComponent(layer);
      this.clouds.resize(this.canvas.width, this.canvas.height);
      await this.clouds.render(view, dt);
    } else {
      this.renderer.prepare(this.world, view, { includeTerrain: true });
      this.renderer.render(this.context, { exposure: layer?.exposure, sky: layer?.sky });
    }
  }
}
