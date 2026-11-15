import { atmosphereColors, mountPlanetApproach, sunDirection } from '../planet/planet-approach.esm.js';
import { isSatelliteWeatherStyle, PLANET_CLOUD_STYLES } from './planetCloudStyles.js';
import { cloudDemoUrl } from './cloudDemoNavigation.js';
import { installCloudLabTheme } from './cloudLabUi.js';
import { stylePlanetPanel } from './planetPanelUi.js';
import {
  createPlanetCloudLayer, disposePlanetCloudLayer, getPlanetCloudRenderMode, togglePlanetCloudRenderMode,
  updatePlanetCloudLayer, updatePlanetCloudLayerOptions,
} from './planetClouds.js';
import { createTweakPanel, buildPlanetCloudConfig, buildPlanetAuroraConfig, cloudConfigForStyle } from '../noise/planetStudioPanel.js';
import terrainDepthShader from './shaders/planetTerrainDepth.wgsl';
import cloudOverlayOpacityShader from './shaders/cloudOverlayOpacity.wgsl';
import cloudOverlayReconstructionShader from './shaders/cloudOverlayReconstruction.wgsl';

const cloudRadius = 50;
const referencePlanetRadius = 262_144;
const weatherStyles = ['realistic', 'broken_cumulus', 'anvil_thunderstorms',
  'frontal_wave_bands', 'wind_swept_clouds', 'ice_filaments'];
const weatherHoldSeconds = 8;
const weatherFadeSeconds = 3;
const weatherPreloadSeconds = 4;

async function createTerrainDepthPass(device, terrainCoverage) {
  const pipeline = await device.createComputePipelineAsync({
    label: 'Planet depth for cloud occlusion',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: cloudOverlayOpacityShader + cloudOverlayReconstructionShader + terrainDepthShader }), entryPoint: 'main' },
  });
  const params = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const values = new Float32Array(20);
  const empty = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  const emptyView = empty.createView({ dimension: '2d-array' });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  let source, opacitySource, nextOpacitySource, output, outputView, group;
  let sampledCamera, sampledScale;
  return {
    sample(depth, camera, scale, width, height, foreground) {
      // Both cloud banks can use the same terrain distances within one camera frame.
      if (terrainCoverage && camera === sampledCamera && scale === sampledScale && depth === source &&
          output?.width === width && output.height === height) return outputView;
      const current = foreground?.current;
      const next = foreground?.next;
      const cloud = current?.view ?? emptyView;
      const nextCloud = next?.view ?? emptyView;
      if (!output || output.width !== width || output.height !== height) {
        output?.destroy();
        output = device.createTexture({
          label: 'Planet ray distances',
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        outputView = output.createView();
        group = null;
      }
      if (source !== depth || opacitySource !== cloud || nextOpacitySource !== nextCloud || !group) {
        source = depth;
        opacitySource = cloud;
        nextOpacitySource = nextCloud;
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: depth.createView() },
            { binding: 1, resource: outputView },
            { binding: 2, resource: { buffer: params } },
            { binding: 3, resource: cloud },
            { binding: 4, resource: sampler },
            { binding: 5, resource: nextCloud },
          ],
        });
      }
      values[0] = camera.near * scale;
      values[1] = camera.near / camera.far;
      values[2] = camera.tanX;
      values[3] = camera.tanY;
      values[4] = current?.bottom ?? 0;
      values[5] = current?.top ?? 0;
      values[6] = current?.alphaPower ?? 1;
      values[7] = current?.opacity ?? 0;
      values[8] = current?.cutoff ?? 0;
      values[9] = Number(terrainCoverage);
      values[10] = Number(current?.reconstruct ?? false);
      values[11] = foreground?.blend ?? 0;
      values[12] = next?.bottom ?? values[4];
      values[13] = next?.top ?? values[5];
      values[14] = next?.alphaPower ?? 1;
      values[15] = next?.opacity ?? 0;
      values[16] = next?.cutoff ?? 0;
      values[17] = Number(next?.reconstruct ?? false);
      device.queue.writeBuffer(params, 0, values);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);
      sampledCamera = camera;
      sampledScale = scale;
      return outputView;
    },
    dispose() {
      output?.destroy();
      params.destroy();
      empty.destroy();
    },
  };
}

