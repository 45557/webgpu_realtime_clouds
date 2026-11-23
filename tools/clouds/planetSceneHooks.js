// Optional hooks into the planet demo for pages built on top of it (the
// roadmap game). Register before importing planetApproachClouds.js; the demo
// calls them with a small scene API so the page drives the same renderer,
// world presets, cloud styles and camera the panel uses.
export const planetSceneHooks = {
  setup: null,      // (scene) once the panel and life layer exist
  frame: null,      // ({ world, camera, phase }) every planet frame
  worldReady: null, // (world) after a new world's clouds have baked
};

export function registerPlanetSceneHooks(hooks) {
  Object.assign(planetSceneHooks, hooks);
}
