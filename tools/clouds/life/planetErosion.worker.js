// Runs the studio's spherical drainage erosion off the main thread.
import { erodeSphericalTerrain } from '../../noise/studio-erosion.js';

// Replies with the change only, so the main thread does one add per texel.
self.onmessage = ({ data: { values, side, strength, rainfall } }) => {
  const before = values.slice();
  erodeSphericalTerrain(values, side, strength, rainfall);
  for (let i = 0; i < values.length; i++) values[i] -= before[i];
  self.postMessage({ delta: values }, [values.buffer]);
};