let planet, camera, sunPhase, animation, studio, cloudConfig, terrainEditor, atmosphereControl, orbitPlanet;
let clouds, aurora, cloudDepth, auroraDepth, activeSeed, activeRadius;
let pendingFrame = false;
let disposed = false;
let settingsWork = Promise.resolve();
let preparing = false;
let capture;
let firstSceneFrame;
let initialSettings;
let cloudShadowControl, cloudOverlay, weatherToggle, weatherStatus, rendererButton;
let incoming, blend = 0, nextWeatherAt;
let weatherVersion = 0, weatherIndex = 0;
let settingsPending = 0, loadingNext = false, switchingRenderer = false;

function weatherLabel(layer) {
  return PLANET_CLOUD_STYLES.find(preset => preset.id === layer?.options.cloudStyle)?.label ?? '';
}

function refreshWeatherControls() {
  const current = weatherLabel(clouds);
  const next = weatherLabel(incoming?.layer);
  const status = !clouds ? 'Preparing clouds…' : !clouds.options.enabled ? 'Clouds hidden' :
    next && blend > 0 ? current + ' → ' + next : current;
  if (weatherStatus.textContent !== status) weatherStatus.textContent = status;
  const mode = getPlanetCloudRenderMode(clouds);
  if (rendererButton.dataset.cloudRenderMode !== mode) {
    rendererButton.dataset.cloudRenderMode = mode;
    rendererButton.textContent = mode === 'mc33-shell' ? 'Cloud renderer: Voxel mesh (MC33)' : 'Cloud renderer: Raymarch';
    rendererButton.setAttribute('aria-pressed', String(mode === 'mc33-shell'));
  }
  rendererButton.disabled = !clouds?.options.enabled || loadingNext || !!incoming || switchingRenderer || preparing || settingsPending > 0;
}

function cloudHost(layer) {
  return layer?.parent;
}

function disposeWeatherLayer(layer) {
  const host = cloudHost(layer);
  disposePlanetCloudLayer(layer);
  host?.remove();
}

function finishWeather(keepIncoming) {
  if (!incoming) return;
  const { layer, completed } = incoming;
  incoming = null;
  completed.resolve();
  blend = 0;
  if (keepIncoming) {
    disposeWeatherLayer(clouds);
    clouds = layer;
  } else {
    disposeWeatherLayer(layer);
  }
  if (cloudHost(clouds)) cloudHost(clouds).style.opacity = '1';
  nextWeatherAt = animation.time + weatherHoldSeconds;
  refreshWeatherControls();
}

function restartWeather() {
  weatherVersion++;
  weatherIndex = weatherStyles.indexOf(clouds?.options.cloudStyle);
  nextWeatherAt = undefined;
}

// The cloud builders use a left-handed view; reflect the world and light together.
function cloudVector([x, y, z], scale = 1) {
  return [-x * scale, y * scale, z * scale];
}

function cloudCamera() {
  return {
    camPos: cloudVector(camera.position, cloudRadius / planet.radius),
    fwd: cloudVector(camera.forward),
    up: cloudVector(camera.up),
    right: cloudVector(camera.right),
    fovYDeg: camera.fov * 180 / Math.PI,
    aspect: camera.aspect,
    animation,
    terrainCloudShadows: cloudShadowControl?.checked,
    atmosphere: atmosphereColors(planet.preset, atmosphereControl.value),
  };
}

function layerVisible(layer, visible) {
  if (layer?.canvas) layer.canvas.style.display = visible ? '' : 'none';
}

