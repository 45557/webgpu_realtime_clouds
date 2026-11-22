// Runs the studio's spherical drainage erosion off the main thread. The
// texel-to-cell map, the rain weights and the height change are all worked
// out here too, so the main thread only adds the change back.
import { erodeSphericalTerrain } from '../../noise/studio-erosion.js';
import { atlasInteriorCells, DRIFT_W, DRIFT_H } from './planetTexels.js';
import { atlasLodState } from './planetAtlasLod.js';

let cells = null, cellsKey = null;

self.onmessage = ({ data: { values, side, strength, weights, grid } }) => {
  const key = `${side}:${weights.length}`;
  if (grid) { cells = atlasInteriorCells(grid, side); cellsKey = key; }
  if (cellsKey !== key) { self.postMessage({ needGrid: true }); return; }
  // Per-texel rain weight, mean about 1 (rainfallWeights in planetErosion.js).
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];
  const mean = sum / weights.length;
  const rainfall = new Float32Array(cells.length);
  for (let t = 0; t < cells.length; t++) rainfall[t] = Math.min(4, weights[cells[t]] / mean);
  const before = values.slice();
  erodeSphericalTerrain(values, side, strength, rainfall);
  // Send back only the change, so craters cut meanwhile are kept, with the
  // largest change in each block of the atlas (which terrain tiles need a
  // rebuild) and the renderer's low-detail grid of the eroded heights.
  const drift = new Float32Array(DRIFT_W * DRIFT_H), span = side - 1;
  for (let row = 0; row < side; row++) {
    const b = Math.min(DRIFT_H - 1, Math.floor(row / span * DRIFT_H)) * DRIFT_W;
    for (let col = 0, i = row * side; col < side; col++, i++) {
      const change = values[i] - before[i];
      before[i] = change;
      const k = b + Math.min(DRIFT_W - 1, Math.floor(col / span * DRIFT_W));
      if (Math.abs(change) > drift[k]) drift[k] = Math.abs(change);
    }
  }
  const { lod, rows } = atlasLodState({ side, values });
  self.postMessage({ delta: before, drift, lod, rows }, [before.buffer, drift.buffer, lod.buffer, rows.buffer]);
};
