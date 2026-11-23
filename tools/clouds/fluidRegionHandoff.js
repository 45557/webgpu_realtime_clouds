// A fresh tile can enter Fluid on the same document and keep the Planet device.
let pending;

export function stageFluidRegion(device, region) {
  pending = {device, region};
}

export function takeFluidRegion() {
  const handoff = pending;
  pending = undefined;
  return handoff;
}
