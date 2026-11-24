// Milestone 1 demo: walk around the mountain basin under the volumetric clouds.
// Open index.html?demo=game  (add &clouds=0 for the fast no-cloud renderer).
import { Engine } from '../engine.js';
import { registerScript } from '../core/scripts.js';
import * as player from './scripts/player.js';
import * as followCamera from './scripts/followCamera.js';
import scene from './walk-scene.json';

registerScript('player', player);
registerScript('followCamera', followCamera);

const q = new URLSearchParams(location.search);
document.title = 'clouds3 engine: walk under the clouds';
document.body.style.cssText = 'margin:0;background:#0b1320;overflow:hidden;font:13px system-ui,sans-serif;color:#eef5ff';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;cursor:crosshair';
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:12px;top:12px;padding:8px 10px;background:#0b1320b0;border:1px solid #90b4d84d;border-radius:8px;line-height:1.5;pointer-events:none;max-width:calc(100vw - 48px)';
hud.textContent = 'Loading engine...';
document.body.append(canvas, hud);

const engine = new Engine(canvas, { clouds: q.get('clouds') !== '0', maxFrames: q.has('frames') ? +q.get('frames') : Infinity, offscreen: q.has('offscreen'),
  // ?lowclouds: small noise textures, for slow GPUs and software rendering.
  cloudTextureSizes: q.has('lowclouds') ? { weather: 128, shape: 32, detail: 16, blue: 64 } : undefined });
globalThis.engine = engine;

(async () => {
  await engine.init();
  hud.textContent = 'Loading scene...';
  await engine.load(scene);
  engine.start();
  const help = 'Click to look around · WASD move · Shift sprint · Space jump · wheel zoom';
  setInterval(() => {
    const p = engine.world.get(engine.world.find('player'), 'Transform')?.position ?? [0, 0, 0];
    hud.innerHTML = `<b>Walk under the clouds</b> · ${engine.stats.fps.toFixed(0)} fps<br>${help}<br>` +
      `<span style="opacity:.7">x ${p[0].toFixed(1)} y ${p[1].toFixed(1)} z ${p[2].toFixed(1)} · clouds ${engine.clouds ? 'on' : 'off (add nothing to the URL to turn on)'}</span>`;
  }, 250);
  globalThis.__engineReady = true;
})().catch((e) => {
  console.error(e);
  hud.textContent = `Engine failed to start: ${e.message}`;
});
