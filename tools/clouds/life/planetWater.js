// Water on the planet cell grid, solved to its balanced state every step.
// A simulation step is 1 Myr, but weather settles in days, rivers and lakes
// in years to millennia and ice sheets in about 100 kyr. So each step finds
// the steady state for the current climate and terrain (vapour along the
// winds, groundwater and rivers down the drainage tree, lakes filled to their
// water balance, ice sheets sized to their area) instead of moving water one
// cell per step, which took 5 to 10 Myr to settle after any change.
//
// Units: one unit of water per cell per step is WATER_UNIT_M_PER_YR of water
// depth over that cell each year (warm open sea evaporates 0.5 units, about
// Earth's 1.2 m/yr). Heights are in metres on a real planet (radius > 1000)
// and in the test planets' unit heights otherwise.

export const WATER_UNIT_M_PER_YR = 2.4;
const SECONDS_PER_YEAR = 3.156e7;
// Groundwater store: how much the ground holds, and the share of the store
// that drains on to lower ground (a steady store is through-flow / RELEASE).
export const GROUND_CAPACITY = 3;
const RELEASE = 0.07;
const INFILTRATION = 0.7;
const RAINOUT_LENGTH_M = 2e6;
const ICE_DENSITY_RATIO = 0.917;
// Whole-ocean thermal expansion at equilibrium, about 0.4 m per kelvin (IPCC AR6).
const THERMAL_EXPANSION_M_PER_K = 0.4;
// Fallback planet radius in metres for unit-sized test planets, and the
// metres per unit of height there (matches the impact code).
const PHYSICS_RADIUS = 262144;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// Ice sheet volume from its area, V = 0.034 A^1.25 (km³ from km²), the
// volume-area scaling of ice sheets and ice caps (Paterson 1994; Bahr et al.
// 1997). A Laurentide-sized sheet, 13 million km², comes out about 2 km thick.
export function iceSheetVolume(areaKm2) {
  return areaKm2 > 0 ? 0.034 * areaKm2 ** 1.25 : 0;
}

// Sea level change in metres when this much extra ice (km³) sits on land.
export function seaLevelFromIce(volumeKm3, oceanAreaKm2) {
  return oceanAreaKm2 > 0 ? -1000 * ICE_DENSITY_RATIO * volumeKm3 / oceanAreaKm2 : 0;
}

// The moon recedes as tides carry spin into its orbit. With the recession
// rate falling as a^-5.5, a^6.5 grows about linearly in time: from roughly
// 20 Earth radii soon after it formed to 60 today (4.5 Gyr).
export function moonDistance(timeMyr, { start = 20, now = 60, age = 4500 } = {}) {
  const t = Math.max(0, timeMyr) / age;
  return (start ** 6.5 + (now ** 6.5 - start ** 6.5) * t) ** (1 / 6.5);
}

// Coastal tidal range in metres. Tide height goes as mass / distance³; the
// sun adds 0.46 of today's lunar tide. Today's range comes out at 1.5 m.
export function tidalRange(timeMyr, moonMass = 1) {
  const lunar = moonMass * (60 / moonDistance(timeMyr)) ** 3;
  return 1.5 * (lunar + 0.46) / 1.46;
}

// River width from discharge, w = 7.2 Q^0.5 (m, m³/s; Moody and Troutman 2002).
export function riverWidth(dischargeM3s) {
  return dischargeM3s > 0 ? 7.2 * Math.sqrt(dischargeM3s) : 0;
}

// Hydrothermal circulation in a fresh crater lasts longer for bigger craters:
// about 2 Myr for a Chicxulub-sized 180 km crater, a few thousand years for a
// 10 km one (Abramov and Kring 2007).
export function hydrothermalLifetime(craterDiameterM) {
  return Math.max(0.002, 2 * (craterDiameterM / 180000) ** 1.5);
}

