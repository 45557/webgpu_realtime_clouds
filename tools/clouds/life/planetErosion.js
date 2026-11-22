// Rain wears the planet down. Simulated rainfall becomes the rain weights of
// the studio's own drainage erosion (erodeSphericalTerrain), run in a worker
// on a copy of the height atlas. The change is added back onto the live
// atlas, so craters cut while the worker ran are kept, then the terrain is
// re-uploaded and the simulation re-reads its ground.
import erosionWorkerURL from './planetErosion.worker.js';
import { texelCells } from './planetLifeLayer.js';
import { refreshTerrain } from './planetCraters.js';

// Studio atlas layout: row = colatitude from +y, col = atan2(z, x) / 2π.
export function atlasTexelDirection(u, v) {
  const lon = 2 * Math.PI * u, colat = Math.PI * v;
  return [Math.sin(colat) * Math.cos(lon), Math.cos(colat), Math.sin(colat) * Math.sin(lon)];
}

// Per-texel rain weight (mean about 1) for the atlas interior rows. The
// studio erosion routes and accumulates these weights itself, so they are the
// water that runs off each cell (rain that does not soak in, and springs),
// which makes the simulated rivers' discharge set how hard valleys are cut.
export function rainfallWeights(sim, cells) {
  const n = sim.grid.count, weight = new Float32Array(n);
  const runoff = sim.water?.runoff;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    weight[i] = (runoff ? runoff[i] + 0.1 * sim.rain[i] : sim.rain[i] + 0.25 * sim.groundwater[i]) + 0.02;
    sum += weight[i];
  }
  const mean = sum / n;
  const out = new Float32Array(cells.length);
  for (let t = 0; t < cells.length; t++) out[t] = Math.min(4, weight[cells[t]] / mean);
  return out;
}

// strength per simulated million years; the studio bake itself uses ~0.74.
export function createErosionDriver({ perMyr = 0.0015, maxStrength = 0.2, interval = 6 } = {}) {
  let worker = null, busy = false, lastRun = -Infinity, lastTime = null, cells = null, cellsKey = null, passes = 0, failed = false;

  function interiorCells(sim, side) {
    const key = `${side}:${sim.grid.count}`;
    if (cellsKey !== key || !cells) {
      const width = side - 1;
      // Interior rows 1..side-2 of the atlas, sampled at texel centres.
      const all = texelCells(sim.grid, width, side - 2, (u, v) => atlasTexelDirection(u - 0.5 / width, (v * (side - 2) + 0.5) / width));
      cells = all;
      cellsKey = key;
    }
    return cells;
  }

  return {
    get passes() { return passes; },
    get busy() { return busy; },
    // rate: 0 turns erosion off; 1 is the default speed.
    update(world, sim, now, rate = 1) {
      const atlas = world?.studioMap;
      if (failed || !sim || !atlas?.values || rate <= 0) { lastTime = sim?.state.time ?? null; return; }
      if (lastTime === null || sim.state.time < lastTime) lastTime = sim.state.time;
      if (busy || now - lastRun < interval) return;
      const myr = sim.state.time - lastTime;
      if (myr < 1) return;
      const strength = Math.min(maxStrength, perMyr * myr * rate);
      lastRun = now;
      lastTime = sim.state.time;
      const { side, values } = atlas;
      const rainfall = rainfallWeights(sim, interiorCells(sim, side));
      try { worker ??= new Worker(erosionWorkerURL); } catch { failed = true; return; }
      busy = true;
      worker.onerror = () => { busy = false; failed = true; };
      worker.onmessage = ({ data }) => {
        busy = false;
        if (world.studioMap !== atlas) return;
        const { delta } = data;
        const guide = atlas.guide?.length === 2 * values.length ? atlas.guide : null;
        for (let i = 0; i < values.length; i++) values[i] += delta[i];
        // The procedural mesh adds the guide's displacement plane to its own base.
        if (guide) for (let i = 0; i < values.length; i++) guide[values.length + i] += delta[i];
        refreshTerrain(world);
        sim.reshape?.([0, 1, 0], Math.PI);
        passes++;
      };
      const copy = values.slice();
      worker.postMessage({ values: copy, side, strength, rainfall }, [copy.buffer, rainfall.buffer]);
    },
    dispose() { worker?.terminate(); worker = null; busy = false; },
  };
}
