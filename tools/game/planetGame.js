// Roadmap 2100: a strategy game on the planet clouds demo. Registers scene
// hooks, then loads the unchanged planet demo, so the game runs on the same
// renderer, terrain catalog, cloud layers and camera.
import { registerPlanetSceneHooks } from '../clouds/planetSceneHooks.js';
import { createGame } from './game.js';
import { createGameScene } from './gameScene.js';
import { createGameHud } from './gameHud.js';
import { QUOTES } from './roadmap.js';

const SAVE_KEY = 'roadmap-2100-save';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
    if (saved?.month >= 0 && saved.version === 1) return saved.game;
  } catch {}
  return null;
}
function save(game) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 1, month: game.month, game })); } catch {}
}

const params = new URL(location.href).searchParams;
const game = (params.has('new') ? null : load()) ?? createGame({ seed: Number(params.get('seed')) || 2100 });
const scene = createGameScene();
let hud;

registerPlanetSceneHooks({
  setup(api) {
    api.doc.title = 'Roadmap 2100';
    // The renderer's own panel stays available behind a button.
    for (const id of ['controls', 'performance']) {
      const node = api.doc.getElementById(id);
      if (node) node.hidden = true;
    }
    scene.attach(api);
    hud = createGameHud(api.doc, game, scene, { onChange: () => save(game) });
    if (game.month === 0) {
      const q = QUOTES.bifurcate;
      hud.popup([
        Object.assign(api.doc.createElement('b'), { textContent: 'December 2026. Fourteen Starship flights, nine successes. The late-2026 Mars window closes this month with no refuelled ship ready.' }),
        Object.assign(api.doc.createElement('q'), { textContent: q.text }),
        Object.assign(api.doc.createElement('a'), { href: q.source.url, target: '_blank', textContent: `Elon Musk, ${q.source.label}` }),
      ]);
    }
  },
  frame() { scene.frame(); },
  worldReady() { return scene.worldReady(); },
});
scene.show('earth');

await import('../clouds/planetApproachClouds.js');
