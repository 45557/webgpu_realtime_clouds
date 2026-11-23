// WebGPU globe layers for the life simulation. The simulation's cell data is
// painted into equirectangular maps (colonies, effects, biomes), and a
// fullscreen shader projects them onto the terrain using the planet's depth
// buffer, like the cloud passes do. The layer canvas sits under the clouds.
import lifeShader from '../shaders/planetLife.wgsl';
import { HABITATS, bodyPlan } from './planetLifeSim.js';
import { craterAngle, metresPerUnit } from './planetCraters.js';
import { drawImpactor, impactEffects, slantToAltitude, waterCavity } from './impactPhysics.js';
import { riverWidth } from './planetWater.js';
import { createRiverPaths, indexRiverCells, PATH_VEC4, writeRiverPath } from './planetRiverPaths.js';
import { sampleStudioPlanetNoise } from '../../noise/studio.js';

const MAP_W = 512, MAP_H = 256, MAX_EVENTS = 8, MAX_CRATERS = 16, MAX_CELLS = 4096;
// Repaint the cell maps at most this often (the simulation steps faster).
const PAINT_INTERVAL = 1 / 12;

// Spreads per-cell colours to the four equirect maps on the GPU through a
// fixed texel-to-cell index, so the CPU only fills a few thousand cells.
export const EXPAND_SHADER = `
@group(0) @binding(0) var<storage, read> cells: array<u32>;
@group(0) @binding(1) var<storage, read> nearest: array<u32>;
@group(0) @binding(6) var<storage, read> weights: array<vec2<f32>>;
@group(0) @binding(2) var lifeMap: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var fxMap: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var biomeMap: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var chemMap: texture_storage_2d<rgba8unorm, write>;
const W: u32 = ${MAP_W}u; const H: u32 = ${MAP_H}u; const STRIDE: u32 = ${MAX_CELLS}u;
@compute @workgroup_size(8, 8) fn expand(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= W || id.y >= H) { return; }
  let t = id.y * W + id.x;
  let c = vec3<u32>(nearest[t * 3u], nearest[t * 3u + 1u], nearest[t * 3u + 2u]);
  let w2 = weights[t];
  let w = vec3<f32>(w2, 1.0 - w2.x - w2.y);
  let at = vec2<i32>(id.xy);
  textureStore(lifeMap, at, blend(0u, c, w));
  // Habitat kind (fx alpha) is a category: keep the nearest cell's.
  let f0 = unpack4x8unorm(cells[STRIDE + c.x]);
  let fx = f0.rgb * w.x + unpack4x8unorm(cells[STRIDE + c.y]).rgb * w.y + unpack4x8unorm(cells[STRIDE + c.z]).rgb * w.z;
  textureStore(fxMap, at, vec4<f32>(fx, f0.a));
  textureStore(biomeMap, at, blend(2u * STRIDE, c, w));
  textureStore(chemMap, at, blend(3u * STRIDE, c, w));
}
// Alpha-weighted blend of three cells, so colour does not bleed from empty ones.
fn blend(base: u32, c: vec3<u32>, w: vec3<f32>) -> vec4<f32> {
  let a = unpack4x8unorm(cells[base + c.x]);
  let b = unpack4x8unorm(cells[base + c.y]);
  let d = unpack4x8unorm(cells[base + c.z]);
  let alpha = w.x * a.a + w.y * b.a + w.z * d.a;
  let rgb = (a.rgb * a.a * w.x + b.rgb * b.a * w.y + d.rgb * d.a * w.z) / max(alpha, 1e-4);
  return vec4<f32>(rgb, alpha);
}`;
const EVENT_FLOATS = 20, EVENTS_AT = 28, CRATERS_AT = EVENTS_AT + MAX_EVENTS * EVENT_FLOATS, FADE_AT = CRATERS_AT + MAX_CRATERS * 4;
const ORIGIN_AT = FADE_AT + MAX_CRATERS, BODY_SLOTS = 2;
// The local origin snaps to this grid, a multiple of every organism cell size.
const ORIGIN_GRID = 1024;
const PHOTO = 3, GENES = 11;
const HABITAT_KEYS = Object.keys(HABITATS);
const HABITAT_COLORS = { vent: '255,140,60', tidal: '90,220,255', pond: '120,255,200', spring: '255,210,90', lake: '90,160,255', brine: '240,170,220' };
// Rivers below this discharge are not drawn (m³/s).
const MIN_RIVER = 5;
const WATER_FLOATS = 16;

