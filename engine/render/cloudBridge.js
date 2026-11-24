// Drives CloudComputeBuilder from the engine: bakes the noise inputs once,
// draws the flat basin terrain, and lets the engine draw its own meshes into
// the same color + ray-distance target the clouds composite against.
// Defaults reproduce the stock flat demo (see cloudLook.js).
import { NoiseComputeBuilder } from '../../tools/noise/noiseCompute.js';
import { CloudComputeBuilder } from '../../tools/clouds/clouds.js';
import {
  FLAT_DEMO_NOISE, FLAT_DEMO_TRANSFORMS, FLAT_DEMO_WIND, FLAT_DEMO_TUNING, FLAT_DEMO_PARAMS, FLAT_DEMO_BOX, FLAT_DEMO_RENDER,
} from './cloudLook.js';

const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Same bake sequence as cloudTest.worker.js (bakeWeather2D / bakeShape128 / bakeDetail32). */
async function bakeInputs(noise, sizes, N = FLAT_DEMO_NOISE) {
  noise.initBlitRender?.();
  const weather = strip(N.weather, ['mode']);
  noise.buildPermTable(weather.seed);
  await noise.computeToTexture(sizes.weather, sizes.weather, { ...weather, toroidal: 1 },
    { noiseChoices: ['clearTexture', N.weather.mode], outputChannel: 1, textureKey: 'weather2d', viewDimension: '2d-array' });
  noise.buildPermTable(N.billow.seed);
  const weatherG = await noise.computeToTexture(sizes.weather, sizes.weather, { ...strip(N.billow, ['mode', 'scale']), toroidal: 1 },
    { noiseChoices: ['clearTexture', N.billow.mode], outputChannel: 2, textureKey: 'weather2d', viewDimension: '2d-array' });
  const weatherView = noise.get2DView('weather2d', { dimension: '2d-array' }) || weatherG;

  const s = sizes.shape;
  const shape = strip(N.shape, ['baseModes', 'bandModes']);
  noise.buildPermTable(shape.seed);
  await noise.computeToTexture3D(s, s, s, { ...shape, toroidal: 1, band: 'base' },
    { noiseChoices: ['clearTexture', ...N.shape.baseModes], outputChannel: 1, id: 'shape' });
  for (let i = 0; i < 3; i++) {
    await noise.computeToTexture3D(s, s, s, { ...shape, zoom: shape.zoom / 2 ** (i + 1), toroidal: 1 },
      { noiseChoices: ['clearTexture', N.shape.bandModes[i]], outputChannel: i + 2, id: 'shape' });
  }

  const d = sizes.detail;
  const detail = strip(N.detail, ['bandModes']);
  noise.buildPermTable(detail.seed);
  for (let i = 0; i < 3; i++) {
    await noise.computeToTexture3D(d, d, d, { ...detail, zoom: detail.zoom / 2 ** i, toroidal: 1 },
      { noiseChoices: ['clearTexture', N.detail.bandModes[i]], outputChannel: i + 1, id: 'detail' });
  }

  noise.buildPermTable(N.blueSeed);
  const blueRaw = await noise.computeToTexture(sizes.blue, sizes.blue, { seed: N.blueSeed },
    { noiseChoices: ['clearTexture', 'computeBlueNoise'], outputChannel: 0, textureKey: 'blue2d', viewDimension: '2d-array' });
  const blueView = noise.get2DView('blue2d') || blueRaw;
  return { weatherView, shape3DView: noise.get3DView('shape'), detail3DView: noise.get3DView('detail'), blueView };
}

/** Thick-box performance tuning, as cloudTest.worker.js autoThickBoxTuning(). */
function autoThickBoxTuning(box) {
  const s = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const [hx, hy, hz] = box.half;
  const xz = Math.max(hx, hz, 0.001), height = Math.max(hy * 2, 0.001);
  const thickF = Math.max(s(0.85, 5.5, height), s(0.045, 0.28, height / xz));
  const reachF = Math.max(thickF, s(24, 120, xz) * 0.85);
  return {
    thickBoxPerf: 0.60 + reachF * 1.90, thickStepBoost: 1.50 + reachF * 2.45,
    thickDetailSkip: 0.040 + thickF * 0.15, thickLightSkip: 0.58 + reachF * 1.55,
  };
}

export class CloudBridge {
  /** @param {GPUDevice} device */
  constructor(device, canvas, { sizes = { weather: 512, shape: 128, detail: 32, blue: 256 } } = {}) {
    this.device = device;
    this.canvas = canvas;
    this.sizes = sizes;
    this.noise = new NoiseComputeBuilder(device, device.queue);
    this.clouds = new CloudComputeBuilder(device, device.queue);
    this.frameIndex = 0;
    this.time = 0;
    /** CloudLayer overrides on top of the demo look. */
    this.layer = { coverage: FLAT_DEMO_PARAMS.globalCoverage, density: FLAT_DEMO_PARAMS.globalDensity, heightOffset: 0, cloudScale: 4,
      renderScale: 4, exposure: FLAT_DEMO_RENDER.exposure, sky: FLAT_DEMO_RENDER.skyColor };
    /** @type {((pass: GPURenderPassEncoder) => void) | null} */
    this.drawScene = null;
  }