async function createLayer(options, isAurora = false, hidden = false) {
  if (disposed) return null;
  const sceneReady = firstSceneFrame?.promise;
  let depth = isAurora ? auroraDepth : cloudDepth;
  if (!depth) {
    depth = await createTerrainDepthPass(planet.device, !isAurora);
    if (disposed) {
      depth.dispose();
      return null;
    }
    if (isAurora) auroraDepth = depth;
    else cloudDepth = depth;
  }
  if (options.cloudRenderMode === 'mc33-shell' && !isAurora) await sceneReady;
  if (disposed) return null;
  const host = isAurora ? null : document.createElement('div');
  if (host) {
    host.style.cssText = 'position:absolute;inset:0;mix-blend-mode:plus-lighter;opacity:' + (hidden ? 0 : 1);
    cloudOverlay.append(host);
  }
  let layer;
  try {
    layer = await createPlanetCloudLayer({
      device: planet.device,
      queue: planet.device.queue,
      parent: host ?? document.body,
      sourceCanvas: planet.canvas,
      getCameraState: cloudCamera,
      getSunDir: () => cloudVector(sunDirection(sunPhase)),
      getTerrainDepth: (width, height) => disposed ? null :
        depth.sample(planet.depth, camera, cloudRadius / planet.radius, width, height,
          isAurora ? foregroundClouds() : null),
      radius: cloudRadius,
      beforeFirstFrame: sceneReady ? () => sceneReady : undefined,
      options,
    });
  } catch (error) {
    host?.remove();
    throw error;
  }
  if (disposed) {
    disposePlanetCloudLayer(layer);
    host?.remove();
    return null;
  }
  return layer;
}

function cloudRenderOptions(config) {
  const seed = planet.studioSeed;
  const { cloudOptions } = buildPlanetCloudConfig({ planetClouds: clouds }, { radius: cloudRadius }, seed, { clouds: config });
  // Keep full ray coverage on fast turns and keep the original weather/shape/detail volumes.
  const options = {
    ...cloudOptions,
    seed: config.seed ?? seed,
    loadingMessage: false,
    showRenderModeToggle: false,
    preloadAlternateCloudRendererOnIdle: false,
    retainCloudOpacity: true,
    reconstructAtPresentation: true,
    godRayAirHeight: 32000 * cloudRadius / planet.radius,
    satelliteOrbitRefinement: true,
    surfaceFieldUpdateHz: cloudOptions.surfaceFieldUpdateHz ?? 12,
    surfaceMeshUpdateHz: cloudOptions.surfaceMeshUpdateHz ?? 12,
    surfaceComputeBudget: cloudOptions.surfaceComputeBudget ?? 0.20,
    nearSurfaceCoarseFactor: 1,
    nearSurfaceMaxSteps: 120,
    fullscreenMaxSteps: 120,
    movingFullscreenMaxSteps: 104,
    movingFullscreenCoarseFactor: 1,
    animatedTemporalBlend: 0.86,
    // Avoid alternating coarse pixel cells across overlapping transparent banks.
    reprojection: { ...cloudOptions.reprojection, temporalCellRate: 1, compactInterleave: 0, temporalBlend: 0.86 },
  };
  const planetRadius = planet.radius;
  if (isSatelliteWeatherStyle(options.cloudStyle)) {
    // The renderer uses a fixed radius of 50. Convert authored heights and
    // frequencies to the active world's scale before baking and rendering.
    const relativeRadius = planetRadius / referencePlanetRadius;
    for (const key of ['cloudBottom', 'cloudTop', 'shellMaxHalfHeight', 'stepBase']) {
      options[key] /= relativeRadius;
    }
    options.worldToUV *= relativeRadius;
    options.weatherSystemScale = relativeRadius * (config.style?.weatherSystemScale ?? 1);
  }
  return options;
}

async function prepareWeather(options, startTime, version) {
  const layer = await createLayer(options, false, true);
  if (!layer) return false;
  if (weatherVersion !== version) {
    disposeWeatherLayer(layer);
    return false;
  }
  incoming = { layer, startTime, completed: Promise.withResolvers() };
  return true;
}

function rotatingWeatherConfig(style) {
  const preset = cloudConfigForStyle(style, cloudRadius);
  for (const key of ['renderScaleDivider', 'updateEvery', 'outputFormat']) {
    preset.textures[key] = cloudConfig.textures[key];
  }
  return {
    ...preset,
    seed: cloudConfig.seed,
    enabled: cloudConfig.enabled,
    performance: cloudConfig.performance,
    reprojection: cloudConfig.reprojection,
    nearSurfaceAdaptiveQuality: cloudConfig.nearSurfaceAdaptiveQuality,
    motion: { ...preset.motion, animate: cloudConfig.motion.animate },
    render: { ...preset.render, shadingBlur: cloudConfig.render.shadingBlur },
    style: { ...preset.style, ...cloudConfig.style },
  };
}

