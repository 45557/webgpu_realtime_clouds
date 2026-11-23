export const regionGridShader = /* wgsl */`
struct RegionGrid {
  normal: vec3<f32>,
  halfAngle: f32,
  east: vec3<f32>,
  side: u32,
  south: vec3<f32>,
  footprint: f32,
  seed: u32,
}
`;

export function planetRegionGridDescriptor(world, frame, span, side) {
  const descriptor = new ArrayBuffer(64);
  const values = new Float32Array(descriptor);
  values.set(frame.up);
  values[3] = span / (2 * world.radius);
  values.set(frame.east, 4);
  new Uint32Array(descriptor)[7] = side;
  values.set(frame.south, 8);
  values[11] = span / (side - 1);
  new Uint32Array(descriptor)[12] = world.studioSeed;
  return descriptor;
}

export function planetRegionShapeJob(world, frame, span, side) {
  // Match TileJob in the Planet height shader. Face 7 identifies the tangent
  // grid and leaves the cubed-sphere jobs and single-point probes unchanged.
  const job = new ArrayBuffer(48);
  const words = new Uint32Array(job);
  const values = new Float32Array(job);
  values.set(frame.up);
  words[3] = 7;
  values.set(frame.east, 4);
  words[7] = side;
  values.set(frame.south, 8);
  values[11] = span / (2 * world.radius);
  return job;
}

async function loadRegionShapeInputs(world, studioMap) {
  if (!world.startupPreview || world.studioVertices?.guide) return;
  const request = world.requestedWorld;
  const startupMap = world.startupMap;
  const ready = await (world.startupVertices ?? world.prepareStudioVertices(request));
  if (world.studioMap !== studioMap || world.requestedWorld !== request) {
    throw new Error('Planet terrain changed. Select the region again.');
  }
  // The local sampler needs the height recipe and guide, not the orbit's
  // mesh, render pipelines or shadow maps. A concurrent orbit upgrade can
  // also supply these inputs, so check again after waiting for the guide.
  if (world.startupPreview && !world.studioVertices?.guide) {
    world.uploadProceduralWorld(ready, startupMap, request);
  }
}

export async function preparePlanetRegionShape(world) {
  const {studioMap} = world;
  await loadRegionShapeInputs(world, studioMap);
  if (world.studioMap !== studioMap || world.terrainSampling !== 'procedural') {
    throw new Error('Planet terrain changed. Select the region again.');
  }
  const studio = world.studioVertices;
  const rowsPerGroup = world.regionPointRows ?? 1;
  return (encoder, job, shape, side) => {
    const [permutationsGroup, inputs] = studio.groups(job, shape);
    const pass = encoder.beginComputePass({label: 'Sample Planet region height'});
    pass.setPipeline(studio.pipeline);
    pass.setBindGroup(0, permutationsGroup);
    pass.setBindGroup(1, inputs);
    pass.dispatchWorkgroups(Math.ceil(side / 16), Math.ceil(side / rowsPerGroup));
    pass.end();
  };
}
