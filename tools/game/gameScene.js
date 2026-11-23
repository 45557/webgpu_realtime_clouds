// Which planet the renderer shows for each destination, and how the game's
// events appear in it. Uses the demo's own primitives through the scene API:
// world presets from the planet catalog, cloud styles from
// PLANET_CLOUD_STYLES through the weather path, the orbit camera, and the life
// layer's meteor overlay for entry trails.

export const WORLDS = Object.freeze({
  earth: {
    label: 'Earth', presets: ['lakeshore', 'oceanic', 'forest'],
    clouds: { style: 'satellite_realistic', enabled: true },
    camera: { direction: [0.35, 0.42, 0.84], altitude: 0.9 },
  },
  moon: {
    label: 'Moon', presets: ['lunar-highlands', 'moon-dust', 'basalt-mare'],
    // Airless: no clouds.
    clouds: { style: 'realistic', enabled: false },
    camera: { direction: [-0.2, 0.92, 0.3], altitude: 0.8 },
  },
  mars: {
    label: 'Mars', presets: ['mars-dawn', 'desert', 'badlands'],
    // Mars has thin water-ice cirrus and dust hazes, not cumulus.
    clouds: { style: 'ice_filaments', enabled: true },
    camera: { direction: [0.6, 0.35, 0.72], altitude: 0.85 },
  },
});

export function createGameScene() {
  let scene = null, current = 'earth', pending = [];

  function desired() { return WORLDS[current]; }

  function applyClouds() {
    return scene?.setClouds(desired().clouds).catch(error => console.warn('Game clouds', error));
  }

  function show(world) {
    current = world;
    if (!scene) return;
    const presets = scene.worldPresets();
    const preset = desired().presets.find(id => presets.includes(id));
    if (preset) scene.setWorld(preset);
    applyClouds();
    const { direction, altitude } = desired().camera;
    const radius = scene.planet?.radius;
    if (radius) scene.orbit({ direction, altitude: radius * altitude });
  }

  return {
    get world() { return current; },
    attach(api) {
      scene = api;
      // The game is not about evolution: keep the life overlay for its
      // meteor trails and storms, paused, with the planet's own colours.
      api.life?.configure({ running: false, layers: { life: false, organisms: false, bareGround: false, scars: true, fire: false } });
      for (const fn of pending.splice(0)) fn();
    },
    worldReady() { return applyClouds(); },
    show(world) {
      if (!scene) { pending.push(() => show(world)); current = world; return; }
      show(world);
    },
    // Plasma trails for ships arriving where the camera is looking.
    entries(count, speed) {
      for (let i = 0; i < Math.min(count, 6); i++) {
        setTimeout(() => scene?.life?.entry({ speed, angle: 0.25 + 0.15 * Math.random() }), i * 700);
      }
    },
  };
}
