export async function readPlanetWeatherProjection(device, pipeline, bindings, projection, resolution) {
  const size = resolution * resolution * Uint32Array.BYTES_PER_ELEMENT;
  const params = device.createBuffer({ size: projection.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    device.queue.writeBuffer(params, 0, projection);
    const encoder = device.createCommandEncoder({ label: 'Capture planet region weather' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    const groups = [
      bindings[0],
      [...bindings[1], { binding: 20, resource: { buffer: params } }, { binding: 21, resource: { buffer: output } }],
    ];
    groups.forEach((entries, i) => pass.setBindGroup(i, device.createBindGroup({ layout: pipeline.getBindGroupLayout(i), entries })));
    pass.dispatchWorkgroups(Math.ceil(resolution / 8), Math.ceil(resolution / 8));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return new Uint8Array(readback.getMappedRange()).slice();
  } finally {
    params.destroy();
    output.destroy();
    readback.destroy();
  }
}
