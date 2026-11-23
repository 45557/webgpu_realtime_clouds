// Keep one spare grid for adjacent flight quality levels. The texel limit
// bounds a spare rgba16float history pair to 16 MiB.
const MAX_SPARE_TEXELS = 1024 * 1024;

function matches(target, width, height, layers, format) {
  return target?.width === width && target.height === height &&
    target.layers === layers && target.format === format;
}

export class CloudRayTargetCache {
  constructor(device, { count = 1, label, usage, retire }) {
    this.device = device;
    this.count = count;
    this.label = label;
    this.usage = usage;
    this.retire = retire;
    this.active = null;
    this.spare = null;
  }

  matchesActive(width, height, layers, format) {
    return matches(this.active, width, height, layers, format);
  }

  releaseSpare() {
    this.spare?.textures.forEach(this.retire);
    this.spare = null;
  }

  acquire(width, height, layers, format, keepPrevious) {
    if (this.matchesActive(width, height, layers, format)) {
      if (!keepPrevious) this.releaseSpare();
      return this.active;
    }

    const previous = this.active;
    const spareMatches = matches(this.spare, width, height, layers, format);
    if (spareMatches) {
      this.active = this.spare;
    } else {
      const textures = Array.from({ length: this.count }, () => this.device.createTexture({
        label: this.label, size: [width, height, layers], format, usage: this.usage,
      }));
      const views = textures.map(texture => texture.createView({ dimension: "2d-array", arrayLayerCount: layers }));
      this.active = { width, height, layers, format, textures, views };
      this.spare?.textures.forEach(this.retire);
    }

    const keep = keepPrevious && previous?.format === format && previous.layers === layers &&
      previous.width * previous.height * previous.layers <= MAX_SPARE_TEXELS;
    this.spare = keep ? previous : null;
    if (!keep) previous?.textures.forEach(this.retire);
    return this.active;
  }
}
