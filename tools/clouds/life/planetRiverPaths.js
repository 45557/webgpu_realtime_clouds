// River courses finer than the simulation grid. The water cycle routes rivers
// from cell to cell (about 18 km apart on the demo planet), which drawn as
// straight lines look like a wire frame. Here each reach is laid along the
// valley floor of the terrain between its two cells: a lowest-cost path
// (Viterbi over a few lanes either side of the straight line) through the
// heights the renderer already has, at a few kilometres per vertex. Each
// cell's river node also sits in the lowest ground near its centre, so
// tributaries and main stems meet there. The shader then adds meanders at
// their physical scale (wavelength about 11 river widths) on top.
//
// This runs on the render side when rivers change, inside a small time budget
// per repaint, never in the simulation step.

export const PATH_POINTS = 10;
// vec4s per cell in the shader's path buffer: the points of the reach that
// leaves it (xyz direction, w meander phase), two vec4s of meta data, then
// RIVER_SLOTS cell indices (-1 for none) of the reaches that pass near it.
export const RIVER_SLOTS = 8;
export const PATH_VEC4 = PATH_POINTS + 2 + RIVER_SLOTS / 4;
const LANES = 5;          // lanes either side of the straight line
const SPREAD = 0.3;       // furthest lane, as a share of the reach length
const BEND_COST = 0.04;   // relief units per (lane step / vertex step)²
const CLIMB_COST = 2;     // extra cost per relief unit of climbing
const NODE_REACH = 0.3;   // how far a node may move, in cell spacings

const hypot3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

// Unit vector across the reach a→b, tangent to the sphere.
function across(a, b, out) {
  const mx = a[0] + b[0], my = a[1] + b[1], mz = a[2] + b[2];
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  let x = my * dz - mz * dy, y = mz * dx - mx * dz, z = mx * dy - my * dx;
  const l = hypot3(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return hypot3(dx, dy, dz);
}

// The point a share t along a→b, moved `offset` reach lengths across it.
export function reachPoint(a, b, t, offset, out = [0, 0, 0], o = 0, side = null, length = 0) {
  if (!side) { side = [0, 0, 0]; length = across(a, b, side); }
  const s = offset * length;
  const x = a[0] + (b[0] - a[0]) * t + side[0] * s;
  const y = a[1] + (b[1] - a[1]) * t + side[1] * s;
  const z = a[2] + (b[2] - a[2]) * t + side[2] * s;
  const l = hypot3(x, y, z) || 1;
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l;
  return out;
}

// Lowest ground among 13 points around `dir`, out to `radius` radians.
export function riverNode(dir, radius, height) {
  // Any two tangent directions will do for the search pattern.
  const t1 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e = [dir[1] * t1[2] - dir[2] * t1[1], dir[2] * t1[0] - dir[0] * t1[2], dir[0] * t1[1] - dir[1] * t1[0]];
  const el = hypot3(e[0], e[1], e[2]);
  e[0] /= el; e[1] /= el; e[2] /= el;
  const f = [dir[1] * e[2] - dir[2] * e[1], dir[2] * e[0] - dir[0] * e[2], dir[0] * e[1] - dir[1] * e[0]];
  let best = dir, low = height(dir);
  const p = [0, 0, 0];
  for (const ring of [0.5, 1]) {
    for (let k = 0; k < 6; k++) {
      const a = (k + ring) * Math.PI / 3, r = radius * ring;
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      p[0] = dir[0] + e[0] * c + f[0] * s; p[1] = dir[1] + e[1] * c + f[1] * s; p[2] = dir[2] + e[2] * c + f[2] * s;
      const l = hypot3(p[0], p[1], p[2]);
      const q = [p[0] / l, p[1] / l, p[2] / l];
      const h = height(q);
      if (h < low) { low = h; best = q; }
    }
  }
  return best;
}

// Lane offsets (in reach lengths) at each of the PATH_POINTS vertices of the
// lowest, least climbing, smoothest course from a to b. Ends stay at 0.
// Also returns the heights along it in `heights` when given.
export function traceReach(a, b, height, relief, out = new Float32Array(PATH_POINTS), heights = null) {
  const n = PATH_POINTS, lanes = 2 * LANES + 1;
  const side = [0, 0, 0];
  const length = across(a, b, side);
  const p = [0, 0, 0];
  const h = new Float64Array(n * lanes), cost = new Float64Array(n * lanes), from = new Int8Array(n * lanes);
  const off = new Float64Array(n * lanes);
  const scale = 1 / Math.max(1e-9, relief);
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    // Lanes narrow to the fixed ends.
    const reach = SPREAD * Math.sqrt(Math.sin(Math.PI * t));
    for (let l = 0; l < lanes; l++) {
      const o = (k === 0 || k === n - 1) ? 0 : reach * (l - LANES) / LANES;
      off[k * lanes + l] = o;
      if ((k === 0 || k === n - 1) && l !== LANES) { h[k * lanes + l] = Infinity; continue; }
      reachPoint(a, b, t, o, p, 0, side, length);
      h[k * lanes + l] = height(p) * scale;
    }
  }
  const step = 1 / (n - 1);
  for (let l = 0; l < lanes; l++) cost[l] = h[l];
  for (let k = 1; k < n; k++) {
    for (let l = 0; l < lanes; l++) {
      const i = k * lanes + l;
      if (h[i] === Infinity) { cost[i] = Infinity; continue; }
      let best = Infinity, arg = LANES;
      for (let m = 0; m < lanes; m++) {
        const j = (k - 1) * lanes + m;
        if (cost[j] === Infinity) continue;
        const bend = (off[i] - off[j]) / step;
        const c = cost[j] + BEND_COST * bend * bend + CLIMB_COST * Math.max(0, h[i] - h[j]);
        if (c < best) { best = c; arg = m; }
      }
      cost[i] = best + h[i];
      from[i] = arg;
    }
  }
  let l = LANES;
  for (let k = n - 1; k >= 0; k--) {
    out[k] = off[k * lanes + l];
    if (heights) heights[k] = h[k * lanes + l] / scale;
    l = from[k * lanes + l];
  }
  // A light 1-2-1 smoothing so the course has no kinks at the vertices.
  let prev = out[0];
  for (let k = 1; k < n - 1; k++) {
    const v = out[k];
    out[k] = 0.25 * prev + 0.5 * v + 0.25 * out[k + 1];
    prev = v;
  }
  return out;
}