// A small binary min-heap of cells keyed by a float.
function createHeap(capacity) {
  const keys = new Float64Array(capacity), items = new Int32Array(capacity);
  let size = 0;
  return {
    get size() { return size; },
    push(key, item) {
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p]; items[i] = items[p]; i = p;
      }
      keys[i] = key; items[i] = item;
    },
    pop() {
      const top = items[0];
      const key = keys[--size], item = items[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; items[i] = items[c]; i = c;
      }
      keys[i] = key; items[i] = item;
      return top;
    },
  };
}

export function createWaterSystem(grid, env) {
  const { count, near, neighbours, dirs } = grid;
  const real = env.radius > 1000;
  const metresPerUnit = real ? 1 : PHYSICS_RADIUS / 50;
  const radiusM = real ? env.radius : PHYSICS_RADIUS;
  const cellAreaM2 = 4 * Math.PI * radiusM * radiusM / count;
  const cellAreaKm2 = cellAreaM2 / 1e6;
  const toM3s = WATER_UNIT_M_PER_YR * cellAreaM2 / SECONDS_PER_YEAR;
  // Share of the vapour crossing a cell that rains out with no lift or
  // saturation: water vapour stays aloft about nine days and travels some
  // 2000 km on the wind (Trenberth 1998), here across one cell spacing.
  const background = 1 - Math.exp(-Math.sqrt(cellAreaM2) / RAINOUT_LENGTH_M);
  // Water the air holds, scaled so warm air at 70% humidity rains about what
  // a warm sea evaporates (0.5 units per cell), as it does on Earth.
  const airCapacity = 0.5 / (1.4 * background);

  // Wind paths: the prevailing wind carries most vapour downstream
  // (env.flow); eddies stir the rest into another neighbour. windFrom lists
  // who blows into each cell, with the share each sends. Cells are visited
  // upwind first: the prevailing-wind graph has one exit per cell, so it is
  // trees feeding into loops (the wind belts); trees come in Kahn order and
  // each loop is then walked once. One Gauss-Seidel sweep in this order
  // carries vapour the whole way along a belt.
  const EDDY = 0.3;
  const windStart = new Int32Array(count + 1), windFrom = new Int32Array(2 * count), windShare = new Float32Array(2 * count);
  const windOrder = new Int32Array(count), eddy = new Int32Array(count);
  function buildWinds() {
    for (let i = 0; i < count; i++) {
      // A fixed neighbour per cell, varied from cell to cell, so eddies mix every way.
      let j = near[i * neighbours + (i * 7 + 3) % neighbours];
      if (j === env.flow[i]) j = near[i * neighbours + (i * 7 + 4) % neighbours];
      eddy[i] = j;
    }
    windStart.fill(0);
    for (let i = 0; i < count; i++) { windStart[env.flow[i] + 1]++; windStart[eddy[i] + 1]++; }
    for (let i = 0; i < count; i++) windStart[i + 1] += windStart[i];
    const fill = windStart.slice(0, count);
    for (let i = 0; i < count; i++) {
      let k = fill[env.flow[i]]++;
      windFrom[k] = i; windShare[k] = 1 - EDDY;
      k = fill[eddy[i]]++;
      windFrom[k] = i; windShare[k] = EDDY;
    }
    const inDegree = new Int32Array(count), placed = new Uint8Array(count);
    for (let i = 0; i < count; i++) inDegree[env.flow[i]]++;
    let n = 0, head = 0;
    for (let i = 0; i < count; i++) if (!inDegree[i]) windOrder[n++] = i;
    while (head < n) {
      const i = windOrder[head++];
      placed[i] = 1;
      const j = env.flow[i];
      if (--inDegree[j] === 0) windOrder[n++] = j;
    }
    for (let i = 0; i < count; i++) {
      if (placed[i]) continue;
      for (let j = i; !placed[j]; j = env.flow[j]) { placed[j] = 1; windOrder[n++] = j; }
    }
  }
  buildWinds();

  // Orographic lift: how far the air climbs into each cell from the cells
  // upwind of it. Recomputed when the ground or the sea changes.
  const uplift = new Float32Array(count);
  function buildUplift() {
    for (let i = 0; i < count; i++) {
      let upwind = 0, share = 0;
      for (let k = windStart[i]; k < windStart[i + 1]; k++) { upwind += windShare[k] * env.altitude[windFrom[k]]; share += windShare[k]; }
      upwind = share ? upwind / share : env.altitude[i];
      uplift[i] = clamp(2.5 * (env.altitude[i] - upwind), 0, 0.7);
    }
  }

  // Vapour leaving each cell downwind, kept between steps as a warm start.
  const outflow = new Float32Array(count);
  // Sweeps until the vapour stops changing (one or two once settled, more
  // after a sudden change, at most `sweeps`).
  function solveAtmosphere({ evaporation, rainBase, capacity, rain, vapor, sweeps = 16, tolerance = 2e-3 }) {
    let used = 0;
    for (; used < sweeps;) {
      let change = 0, total = 0;
      for (let n = 0; n < count; n++) {
        const i = windOrder[n];
        let v = evaporation[i];
        for (let k = windStart[i]; k < windStart[i + 1]; k++) v += windShare[k] * outflow[windFrom[k]];
        // Rain-out: mountains, cold air, and air near saturation.
        const over = v / capacity[i] - 0.7;
        const chance = Math.min(0.95, over > 0 ? rainBase[i] + 0.5 * over : rainBase[i]);
        rain[i] = v * chance;
        const out = v - rain[i];
        change += Math.abs(out - outflow[i]);
        total += out;
        outflow[i] = out;
      }
      used++;
      if (change <= tolerance * total) break;
    }
    vapor.set(outflow);
    return used;
  }

  // Drainage on the land surface, by priority flood from the sea (Barnes et
  // al. 2014): every land cell drains to the neighbour it was flooded from,
  // which is its lowest neighbour on the filled surface, and closed hollows
  // fill to their spill level. A planet with no sea drains to its lowest cell.
  const receiver = new Int32Array(count), floodOrder = new Int32Array(count);
  const spill = new Float32Array(count), lakeOf = new Int32Array(count), shown = new Int32Array(count);
  // Lakes in a list, and each pour point's lake (-1 where none).
  let lakes = [], builtSea = NaN, dirty = true;
  const lakeAt = new Int32Array(count).fill(-1);
  function buildDrainage() {
    const elevation = env.elevation;
    const heap = createHeap(count * neighbours + count);
    const seen = new Uint8Array(count);
    receiver.fill(-1);
    let lowest = 0;
    for (let i = 0; i < count; i++) {
      if (elevation[i] < elevation[lowest]) lowest = i;
      if (env.ocean[i]) { seen[i] = 1; spill[i] = env.seaLevel; heap.push(env.seaLevel, i); }
    }
    if (!heap.size) { seen[lowest] = 1; spill[lowest] = elevation[lowest]; heap.push(elevation[lowest], lowest); }
    let n = 0;
    while (heap.size) {
      const i = heap.pop();
      floodOrder[n++] = i;
      for (let k = 0; k < neighbours; k++) {
        const j = near[i * neighbours + k];
        if (seen[j]) continue;
        seen[j] = 1;
        spill[j] = Math.max(elevation[j], spill[i]);
        receiver[j] = i;
        heap.push(spill[j], j);
      }
    }
    // A hollow is a run of cells below their spill level; each lake is named
    // by its pour point, the rim cell its water would leave over.
    const eps = 1e-4 * env.relief;
    lakes = [];
    lakeAt.fill(-1);
    for (let n = 0; n < count; n++) {
      const i = floodOrder[n];
      lakeOf[i] = -1;
      if (env.ocean[i] || spill[i] - elevation[i] <= eps) continue;
      const r = receiver[i];
      const pour = lakeOf[i] = lakeOf[r] >= 0 ? lakeOf[r] : r;
      if (lakeAt[pour] < 0) { lakeAt[pour] = lakes.length; lakes.push({ pour, cells: [], open: false, fill: 0, inflow: 0 }); }
      lakes[lakeAt[pour]].cells.push(i);
    }
    for (const lake of lakes) lake.cells = Int32Array.from(lake.cells.sort((a, b) => elevation[a] - elevation[b]));
    // Rivers are drawn downhill: inside a hollow toward its floor, elsewhere
    // along the drainage tree.
    for (let i = 0; i < count; i++) {
      if (lakeOf[i] < 0) { shown[i] = receiver[i]; continue; }
      let best = -1, low = elevation[i];
      for (let k = 0; k < neighbours; k++) {
        const j = near[i * neighbours + k];
        if (elevation[j] < low) { low = elevation[j]; best = j; }
      }
      shown[i] = best;
    }
    builtSea = env.seaLevel;
    dirty = false;
  }

  // Coastal and equatorial upwelling. Where the wind blows off the land
  // within the trade-wind belts it pushes surface water out to sea and deep,
  // nutrient-rich water rises (the west coasts of continents); the trades
  // also spread water apart at the equator.
  const upwelling = new Float32Array(count);
  function buildUpwelling() {
    for (let i = 0; i < count; i++) {
      upwelling[i] = 0;
      if (!env.ocean[i]) continue;
      if (env.latitude[i] < 0.1) upwelling[i] = 0.6;
      if (env.latitude[i] > 0.6) continue;
      for (let k = windStart[i]; k < windStart[i + 1]; k++) if (windShare[k] > EDDY && !env.ocean[windFrom[k]]) upwelling[i] = 1;
    }
  }

  const discharge = new Float32Array(count), runoff = new Float32Array(count), landEvaporation = new Float32Array(count);
  const groundIn = new Float32Array(count), lakeInflow = new Float32Array(count), lakeDemand = new Float32Array(count);
  const lakeCover = new Float32Array(count), salt = new Float32Array(count), ice = new Float32Array(count);
  const mouth = new Float32Array(count), nutrient = new Float32Array(count), openEvaporation = new Float32Array(count);
  const iceSheet = new Int32Array(count), members = new Int32Array(count);

  // Groundwater, springs, rivers and lakes for this rain, from the top of
  // each drainage tree down. Returns whether the set of lake cells changed.
  function route({ rain, temperature, potential, groundwater }) {
    if (dirty || builtSea !== env.seaLevel) refresh();
    discharge.fill(0);
    groundIn.fill(0);
    lakeInflow.fill(0);
    lakeDemand.fill(0);
    mouth.fill(0);
    for (const lake of lakes) for (const i of lake.cells) lakeDemand[lake.pour] += openEvaporation[i];
    for (let n = count - 1; n >= 0; n--) {
      const i = floodOrder[n];
      if (env.ocean[i]) continue;
      const r = receiver[i];
      let passOn = 0;
      if (lakeCover[i] > 0.5) {
        // Open water: all the rain joins the lake, whose evaporation is
        // settled at its pour point.
        groundwater[i] = GROUND_CAPACITY;
        landEvaporation[i] = 0;
        runoff[i] = 0;
        discharge[i] += rain[i] + groundIn[i];
      } else {
        const recharge = INFILTRATION * rain[i] + groundIn[i];
        const evap = Math.min(potential[i], recharge);
        landEvaporation[i] = evap;
        let through = recharge - evap, overflow = 0;
        // A full aquifer spills the rest as springs.
        if (through > GROUND_CAPACITY * RELEASE) { overflow = through - GROUND_CAPACITY * RELEASE; through = GROUND_CAPACITY * RELEASE; }
        groundwater[i] = through / RELEASE;
        runoff[i] = (1 - INFILTRATION) * rain[i] + overflow;
        discharge[i] += runoff[i];
        passOn = through;
      }
      // Settle a lake at its pour point: it overflows if its inflow beats
      // its evaporation, otherwise it shrinks to the area that balances.
      if (lakeAt[i] >= 0) {
        const lake = lakes[lakeAt[i]];
        const inflow = lakeInflow[i];
        lake.open = inflow >= lakeDemand[i];
        discharge[i] += lake.open ? inflow - lakeDemand[i] : 0;
        lake.inflow = inflow;
      }
      if (r < 0) continue;
      if (env.ocean[r]) { mouth[r] += discharge[i]; continue; }
      if (lakeOf[i] >= 0 && lakeOf[r] < 0) lakeInflow[r] += discharge[i] + passOn;
      else {
        discharge[r] += discharge[i];
        if (lakeCover[r] > 0.5) discharge[r] += passOn; else groundIn[r] += passOn;
      }
    }
    // Fill each lake: overflowing lakes are full; closed ones fill from the
    // bottom until their evaporation uses up the inflow, and grow salty.
    let changed = false;
    for (const lake of lakes) {
      let budget = lake.open ? Infinity : lake.inflow;
      let filled = 0;
      for (const i of lake.cells) {
        const e = Math.max(1e-6, openEvaporation[i]);
        const cover = budget >= e ? 1 : budget > 0 ? budget / e : 0;
        budget -= e;
        if ((cover > 0.5) !== (lakeCover[i] > 0.5)) changed = true;
        lakeCover[i] = cover;
        if (cover > 0) filled++;
        salt[i] = lake.open ? salt[i] * 0.3 : cover > 0 ? Math.min(1, salt[i] + 0.15) : salt[i] * 0.995;
      }
      lake.fill = filled / lake.cells.length;
    }
    for (let i = 0; i < count; i++) {
      if (lakeOf[i] >= 0) continue;
      if (lakeCover[i] > 0.5) changed = true;
      lakeCover[i] = 0;
      salt[i] = 0;
    }
    return changed;
  }

  // Ice sheets: cold land that gets snow builds ice, each connected sheet
  // sized by volume-area scaling. Returns the ice volume in km³.
  function iceSheets({ temperature, rain }) {
    iceSheet.fill(-1);
    ice.fill(0);
    let volume = 0, cells = 0;
    for (let s = 0; s < count; s++) {
      if (iceSheet[s] >= 0 || !isIce(s)) continue;
      // Flood the sheet; members[] doubles as the stack.
      iceSheet[s] = s;
      members[0] = s;
      let size = 1;
      for (let head = 0; head < size; head++) {
        const i = members[head];
        for (let k = 0; k < neighbours; k++) {
          const j = near[i * neighbours + k];
          if (iceSheet[j] < 0 && isIce(j)) { iceSheet[j] = s; members[size++] = j; }
        }
      }
      const area = size * cellAreaKm2, v = iceSheetVolume(area);
      volume += v;
      cells += size;
      // Mean thickness, in metres, over the sheet.
      const thickness = 1000 * v / area;
      for (let n = 0; n < size; n++) ice[members[n]] = thickness;
    }
    return { volume, cells };
    function isIce(i) { return !env.ocean[i] && lakeCover[i] <= 0.5 && temperature[i] < -2 && rain[i] > 0.005; }
  }

  // Nutrients in the water: upwelling (stronger while the deep ocean
  // overturns), river mouths and lakes fed by rivers.
  function nutrients(overturning) {
    for (let i = 0; i < count; i++) {
      if (!env.water[i]) { nutrient[i] = 0; continue; }
      const river = Math.min(0.6, mouth[i] * toM3s / 2000);
      nutrient[i] = clamp(0.35 + 0.5 * upwelling[i] * (0.5 + 0.5 * overturning) + river + (lakeCover[i] > 0.5 ? 0.15 : 0), 0, 1);
    }
  }

  function refresh() { buildDrainage(); buildUpwelling(); buildUplift(); }
  refresh();

  return {
    metresPerUnit, uplift, background, airCapacity, cellAreaKm2, toM3s, receiver, shown, discharge, runoff, landEvaporation, openEvaporation,
    lakeCover, salt, ice, mouth, nutrient, upwelling, outflow,
    get lakes() { return lakes; },
    markDirty() { dirty = true; },
    rebuildWinds() { buildWinds(); buildUpwelling(); },
    solveAtmosphere, route, iceSheets, nutrients,
    // Sea level in metres from ice on land and ocean warmth, relative to the start.
    seaLevelMetres({ iceVolume, temperature, reference, oceanAreaKm2 }) {
      return seaLevelFromIce(iceVolume - reference.iceVolume, oceanAreaKm2) + THERMAL_EXPANSION_M_PER_K * (temperature - reference.temperature);
    },
    dirs,
  };
}
