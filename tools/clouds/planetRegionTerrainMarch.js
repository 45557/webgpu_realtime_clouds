import {LOCAL_REGION_UNITS} from '../planet/planetRegion.js';
import {REGION_DETAIL_CELLS, REGION_DETAIL_SUBDIVISIONS} from './cloudTerrainMesh.js';
import {MC33_ALL_TABLES} from './mc33Tables.js';
import mc33 from './shaders/mc33.wgsl';
import terrainMarch from './shaders/planetRegionTerrainMarch.wgsl';

export const regionTerrainMarchWGSL = mc33 + '\n' + terrainMarch;

const GROUP_SIZE = 8;
// Each of the two layers has one fixed-sign face, allowing at most four
// MC33 triangles. A triangle intersecting the sea can emit nine vertices.
const MAX_CODES_PER_COLUMN = 2 * 4 * 9;

function marchLOD(region, window) {
  const spacing = region.span / (region.resolution - 1);
  // More ground at the same outer sample count. The immediate foreground
  // still gets the finer grid used for very low flight.
  const divisions = REGION_DETAIL_SUBDIVISIONS * REGION_DETAIL_CELLS / window.cells;
  const strength = Math.ceil(window.strength * 8) / 8;
  const middleCells = 32;
  const middleDivisions = Math.max(divisions, Math.min(6, Math.max(4, Math.ceil(spacing / 16))));
  const middleSamples = window.cells * divisions + middleCells * (middleDivisions - divisions);
  const nearStrength = Math.round(window.nearStrength * 8) / 8;
  const target = 3.5 - nearStrength * (3.5 - .85);
  const targetExtra = Math.max(0, Math.min(64, Math.ceil(spacing / target)) - middleDivisions);
  const available = 504 - middleSamples;
  // Keep the broad flyover grid as the camera descends. Shrink only the
  // closest patch on large tiles and phase in its share of the old budget.
  const nearCells = nearStrength > 0 && targetExtra > 0
    ? Math.min(Math.round(8 - nearStrength * 4), Math.floor(available / targetExtra))
    : 0;
  const extraDivisions = nearCells > 0 ? Math.min(targetExtra, Math.floor(available * nearStrength / nearCells)) : 0;
  const nearDivisions = middleDivisions + extraDivisions;
  const cellWidth = LOCAL_REGION_UNITS / (region.resolution - 1);
  const localFocus = (focus, start) => (focus + LOCAL_REGION_UNITS * .5) / cellWidth - start;
  const middleOrigin = focus => Math.max(0, Math.min(window.cells - middleCells, Math.round((focus - middleCells / 2) / 8) * 8));
  const nearOrigin = (focus, middle) => nearCells === 0 ? middle :
    Math.max(middle, Math.min(middle + middleCells - nearCells, Math.round(focus - nearCells / 2)));
  const x = localFocus(window.focusX, window.startX), z = localFocus(window.focusZ, window.startZ);
  const middleX = middleOrigin(x), middleZ = middleOrigin(z);
  const nearX = nearOrigin(x, middleX), nearZ = nearOrigin(z, middleZ);
  const cells = middleSamples + nearCells * extraDivisions;
  return {cells, divisions, middleCells, middleDivisions, middleX, middleZ, nearCells, nearDivisions, nearX, nearZ, strength, nearStrength};
}