// Per-cell cache of river nodes and traced reaches, kept up to date within a
// time budget. `height(dir)` gives ground height in metres.
export function createRiverPaths({ budgetMs = 1, clock = () => performance.now() } = {}) {
  let grid = null, count = 0;
  let nodes, offsets, slope, tracedTo, nodeDone, cursor = 0, version = 0;
  const heights = new Float64Array(PATH_POINTS);

  function reset(g) {
    grid = g; count = g.count;
    nodes = new Float32Array(count * 3);
    nodes.set(g.dirs.subarray(0, count * 3));
    offsets = new Float32Array(count * PATH_POINTS);
    slope = new Float32Array(count).fill(NaN);
    tracedTo = new Int32Array(count).fill(-2);
    nodeDone = new Uint8Array(count);
    cursor = 0;
    version++;
  }

  const node = (i, out = [0, 0, 0]) => {
    out[0] = nodes[i * 3]; out[1] = nodes[i * 3 + 1]; out[2] = nodes[i * 3 + 2];
    return out;
  };

  // The end of reach i: the next cell's node, or half way to the sea.
  function endOf(i, r, sea, out = [0, 0, 0]) {
    if (!sea) return node(r, out);
    const d = grid.dirs;
    const x = 0.5 * (nodes[i * 3] + d[r * 3]), y = 0.5 * (nodes[i * 3 + 1] + d[r * 3 + 1]), z = 0.5 * (nodes[i * 3 + 2] + d[r * 3 + 2]);
    const l = hypot3(x, y, z);
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return out;
  }
  const ends = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  function snap(i, height) {
    const d = [grid.dirs[i * 3], grid.dirs[i * 3 + 1], grid.dirs[i * 3 + 2]];
    nodes.set(riverNode(d, NODE_REACH * grid.spacing, height), i * 3);
    nodeDone[i] = 1;
  }

  function trace(i, r, sea, height, relief) {
    const a = node(i), b = endOf(i, r, sea);
    traceReach(a, b, height, relief, offsets.subarray(i * PATH_POINTS, (i + 1) * PATH_POINTS), heights);
    const angle = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    slope[i] = angle > 0 ? Math.max(0, heights[0] - heights[PATH_POINTS - 1]) / angle : 0;
    tracedTo[i] = sea ? -3 - r : r;
  }

  return {
    get version() { return version; },
    // Start over when the simulation's cell grid changes.
    use(g) { if (g !== grid) reset(g); },
    // `rivers(i)` gives the receiving cell of a drawn reach or -1, and
    // `sea(i)` whether that reach ends at the shore. `refresh` reaches are
    // also traced again in turn, for terrain that craters and erosion reshape.
    // Returns how many new or changed reaches were traced.
    update({ grid: g, rivers, sea, height, relief, refresh = 0 }) {
      if (g !== grid) reset(g);
      if (!height) return 0;
      const start = clock();
      let traced = 0, refreshed = 0;
      // New or changed reaches first, then the round robin.
      for (let i = 0; i < count; i++) {
        const r = rivers(i);
        if (r < 0) continue;
        const want = sea(i) ? -3 - r : r;
        if (tracedTo[i] === want) continue;
        if (!nodeDone[i]) snap(i, height);
        if (!sea(i) && !nodeDone[r]) snap(r, height);
        trace(i, r, sea(i), height, relief);
        traced++;
        if (clock() - start > budgetMs) { version++; return traced; }
      }
      for (let n = 0; n < count && refreshed < refresh; n++) {
        const i = cursor;
        cursor = (cursor + 1) % count;
        const r = rivers(i);
        if (r < 0) continue;
        snap(i, height);
        trace(i, r, sea(i), height, relief);
        refreshed++;
        if (clock() - start > budgetMs) break;
      }
      if (traced || refreshed) version++;
      return traced;
    },
    // Writes reach i's points into `out` (PATH_POINTS × 3) and returns its
    // drop per unit angle (metres per radian), or NaN when not traced yet.
    points(i, r, isSea, out) {
      const [a, b, side] = ends;
      node(i, a); endOf(i, r, isSea, b);
      const traced = tracedTo[i] === (isSea ? -3 - r : r);
      const length = across(a, b, side);
      for (let k = 0; k < PATH_POINTS; k++) {
        reachPoint(a, b, k / (PATH_POINTS - 1), traced ? offsets[i * PATH_POINTS + k] : 0, out, k * 3, side, length);
      }
      return traced ? slope[i] : NaN;
    },
  };
}

