// The stock flat demo's startup look ("cumulonimbus_anvil" over the mountain
// basin), captured from the values cloudTestThreaded.js sends to its worker.
// Keeping these in one place means the engine's clouds match the demo.

export const FLAT_DEMO_NOISE = {
  weather: { mode: 'computeFBM4D', seed: 3197704713, zoom: 3.55, freq: 1, octaves: 5, lacunarity: 2, seedAngle: Math.PI / 2, gain: 0.5, threshold: 0, time: 0, voroMode: 0, edgeK: 0, warpAmp: 0 },
  billow: { mode: 'computeBillow4D', seed: 3197704712, zoom: 4.3, freq: 1.55, octaves: 4, lacunarity: 2, seedAngle: Math.PI / 2, gain: 0.5, threshold: 0, time: 0, voroMode: 0, edgeK: 0, warpAmp: 0, scale: 1 },
  shape: { seed: 242649276, zoom: 4.6, freq: 1.05, octaves: 2, lacunarity: 2, seedAngle: Math.PI / 2, gain: 0.5, threshold: 0.4, time: 0, voroMode: 4, edgeK: 0, warpAmp: 0,
    baseModes: ['computeAntiWorley4D'], bandModes: ['computeAntiWorley4D', 'computeAntiWorley4D', 'computeAntiWorley4D'] },
  detail: { seed: 242649276, zoom: 6.3, freq: 1.55, octaves: 4, lacunarity: 2, seedAngle: Math.PI / 2, gain: 0.5, threshold: 0, time: 0, voroMode: 7, edgeK: 0, warpAmp: 0,
    bandModes: ['computeWorley4D', 'computeWorley4D', 'computeWorley4D'] },
  blueSeed: 242649276,
};

export const FLAT_DEMO_TRANSFORMS = {
  shapeOffsetWorld: [0, 0, 0], detailOffsetWorld: [0, 0, 0], weatherOffsetWorld: [0, 0, 0],
  shapeScale: 0.132, detailScale: 2.05, weatherScale: 1,
  shapeAxisScale: [1, 2.86, 1], detailAxisScale: [1, 3.25, 1], weatherAxisScale: [1, 1, 1],
  shapeBias: 0.33, detailBias: 0, weatherBias: 0.3,
};
/** World units per second the noise fields drift. */
export const FLAT_DEMO_WIND = { shape: [0.1, 0, 0], detail: [0.03, 0, 0], weather: [0.01, 0, 0] };

export const FLAT_DEMO_TUNING = {
  maxSteps: 224, minStep: 0.003, maxStep: 0.16, sunSteps: 4, sunStride: 4, phaseJitter: 1, stepJitter: 0.3,
  baseJitterFrac: 0.045, topJitterFrac: 0.32, lodBiasWeather: 1.5, nearFluffDist: 60, nearDensityMult: 2.9,
  lodBlendThreshold: 0.46, farStart: 1.05, farFull: 4.2, farStepMult: 2.05, raySmoothDens: 0.23, raySmoothSun: 0.34,
  fluffFactor: 4.9, sparsity: 0.44, definition: 0.72, formType: 3, puffScale: 7, aoStrength: 0.82,
  towerHeightVariation: 0.18, shelfFlow: 0, paintedLayers: 0, anvilLift: 0.6, alphaCutoff: 0.965,
  verticalStepBoost: 3, verticalTextureHomogeneity: 0, verticalLightingStepBoost: 1.35,
  frontOcclusionStrength: 0.82, frontOcclusionAlpha: 0.58, frontOcclusionStepBoost: 4.2, sliceJitterStrength: 0.14,
  verticalLayerDecorrelation: 1, directLightBlend: 0.85, directLightBoost: 0.65, alphaBoostThreshold: 0.2,
  alphaBoostAmount: 0.14, minOutputAlpha: 0.12, outputAlphaFeather: 0.52,
};

export const FLAT_DEMO_PARAMS = {
  globalCoverage: 0.94, globalDensity: 11.8, cloudAnvilAmount: 1.15, cloudBeer: 6, attenuationClamp: 0.015,
  inScatterG: 1, silverIntensity: 1.15, silverExponent: 1.65, outScatterG: 0.1, inVsOut: 0.5,
  outScatterAmbientAmt: 0.08, ambientMinimum: 0.045,
  sunColor: [1.3776, 1.176, 0.855], frontLightColor: [1.5904, 1.407, 1.062], shadowLightColor: [0.31, 0.4, 0.55],
};

export const FLAT_DEMO_BOX = { center: [0, 11.5, 0], half: [18, 5.8, 18], uvScale: 1 };

/** Compositor (render uniform) look. */
export const FLAT_DEMO_RENDER = {
  exposure: 1.12, skyColor: [0.16, 0.36, 0.64], gradeStyle: 46, cloudShading: 'soft', sunBloom: 0.08,
  sunColorTint: [1.12, 1.05, 0.9], lightTint: [1.22, 1.17, 1.06], shadowTint: [0.43, 0.51, 0.64], edgeTint: [1.52, 1.35, 0.98],
  styleShadowStrength: 1.28, styleShadowEdge: 0.18, styleShadowDarkness: 0, styleColorLift: 1.08, styleSaturation: 1,
  styleRimStrength: 0.24, styleSunBleed: 0.045, styleMidLift: 1.06, alphaFloor: 0,
  fogDensity: 0.04, fogHorizon: 0.3, fogSun: 0.08,
  godRaysEnabled: true, godRayStrength: 0.08, godRayLength: 1, godRayFalloff: 1.6,
};

export const FLAT_DEMO_SUN = { azimuthDeg: 45, elevationDeg: 21 };