// Rivers, lakes, salt and ice per cell for the shader's WaterCell struct.
// With `paths` (createRiverPaths) each drawn reach also gets its course in
// `pathOut`: PATH_POINTS points (xyz, w meander phase), then (centre xyz,
// reach radius) and (meander amplitude m, 0, 0, 0).
export function paintWater(sim, out, paths = null, pathOut = null, radius = 262144, texelIds = null) {
  const { water, env, grid } = sim;
  const count = Math.min(out.length / WATER_FLOATS, grid.count);
  const d = grid.dirs;
  paths?.use(grid);
  const reaches = [];
  // The main river into each cell: the biggest one that drains to it.
  const main = upstream ??= new Int32Array(out.length / WATER_FLOATS);
  main.fill(-1);
  for (let i = 0; i < count; i++) {
    const r = water.shown[i];
    if (r >= 0 && r < count && (main[r] < 0 || water.discharge[i] > water.discharge[main[r]])) main[r] = i;
  }
  const drawn = i => !env.ocean[i] && water.lakeCover[i] <= 0.5 && water.shown[i] >= 0 && water.shown[i] < count &&
    water.discharge[i] * water.toM3s >= MIN_RIVER;
  for (let i = 0; i < count; i++) {
    const o = i * WATER_FLOATS;
    out[o] = d[i * 3]; out[o + 1] = d[i * 3 + 1]; out[o + 2] = d[i * 3 + 2];
    const q = water.discharge[i] * water.toM3s, r = water.shown[i];
    let width = 0;
    out[o + 4] = out[o + 5] = out[o + 6] = out[o + 7] = 0;
    if (drawn(i)) {
      width = riverWidth(q);
      // Into the sea a river stops at the shore, half way to the sea cell.
      let x = d[r * 3], y = d[r * 3 + 1], z = d[r * 3 + 2];
      if (env.ocean[r]) {
        x = 0.5 * (x + out[o]); y = 0.5 * (y + out[o + 1]); z = 0.5 * (z + out[o + 2]);
        const l = Math.hypot(x, y, z);
        x /= l; y /= l; z /= l;
      }
      out[o + 4] = x; out[o + 5] = y; out[o + 6] = z;
      out[o + 7] = Math.min(1, Math.log10(q / MIN_RIVER) / 3);
      if (paths && pathOut) { writeRiverPath(paths, pathOut, i, r, !!env.ocean[r], width, radius); reaches.push(i); }
    }
    out[o + 3] = width;
    out[o + 8] = water.lakeCover[i];
    out[o + 9] = env.ocean[i] ? 0 : water.salt[i];
    out[o + 10] = water.ice[i];
  }
  // Second pass, once every cell's own reach is known.
  for (let i = 0; i < count; i++) {
    const o = i * WATER_FLOATS, j = main[i], u = j * WATER_FLOATS;
    const ok = j >= 0 && out[u + 3] > 0;
    out[o + 12] = ok ? out[u] : 0; out[o + 13] = ok ? out[u + 1] : 0; out[o + 14] = ok ? out[u + 2] : 0;
    out[o + 15] = ok ? out[u + 3] : 0;
    // The main river in, by cell index (-1 for none).
    out[o + 11] = ok ? j : -1;
  }
  if (paths && pathOut && texelIds) indexRiverCells(pathOut, reaches, water.discharge, texelIds, MAP_W, MAP_H, count);
  return drawn;
}
let upstream = null;


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
  let green = 0;
  const slots = sim.slots ?? 1;
  for (let k = i * slots; k < i * slots + slots; k++) {
    if (sim.lineageOf[k] >= 0 && sim.genome[k * GENES + PHOTO] > 0.4) green += sim.biomass[k];
  }
  const greenery = Math.min(1, green / 1.5);
  const m = env.moisture[i];
  if (t < 5) return [0.59, 0.65, 0.55, 0.35 + 0.2 * greenery];
  if (m < 0.25) return [0.86, 0.7, 0.43, 0.45];
  if (greenery > 0.2) return t > 22 && m > 0.5 ? [0.08, 0.47, 0.2, 0.55] : [0.24, 0.55, 0.24, 0.5];
  return [0.67, 0.67, 0.35, 0.4];
}