// Meanders: wavelength about 11 channel widths and amplitude about 1.2
// widths on flat ground (Leopold and Wolman 1960; Williams 1986), dying out
// on steep ground where rivers run straight.
const MEANDER_WAVELENGTH = 11, MEANDER_AMPLITUDE = 1.2;
export function meanderAmplitude(width, slope) {
  if (!(slope >= 0)) return 0.6 * MEANDER_AMPLITUDE * width;
  const t = Math.min(1, Math.max(0, (slope - 0.004) / 0.036));
  return MEANDER_AMPLITUDE * width * (1 - 0.7 * t * t * (3 - 2 * t));
}

const pathPoints = new Float32Array(PATH_POINTS * 3), seg = new Float64Array(PATH_POINTS);
// Writes reach i (draining to r) for the shader: PATH_POINTS points (xyz,
// w meander phase), then (centre xyz, bounding radius) and (meander amplitude
// in metres, 0, 0, 0), at i * PATH_VEC4 vec4s into pathOut.
export function writeRiverPath(paths, pathOut, i, r, sea, width, radius) {
  const slope = paths.points(i, r, sea, pathPoints) / radius;
  const o = i * PATH_VEC4 * 4;
  // Meander phase along the course, rounded to whole wavelengths per reach so
  // every reach starts and ends on its centre line where tributaries join.
  const wavelength = MEANDER_WAVELENGTH * width;
  let total = 0;
  for (let k = 1; k < PATH_POINTS; k++) {
    const a = (k - 1) * 3, b = k * 3;
    // Chord length: equal to the arc to 1 part in 10⁵ at a few km.
    seg[k] = hypot3(pathPoints[b] - pathPoints[a], pathPoints[b + 1] - pathPoints[a + 1], pathPoints[b + 2] - pathPoints[a + 2]) * radius;
    total += seg[k];
  }
  const raw = total * 2 * Math.PI / wavelength;
  const turns = 2 * Math.PI * Math.max(1, Math.round(raw / (2 * Math.PI)));
  let phase = 0, cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < PATH_POINTS; k++) {
    if (k) phase += total > 0 ? turns * seg[k] / total : 0;
    pathOut[o + k * 4] = pathPoints[k * 3]; pathOut[o + k * 4 + 1] = pathPoints[k * 3 + 1]; pathOut[o + k * 4 + 2] = pathPoints[k * 3 + 2];
    pathOut[o + k * 4 + 3] = phase;
    cx += pathPoints[k * 3]; cy += pathPoints[k * 3 + 1]; cz += pathPoints[k * 3 + 2];
  }
  const l = hypot3(cx, cy, cz) || 1;
  cx /= l; cy /= l; cz /= l;
  // Bounding radius, so the shader can skip far reaches with one test.
  let reach = 0;
  for (let k = 0; k < PATH_POINTS; k++) {
    reach = Math.max(reach, hypot3(pathPoints[k * 3] - cx, pathPoints[k * 3 + 1] - cy, pathPoints[k * 3 + 2] - cz));
  }
  const amplitude = meanderAmplitude(width, slope);
  const m = o + PATH_POINTS * 4;
  pathOut[m] = cx; pathOut[m + 1] = cy; pathOut[m + 2] = cz;
  pathOut[m + 3] = reach + (amplitude + width) / radius;
  pathOut[m + 4] = amplitude; pathOut[m + 5] = 0; pathOut[m + 6] = 0; pathOut[m + 7] = 0;
}