function scheduleWeather() {
  if (!weatherToggle.checked || animation.paused || !clouds?.options.enabled ||
      incoming || loadingNext || switchingRenderer || settingsPending) return;
  nextWeatherAt ??= animation.time + weatherHoldSeconds;
  if (animation.time < nextWeatherAt - weatherPreloadSeconds) return;
  const nextIndex = (weatherIndex + 1) % weatherStyles.length;
  const version = weatherVersion;
  const seed = planet.studioSeed;
  const radius = planet.radius;
  const startTime = nextWeatherAt;
  loadingNext = true;
  refreshWeatherControls();
  settingsWork = settingsWork.catch(() => {}).then(async () => {
    if (version !== weatherVersion || seed !== planet.studioSeed || radius !== planet.radius || disposed) return;
    const style = weatherStyles[nextIndex];
    if (clouds.options.cloudStyle === style ||
        await prepareWeather(cloudRenderOptions(rotatingWeatherConfig(style)), startTime, version)) {
      weatherIndex = nextIndex;
      nextWeatherAt = animation.time + weatherHoldSeconds;
    }
  }).catch(error => {
    nextWeatherAt = animation.time + weatherHoldSeconds;
    studio.setStatus('Weather preset could not load. The current clouds are still active.');
    console.error(error);
  }).finally(() => {
    loadingNext = false;
    refreshWeatherControls();
  });
}

async function presentWeather() {
  await updatePlanetCloudLayer(clouds);
  const transition = incoming;
  if (!transition) return;
  const { layer, startTime } = transition;
  if (startTime !== undefined && animation.time < startTime) return;
  const now = startTime === undefined ? performance.now() / 1000 : animation.time;
  transition.fadeStart ??= now;
  await updatePlanetCloudLayer(layer);
  if (incoming !== transition || disposed) return;
  const duration = startTime === undefined ? 1.35 : weatherFadeSeconds;
  const elapsed = transition.wallClockStart === undefined ? now - transition.fadeStart :
    performance.now() / 1000 - transition.wallClockStart;
  transition.elapsed = elapsed;
  const t = Math.max(0, Math.min(1, elapsed / duration));
  blend = t * t * (3 - 2 * t);
  cloudHost(layer).style.opacity = String(blend);
  cloudHost(clouds).style.opacity = String(1 - blend);
  if (t === 1) finishWeather(true);
  else if (t > 0) refreshWeatherControls();
}

async function applyCloudSettings(config, { rebake, auroraOnly, replaceWorld }) {
  if (!planet || disposed) return;
  if (!auroraOnly) {
    // Finish a visible fade before applying a new selection, even if the
    // weather clock is paused. A hidden preload can be discarded immediately.
    if (incoming && blend > 0 && !replaceWorld) {
      incoming.wallClockStart ??= performance.now() / 1000 - incoming.elapsed;
      await incoming.completed.promise;
      if (disposed) return;
    } else {
      finishWeather(false);
    }
    const options = cloudRenderOptions(config);
    const wantsClouds = options.enabled;
    if (wantsClouds && (!clouds?.options.enabled || replaceWorld)) {
      const next = await createLayer(options, false, !!clouds);
      if (next) {
        disposeWeatherLayer(clouds);
        clouds = next;
        cloudHost(clouds).style.opacity = '1';
      }
    } else if (clouds) {
      const satelliteScaleChanged = isSatelliteWeatherStyle(options.cloudStyle) &&
        options.weatherSystemScale !== clouds.options.weatherSystemScale;
      if (wantsClouds && (rebake || clouds.options.cloudStyle !== options.cloudStyle || satelliteScaleChanged)) {
        await prepareWeather(options, undefined, weatherVersion);
      } else {
        updatePlanetCloudLayerOptions(clouds, options, { resetHistory: true });
      }
    }
    layerVisible(clouds, wantsClouds);
    restartWeather();
  }
  const { cloudOptions: auroraOptions } = buildPlanetAuroraConfig(
    { planetClouds: clouds }, { radius: cloudRadius }, planet.studioSeed, { clouds: config },
  );
  const auroraRenderOptions = { ...auroraOptions, loadingMessage: false,
    auroraTemporalBlend: 0.22, nearSurfaceCoarseFactor: 1, movingFullscreenCoarseFactor: 1, canvasZIndex: 3 };
  if (auroraOptions.enabled && (!aurora || rebake || replaceWorld)) {
    disposePlanetCloudLayer(aurora);
    aurora = null;
    aurora = await createLayer(auroraRenderOptions, true);
  } else if (aurora) {
    updatePlanetCloudLayerOptions(aurora, auroraRenderOptions, { resetHistory: true });
  }
  layerVisible(aurora, auroraOptions.enabled);
  cloudConfig = config;
}

