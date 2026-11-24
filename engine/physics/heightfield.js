// Heightfield sampling shared by terrain collision and gameplay height queries.
// Grids are row-major: heights[z * n + x], x and z spanning [-extent, extent].

/**
 * Sample a height function on a uniform (n x n) grid.
 * @param {(x: number, z: number) => number} heightAt
 */
export function sampleHeightGrid(heightAt, extent, n) {
  const heights = new Float32Array(n * n);
  const step = (2 * extent) / (n - 1);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    heights[z * n + x] = heightAt(-extent + x * step, -extent + z * step);
  }
  return { n, extent, heights };
}

/** Bilinear height lookup on a sampled grid. Outside the grid returns the nearest edge. */
export function gridHeightAt({ n, extent, heights }, x, z) {
  const step = (2 * extent) / (n - 1);
  const fx = Math.min(n - 1.000001, Math.max(0, (x + extent) / step));
  const fz = Math.min(n - 1.000001, Math.max(0, (z + extent) / step));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const h = (i, j) => heights[j * n + i];
  const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * tx;
  const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * tx;
  return a + (b - a) * tz;
}

/**
 * Convert a row-major grid to Rapier's heightfield layout: (nrows+1) x (ncols+1)
 * column-major, rows along Z and columns along X, centered on the origin.
 */
export function toRapierHeightfield({ n, extent, heights }) {
  const out = new Float32Array(n * n);
  for (let col = 0; col < n; col++) for (let row = 0; row < n; row++) out[col * n + row] = heights[row * n + col];
  return { nrows: n - 1, ncols: n - 1, heights: out, scale: { x: 2 * extent, y: 1, z: 2 * extent } };
}
