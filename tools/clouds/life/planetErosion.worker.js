// Runs the studio's spherical drainage erosion off the main thread. The
// texel-to-cell map, the rain weights and the height change are all worked
// out here too, so the main thread only adds the change back.
import { erodeSphericalTerrain } from '../../noise/studio-erosion.js';
import { atlasInteriorCells } from './planetTexels.js';

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
  // Send back only the change, so craters cut meanwhile are kept.
  for (let i = 0; i < values.length; i++) before[i] = values[i] - before[i];
  self.postMessage({ delta: before }, [before.buffer]);
};
