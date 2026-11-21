// Sidebar sections and frame driver for the planet life simulation. The
// environment is read from the planet renderer's own terrain sampler
// (sampleSurface, sampleLandforms) and the studio climate, storms follow the
// active cloud weather, and "Fly to" uses the demo's orbit navigation.
import { adoptField } from '../cloudLabUi.js';
import { studioClimate } from '../../noise/studio-climate.js';
import { PLANET_CLOUD_STYLES } from '../planetCloudStyles.js';
import {
  createCellGrid, createEnvironment, createLifeSim, DEFAULT_LIFE_SETTINGS, GENES, HABITATS, stormFactor,
} from './planetLifeSim.js';
import { createLifeLayer, HABITAT_LEGEND, CHEMICALS, texelCells, cloudTexelDirection } from './planetLifeLayer.js';
import { createCraterQueue } from './planetCraters.js';
import { createErosionDriver } from './planetErosion.js';
import { createStormSystem, stormCategory } from './planetStorms.js';
import { setCloudHumidity, setSatelliteStorms } from '../planetCloudNoise.js';

const CELL_COUNT = 2600;
const STEP_BUDGET_MS = 6;

function formatTime(myr) {
  return myr >= 1000 ? `${(myr / 1000).toFixed(2)} Gyr` : `${Math.round(myr)} Myr`;
}

