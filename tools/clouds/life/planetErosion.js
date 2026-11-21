// Rain wears the planet down. Simulated rainfall becomes the rain weights of
// the studio's own drainage erosion (erodeSphericalTerrain), run in a worker
// on a copy of the height atlas. The change is added back onto the live
// atlas, so craters cut while the worker ran are kept, then the terrain is
// re-uploaded and the simulation re-reads its ground a few cells per frame.
// The texel mapping and rain weights are worked out in the worker, so the
// main thread never walks the million-texel atlas except to add the change.
import erosionWorkerURL from './planetErosion.worker.js';
import { atlasTexelDirection } from './planetTexels.js';

export { atlasTexelDirection };

// Per-cell rain weight: simulated rain and how full the ground is.
export function cellRainWeights(sim) {
  const n = sim.grid.count, weight = new Float32Array(n);
  for (let i = 0; i < n; i++) weight[i] = sim.rain[i] + 0.25 * sim.groundwater[i] + 0.02;
  return weight;
}

// Per-texel rain weight (mean about 1) for the atlas interior rows, from the
// simulated rain and how full the ground is.
export function rainfallWeights(sim, cells) {
  const weight = cellRainWeights(sim), n = weight.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weight[i];
  const mean = sum / n;
  const out = new Float32Array(cells.length);
  for (let t = 0; t < cells.length; t++) out[t] = Math.min(4, weight[cells[t]] / mean);
  return out;
}

// strength per simulated million years; the studio bake itself uses ~0.74.
// Each pass re-uploads the whole atlas, which rebuilds every terrain tile,
// so passes are spaced a few seconds apart.
export function createErosionDriver({ perMyr = 0.0015, maxStrength = 0.2, interval = 4 } = {}) {
  let worker = null, busy = false, lastRun = -Infinity, lastTime = null, passes = 0, failed = false;
  let sentGrid = null, result = null;

  return {
    get passes() { return passes; },
    get busy() { return busy; },
    // rate: 0 turns erosion off; 1 is the default speed. Returns true when
    // it did heavy work this frame, so the caller can hold other work back.
    update(world, sim, now, rate = 1) {
      const atlas = world?.studioMap;
      if (result) {
        // Apply a finished pass on a frame, not inside the worker message.
        const { delta, map, simAtStart } = result;
        result = null;
        if (world.studioMap !== map || delta.length !== map.values.length) return false;
        const values = map.values;
        for (let i = 0; i < values.length; i++) values[i] += delta[i];
        world.uploadStudioMap(map, world.studioSeed);
        if (sim === simAtStart) {
          if (sim.refreshGround) sim.refreshGround();
          else sim.reshape?.([0, 1, 0], Math.PI);
        }
        passes++;
        return true;
      }
      if (failed || !sim || !atlas?.values || rate <= 0) { lastTime = sim?.state.time ?? null; return false; }
      if (lastTime === null || sim.state.time < lastTime) lastTime = sim.state.time;
      if (busy || now - lastRun < interval) return false;
      const myr = sim.state.time - lastTime;
      if (myr < 1) return false;
      const strength = Math.min(maxStrength, perMyr * myr * rate);
      lastRun = now;
      lastTime = sim.state.time;
      const { side, values } = atlas;
      try { worker ??= new Worker(erosionWorkerURL); } catch { failed = true; return false; }
      busy = true;
      worker.onerror = () => { busy = false; failed = true; };
      const weights = cellRainWeights(sim);
      const send = (withGrid) => {
        const copy = values.slice();
        const grid = withGrid ? { dirs: sim.grid.dirs, near: sim.grid.near, neighbours: sim.grid.neighbours } : undefined;
        if (withGrid) sentGrid = sim.grid;
        worker.postMessage({ values: copy, side, strength, weights: weights.slice(), grid }, [copy.buffer]);
      };
      worker.onmessage = ({ data }) => {
        if (data.needGrid) { send(true); return; }
        busy = false;
        result = { delta: data.delta, map: atlas, simAtStart: sim };
      };
      send(sentGrid !== sim.grid);
      return true;
    },
    dispose() { worker?.terminate(); worker = null; busy = false; result = null; sentGrid = null; },
  };
}
