// Runs the studio's spherical drainage erosion off the main thread.
import { erodeSphericalTerrain } from '../../noise/studio-erosion.js';

self.onmessage = ({ data: { values, side, strength, rainfall } }) => {
  erodeSphericalTerrain(values, side, strength, rainfall);
  self.postMessage({ values }, [values.buffer]);
};
