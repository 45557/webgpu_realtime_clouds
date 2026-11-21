// WebGPU globe layers for the life simulation. The simulation's cell data is
// painted into equirectangular maps (colonies, effects, biomes), and a
// fullscreen shader projects them onto the terrain using the planet's depth
// buffer, like the cloud passes do. The layer canvas sits under the clouds.
import lifeShader from '../shaders/planetLife.wgsl';
import { HABITATS } from './planetLifeSim.js';
import { craterSize } from './planetCraters.js';

const MAP_W = 512, MAP_H = 256, MAX_EVENTS = 8, MAX_CRATERS = 16;
const EVENTS_AT = 28, CRATERS_AT = EVENTS_AT + MAX_EVENTS * 8, FADE_AT = CRATERS_AT + MAX_CRATERS * 4;
const PHOTO = 3, GENES = 11;
const HABITAT_KEYS = Object.keys(HABITATS);
const HABITAT_COLORS = { vent: '255,140,60', tidal: '90,220,255', pond: '120,255,200', spring: '255,210,90' };

// Element colours after the usual CPK model colours, lightened to read on terrain.
export const CHEMICALS = Object.freeze([
  { key: 'h2o', label: 'Water (H₂O)', color: [80, 200, 255] },
  { key: 'o2', label: 'Oxygen (O₂)', color: [255, 70, 70] },
  { key: 'h2', label: 'Hydrogen (H₂)', color: [245, 245, 245] },
  { key: 'n', label: 'Fixed nitrogen (N)', color: [120, 110, 255] },
  { key: 'c', label: 'Carbon (organics, CO₂)', color: [150, 150, 150] },
]);

export function chemicalLevels(sim, i) {
  return {
    h2o: sim.env.water[i] ? 1 : 0.7 * sim.env.moisture[i],
    o2: Math.min(1, 2 * sim.state.o2 + 0.5 * sim.oxygen[i]),
    h2: Math.min(1, sim.hydrogen[i]),
    n: Math.min(1, sim.nitrogen[i] * 1.5),
    c: Math.min(1, sim.organics[i] / 1.5 + 0.02 * sim.state.co2),
  };
}

export const HABITAT_LEGEND = HABITAT_KEYS.filter(k => HABITAT_COLORS[k])
  .map(key => ({ key, label: HABITATS[key], color: HABITAT_COLORS[key] }));

function hslToRgb(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

// Biomes from the simulated climate: sea ice, ice, tundra, desert, forest,
// rainforest and grassland. Returns [r, g, b, a] in 0..1, or null.
export function biomeRgba(sim, i) {
  const t = sim.temperature[i];
  const { env } = sim;
  if (env.ocean[i]) return t < -2 ? [0.88, 0.94, 1, 0.55] : null;
  if (t < -2) return [0.94, 0.97, 1, 0.6];
  const greenery = sim.lineageOf[i] >= 0 && sim.genome[i * GENES + PHOTO] > 0.4 ? Math.min(1, sim.biomass[i] / 1.5) : 0;
  const m = env.moisture[i];
  if (t < 5) return [0.59, 0.65, 0.55, 0.35 + 0.2 * greenery];
  if (m < 0.25) return [0.86, 0.7, 0.43, 0.45];
  if (greenery > 0.2) return t > 22 && m > 0.5 ? [0.08, 0.47, 0.2, 0.55] : [0.24, 0.55, 0.24, 0.5];
  return [0.67, 0.67, 0.35, 0.4];
}

// Map every texel of the equirectangular maps to its nearest simulation cell
// by walking the cell neighbour graph from the previous texel.
// The layer's own equirect layout: longitude starts half a turn round.
function layerTexelDirection(u, v) {
  const lat = Math.PI * (0.5 - v), lon = 2 * Math.PI * (u - 0.5);
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
}

// The cloud weather map's layout (weatherDirection in planetCloudNoise), in
// cloud space, mirrored back to world space.
export function cloudTexelDirection(u, v) {
  const lon = 2 * Math.PI * u, colat = Math.PI * v;
  return [-Math.sin(colat) * Math.cos(lon), Math.cos(colat), Math.sin(colat) * Math.sin(lon)];
}

export function texelCells(grid, width = MAP_W, height = MAP_H, direction = layerTexelDirection) {
  const cells = new Int32Array(width * height);
  const { dirs, near, neighbours } = grid;
  let cell = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = direction((x + 0.5) / width, (y + 0.5) / height);
      let best = dirs[cell * 3] * d[0] + dirs[cell * 3 + 1] * d[1] + dirs[cell * 3 + 2] * d[2];
      for (let improved = true; improved;) {
        improved = false;
        for (let n = 0; n < neighbours; n++) {
          const j = near[cell * neighbours + n];
          const score = dirs[j * 3] * d[0] + dirs[j * 3 + 1] * d[1] + dirs[j * 3 + 2] * d[2];
          if (score > best) { best = score; cell = j; improved = true; }
        }
      }
      cells[y * width + x] = cell;
    }
  }
  return cells;
}

