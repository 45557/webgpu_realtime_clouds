// Map every texel of an equirectangular map to its nearest simulation cell
// by walking the cell neighbour graph from the previous texel. Kept free of
// other imports so the erosion worker can run it off the main thread.

// Studio atlas layout: row = colatitude from +y, col = atan2(z, x) / 2π.
export function atlasTexelDirection(u, v) {
  const lon = 2 * Math.PI * u, colat = Math.PI * v;
  return [Math.sin(colat) * Math.cos(lon), Math.cos(colat), Math.sin(colat) * Math.sin(lon)];
}

// Interior rows 1..side-2 of a studio atlas, sampled at texel centres.
export function atlasInteriorCells(grid, side) {
  const width = side - 1;
  return nearestCells(grid, width, side - 2, (u, v) => atlasTexelDirection(u - 0.5 / width, (v * (side - 2) + 0.5) / width));
}

export function nearestCells(grid, width, height, direction) {
  const cells = new Int32Array(width * height);
  const { dirs, near, neighbours } = grid;
  let cell = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = direction((x + 0.5) / width, (y + 0.5) / height);
      let best = dirs[cell * 3] * d[0] + dirs[cell * 3 + 1] * d[1] + dirs[cell * 3 + 2] * d[2];
      for (let improved = true; improved;) {
        improved = false;
        for (let n = 0; n < neighbours; n++) {
          const j = near[cell * neighbours + n];
          const score = dirs[j * 3] * d[0] + dirs[j * 3 + 1] * d[1] + dirs[j * 3 + 2] * d[2];
          if (score > best) { best = score; cell = j; improved = true; }
        }
      }
      cells[y * width + x] = cell;
    }
  }
  return cells;
}