export function createRegionTerrainMarch(device, module, renderConfig, inputs) {
  const compute = (entryPoint, label) => device.createComputePipeline({
    label, layout:'auto', compute:{module, entryPoint},
  });
  const sample = compute('sample_region_march', 'Sample regional terrain isosurface');
  const extract = compute('extract_region_march', 'March regional terrain cubes');
  const render = device.createRenderPipeline({
    ...renderConfig, label:'Regional terrain MC33', layout:'auto',
    primitive:{...renderConfig.primitive, cullMode:'none'},
    vertex:{module, entryPoint:'region_march_vertex'},
  });
  const buffer = (label, size, extra = 0) => device.createBuffer({
    label, size, usage:GPUBufferUsage.STORAGE | extra,
  });
  const uniform = device.createBuffer({
    label:'Regional terrain Marching Cubes LOD', size:64, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const table = buffer('Regional terrain MC33 table', MC33_ALL_TABLES.byteLength, GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(table, 0, MC33_ALL_TABLES);
  const indirect = buffer('Regional terrain indirect draw', 16, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(indirect, 4, new Uint32Array([1, 0, 0]));

  const binding = (index, resource) => ({binding:index, resource:{buffer:resource}});
  const group = (pipeline, slot, entries) => device.createBindGroup({
    layout:pipeline.getBindGroupLayout(slot), entries,
  });
  const coarse = [binding(0, inputs.vertices), binding(1, inputs.materials), binding(2, uniform)];
  const sampleScene = group(sample, 0, [inputs.sampleScene]);
  const sampleDetail = group(sample, 1, coarse);
  const extractDetail = group(extract, 1, [binding(2, uniform)]);
  const renderScene = inputs.renderScene(render);
  const renderDetail = group(render, 1, coarse);
  const descriptor = new ArrayBuffer(64);
  let sampleBuffer, codes, sampleOutput, extractOutput, renderMesh;
  let capacity = 0, signature;

  function reserve(cells) {
    if (cells <= capacity) return;
    sampleBuffer?.destroy();
    codes?.destroy();
    capacity = cells;
    sampleBuffer = buffer('Regional terrain sampled elevations', (cells + 1) ** 2 * 16);
    codes = buffer('Regional terrain MC33 vertex codes', cells ** 2 * MAX_CODES_PER_COLUMN * 4);
    sampleOutput = group(sample, 2, [binding(0, sampleBuffer)]);
    extractOutput = group(extract, 2, [
      binding(0, sampleBuffer), binding(1, codes), binding(2, indirect), binding(5, table),
    ]);
    renderMesh = group(render, 2, [binding(3, sampleBuffer), binding(4, codes)]);
  }

  return {
    destroy() {
      for (const resource of [uniform, table, indirect, sampleBuffer, codes]) resource?.destroy();
    },
    prepare(encoder, region, window) {
      const lod = marchLOD(region, window);
      const key = [window.startX, window.startZ, window.cells, lod.middleX, lod.middleZ, lod.middleDivisions,
        lod.nearX, lod.nearZ, lod.nearDivisions, lod.nearCells, lod.strength, lod.nearStrength].join(',');
      if (key === signature) return;
      signature = key;
      reserve(lod.cells);
      const words = new Uint32Array(descriptor), floats = new Float32Array(descriptor);
      words.set([window.startX, window.startZ, region.resolution, window.cells, lod.middleX, lod.middleZ]);
      floats[6] = lod.strength;
      words.set([lod.divisions, lod.nearX, lod.nearZ, lod.nearCells, lod.nearDivisions], 7);
      floats[12] = lod.nearStrength;
      words.set([lod.middleCells, lod.middleDivisions], 13);
      device.queue.writeBuffer(uniform, 0, descriptor);
      encoder.clearBuffer(indirect, 0, 4);

      const field = encoder.beginComputePass({label:'Sample regional terrain'});
      field.setPipeline(sample);
      field.setBindGroup(0, sampleScene);
      field.setBindGroup(1, sampleDetail);
      field.setBindGroup(2, sampleOutput);
      const points = Math.ceil((lod.cells + 1) / GROUP_SIZE);
      field.dispatchWorkgroups(points, points);
      field.end();

      const march = encoder.beginComputePass({label:'Extract regional terrain'});
      march.setPipeline(extract);
      march.setBindGroup(1, extractDetail);
      march.setBindGroup(2, extractOutput);
      const cubes = Math.ceil(lod.cells / GROUP_SIZE);
      march.dispatchWorkgroups(cubes, cubes);
      march.end();
    },
    draw(pass) {
      pass.setPipeline(render);
      pass.setBindGroup(0, renderScene);
      pass.setBindGroup(1, renderDetail);
      pass.setBindGroup(2, renderMesh);
      pass.drawIndirect(indirect, 0);
    },
  };
}
