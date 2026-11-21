// Tropical cyclones on the simulated planet. They form over warm tropical
// ocean away from the equator, strengthen while the water stays warm, track
// west with the trades and then curve poleward and east, and fall apart over
// land or cold water. Storms run on the day clock (the sun's turn), not on
// the evolution clock, and are handed to the satellite weather renderer,
// which draws the eye, eyewall and spiral rainbands.

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// Saffir-Simpson style category from intensity 0..1 (0 = tropical storm).
export function stormCategory(intensity) {
  return intensity < 0.35 ? 0 : Math.min(5, 1 + Math.floor((intensity - 0.35) / 0.13));
}

export function createStormSystem({ random = Math.random, maxStorms = 8 } = {}) {
  const storms = [];
  let nextId = 1, formed = 0;

  function cellAt(sim, dir) {
    return sim.nearestCell(dir);
  }

  function spawn(sim, activity) {
    // Try a handful of random cells; keep one that is warm tropical sea.
    for (let tries = 0; tries < 12; tries++) {
      const i = Math.floor(random() * sim.grid.count);
      const y = sim.grid.dirs[i * 3 + 1];
      const lat = Math.abs(y);
      if (!sim.env.ocean[i] || sim.temperature[i] < 24 || lat < 0.09 || lat > 0.5) continue;
      if (random() > activity) return null;
      const dir = Array.from(sim.grid.dirs.subarray(i * 3, i * 3 + 3));
      const storm = { id: nextId++, dir, intensity: 0.12, age: 0, phase: random() * 2 * Math.PI, twist: 4 + 2.5 * random(), peak: 0.12 };
      storms.push(storm);
      formed++;
      return storm;
    }
    return null;
  }

  function move(storm, days) {
    const [x, y, z] = storm.dir;
    // East along the parallel and toward the nearer pole.
    let east = [-z, 0, x];
    const el = Math.hypot(...east) || 1;
    east = east.map(v => v / el);
    const north = [-y * x, 1 - y * y, -y * z];
    const nl = Math.hypot(...north) || 1;
    const pole = Math.sign(y) || 1;
    const lat = Math.abs(y);
    // Trades push west in the tropics; past the subtropical ridge storms recurve east.
    const zonal = lat < 0.42 ? -0.05 : 0.07;
    const meridional = (lat < 0.42 ? 0.015 : 0.03) * pole;
    const d = [0, 1, 2].map(k => storm.dir[k] + days * (zonal * east[k] + meridional * north[k] / nl));
    const length = Math.hypot(...d);
    storm.dir = d.map(v => v / length);
  }

  return {
    storms,
    get formed() { return formed; },
    // days: how many simulated days passed; activity: 0..~4 storm setting.
    update(sim, days, activity) {
      if (!sim || days <= 0) return;
      if (storms.length < maxStorms && random() < Math.min(0.9, 0.06 * days * activity)) spawn(sim, Math.min(1, activity));
      for (let n = storms.length - 1; n >= 0; n--) {
        const storm = storms[n];
        move(storm, days);
        const i = cellAt(sim, storm.dir);
        storm.cell = i;
        const warm = sim.env.ocean[i] ? clamp((sim.temperature[i] - 25) / 5, -1, 1) : -1.4;
        // Warm water feeds the storm; land and cold water starve it.
        storm.intensity = clamp(storm.intensity + days * (warm > 0 ? 0.09 * warm * (1.05 - storm.intensity) : 0.22 * warm), 0, 1);
        storm.age += days;
        storm.phase += days * 2.2;
        storm.peak = Math.max(storm.peak, storm.intensity);
        if (storm.intensity < 0.04 && storm.age > 1) storms.splice(n, 1);
      }
    },
    // Storms in the satellite renderer's format. Cloud space mirrors x.
    forClouds() {
      return storms.map(storm => ({
        axis: [-storm.dir[0], storm.dir[1], storm.dir[2]],
        extent: 0.09 + 0.13 * storm.intensity,
        eye: clamp(0.15 - 0.08 * storm.intensity, 0.06, 0.15),
        twist: storm.twist,
        maturity: 0.35 + 0.64 * storm.intensity,
        phase: storm.phase,
      }));
    },
    clear() { storms.length = 0; },
  };
}