// Lists, for each cell, the reaches whose course passes through the map
// texels the shader looks it up from, biggest rivers first, so a course that
// strays from the straight line between its cells is still found and drawn
// whole. `texelCells` holds three cells per texel of a width × height
// equirectangular map (the heatmap's blend); `reaches` the drawn cells.
export function indexRiverCells(pathOut, reaches, discharge, texelCells, width, height, count) {
  const slotAt = PATH_POINTS + 2;
  for (let c = 0; c < count; c++) pathOut.fill(-1, (c * PATH_VEC4 + slotAt) * 4, (c + 1) * PATH_VEC4 * 4);
  const order = reaches.slice().sort((a, b) => discharge[b] - discharge[a]);
  const add = (c, i) => {
    const s = (c * PATH_VEC4 + slotAt) * 4;
    for (let k = 0; k < RIVER_SLOTS; k++) {
      const v = pathOut[s + k];
      if (v === i) return;
      if (v < 0) { pathOut[s + k] = i; return; }
    }
  };
  for (const i of order) {
    const o = i * PATH_VEC4 * 4;
    for (let k = 0; k < 2 * PATH_POINTS - 1; k++) {
      // Each vertex and the midpoint after it.
      const a = o + (k >> 1) * 4, b = o + Math.min(PATH_POINTS - 1, (k + 1) >> 1) * 4;
      const x = pathOut[a] + pathOut[b], y = pathOut[a + 1] + pathOut[b + 1], z = pathOut[a + 2] + pathOut[b + 2];
      const l = hypot3(x, y, z) || 1;
      // Same texel as the shader's mapUv/texelOf.
      const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5, v = 0.5 - Math.asin(Math.max(-1, Math.min(1, y / l))) / Math.PI;
      const t = Math.min(height - 1, Math.floor(Math.max(0, v) * height)) * width + Math.min(width - 1, Math.floor(u * width));
      for (let n = 0; n < 3; n++) if (texelCells[t * 3 + n] < count) add(texelCells[t * 3 + n], i);
    }
  }
}