// Plant cover on land where photosynthetic colonies live, in natural
// greens by climate (the terrain itself is drawn bare; see planetBareGround).
export function vegetationRgba(sim, i) {
  const { env } = sim;
  if (env.ocean[i] || env.water[i]) return null;
  let green = 0;
  const slots = sim.slots ?? 1;
  for (let k = i * slots; k < i * slots + slots; k++) {
    if (sim.lineageOf[k] >= 0) green += sim.genome[k * GENES + PHOTO] * sim.biomass[k];
  }
  if (green < 0.02) return null;
  const cover = Math.min(1, green / 1.2);
  const t = sim.temperature[i], m = env.moisture[i];
  // Dry ground olive, cold ground grey-green, warm and wet ground deep green.
  const rgb = m < 0.3 ? [0.42, 0.45, 0.22] : t < 5 ? [0.3, 0.4, 0.27] : t > 22 && m > 0.55 ? [0.1, 0.34, 0.12] : [0.2, 0.42, 0.17];
  return [...rgb, 0.15 + 0.65 * cover];
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

// For a smooth heatmap each texel blends its nearest cell and the next two
// closest among that cell's neighbours, with Gaussian weights on distance.
// Returns cells (3 per texel) and the first two weights (the third is the rest).
export function texelBlend(grid, width = MAP_W, height = MAP_H, direction = layerTexelDirection) {
  const nearest = texelCells(grid, width, height, direction);
  const { dirs, near, neighbours, spacing } = grid;
  const cells = new Uint32Array(nearest.length * 3), weights = new Float32Array(nearest.length * 2);
  const width2 = 0.55 * spacing * spacing;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = y * width + x, c = nearest[t];
    const d = direction((x + 0.5) / width, (y + 0.5) / height);
    const dist = j => 2 * (1 - (dirs[j * 3] * d[0] + dirs[j * 3 + 1] * d[1] + dirs[j * 3 + 2] * d[2]));
    let a = -1, b = -1, da = Infinity, db = Infinity;
    for (let n = 0; n < neighbours; n++) {
      const j = near[c * neighbours + n], dj = dist(j);
      if (dj < da) { b = a; db = da; a = j; da = dj; } else if (dj < db) { b = j; db = dj; }
    }
    const w0 = 1, w1 = Math.exp(-(da - dist(c)) / width2), w2 = Math.exp(-(db - dist(c)) / width2);
    const sum = w0 + w1 + w2;
    cells[t * 3] = c; cells[t * 3 + 1] = a; cells[t * 3 + 2] = b;
    weights[t * 2] = w0 / sum; weights[t * 2 + 1] = w1 / sum;
  }
  return { cells, weights };
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
  let device, context, pipeline, uniform, sampler, maps, group, groupDepth, texelGrid;
  let expandPipeline, expandGroup, cellBuffer, indexBuffer, weightBuffer, lastPaintAt = -Infinity;
  const values = new Float32Array(ORIGIN_AT + 12);
  // Per colony site: body size, form, density, speed, then rgb and a spare.
  const bodyData = new Float32Array(MAX_CELLS * BODY_SLOTS * 8);
  let bodyBuffer, groundRadius = 0, groundAt = -Infinity;
  const waterData = new Float32Array(MAX_CELLS * WATER_FLOATS);
  let waterBuffer, pathBuffer;
  // River courses along the terrain, traced a little at a time.
  const riverPaths = createRiverPaths({ budgetMs: 1 });
  const pathData = new Float32Array(MAX_CELLS * PATH_VEC4 * 4);
  // Four layers of packed RGBA per cell: life, effects, biome, chemistry.
  const cellBytes = new Uint8Array(4 * 4 * MAX_CELLS);
  const cellLife = cellBytes.subarray(0, 4 * MAX_CELLS), cellFx = cellBytes.subarray(4 * MAX_CELLS, 8 * MAX_CELLS);
  const cellBiome = cellBytes.subarray(8 * MAX_CELLS, 12 * MAX_CELLS), cellChem = cellBytes.subarray(12 * MAX_CELLS);
  const events = [];
  const craters = [];
  let planetRadius = 262144;
  // Lightning comes and goes in a blink; make room by dropping a bolt first.
  const push = (event) => {
    events.push(event);
    if (events.length <= MAX_EVENTS) return;
    const bolt = events.findIndex(e => e.kind === 1);
    events.splice(bolt >= 0 ? bolt : 0, 1);
  };
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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    }));
    cellBuffer = device.createBuffer({ label: 'Life cells', size: cellBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    indexBuffer = device.createBuffer({ label: 'Life texel cells', size: MAP_W * MAP_H * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    weightBuffer = device.createBuffer({ label: 'Life texel weights', size: MAP_W * MAP_H * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    bodyBuffer = device.createBuffer({ label: 'Life body plans', size: bodyData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    waterBuffer = device.createBuffer({ label: 'Surface water', size: waterData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    pathBuffer = device.createBuffer({ label: 'River courses', size: pathData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    expandPipeline = device.createComputePipeline({
      label: 'Planet life map expand', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'Planet life map expand', code: EXPAND_SHADER }), entryPoint: 'expand' },
    });
    expandGroup = device.createBindGroup({
      layout: expandPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: cellBuffer } },
        { binding: 1, resource: { buffer: indexBuffer } },
        ...maps.map((map, n) => ({ binding: n + 2, resource: map.createView() })),
        { binding: 6, resource: { buffer: weightBuffer } },
      ],
    });
    texelGrid = null;
    group = null;
  }

  // Lineage colours, cached per lineage and selection state.
  const lineageColors = new Map();
  function lineageRgb(lineage, chosen) {
    const key = lineage.id * 2 + (chosen ? 1 : 0);
    let rgb = lineageColors.get(key);
    if (!rgb) {
      rgb = hslToRgb(lineage.hue, chosen ? 1 : 0.75, chosen ? 0.66 : 0.5);
      if (lineageColors.size > 20000) lineageColors.clear();
      lineageColors.set(key, rgb);
    }
    return rgb;
  }

  // What an individual of each colony looks like up close. Sea life stays
  // under the water surface, so only land and shore colonies are drawn.
  const plans = new Map();
  function paintBodies(sim, i, slots) {
    for (let n = 0; n < BODY_SLOTS; n++) {
      const k = i * slots + n, o = (i * BODY_SLOTS + n) * 8;
      const l = n < slots ? sim.lineageOf[k] : -1;
      if (l < 0 || sim.env.ocean[i]) { bodyData[o + 1] = 0; continue; }
      const lineage = sim.lineages[l];
      // A lineage keeps its founder's body plan; small drifts do not resize it.
      let plan = plans.get(lineage);
      if (!plan) {
        plan = bodyPlan(lineage.founder);
        if (plans.size > 20000) plans.clear();
        plans.set(lineage, plan);
      }
      const rgb = lineageRgb(lineage, false);
      bodyData[o] = plan.size; bodyData[o + 1] = plan.form;
      bodyData[o + 2] = 1 - Math.exp(-sim.biomass[k] / 0.9); bodyData[o + 3] = plan.speed;
      bodyData[o + 4] = rgb[0]; bodyData[o + 5] = rgb[1]; bodyData[o + 6] = rgb[2];
    }
  }

  // Per-cell colours, then spread to texels through the nearest-cell map.
  // Ground height in metres for tracing rivers: the height atlas the terrain
  // is built from (cheap to sample), else the renderer's own sampler.
  function groundHeight(world) {
    const atlas = world?.studioMap;
    const scale = atlas?.values ? metresPerUnit(world, atlas) : null;
    if (scale) return d => sampleStudioPlanetNoise(atlas, d) * scale;
    if (world?.sampleSurface) return d => { const s = world.sampleSurface(d); return (s.height ?? 0) - (s.depth ?? 0); };
    return null;
  }

  let drawnRiver = null, pathVersion = -1, riversAt = -Infinity, texelIds = null;
  function paintRivers(sim, count) {
    drawnRiver = paintWater(sim, waterData, riverPaths, pathData, planetRadius, texelIds);
    device.queue.writeBuffer(waterBuffer, 0, waterData, 0, count * WATER_FLOATS);
    device.queue.writeBuffer(pathBuffer, 0, pathData, 0, count * PATH_VEC4 * 4);
    pathVersion = riverPaths.version;
  }
  // Trace new reaches within about a millisecond (and `refresh` old ones
  // again); they show from the next repaint.
  function traceRivers(sim, world, count, refresh = 0) {
    if (!drawnRiver) return;
    const { water, env } = sim, drawn = drawnRiver;
    riverPaths.update({
      grid: sim.grid, height: groundHeight(world), relief: env.relief, refresh,
      rivers: i => i < count && drawn(i) ? water.shown[i] : -1,
      sea: i => !!env.ocean[water.shown[i]],
    });
  }

  function paint(sim, layers, world) {
    if (texelGrid !== sim.grid) {
      const { cells, weights } = texelBlend(sim.grid);
      texelIds = cells;
      device.queue.writeBuffer(indexBuffer, 0, cells);
      device.queue.writeBuffer(weightBuffer, 0, weights);
      texelGrid = sim.grid;
    }
    const count = Math.min(MAX_CELLS, sim.grid.count);
    const slots = sim.slots ?? 1;
    const chemShown = layers.chemical && layers.chemical !== 'none';
    const shown = layers.chemical === 'all' ? CHEMICALS : CHEMICALS.filter(c => c.key === layers.chemical);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      // Density heatmap: every colony in the cell adds its colour by biomass,
      // so overlapping lifeforms mix, and the total sets how dense it reads.
      let r = 0, g = 0, b = 0, mass = 0, selected = false;
      for (let k = i * slots; k < i * slots + slots; k++) {
        const l = sim.lineageOf[k];
        if (l < 0) continue;
        const lineage = sim.lineages[l];
        const chosen = layers.selectedFamily?.has(l);
        selected ||= chosen;
        const w = sim.biomass[k] * (chosen ? 3 : 1);
        const rgb = lineageRgb(lineage, chosen);
        r += rgb[0] * w; g += rgb[1] * w; b += rgb[2] * w; mass += w;
      }
      if (mass > 0) {
        cellLife[o] = 255 * r / mass; cellLife[o + 1] = 255 * g / mass; cellLife[o + 2] = 255 * b / mass;
        const density = 1 - Math.exp(-mass / 1.1);
        cellLife[o + 3] = 255 * (selected ? Math.max(0.85, density) : 0.12 + 0.8 * density);
      } else {
        cellLife[o + 3] = 0;
      }
      const kind = HABITAT_KEYS[sim.env.habitat[i]];
      cellFx[o] = 255 * Math.min(1, sim.fire[i]);
      cellFx[o + 1] = 255 * Math.min(1, sim.scar[i]);
      cellFx[o + 2] = HABITAT_COLORS[kind] ? 255 * Math.min(1, sim.organics[i] / 1.5) : 0;
      cellFx[o + 3] = 255 * sim.env.habitat[i] / 7;
      const biome = layers.biomes ? biomeRgba(sim, i) : layers.bareGround ? vegetationRgba(sim, i) : null;
      cellBiome[o + 3] = biome ? biome[3] * 255 : 0;
      if (biome) { cellBiome[o] = biome[0] * 255; cellBiome[o + 1] = biome[1] * 255; cellBiome[o + 2] = biome[2] * 255; }
      paintBodies(sim, i, slots);
      cellChem[o + 3] = 0;
      if (chemShown) {
        const levels = chemicalLevels(sim, i);
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
    device.queue.writeBuffer(cellBuffer, 0, cellBytes);
    device.queue.writeBuffer(bodyBuffer, 0, bodyData, 0, count * BODY_SLOTS * 8);
    if (layers.water !== false && sim.water) {
      paintRivers(sim, count);
      traceRivers(sim, world, count, 6);
    }
    const encoder = device.createCommandEncoder({ label: 'Planet life map expand' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(expandPipeline);
    pass.setBindGroup(0, expandGroup);
    pass.dispatchWorkgroups(MAP_W / 8, MAP_H / 8);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    canvas,
    draw({ sim, world, camera, layers, now, sun }) {
      if (!sim || !camera || !world?.depth || canvas.style.display === 'none') return;
      if (device !== world.device) init(world.device);
      const depth = world.depth;
      if (world.radius > 1000) planetRadius = world.radius;
      if (canvas.width !== depth.width || canvas.height !== depth.height) {
        canvas.width = depth.width;
        canvas.height = depth.height;
      }
      if (layers.dirty || (sim.state.time !== lastPaint && now - lastPaintAt >= PAINT_INTERVAL)) {
        paint(sim, layers, world);
        lastPaint = sim.state.time;
        lastPaintAt = now;
        layers.dirty = false;
      } else if (layers.water !== false && sim.water && drawnRiver) {
        // Between repaints, keep tracing rivers and show them as they come.
        const count = Math.min(MAX_CELLS, sim.grid.count);
        traceRivers(sim, world, count);
        if (riverPaths.version !== pathVersion && now - riversAt > 0.1) { paintRivers(sim, count); riversAt = now; }
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
            { binding: 7, resource: { buffer: bodyBuffer } },
            { binding: 8, resource: { buffer: indexBuffer } },
            { binding: 9, resource: { buffer: weightBuffer } },
            { binding: 10, resource: { buffer: waterBuffer } },
            { binding: 11, resource: { buffer: pathBuffer } },
          ],
        });
      }
      for (let n = events.length - 1; n >= 0; n--) if (now - events[n].start > (events[n].life ?? 0.4)) events.splice(n, 1);
      values.fill(0);
      values.set(camera.position, 0); values[3] = world.radius;
      values.set(camera.right, 4); values[7] = camera.tanX;
      values.set(camera.up, 8); values[11] = camera.tanY;
      values.set(camera.forward, 12); values[15] = camera.near;
      values.set(sun ?? [0, 1, 0], 16); values[19] = camera.far;
      values.set([+layers.life, +layers.habitat, +(layers.biomes || !!layers.bareGround), +layers.scars], 20);
      values.set([+layers.fire, now % 1000, Math.min(events.length, MAX_EVENTS), 0.012 + (layers.chemical && layers.chemical !== 'none' ? 10 : 0)], 24);
      events.slice(-MAX_EVENTS).forEach((event, n) => {
        // Strike the drawn ground (land or sea surface), not the bare radius.
        event.scale ??= world.sampleSurface ? 1 + world.sampleSurface(event.dir).height / world.radius : 1;
        const at = EVENTS_AT + n * EVENT_FLOATS;
        values.set([...event.dir.map(v => v * event.scale), event.kind, now - event.start, event.diameter ?? 0, event.seed, event.seed * 6.283], at);
        if (event.path) values.set([...event.path, ...event.effect, ...event.wave], at + 8);
      });
      // Craters show from the moment the fireball lands and weather over a few hundred Myr.
      craters.slice(-MAX_CRATERS).forEach((crater, n) => {
        const landed = now - crater.start >= crater.flight;
        values.set([...crater.dir, landed ? crater.radius : 0], CRATERS_AT + n * 4);
        values[FADE_AT + n] = Math.exp(-Math.max(0, sim.state.time - crater.time) / 400);
      });
      // Organisms: a local origin near the camera keeps their positions precise.
      const origin = camera.position.map(v => Math.round(v / ORIGIN_GRID) * ORIGIN_GRID);
      if (now - groundAt > 0.25 && world.sampleSurface) {
        const r = Math.hypot(...camera.position);
        groundRadius = world.radius + world.sampleSurface(camera.position.map(v => v / r)).height;
        groundAt = now;
      }
      const camHeight = Math.max(0.1, Math.hypot(...camera.position) - groundRadius);
      values.set([...origin, 2 * camera.tanY / depth.height], ORIGIN_AT);
      values.set([...camera.position.map((v, n) => v - origin[n]), layers.organisms !== false && layers.life ? 1 : 0], ORIGIN_AT + 4);
      values.set([groundRadius || world.radius, camHeight, layers.water !== false && sim.water ? 1 : 0], ORIGIN_AT + 8);
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
      push({ kind: 1, dir, start: now, seed: Math.random(), life: 0.4 });
    },
    meteor(record, now) {
      const R = planetRadius;
      const physics = record.physics ?? impactEffects(drawImpactor(record.size ?? 0.3), { radius: R });
      const water = record.water ?? 0;
      const cavity = waterCavity(physics, water);
      const burstSlant = physics.airburst ? slantToAltitude(physics.burstAltitude, physics.angle, R) : 0;
      const excavation = physics.excavation || 0;
      // On screen until the trains fade, the crater settles and the sea waves run out.
      const life = physics.flight + Math.max(40, 6 * excavation + 20, cavity.radius ? 300 : 0);
      push({ kind: 2, dir: record.dir, diameter: physics.diameter, start: now, seed: Math.random(), life,
        path: [physics.flight, physics.angle, physics.azimuth ?? 0, burstSlant],
        effect: [physics.craterDiameter / 2, physics.fireball, water, excavation],
        wave: [cavity.radius, cavity.amplitude, physics.entryVelocity, physics.impactVelocity] });
      if (physics.craterDiameter > 0) {
        craters.push({ dir: record.dir, radius: craterAngle({ ...record, physics }, R), time: record.time, start: now, flight: physics.flight });
        if (craters.length > MAX_CRATERS) craters.shift();
      }
    },
    clearCraters() { craters.length = 0; },
    setVisible(visible) { canvas.style.display = visible ? '' : 'none'; },
    dispose() {
      for (const map of maps ?? []) map.destroy();
      cellBuffer?.destroy();
      indexBuffer?.destroy();
      weightBuffer?.destroy();
      bodyBuffer?.destroy();
      waterBuffer?.destroy();
      pathBuffer?.destroy();
      uniform?.destroy();
      canvas.remove();
    },
  };
}
