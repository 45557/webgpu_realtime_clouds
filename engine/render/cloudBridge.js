// Drives CloudComputeBuilder from the engine: bakes the noise inputs once,
// draws the flat basin terrain, and lets the engine draw its own meshes into
// the same color + ray-distance target the clouds composite against.
import { NoiseComputeBuilder } from '../../tools/noise/noiseCompute.js';
import { CloudComputeBuilder } from '../../tools/clouds/clouds.js';

const SEED = 123456789;

/** @param {NoiseComputeBuilder} noise */
async function bakeInputs(noise, sizes) {
  noise.initBlitRender?.();
  noise.buildPermTable(SEED);
  const common = { lacunarity: 2, gain: 0.5, threshold: 0, seedAngle: Math.PI / 2, time: 0, voroMode: 0, edgeK: 0, warpAmp: 0, toroidal: 1 };
  await noise.computeToTexture(sizes.weather, sizes.weather, { ...common, mode: 'computeFBM4D', seed: 123456789001, zoom: 4, freq: 1, octaves: 5 },
    { noiseChoices: ['clearTexture', 'computeFBM4D'], outputChannel: 1, textureKey: 'weather2d', viewDimension: '2d-array' });
  const weatherRView = await noise.computeToTexture(sizes.weather, sizes.weather, { ...common, seed: 123456789000, zoom: 4, freq: 1.5, octaves: 4 },
    { noiseChoices: ['clearTexture', 'computeBillow4D'], outputChannel: 2, textureKey: 'weather2d', viewDimension: '2d-array' });
  const weatherView = noise.get2DView('weather2d', { dimension: '2d-array' }) || weatherRView;
  const s = sizes.shape;
  const shapeBase = { ...common, seed: SEED, zoom: 4, freq: 1, octaves: 2, threshold: 0.4, voroMode: 4 };
  await noise.computeToTexture3D(s, s, s, { ...shapeBase, band: 'base' }, { noiseChoices: ['clearTexture', 'computePerlin4D', 'computeAntiWorley4D'], outputChannel: 1, id: 'shape' });
  for (const [ch, zoom] of [[2, 2], [3, 1], [4, 0.5]]) {
    await noise.computeToTexture3D(s, s, s, { ...shapeBase, zoom }, { noiseChoices: ['clearTexture', 'computeWorley4D'], outputChannel: ch, id: 'shape' });
  }
  const d = sizes.detail;
  const detailBase = { ...common, seed: SEED + 7, freq: 1, octaves: 4 };
  for (const [ch, zoom] of [[1, 4], [2, 2], [3, 1]]) {
    await noise.computeToTexture3D(d, d, d, { ...detailBase, zoom }, { noiseChoices: ['clearTexture', 'computeWorley4D'], outputChannel: ch, id: 'detail' });
  }
  const blueRaw = await noise.computeToTexture(sizes.blue, sizes.blue, { seed: SEED + 3 },
    { noiseChoices: ['clearTexture', 'computeBlueNoise'], outputChannel: 0, textureKey: 'blue2d', viewDimension: '2d-array' });
  const blueView = noise.get2DView('blue2d') || blueRaw;
  return { weatherView, shape3DView: noise.get3DView('shape'), detail3DView: noise.get3DView('detail'), blueView };
}

/** Default look for the flat mountain basin: a cumulus deck above the valley floor. */
export const DEFAULT_CLOUD_LAYER = Object.freeze({
  box: { center: [0, 0, 0], half: [18, 0.3, 18], uvScale: 1 },
  cloudScale: 4,
  heightOffset: 6,
  coverage: 1.0,
  density: 1000,
  renderScale: 3,
  exposure: 1.18,
  sky: [0.60, 0.75, 0.98],
});

export class CloudBridge {
  /** @param {GPUDevice} device */
  constructor(device, canvas, { sizes = { weather: 512, shape: 128, detail: 32, blue: 256 } } = {}) {
    this.device = device;
    this.canvas = canvas;
    this.sizes = sizes;
    this.noise = new NoiseComputeBuilder(device, device.queue);
    this.clouds = new CloudComputeBuilder(device, device.queue);
    this.layer = { ...DEFAULT_CLOUD_LAYER };
    this.frameIndex = 0;
    /** @type {((pass: GPURenderPassEncoder, view: object) => void) | null} */
    this.drawScene = null;
  }

