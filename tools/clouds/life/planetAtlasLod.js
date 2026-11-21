// The low-detail copy of the studio height atlas that the planet renderer
// uploads with every atlas change (uploadStudioMap's third argument): a
// quarter-resolution grid smoothed with a 1-4-6-4-1 filter. The renderer
// rebuilds it from the whole atlas on each upload (about 4 ms); this module
// makes the same grid and, after a crater, redoes only the rows it touched.
// atlasLod must stay identical to the renderer's own (see the test).

const TAPS = [1, 4, 6, 4, 1];

function lodSize(side) {
  const span = side - 1, cells = Math.max(1, Math.floor(span / 4));
  return { span, cells, stride: cells + 1 };
}

// Horizontal pass of one atlas row into the row buffer.
function filterRow(values, side, row, rows, span, cells) {
  const base = row * side;
  for (let n = 0; n < cells; n++) {
    const c = Math.round(n * span / cells);
    let sum = 0;
    for (let k = 0; k < 5; k++) sum += TAPS[k] * values[base + (c + (k - 2) * 2 + span) % span];
    rows[row * cells + n] = sum / 16;
  }
}

// Vertical pass of one output row (1..cells-1).
function filterColumn(rows, lod, n, span, cells, stride) {
  const c = Math.round(n * span / cells);
  for (let u = 0; u < cells; u++) {
    let sum = 0;
    for (let k = 0; k < 5; k++) sum += TAPS[k] * rows[Math.min(span, Math.max(0, c + (k - 2) * 2)) * cells + u];
    lod[n * stride + u] = sum / 16;
  }
  lod[n * stride + cells] = lod[n * stride];
}

function poles(values, side, lod, span, cells, stride) {
  lod.fill(values[0], 0, stride);
  lod.fill(values[span * side], cells * stride);
}

// The whole grid, plus the row buffer needed to update it later.
export function atlasLodState({ side, values }) {
  const { span, cells, stride } = lodSize(side);
  const lod = new Float32Array(stride ** 2), rows = new Float32Array(side * cells);
  for (let row = 0; row < side; row++) filterRow(values, side, row, rows, span, cells);
  poles(values, side, lod, span, cells, stride);
  for (let n = 1; n < cells; n++) filterColumn(rows, lod, n, span, cells, stride);
  return { side, lod, rows };
}

export function atlasLod(map) {
  return atlasLodState(map).lod;
}

// Redo the grid for atlas rows first..last (inclusive) changed in place.
export function updateAtlasLod(state, { side, values }, first, last) {
  const { span, cells, stride } = lodSize(side);
  first = Math.max(0, first); last = Math.min(span, last);
  for (let row = first; row <= last; row++) filterRow(values, side, row, state.rows, span, cells);
  poles(values, side, state.lod, span, cells, stride);
  for (let n = 1; n < cells; n++) {
    const c = Math.round(n * span / cells);
    if (c + 4 >= first && c - 4 <= last) filterColumn(state.rows, state.lod, n, span, cells, stride);
  }
  return state.lod;
}

// Cache of grids per atlas. A sparse fingerprint of the rows that should not
// have changed catches an atlas something else rewrote in place, which then
// gets a full rebuild.
function rowPrint(values, side, row) {
  let sum = 0;
  for (let i = row * side; i < (row + 1) * side; i += 61) sum += values[i];
  return sum;
}

function prints(values, side) {
  const out = new Float64Array(side);
  for (let row = 0; row < side; row += 8) out[row] = rowPrint(values, side, row);
  return out;
}

function unchangedOutside(state, map, first, last) {
  for (let row = 0; row < map.side; row += 8) {
    if (row >= first && row <= last) continue;
    if (state.prints[row] !== rowPrint(map.values, map.side, row)) return false;
  }
  return true;
}

export function createAtlasLodCache() {
  const states = new WeakMap();
  return {
    // The grid for `map` after rows first..last changed in place.
    get(map, first, last) {
      let state = states.get(map);
      if (state && state.side === map.side && state.values === map.values && unchangedOutside(state, map, first, last)) {
        updateAtlasLod(state, map, first, last);
        for (let row = Math.ceil(Math.max(0, first) / 8) * 8; row <= last && row < map.side; row += 8) state.prints[row] = rowPrint(map.values, map.side, row);
      } else {
        state = { ...atlasLodState(map), values: map.values, prints: prints(map.values, map.side) };
        states.set(map, state);
      }
      return state.lod;
    },
    // A grid and row buffer made elsewhere (the erosion worker) for the atlas
    // as it is now.
    set(map, lod, rows) {
      const { cells, stride } = lodSize(map.side);
      if (lod?.length !== stride ** 2 || rows?.length !== map.side * cells) { states.delete(map); return null; }
      states.set(map, { side: map.side, lod, rows, values: map.values, prints: prints(map.values, map.side) });
      return lod;
    },
  };
}