  async init() {
    const maps = await bakeInputs(this.noise, this.sizes);
    const c = this.clouds;
    c.setInputMaps(maps);
    c.setOptions({ writeRGB: true, outputChannel: 0, sphericalMode: false, planetStyleMode: false });
    c.setFieldQuality?.('balanced');
    c.setCloudTurbulence?.(0.75);
    c.sceneDrawHook = (pass) => this.drawScene?.(pass);
    const tuning = { ...autoThickBoxTuning(FLAT_DEMO_BOX), ...FLAT_DEMO_TUNING };
    c.setTuning(tuning);
    c.setPerfParams?.({ lodBiasMul: tuning.lodBiasWeather, coarseMipBias: 0 });
    this.applyLayer({});
  }

  applyLayer(layer) {
    this.layer = { ...this.layer, ...layer };
    const L = this.layer;
    this.clouds.setBox(FLAT_DEMO_BOX);
    this.clouds.setParams({ ...FLAT_DEMO_PARAMS, globalCoverage: L.coverage, globalDensity: L.density });
  }

  /** Apply a CloudLayer component's values when they change. */
  applyLayerFromComponent(c) {
    const key = JSON.stringify(c);
    if (key === this.layerKey) return;
    this.layerKey = key;
    this.applyLayer({
      coverage: c.coverage, density: c.density, heightOffset: c.heightOffset, cloudScale: c.cloudScale,
      renderScale: c.renderScale, exposure: c.exposure, sky: c.sky.slice(0, 3),
    });
  }

  resize(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width; this.height = height;
    this.clouds.createOutputTexture(width, height, 1, 'rgba16float');
    this.frameIndex = 0;
  }

  /** Drift the noise fields with the wind. */
  advance(dt) {
    this.time += dt;
    const t = this.time, w = FLAT_DEMO_WIND, T = FLAT_DEMO_TRANSFORMS;
    const drift = (o, v) => [o[0] + v[0] * t, o[1] + v[1] * t, o[2] + v[2] * t];
    this.clouds.setNoiseTransforms({
      ...T,
      shapeOffsetWorld: drift(T.shapeOffsetWorld, w.shape),
      detailOffsetWorld: drift(T.detailOffsetWorld, w.detail),
      weatherOffsetWorld: drift(T.weatherOffsetWorld, w.weather),
    });
  }

  /**
   * Render one frame. Engine meshes are drawn through `drawScene` inside the
   * cloud renderer's terrain pass, so clouds truncate and composite over them.
   * @param {{camPos:number[], right:number[], up:number[], fwd:number[], fovYDeg:number, aspect:number, sunDir:number[]}} view
   */
  async render(view, dt = 0) {
    const L = this.layer;
    const c = this.clouds;
    this.advance(dt);
    const cam = { camPos: view.camPos, right: view.right, up: view.up, fwd: view.fwd, fovYDeg: view.fovYDeg, aspect: view.aspect };
    const box = FLAT_DEMO_BOX;
    c.setViewFromCamera({
      ...cam,
      planetRadius: 0,
      cloudBottom: box.center[1] - box.half[1],
      cloudTop: box.center[1] + box.half[1],
      cloudHeightOffset: L.heightOffset,
      worldToUV: box.uvScale,
      stepBase: 0.02, stepInc: 0.04, volumeLayers: 1,
      terrainEnabled: true,
      cloudScale: L.cloudScale,
    });
    c.setLight({ sunDir: view.sunDir, camPos: view.camPos });
    c.setReprojSettings({ enabled: 0, subsample: 1, sampleOffset: 0, temporalBlend: 0, frameIndex: this.frameIndex,
      fullWidth: this.width, fullHeight: this.height, temporalCellRate: 1, temporalCellPhase: 0, compactInterleave: 0 });
    await c.dispatch({ coarseFactor: L.renderScale });
    c.renderToCanvas(this.canvas, {
      ...FLAT_DEMO_RENDER,
      cam, sunDir: view.sunDir, box,
      exposure: L.exposure, skyColor: L.sky,
      cloudScale: L.cloudScale, cloudHeightOffset: L.heightOffset, terrainEnabled: true,
      silverIntensity: FLAT_DEMO_PARAMS.silverIntensity, silverExponent: FLAT_DEMO_PARAMS.silverExponent,
      compositeQuality: 2, layerIndex: 0,
    });
    this.frameIndex++;
  }
}