export function createPlanetLifeUi(doc, { overlayParent = doc.body, orbit } = {}) {
  const settings = { ...DEFAULT_LIFE_SETTINGS };
  const sunSync = { follow: true, phase: null };
  const cyclones = createStormSystem();
  let lastStormSync = 0, stormsShown = false;
  const layers = { cyclones: true, life: true, habitat: false, biomes: false, scars: true, fire: true, selected: null, chemical: 'none', deform: true, humidity: true };
  // Simulated water vapor shapes the cloud cover.
  const HUMID_W = 256, HUMID_H = 128;
  let humidityCells = null, humidityGrid = null, lastHumidity = -Infinity, humidityShown = false;
  const craters = createCraterQueue();
  const erosion = createErosionDriver();
  let sim = null, world = null, sampledMap = null, sampledSeed, running = true, speed = 20;
  let pendingSteps = 0, lastNow = null, lastPanel = 0, lastTree = 0;
  let seenStrikes = 0, seenImpacts = 0, cameraState = null, cloudInfo = { style: null, enabled: true };
  let buildError = null;
  const overlay = createLifeLayer(doc, overlayParent);

  const el = (tag, props = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.style.cssText = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };

  function slider(text, key, min, max, step, format = v => v, target = settings, onChange) {
    const input = el('input', { type: 'range', min, max, step, id: `life-${key}` });
    input.value = String(target[key]);
    const value = el('output', { text: format(target[key]) });
    const label = el('label', {}, text, input);
    input.addEventListener('input', () => {
      target[key] = Number(input.value);
      value.textContent = format(target[key]);
      sim?.setSettings(settings);
      onChange?.(target[key]);
    });
    return adoptField(label, { text, value });
  }

  function toggle(text, key, target = settings) {
    const input = el('input', { type: 'checkbox', id: `life-${key}` });
    input.checked = !!target[key];
    input.addEventListener('change', () => {
      target[key] = input.checked;
      sim?.setSettings(settings);
      layers.dirty = true;
    });
    return adoptField(el('label', {}, input, text), { text });
  }

  // Rail actions: full width on their own, shared out inside a cl-btnrow.
  function button(text, onClick, primary = false) {
    const node = el('button', { type: 'button', class: `cl-btn cl-btn--sm cl-btn--block${primary ? ' cl-btn--primary' : ''}`, text });
    node.addEventListener('click', onClick);
    return node;
  }

  const stats = (rows) => {
    const list = el('dl', { class: 'cl-life-stats' });
    const values = {};
    for (const [key, label] of rows) {
      values[key] = el('dd', { text: '—' });
      list.append(el('dt', { text: label }), values[key]);
    }
    return { list, values };
  };

  function flyToCell(cell, altitude = 0.55) {
    if (!sim || cell === undefined || cell < 0 || !world) return;
    const d = sim.grid.dirs;
    orbit?.({ direction: [d[cell * 3], d[cell * 3 + 1], d[cell * 3 + 2]], altitude: world.radius * altitude });
  }

  // Lifeforms ----------------------------------------------------------------
  const runButton = button('Pause', () => {
    running = !running;
    runButton.textContent = running ? 'Pause' : 'Run';
  }, true);
  const restartButton = button('Restart', () => restart());
  const speedField = slider('Speed', 'speed', 1, 200, 1, v => `${v} Myr/s`, { speed }, v => { speed = v; });
  const lifeStats = stats([
    ['time', 'Time'], ['alive', 'Living lineages'], ['total', 'Lineages so far'],
    ['complexity', 'Highest complexity'], ['traits', 'Traits in play'],
  ]);
  const tree = el('canvas', { class: 'cl-life-tree', width: 640, height: 360, 'aria-label': 'Genealogy over time' });
  const detail = el('div', { class: 'cl-hint cl-life-detail', text: 'Tap a branch to see its ancestry.' });
  const timeline = el('ol', { class: 'cl-life-timeline' });
  let treeRows = [];
  tree.addEventListener('click', (event) => {
    const rect = tree.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height * tree.height;
    const row = treeRows.find(r => Math.abs(r.y - y) <= Math.max(4, r.h));
    selectLineage(row?.id ?? null);
  });

  function selectLineage(id) {
    layers.selected = id;
    layers.selectedFamily = null;
    layers.dirty = true;
    if (id === null || !sim) {
      detail.textContent = 'Tap a branch to see its ancestry.';
      return;
    }
    const path = sim.lineagePath(id);
    layers.selectedFamily = new Set(path.map(l => l.id));
    const lineage = path[0];
    const root = path.at(-1);
    const traits = lineage.tags.length ? lineage.tags.join(', ') : 'simple replicator';
    const ancestry = path.slice(0, 8).map(l => `L${l.id}`).join(' ← ') + (path.length > 8 ? ` ← … ← L${root.id}` : '');
    const span = lineage.extinct === null ? `since ${formatTime(lineage.born)}, ${lineage.cells} colonies` :
      `${formatTime(lineage.born)} to ${formatTime(lineage.extinct)}`;
    detail.replaceChildren(
      el('p', { class: 'cl-hint' }, el('strong', { text: `L${lineage.id}` }), ` ${traits}. ${span}.`),
      el('p', { class: 'cl-hint', text: `Ancestry: ${ancestry}, from ${root.origin === 'meteorite' ? 'a meteorite' : `abiogenesis in a ${root.origin}`} at ${formatTime(root.born)}.` }),
      el('p', { class: 'cl-hint', text: `Genome: ${GENES.map((g, k) => `${g} ${lineage.founder[k].toFixed(2)}`).join(', ')}.` }),
    );
    const fly = button('Fly to this lineage', () => {
      let cell = -1;
      for (let i = 0; i < sim.grid.count && cell < 0; i++) if (sim.lineageOf[i] === lineage.id) cell = i;
      flyToCell(cell >= 0 ? cell : lineage.cell);
    });
    detail.append(fly);
  }

  const lifeSection = [
    el('div', { class: 'cl-btnrow' }, runButton, restartButton),
    speedField,
    lifeStats.list,
    el('p', { class: 'cl-hint', text: 'Genealogy over time. Each bar is a lineage, colored by how it gets energy (orange chemistry, green light, magenta other life). Lines join a lineage to its parent; ☄ marks meteorite seedings.' }),
    tree,
    detail,
    el('p', { class: 'cl-hint', text: 'Timeline' }),
    timeline,
    slider('Copying errors', 'mutation', 0, 3, 0.05, v => `×${v.toFixed(2)}`),
    slider('New lineage at', 'speciation', 0.4, 2, 0.05, v => `${v.toFixed(2)} drift`),
    toggle('Show colonies on the planet', 'life', layers),
    sunToggle(),
  ];

  // Day and night: turn the sun with the simulation clock through the demo's
  // own Sun orbit slider, so faster evolution means faster days.
  function sunToggle() {
    const node = toggle('Sun follows simulation speed', 'follow', sunSync);
    node.querySelector('input').addEventListener('change', () => {
      sunSync.phase = null;
      const cycle = doc.getElementById('sunCycle');
      if (!sunSync.follow && cycle) cycle.checked = true;
    });
    return node;
  }

  // Cyclones run on the day clock: as many days pass as the sun turns.
  function updateCyclones(dt, now) {
    if (!sim) return;
    if (!layers.cyclones) {
      if (stormsShown) { cyclones.clear(); setSatelliteStorms(null); stormsShown = false; }
      return;
    }
    const days = running ? Math.min(240, 0.9 * speed) * dt / 360 : 0;
    cyclones.update(sim, days, settings.storms * stormFactor(cloudInfo.style, cloudInfo.enabled));
    for (const storm of cyclones.storms) {
      // Rain under the core puts fires out; the eyewall throws lightning.
      if (storm.cell !== undefined) {
        sim.fire[storm.cell] = 0;
        sim.env.moisture[storm.cell] = 1;
      }
      if (Math.random() < storm.intensity * dt * 4) {
        const a = Math.random() * 2 * Math.PI, r = (0.09 + 0.13 * storm.intensity) * 0.25;
        const [x, y, z] = storm.dir;
        let e = [-z, 0, x];
        const el = Math.hypot(...e) || 1;
        e = e.map(v => v / el);
        const nrt = [y * e[2] - z * e[1], z * e[0] - x * e[2], x * e[1] - y * e[0]];
        const d = storm.dir.map((v, k) => v + r * (Math.cos(a) * e[k] + Math.sin(a) * nrt[k]));
        sim.lightning(sim.nearestCell(d));
      }
    }
    if (now - lastStormSync > 0.2 && (cyclones.storms.length || stormsShown)) {
      lastStormSync = now;
      setSatelliteStorms(cyclones.storms.length ? cyclones.forClouds() : null);
      stormsShown = cyclones.storms.length > 0;
    }
  }

  // Evaporation makes clouds: vapor plus rain-out, blurred over neighbours,
  // drawn into every cloud weather map about once a second.
  function updateHumidity(now) {
    if (!sim || !layers.humidity) {
      if (humidityShown) { setCloudHumidity(null); humidityShown = false; }
      return;
    }
    if (now - lastHumidity < 1) return;
    lastHumidity = now;
    const { grid } = sim;
    if (humidityGrid !== grid) { humidityCells = texelCells(grid, HUMID_W, HUMID_H, cloudTexelDirection); humidityGrid = grid; }
    const n = grid.count, k = grid.neighbours, wet = new Float32Array(n);
    for (let i = 0; i < n; i++) wet[i] = sim.vapor[i] + 2 * sim.rain[i];
    const smooth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 2 * wet[i];
      for (let j = 0; j < k; j++) sum += wet[grid.near[i * k + j]];
      smooth[i] = Math.min(1, sum / (k + 2) / 2.5);
    }
    const data = new Uint8Array(HUMID_W * HUMID_H * 4);
    for (let t = 0; t < humidityCells.length; t++) data[t * 4] = Math.round(255 * smooth[humidityCells[t]]);
    setCloudHumidity({ data, width: HUMID_W, height: HUMID_H });
    humidityShown = true;
  }

  function turnSun(dt) {
    const slider = doc.getElementById('sunPhase');
    if (!sunSync.follow || !slider) return;
    if (slider.step !== 'any') slider.step = 'any';
    sunSync.phase ??= slider.valueAsNumber || 0;
    // 20 Myr/s gives about a 20 second day; paused evolution holds the sun.
    const degrees = running && sim ? Math.min(240, 0.9 * speed) * dt : 0;
    if (!degrees) return;
    sunSync.phase = (sunSync.phase + degrees) % 360;
    slider.value = String(sunSync.phase);
    slider.dispatchEvent(new Event('input'));
  }

  // First Life habitat -------------------------------------------------------
  const habitatStats = stats([
    ['vent', 'Vents'], ['tidal', 'Tidal pools'], ['pond', 'Warm ponds'], ['spring', 'Hot springs'],
    ['soup', 'Primordial soup'], ['origins', 'Origins of life'],
  ]);
  const legend = el('p', { class: 'cl-hint cl-life-legend' });
  for (const h of HABITAT_LEGEND) {
    legend.append(el('span', { class: 'cl-life-key' }, el('i', { style: `--swatch:rgb(${h.color})` }), h.label));
  }
  const chemSelect = el('select', { id: 'life-chemical' });
  for (const [value, label] of [['none', 'Off'], ['all', 'All chemicals'], ...CHEMICALS.map(c => [c.key, c.label])]) {
    chemSelect.append(el('option', { value, text: label }));
  }
  chemSelect.addEventListener('change', () => { layers.chemical = chemSelect.value; layers.dirty = true; });
  const chemLegend = el('p', { class: 'cl-hint cl-life-legend' });
  for (const c of CHEMICALS) {
    chemLegend.append(el('span', { class: 'cl-life-key' }, el('i', { style: `--swatch:rgb(${c.color})` }), c.label));
  }
  const habitatSection = [
    el('p', { class: 'cl-hint', text: 'Sites come from this planet\'s terrain: volcanic sea floor makes vents, coasts make tidal pools, volcanic land makes hot springs. Energy builds organic molecules there until some start copying themselves.' }),
    habitatStats.list,
    toggle('Hydrothermal vent heat', 'vents'),
    toggle('Lightning chemistry', 'lightningChemistry'),
    toggle('Ultraviolet sunlight', 'uvChemistry'),
    toggle('Meteorite delivery', 'meteorDelivery'),
    slider('Organic richness', 'richness', 0, 3, 0.05, v => `×${v.toFixed(2)}`),
    slider('Spark of life', 'abiogenesis', 0, 5, 0.05, v => `×${v.toFixed(2)}`),
    toggle('Show habitat chemistry', 'habitat', layers),
    legend,
    adoptField(el('label', {}, 'Chemistry layer', chemSelect), { text: 'Chemistry layer' }),
    chemLegend,
    button('Fly to the richest site', () => {
      if (!sim) return;
      let best = -1, value = 0;
      for (let i = 0; i < sim.grid.count; i++) if (sim.env.water[i] && sim.organics[i] > value) { value = sim.organics[i]; best = i; }
      flyToCell(best);
    }),
  ];

  // Planet life ---------------------------------------------------------------
  const planetStats = stats([
    ['o2', 'Oxygen'], ['co2', 'Carbon dioxide'], ['biomass', 'Biomass'], ['land', 'Land covered'], ['top', 'Most widespread'],
  ]);
  const planetSection = [
    planetStats.list,
    el('div', { class: 'cl-btnrow' },
      button('Fly to the largest lineage', () => {
        const top = largestLineage();
        if (top) selectLineage(top.id);
        if (top) for (let i = 0; i < sim.grid.count; i++) if (sim.lineageOf[i] === top.id) return flyToCell(i);
      }),
      button('Fly to first life', () => {
        const first = sim?.lineages[0];
        if (first) { selectLineage(first.id); flyToCell(first.cell); }
      })),
  ];

  // Climate and biomes -------------------------------------------------------
  const climateStats = stats([['temp', 'Mean temperature'], ['ice', 'Ice cover'], ['sea', 'Sea level'], ['source', 'Planet climate'],
    ['evap', 'Evaporation'], ['rain', 'Rainfall'], ['ground', 'Groundwater on land'], ['erosion', 'Erosion passes']]);
  const climateSection = [
    climateStats.list,
    toggle('Evaporation makes the clouds', 'humidity', layers),
    slider('Temperature', 'temperature', -30, 30, 1, v => `${v > 0 ? '+' : ''}${v} °C`),
    slider('Greenhouse strength', 'greenhouse', 0, 2, 0.05, v => `×${v.toFixed(2)}`),
    slider('Volcanism', 'volcanism', 0, 3, 0.05, v => `×${v.toFixed(2)}`),
    slider('Rain erosion', 'erosion', 0, 3, 0.05, v => v ? `×${v.toFixed(2)}` : 'Off'),
    el('p', { class: 'cl-hint', text: 'Rain runs downhill and cuts valleys with the studio\'s own erosion, faster where the simulation rains more.' }),
    toggle('Show biomes', 'biomes', layers),
  ];

  // Meteorites ------------------------------------------------------------------
  const meteorStats = stats([['count', 'Impacts'], ['last', 'Last impact'], ['seeded', 'Lineages seeded'], ['craters', 'Craters cut']]);
  const meteorSection = [
    slider('Impact rate', 'meteorRate', 0, 30, 0.5, v => `${v} per 100 Myr`),
    slider('Impactor size', 'meteorSize', 0.05, 1.2, 0.01, v => v.toFixed(2)),
    slider('Seeds life (panspermia)', 'panspermia', 0, 1, 0.01, v => `${Math.round(v * 100)}%`),
    toggle('Craters reshape the terrain', 'deform', layers),
    toggle('Show crater marks and ejecta', 'scars', layers),
    button('Drop a meteorite where I look', () => dropMeteorite(), true),
    meteorStats.list,
  ];

  // Lightning and wildfires -----------------------------------------------------
  const stormStats = stats([['weather', 'Weather'], ['cyclones', 'Cyclones now'], ['strongest', 'Strongest'], ['formed', 'Cyclones formed'], ['strikes', 'Strikes'], ['fires', 'Fires started'], ['burning', 'Burning now']]);
  const satelliteButton = button('Show storm eyes in the clouds', () => {
    // The satellite weather shapes draw each cyclone's eye, eyewall and rainbands.
    const select = doc.getElementById('planet-shape-preset');
    if (!select) return;
    select.value = 'satellite_realistic';
    select.dispatchEvent(new Event('change'));
  });
  const stormSection = [
    toggle('Tropical cyclones', 'cyclones', layers),
    satelliteButton,
    slider('Storm activity', 'storms', 0, 4, 0.05, v => `×${v.toFixed(2)}`),
    toggle('Wildfires', 'wildfires'),
    slider('Dryness', 'dryness', 0, 1, 0.01, v => `${Math.round(v * 100)}%`),
    toggle('Show fires', 'fire', layers),
    stormStats.list,
    el('p', { class: 'cl-hint', text: 'Storms follow the cloud weather: thunderstorm presets strike more. Strikes in water make organics; strikes in dry vegetation can start fires once plants reach land.' }),
  ];

  const style = el('style', { text: `
    .cl-life-stats { display:grid; grid-template-columns:auto 1fr; gap:var(--space-1) var(--space-4); margin:0; padding:var(--space-3) var(--space-4);
      background:var(--surface-inset); border:1px solid var(--line); border-radius:var(--radius-md); font-size:11px; line-height:16px; }
    .cl-life-stats dt { color:var(--ink-faint); } .cl-life-stats dd { margin:0; color:var(--ink); text-align:right; font-variant-numeric:tabular-nums; }
    .cl-life-tree { display:block; width:100%; height:180px; background:var(--surface-inset); border:1px solid var(--line); border-radius:var(--radius-md); cursor:pointer; }
    .cl-life-timeline { list-style:none; margin:0; padding:0 var(--space-3); max-height:160px; overflow:auto; font-size:11px; line-height:16px; color:var(--ink-muted);
      background:var(--surface-inset); border:1px solid var(--line); border-radius:var(--radius-md); }
    .cl-life-timeline li { padding:var(--space-1) 0; border-bottom:1px solid var(--line); } .cl-life-timeline li:last-child { border-bottom:0; }
    .cl-life-timeline li.is-link { cursor:pointer; } .cl-life-timeline li.is-link:hover { color:var(--ink); }
    .cl-life-timeline time { color:var(--ink-faint); margin-right:var(--space-2); font-variant-numeric:tabular-nums; }
    .cl-life-timeline li[data-kind=milestone] { color:var(--sun); } .cl-life-timeline li[data-kind=origin] { color:var(--sky); }
    .cl-life-legend { display:flex; flex-wrap:wrap; gap:var(--space-1) var(--space-4); }
    .cl-life-key { display:inline-flex; align-items:center; gap:var(--space-2); }
    .cl-life-key i { width:8px; height:8px; border-radius:var(--radius-pill); background:var(--swatch); }
    .cl-life-detail { display:grid; gap:var(--space-3); }
  ` });

  function largestLineage() {
    if (!sim) return null;
    let top = null;
    for (const l of sim.lineages) if (l.extinct === null && (!top || l.cells > top.cells)) top = l;
    return top;
  }

  function lookCell() {
    if (!cameraState || !world || !sim) return null;
    const { position: p, forward: f } = cameraState;
    const R = world.radius;
    const b = p[0] * f[0] + p[1] * f[1] + p[2] * f[2];
    const c = p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - R * R;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const hit = p.map((v, k) => v + f[k] * t);
    const length = Math.hypot(...hit);
    return hit.map(v => v / length);
  }

  function dropMeteorite() {
    if (!sim) return;
    const dir = lookCell() ?? undefined;
    sim.impact(dir ? { dir } : {});
  }

  function restart() {
    if (!world) return;
    sampledMap = null;
    build();
  }

  function build() {
    if (!world) return;
    try {
      const radius = world.radius;
      const climate = studioClimate(world.studioSeed);
      const grid = createCellGrid(CELL_COUNT);
      const env = createEnvironment(grid, {
        radius, climate, seed: world.studioSeed,
        sample(dir) {
          const surface = world.sampleSurface(dir);
          const landforms = world.sampleLandforms?.(dir);
          return { height: surface.height, depth: surface.depth, volcanic: landforms?.volcanic ?? 0 };
        },
      });
      craters.clear();
      cyclones.clear();
      overlay.clearCraters();
      sim = createLifeSim({ grid, env, seed: world.studioSeed, settings, onImpact: record => { if (layers.deform) craters.add(record, performance.now() / 1000); } });
      sampledMap = world.studioMap;
      sampledSeed = world.studioSeed;
      seenStrikes = seenImpacts = 0;
      pendingSteps = 0;
      buildError = null;
      selectLineage(null);
      timeline.replaceChildren();
      climateStats.values.source.textContent = climate[3] === 0 ? 'Snow-free' : climate[1] === 0 && climate[0] === 0 ? 'Highland snow' : 'Polar snow';
    } catch (error) {
      // The terrain map may still be baking; try again on a later frame.
      buildError = error;
      sim = null;
    }
  }

  function updatePanels() {
    if (!sim) {
      lifeStats.values.time.textContent = buildError ? 'Waiting for terrain…' : '—';
      return;
    }
    const { state, lineages, env } = sim;
    const v = lifeStats.values;
    v.time.textContent = formatTime(state.time) + (running ? '' : ' (paused)');
    v.alive.textContent = String(state.alive);
    v.total.textContent = String(lineages.length);
    v.complexity.textContent = state.maxComplexity.toFixed(1) + ' / 9';
    const tags = Object.entries(state.tagCells ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    v.traits.textContent = tags.join(', ') || (state.alive ? 'simple replicators' : 'none yet');
    const h = habitatStats.values;
    const counts = { vent: 0, tidal: 0, pond: 0, spring: 0 };
    const keys = Object.keys(HABITATS);
    let soup = 0, water = 0;
    for (let i = 0; i < sim.grid.count; i++) {
      const key = keys[env.habitat[i]];
      if (key in counts) counts[key]++;
      if (env.water[i]) { soup += sim.organics[i]; water++; }
    }
    for (const key in counts) h[key].textContent = String(counts[key]);
    h.soup.textContent = water ? (soup / water).toFixed(2) : '0';
    h.origins.textContent = String(lineages.filter(l => l.parent === null).length);
    const p = planetStats.values;
    p.o2.textContent = `${(state.o2 * 21).toFixed(state.o2 < 0.05 ? 2 : 1)}%`;
    p.co2.textContent = `${state.co2.toFixed(1)}× today`;
    p.biomass.textContent = state.biomass.toFixed(0);
    p.land.textContent = `${Math.round(state.landCover * 100)}%`;
    const top = largestLineage();
    p.top.textContent = top ? `L${top.id} (${top.tags.join(', ') || 'replicator'})` : '—';
    climateStats.values.temp.textContent = `${state.globalTemperature.toFixed(1)} °C`;
    climateStats.values.ice.textContent = `${Math.round(state.ice * 100)}%`;
    climateStats.values.evap.textContent = (state.evaporation ?? 0).toFixed(2);
    climateStats.values.rain.textContent = (state.rainfall ?? 0).toFixed(2);
    climateStats.values.erosion.textContent = String(erosion.passes);
    climateStats.values.ground.textContent = `${Math.round((state.groundwater ?? 0) / 3 * 100)}% of capacity`;
    climateStats.values.sea.textContent = env.anyOcean ? `${state.seaOffset >= 0 ? '+' : ''}${(state.seaOffset / env.relief * 100).toFixed(1)}% of relief` : 'No ocean';
    const m = meteorStats.values;
    m.count.textContent = String(state.impacts);
    const last = sim.impacts.at(-1);
    m.last.textContent = last ? `${formatTime(last.time)}, size ${last.size.toFixed(2)}` : '—';
    m.seeded.textContent = String(lineages.filter(l => l.origin === 'meteorite').length);
    m.craters.textContent = String(craters.total);
    const s = stormStats.values;
    const label = PLANET_CLOUD_STYLES.find(p => p.id === cloudInfo.style)?.label ?? 'Clouds';
    s.weather.textContent = `${cloudInfo.enabled ? label : 'Clouds hidden'} ×${stormFactor(cloudInfo.style, cloudInfo.enabled)}`;
    s.strikes.textContent = String(state.strikes);
    s.fires.textContent = String(state.fires);
    s.burning.textContent = String(state.burning ?? 0);
    s.cyclones.textContent = String(cyclones.storms.length);
    const strongest = cyclones.storms.reduce((a, b) => (!a || b.intensity > a.intensity ? b : a), null);
    s.strongest.textContent = strongest ? (stormCategory(strongest.intensity) ? `Category ${stormCategory(strongest.intensity)}` : 'Tropical storm') : '—';
    s.formed.textContent = String(cyclones.formed);
    renderTimeline();
  }

  let shownEvents = 0;
  function renderTimeline() {
    const events = sim.events;
    const latest = events.at(-1);
    if (!latest || latest === timeline._latest) return;
    timeline._latest = latest;
    const notable = events.filter(e => e.kind !== 'impact' || e.lineage !== null || e.size > 0.7).slice(-60).reverse();
    shownEvents = notable.length;
    timeline.replaceChildren(...notable.map(e => {
      const item = el('li', { 'data-kind': e.kind }, el('time', { text: formatTime(e.time) }), e.text);
      if (e.lineage !== undefined && e.lineage !== null) {
        item.classList.add('is-link');
        item.addEventListener('click', () => { selectLineage(e.lineage); flyToCell(sim.lineages[e.lineage]?.cell); });
      }
      return item;
    }));
  }

  // Genealogy laid out on a time axis: rows in depth-first order so each
  // family stays together, with a connector from parent to child at birth.
  function renderTree() {
    const ctx = tree.getContext('2d');
    const W = tree.width, H = tree.height;
    ctx.clearRect(0, 0, W, H);
    if (!sim) return;
    const { lineages, state } = sim;
    const keep = new Set();
    for (let i = lineages.length - 1; i >= 0; i--) {
      const l = lineages[i];
      const important = l.peak >= 12 || (l.extinct === null && l.cells >= 4) || l.origin === 'meteorite' && l.peak >= 2;
      if (important || keep.has(l.id)) {
        keep.add(l.id);
        if (l.parent !== null) keep.add(l.parent);
      }
    }
    const shown = [];
    const visit = (l, depth) => {
      if (shown.length > 140) return;
      shown.push(l);
      for (const c of l.children) if (keep.has(c)) visit(lineages[c], depth + 1);
    };
    for (const l of lineages) if (l.parent === null && keep.has(l.id)) visit(l, 0);
    const end = Math.max(50, state.time);
    const top = 14, rowH = Math.max(2, Math.min(10, (H - top - 4) / Math.max(1, shown.length)));
    const x = t => 4 + (W - 8) * t / end;
    const rowOf = new Map();
    treeRows = shown.map((l, n) => {
      const y = top + n * rowH + rowH / 2;
      rowOf.set(l.id, y);
      return { id: l.id, y, h: rowH / 2 };
    });
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(167,190,209,.8)';
    ctx.fillText('0', 4, 12);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(state.time), W - 4, 12);
    ctx.textAlign = 'left';
    // Large impacts as faint vertical bands.
    for (const impact of sim.impacts) {
      if (impact.size < 0.6) continue;
      ctx.fillStyle = `rgba(255,140,60,${0.12 + 0.2 * Math.min(1, impact.size)})`;
      ctx.fillRect(x(impact.time), top, 1.5, H - top);
    }
    for (const l of shown) {
      const y = rowOf.get(l.id);
      const x0 = x(l.born), x1 = x(l.extinct ?? state.time);
      if (l.parent !== null && rowOf.has(l.parent)) {
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, rowOf.get(l.parent)); ctx.lineTo(x0, y); ctx.stroke();
      }
      const selected = layers.selectedFamily?.has(l.id);
      ctx.fillStyle = `hsla(${l.hue},80%,${selected ? 72 : 58}%,${l.extinct === null ? 1 : 0.55})`;
      ctx.fillRect(x0, y - Math.max(1, rowH * 0.35), Math.max(1.5, x1 - x0), Math.max(2, rowH * 0.7));
      if (l.origin === 'meteorite') {
        ctx.fillStyle = '#ffd28a';
        ctx.fillText('☄', Math.max(0, x0 - 16), y + 6);
      }
    }
    for (const e of sim.events) {
      if (e.kind !== 'milestone') continue;
      ctx.fillStyle = '#ffe39a';
      ctx.beginPath(); ctx.arc(x(e.time), top - 6, 3, 0, 2 * Math.PI); ctx.fill();
    }
  }

  function frame({ world: next, camera, cloudStyle, cloudsEnabled = true, sun }) {
    world = next;
    cameraState = camera;
    cloudInfo = { style: cloudStyle, enabled: cloudsEnabled };
    if (!world) return;
    if (!sim || world.studioSeed !== sampledSeed || world.studioMap !== sampledMap) {
      if (world.studioMap) build();
    }
    const now = performance.now() / 1000;
    const dt = lastNow === null ? 0 : Math.min(0.25, now - lastNow);
    lastNow = now;
    turnSun(dt);
    updateCyclones(dt, now);
    updateHumidity(now);
    if (sim && running) {
      pendingSteps += dt * speed;
      const start = performance.now();
      const factor = stormFactor(cloudStyle, cloudsEnabled);
      while (pendingSteps >= 1 && performance.now() - start < STEP_BUDGET_MS) {
        sim.step(factor);
        pendingSteps -= 1;
      }
      pendingSteps = Math.min(pendingSteps, 4);
    }
    if (sim) {
      const strikes = sim.state.strikes;
      if (strikes > seenStrikes) {
        // Show a few of the strikes from this frame; the rest are summarised.
        for (const strike of sim.strikes.slice(-Math.min(2, strikes - seenStrikes))) {
          overlay.flash(Array.from(sim.grid.dirs.subarray(strike.cell * 3, strike.cell * 3 + 3)), now);
        }
        seenStrikes = strikes;
      }
      if (sim.state.impacts > seenImpacts) {
        for (const record of sim.impacts.slice(-Math.min(3, sim.state.impacts - seenImpacts))) overlay.meteor(record, now);
        seenImpacts = sim.state.impacts;
      }
      if (craters.flush(world, sim, now)) layers.dirty = true;
      if (running) erosion.update(world, sim, now, settings.erosion);
      overlay.draw({ sim, world, camera, layers, now, sun });
    }
    if (now - lastPanel > 0.25) { lastPanel = now; updatePanels(); }
    if (now - lastTree > 0.5) { lastTree = now; renderTree(); }
  }

  return {
    sections: {
      'Lifeforms': [style, ...lifeSection],
      'First Life habitat': habitatSection,
      'Planet life': planetSection,
      'Climate and biomes': climateSection,
      'Meteorites': meteorSection,
      'Lightning and wildfires': stormSection,
    },
    frame,
    get sim() { return sim; },
    get canvas() { return overlay.canvas; },
    dispose() { overlay.dispose(); erosion.dispose(); setCloudHumidity(null); setSatelliteStorms(null); },
  };
}

export { stormFactor };