function queueSettings(config, options = {}) {
  if (!options.auroraOnly) restartWeather();
  settingsPending++;
  refreshWeatherControls();
  settingsWork = settingsWork.catch(() => {}).then(() => applyCloudSettings(config, options)).finally(() => {
    settingsPending--;
    refreshWeatherControls();
  });
  return settingsWork;
}

let pendingStorybookClouds;

function setup(doc) {
  installCloudLabTheme(doc);
  doc.title = 'Planet Clouds';
  const panel = doc.getElementById('controls');
  atmosphereControl = doc.getElementById('atmosphere');
  panel.classList.add('cl-root');
  panel.style.colorScheme = 'dark';
  panel.style.overflowX = 'hidden';
  panel.querySelector('h1').textContent = 'Planet Clouds';
  const nav = panel.querySelector('nav');
  nav.replaceChildren();
  for (const [demo, label] of [['flat', 'Flat clouds'], ['planet', 'Planet clouds']]) {
    const link = doc.createElement('a');
    link.textContent = label;
    link.href = cloudDemoUrl(demo);
    if (demo === 'planet') link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  for (const id of ['controls', 'performance', 'showInterface']) {
    doc.getElementById(id).style.zIndex = '4';
  }
  const quickFlight = doc.getElementById('approach').parentElement;
  const height = doc.getElementById('altitude').parentElement;
  const randomize = doc.getElementById('random');
  const help = panel.querySelector('.help') || panel.querySelector('p');
  const animationButton = doc.getElementById('sceneAnimation');
  const status = doc.getElementById('status');
  randomize.style.display = 'none';
  const terrain = doc.createElement('div');
  for (const child of [...panel.children]) {
    if (child !== nav && child !== status && child !== quickFlight && child !== height &&
        child !== help && child !== animationButton && !child.classList.contains('heading')) terrain.append(child);
  }
  const shadowLabel = doc.createElement('label');
  shadowLabel.className = 'checks';
  cloudShadowControl = doc.createElement('input');
  cloudShadowControl.type = 'checkbox';
  cloudShadowControl.id = 'cloudShadows';
  cloudShadowControl.checked = true;
  shadowLabel.append(cloudShadowControl, ' Cloud shadows (raymarch)');
  height.after(shadowLabel);
  cloudOverlay = doc.createElement('div');
  cloudOverlay.style.cssText = 'position:absolute;inset:0;z-index:2;isolation:isolate;pointer-events:none';
  doc.body.append(cloudOverlay);
  const weatherRow = doc.createElement('label');
  weatherRow.className = 'checks';
  weatherToggle = doc.createElement('input');
  weatherToggle.type = 'checkbox';
  weatherToggle.id = 'planet-weather-cycle';
  weatherToggle.checked = true;
  weatherStatus = doc.createElement('output');
  weatherStatus.id = 'planet-weather-current';
  weatherStatus.setAttribute('aria-live', 'polite');
  weatherStatus.style.cssText = 'display:block;font-size:.85em;margin:0 0 .5rem;color:#a7bed1';
  weatherRow.append(weatherToggle, ' Evolving weather');
  animationButton.after(weatherRow, weatherStatus);
  weatherToggle.addEventListener('change', () => {
    restartWeather();
    if (!weatherToggle.checked) {
      queueSettings(cloudConfig).catch(error => studio.setStatus('Cloud settings failed: ' + error.message));
    }
  });
  const studioOptions = {
    terrainControls: terrain,
    readTerrainLook: () => terrainEditor?.read(),
    stageTerrainLook: look => terrainEditor?.stage(look),
    getWorldSeed: () => planet?.studioSeed,
    viewAurora(pole) {
      if (!orbitPlanet || !planet) return;
      const north = pole === 'north';
      return orbitPlanet({
        direction: north ? [-0.32, 0.91, 0.28] : [-0.30, -0.94, -0.14],
        altitude: planet.radius * 0.7,
        sunTurn: north ? 0.5 : 0,
      });
    },
    captureImage: () => new Promise((resolve, reject) => { capture = { resolve, reject }; }),
    clouds: {
      performance: { coarseFactor: 1 },
      aurora: {
        enabled: true,
        textures: { renderScaleDivider: 3 },
        tuning: { maxSteps: 48 },
        performance: { coarseFactor: 1 },
      },
    },
  };
  studio = createTweakPanel(studioOptions);
  status.before(studio.element);
  stylePlanetPanel(panel, panel.id);
  cloudConfig = studio.readOptions().clouds;
  studio.setCloudLiveApply(({ cloudConfig, path }) => {
    const auroraOnly = path.startsWith('aurora.');
    if (!auroraOnly) weatherToggle.checked = false;
    return queueSettings(cloudConfig, { auroraOnly });
  });
  rendererButton = doc.createElement('button');
  rendererButton.type = 'button';
  rendererButton.className = 'cl-btn';
  rendererButton.style.width = '100%';
  doc.getElementById('planet-render-mode-slot').append(rendererButton);
  refreshWeatherControls();
  rendererButton.addEventListener('click', () => {
    if (rendererButton.disabled) return;
    switchingRenderer = true;
    refreshWeatherControls();
    settingsWork = settingsWork.catch(() => {}).then(() => togglePlanetCloudRenderMode(clouds))
      .catch(error => studio.setStatus('Cloud renderer could not switch: ' + error.message))
      .finally(() => {
        switchingRenderer = false;
        refreshWeatherControls();
      });
  });
  const terrainPreset = doc.getElementById('preset');
  const cloudShape = doc.getElementById('planet-shape-preset');
  terrainPreset.addEventListener('change', () => {
    const previousShape = cloudShape.value;
    pendingStorybookClouds = terrainPreset.value === 'storybook-glacier' ? (preset) => {
      if (preset !== 'storybook-glacier' && terrainPreset.disabled) return;
      pendingStorybookClouds = null;
      if (preset === 'storybook-glacier' && cloudShape.value === previousShape && previousShape !== 'storybook') {
        cloudShape.value = 'storybook';
        cloudShape.dispatchEvent(new Event('change'));
      }
    } : null;
  });
  studio.buttons.randomCloudButton.addEventListener('click', () => randomize.click());
  studio.buttons.resetButton.addEventListener('click', () => studio.resetEditors(studioOptions));
  const apply = async (rebake) => {
    try {
      await studio.flushPresetPreview();
      await terrainEditor?.apply();
      weatherToggle.checked = false;
      await queueSettings(studio.readOptions().clouds, { rebake: rebake || studio.hasPendingCloudTextures() });
      studio.markApplied();
      studio.setStatus('Studio settings applied.');
    } catch (error) {
      studio.setStatus(`Studio settings failed: ${error.message}`);
    }
  };
  studio.buttons.rebakeButton.addEventListener('click', () => apply(false));
  studio.buttons.rebakeCloudButton.addEventListener('click', () => apply(true));
}

function foregroundClouds() {
  return { current: cloudOpacity(clouds), next: blend > 0 ? cloudOpacity(incoming?.layer) : null, blend };
}

function cloudOpacity(layer) {
  const active = layer?.activeLayer ?? layer;
  if (!active || active.options.enabled === false) return null;
  const voxel = active.kind === 'mc33-shell';
  const view = voxel ? active.opacityView : active.cloudRenderView;
  if (!view) return null;
  const { cloudBottom, cloudTop, tuning, alphaPower, opacity, alphaCutoff } = active.options;
  const lift = Math.max(0, tuning?.anvilLift ?? 0);
  return { view, bottom: cloudRadius + cloudBottom, top: cloudRadius + cloudTop + lift,
    reconstruct: !voxel && active.options.reconstructAtPresentation,
    alphaPower: voxel ? 1 : alphaPower ?? 0.82, opacity: voxel ? 1 : opacity ?? 1,
    cutoff: voxel ? 0 : alphaCutoff ?? 0 };
}

function saveFrame() {
  const request = capture;
  capture = null;
  const canvas = document.createElement('canvas');
  canvas.width = planet.canvas.width;
  canvas.height = planet.canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(planet.canvas, 0, 0);
  const blendCanvas = document.createElement('canvas');
  blendCanvas.width = canvas.width;
  blendCanvas.height = canvas.height;
  const blendContext = blendCanvas.getContext('2d');
  blendContext.globalCompositeOperation = 'lighter';
  for (const [layer, opacity] of [[clouds, 1 - blend], [incoming?.layer, blend]]) {
    if (!layer?.canvas || layer.canvas.style.display === 'none' || opacity === 0) continue;
    blendContext.globalAlpha = opacity;
    blendContext.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(blendCanvas, 0, 0);
  if (aurora?.canvas && aurora.canvas.style.display !== 'none') {
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(aurora.canvas, 0, 0, canvas.width, canvas.height);
  }
  canvas.toBlob(blob => blob ? request.resolve(blob) : request.reject(new Error('Screenshot capture failed.')));
}

function disposeCloudStudio(error) {
  if (disposed) return;
  disposed = true;
  firstSceneFrame?.reject(error);
  firstSceneFrame = null;
  disposeWeatherLayer(clouds);
  disposeWeatherLayer(incoming?.layer);
  incoming?.completed.resolve();
  cloudOverlay?.remove();
  disposePlanetCloudLayer(aurora);
  cloudDepth?.dispose();
  auroraDepth?.dispose();
  capture?.reject(error);
}

await mountPlanetApproach({
  setup,
  onDeviceReady(world) {
    planet = world;
    firstSceneFrame = Promise.withResolvers();
    firstSceneFrame.promise.catch(() => {});
    studio.setStatus('Generating cloud volumes…');
    initialSettings = queueSettings(cloudConfig);
    initialSettings.catch(() => {});
  },
  sampleDepth: true,
  onTerrainReady(editor) { terrainEditor = editor; },
  onNavigationReady({ orbit }) { orbitPlanet = orbit; },
  onFrame(world, view, phase, animationState) {
    planet = world;
    camera = view;
    sunPhase = phase;
    animation = animationState;
    firstSceneFrame?.resolve();
    firstSceneFrame = null;
    if (pendingFrame || disposed) return;
    // Stage the paired shape before the new world seed starts its cloud bake.
    pendingStorybookClouds?.(world.preset);
    const seed = world.studioSeed;
    pendingFrame = true;
    (async () => {
      const seedChanged = seed !== activeSeed;
      const scaleChanged = world.radius !== activeRadius;
      if ((seedChanged || scaleChanged) && !preparing) {
        const first = activeSeed === undefined;
        activeSeed = seed;
        activeRadius = world.radius;
        preparing = true;
        if (!first) finishWeather(false);
        studio.setStatus('Generating cloud volumes…');
        try {
          if (first) await (initialSettings ?? queueSettings(cloudConfig));
          else if (!seedChanged) await queueSettings(cloudConfig, { replaceWorld: true });
          else await studio.randomizeClouds(seed, config => queueSettings(config, { replaceWorld: true }));
          studio.setStatus('Clouds ready.');
        } finally {
          preparing = false;
          initialSettings = null;
          refreshWeatherControls();
        }
      }
      await presentWeather();
      await updatePlanetCloudLayer(aurora);
      scheduleWeather();
      if (capture) saveFrame();
    })().catch((error) => {
      if (disposed) return;
      studio.setStatus(`Cloud render failed: ${error.message}`);
      console.error(error);
    }).finally(() => { pendingFrame = false; });
  },
  onDispose() {
    disposeCloudStudio(new Error('The planet preview closed.'));
  },
}).catch(error => {
  disposeCloudStudio(error);
  throw error;
});