export function createLifeLayer(doc, parent) {
  const canvas = doc.createElement('canvas');
  canvas.id = 'planet-life-layer';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:none';
  parent.append(canvas);
  let device, context, pipeline, uniform, sampler, maps, group, groupDepth, texels, texelGrid;
  const values = new Float32Array(FADE_AT + MAX_CRATERS);
  const cellLife = new Uint8Array(4 * 4096), cellFx = new Uint8Array(4 * 4096), cellBiome = new Uint8Array(4 * 4096);
  const cellChem = new Uint8Array(4 * 4096);
  const pixels = [0, 1, 2, 3].map(() => new Uint8Array(MAP_W * MAP_H * 4));
  const events = [];
  const craters = [];
  let lastPaint = -1;

  function init(gpu) {
    device = gpu;
    context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const module = device.createShaderModule({ label: 'Planet life layers', code: lifeShader });
    pipeline = device.createRenderPipeline({
      label: 'Planet life layers',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    uniform = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    maps = [0, 1, 2, 3].map(n => device.createTexture({
      label: ['Life map', 'Life effects map', 'Biome map', 'Chemistry map'][n],
      size: [MAP_W, MAP_H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }));
  }

  // Per-cell colours, then spread to texels through the nearest-cell map.
  function paint(sim, layers) {
    if (texelGrid !== sim.grid) {
      texels = texelCells(sim.grid);
      texelGrid = sim.grid;
    }
    const { count } = sim.grid;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const l = sim.lineageOf[i];
      if (l >= 0) {
        const lineage = sim.lineages[l];
        const selected = layers.selectedFamily?.has(l);
        const [r, g, b] = hslToRgb(lineage.hue, selected ? 1 : 0.75, selected ? 0.66 : 0.5);
        cellLife[o] = r * 255; cellLife[o + 1] = g * 255; cellLife[o + 2] = b * 255;
        cellLife[o + 3] = selected ? 250 : 255 * (0.3 + 0.55 * Math.min(1, sim.biomass[i] / 2));
      } else {
        cellLife[o + 3] = 0;
      }
      const kind = HABITAT_KEYS[sim.env.habitat[i]];
      cellFx[o] = 255 * Math.min(1, sim.fire[i]);
      cellFx[o + 1] = 255 * Math.min(1, sim.scar[i]);
      cellFx[o + 2] = HABITAT_COLORS[kind] ? 255 * Math.min(1, sim.organics[i] / 1.5) : 0;
      cellFx[o + 3] = 255 * sim.env.habitat[i] / 5;
      const biome = biomeRgba(sim, i);
      cellBiome[o + 3] = biome ? biome[3] * 255 : 0;
      if (biome) { cellBiome[o] = biome[0] * 255; cellBiome[o + 1] = biome[1] * 255; cellBiome[o + 2] = biome[2] * 255; }
      cellChem[o + 3] = 0;
      if (layers.chemical && layers.chemical !== 'none') {
        const levels = chemicalLevels(sim, i);
        const shown = layers.chemical === 'all' ? CHEMICALS : CHEMICALS.filter(c => c.key === layers.chemical);
        let r = 0, g = 0, b = 0, sum = 0, peak = 0;
        for (const chem of shown) {
          // In the mixed view water is everywhere at sea; weight it down so traces show.
          const w = levels[chem.key] * (layers.chemical === 'all' && chem.key === 'h2o' ? 0.25 : 1);
          r += chem.color[0] * w; g += chem.color[1] * w; b += chem.color[2] * w;
          sum += w; peak = Math.max(peak, w);
        }
        if (sum > 0) {
          cellChem[o] = r / sum; cellChem[o + 1] = g / sum; cellChem[o + 2] = b / sum;
          cellChem[o + 3] = 255 * Math.min(1, peak);
        }
      }
    }
    const sources = [cellLife, cellFx, cellBiome, cellChem];
    for (let m = 0; m < 4; m++) {
      const out = pixels[m], src = sources[m];
      for (let t = 0; t < texels.length; t++) {
        const s = texels[t] * 4, d = t * 4;
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
      }
      device.queue.writeTexture({ texture: maps[m] }, out, { bytesPerRow: MAP_W * 4 }, [MAP_W, MAP_H]);
    }
  }

  return {
    canvas,
    draw({ sim, world, camera, layers, now, sun }) {
      if (!sim || !camera || !world?.depth || canvas.style.display === 'none') return;
      if (device !== world.device) init(world.device);
      const depth = world.depth;
      if (canvas.width !== depth.width || canvas.height !== depth.height) {
        canvas.width = depth.width;
        canvas.height = depth.height;
      }
      if (sim.state.time !== lastPaint || layers.dirty) {
        paint(sim, layers);
        lastPaint = sim.state.time;
        layers.dirty = false;
      }
      if (!group || groupDepth !== depth) {
        groupDepth = depth;
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: depth.createView() },
            ...maps.slice(0, 3).map((map, n) => ({ binding: n + 1, resource: map.createView() })),
            { binding: 4, resource: sampler },
            { binding: 5, resource: { buffer: uniform } },
            { binding: 6, resource: maps[3].createView() },
          ],
        });
      }
      for (let n = events.length - 1; n >= 0; n--) if (now - events[n].start > (events[n].kind === 2 ? 9 : 0.4)) events.splice(n, 1);
      values.fill(0);
      values.set(camera.position, 0); values[3] = world.radius;
      values.set(camera.right, 4); values[7] = camera.tanX;
      values.set(camera.up, 8); values[11] = camera.tanY;
      values.set(camera.forward, 12); values[15] = camera.near;
      values.set(sun ?? [0, 1, 0], 16); values[19] = camera.far;
      values.set([+layers.life, +layers.habitat, +layers.biomes, +layers.scars], 20);
      values.set([+layers.fire, now % 1000, Math.min(events.length, MAX_EVENTS), 0.012 + (layers.chemical && layers.chemical !== 'none' ? 10 : 0)], 24);
      events.slice(-MAX_EVENTS).forEach((event, n) => {
        values.set([...event.dir, event.kind, now - event.start, event.size ?? 0, event.seed, event.seed * 6.283], EVENTS_AT + n * 8);
      });
      // Craters show from the moment the fireball lands and weather over a few hundred Myr.
      craters.slice(-MAX_CRATERS).forEach((crater, n) => {
        const landed = now - crater.start >= 1.2;
        values.set([...crater.dir, landed ? crater.radius : 0], CRATERS_AT + n * 4);
        values[FADE_AT + n] = Math.exp(-Math.max(0, sim.state.time - crater.time) / 400);
      });
      device.queue.writeBuffer(uniform, 0, values);
      const encoder = device.createCommandEncoder({ label: 'Planet life layers' });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    flash(dir, now) {
      events.push({ kind: 1, dir, start: now, seed: Math.random() });
      if (events.length > MAX_EVENTS) events.shift();
    },
    meteor(record, now) {
      events.push({ kind: 2, dir: record.dir, size: record.size, start: now, seed: Math.random() });
      if (events.length > MAX_EVENTS) events.shift();
      craters.push({ dir: record.dir, radius: craterSize(record.size), time: record.time, start: now });
      if (craters.length > MAX_CRATERS) craters.shift();
    },
    clearCraters() { craters.length = 0; },
    setVisible(visible) { canvas.style.display = visible ? '' : 'none'; },
    dispose() {
      for (const map of maps ?? []) map.destroy();
      uniform?.destroy();
      canvas.remove();
    },
  };
}