  async init() {
    const maps = await bakeInputs(this.noise, this.sizes);
    this.clouds.setInputMaps(maps);
    this.clouds.setOptions({ writeRGB: true, outputChannel: 0, sphericalMode: false, planetStyleMode: false });
    this.clouds.sceneDrawHook = (pass) => this.drawScene?.(pass);
    this.applyLayer(this.layer);
  }

  applyLayer(layer) {
    this.layer = { ...this.layer, ...layer };
    const L = this.layer;
    const c = this.clouds;
    c.setBox(L.box);
    c.setParams({
      globalCoverage: L.coverage, globalDensity: L.density, cloudAnvilAmount: 0.1, cloudBeer: 6.0,
      attenuationClamp: 0.015, inScatterG: 0.55, outScatterG: 0.08, inVsOut: 0.55,
      silverIntensity: 12.0, silverExponent: 12.0, silverDirectionBias: 0.9, silverHorizonBoost: 0.35,
      ambientMinimum: 0.04, outScatterAmbientAmt: 0.08,
      sunColor: [1.0, 0.985, 0.95], frontLightColor: [1.10, 1.12, 1.16], shadowLightColor: [0.62, 0.68, 0.78],
    });
    c.setNoiseTransforms({ shapeScale: 0.1, detailScale: 1.0, weatherScale: 1.0, shapeBias: 0.4, detailBias: 0.0, weatherBias: 0.3 });
    c.setTuning({
      maxSteps: 256, minStep: 0.003, maxStep: 0.16, sunSteps: 6, sunStride: 3, baseJitterFrac: 0.02, topJitterFrac: 0.1,
      raySmoothDens: 0.34, raySmoothSun: 0.34, fluffFactor: 2.0, alphaCutoff: 0.98,
      frontOcclusionStrength: 0.72, frontOcclusionAlpha: 0.66, frontOcclusionStepBoost: 3.0,
      sliceJitterStrength: 0.18, verticalLayerDecorrelation: 0.35, directLightBlend: 0.78, directLightBoost: 0.58,
      alphaBoostThreshold: 0.22, alphaBoostAmount: 0.16,
    });
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

  /**
   * Render one frame. Engine meshes are drawn through `drawScene` inside the
   * cloud renderer's terrain pass, so clouds truncate and composite over them.
   * @param {{camPos:number[], right:number[], up:number[], fwd:number[], fovYDeg:number, aspect:number, sunDir:number[]}} view
   */
  async render(view) {
    const L = this.layer;
    const c = this.clouds;
    const cam = { camPos: view.camPos, right: view.right, up: view.up, fwd: view.fwd, fovYDeg: view.fovYDeg, aspect: view.aspect };
    c.setViewFromCamera({
      ...cam,
      terrainEnabled: true,
      cloudScale: L.cloudScale,
      cloudHeightOffset: L.heightOffset,
      cloudBottom: L.box.center[1] - L.box.half[1],
      cloudTop: L.box.center[1] + L.box.half[1],
    });
    c.setLight({ sunDir: view.sunDir, camPos: view.camPos });
    c.setReprojSettings({ enabled: 0, frameIndex: this.frameIndex, fullWidth: this.width, fullHeight: this.height });
    await c.dispatch({ coarseFactor: L.renderScale });
    c.renderToCanvas(this.canvas, {
      cam, sunDir: view.sunDir, skyColor: L.sky, exposure: L.exposure, gradeStyle: 3, sunBloom: 0.18,
      cloudScale: L.cloudScale, cloudHeightOffset: L.heightOffset, terrainEnabled: true,
      godRaysEnabled: false, fogDensity: 0.34, fogHorizon: 0.30, fogSun: 1.5, box: L.box,
    });
    this.frameIndex++;
  }
}
