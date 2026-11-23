import {bakePlanetRegion, pickPlanetRegion, planetRegionCoordinates, planetRegionDirection,
  planetRegionFrame, projectPlanetRegionPoint, storePlanetRegion} from './planetRegion.js';
import {warmPlanetRegionSurface, samplePlanetRegionSurface} from './planetRegionMaterial.js';

export function mountPlanetRegionPicker(document, parent, readScene, openFluidRegion) {
  const section = document.createElement('div');
  section.className = 'cl-basic-block';
  section.innerHTML = `
    <label class="row"><span>Local map width</span>
      <select id="planet-local-span"><option value="4000">4 km</option><option value="12000">12 km</option>
        <option value="32000" selected>32 km</option><option value="80000">80 km</option><option value="160000">160 km</option></select>
    </label>
    <label class="row"><span>Open picked region in</span>
      <select id="planet-local-destination"><option value="fluid" selected>Fluid flight</option><option value="flat">Flat clouds</option></select>
    </label>
    <div style="display:flex;gap:.45rem;flex-wrap:wrap">
      <button type="button" id="planet-local-pick" class="cl-btn">Pick local region</button>
      <button type="button" id="planet-local-export" class="cl-btn" disabled>Build local map</button>
      <a id="planet-local-open" class="cl-btn" hidden>Open in Flat</a>
      <a id="planet-local-fluid" class="cl-btn" hidden>Open in Fluid</a>
    </div>
    <output id="planet-local-status" style="display:block;margin:.4rem 0;font-size:.85em" aria-live="polite"></output>`;
  parent.after(section);
  const spanInput = section.querySelector('#planet-local-span');
  const destination = section.querySelector('#planet-local-destination');
  const pickButton = section.querySelector('#planet-local-pick');
  const buildButton = section.querySelector('#planet-local-export');
  const open = section.querySelector('#planet-local-open');
  const fluid = section.querySelector('#planet-local-fluid');
  const status = section.querySelector('output');
  const outline = document.createElement('canvas');
  outline.setAttribute('aria-label', 'Planet region selection');
  outline.tabIndex = -1;
  outline.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;touch-action:none';
  document.body.append(outline);
  const paint = outline.getContext('2d');
  const nextFrame = () => new Promise(requestAnimationFrame);
  let selected, picking = false, building = false, warmedWorld;

  function pickMode(enabled) {
    picking = enabled;
    outline.style.pointerEvents = enabled ? 'auto' : 'none';
    outline.style.cursor = enabled ? 'crosshair' : '';
    pickButton.textContent = enabled ? 'Cancel selection' : 'Pick local region';
    pickButton.setAttribute('aria-pressed', String(enabled));
    if (enabled) outline.focus();
  }
  const selectedSpan = () => Number(spanInput.value);
  function updateStatus() {
    open.hidden = fluid.hidden = true;
    if (!selected) return;
    const [lat, lon] = planetRegionCoordinates(selected.frame.up);
    status.textContent = `${(selectedSpan() / 1000).toFixed(1)} km square · ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  }
  pickButton.onclick = () => {
    if (!readScene().camera) return;
    pickMode(!picking);
    if (picking) {
      status.textContent = 'Click the planet, or press Enter to use the view center.';
      const {world} = readScene();
      void warmPlanetRegionSurface(world).catch(() => {});
    }
    else if (selected) updateStatus();
    else status.textContent = '';
  };
  function selectAt(ndcX, ndcY) {
    const {world, camera} = readScene();
    const direction = pickPlanetRegion(camera, ndcX, ndcY, world.radius, dir => world.sampleSurface(dir).height);
    if (!direction) {
      status.textContent = 'Aim at the visible planet surface.';
      return;
    }
    selected = {frame: planetRegionFrame(direction), seed: world.studioSeed, preset: world.preset, radius: world.radius};
    pickMode(false);
    buildButton.disabled = false;
    updateStatus();
    void buildLocalMap();
  }
  outline.addEventListener('pointerdown', event => {
    if (!picking || event.button !== 0) return;
    const rect = outline.getBoundingClientRect();
    selectAt((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
  });
  outline.addEventListener('keydown', event => {
    if (!picking || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') selectAt(0, 0);
    else {
      pickButton.click();
      pickButton.focus();
    }
  });
  spanInput.onchange = updateStatus;
  async function buildLocalMap() {
    if (!selected || building) return;
    const {world, cloudStyle, cloudState, sunlight, captureWeather} = readScene();
    const tile = selected;
    const span = selectedSpan();
    const fluidFirst = destination.value === "fluid";
    pickMode(false);
    building = pickButton.disabled = spanInput.disabled = destination.disabled = buildButton.disabled = true;
    open.hidden = fluid.hidden = true;
    try {
      status.textContent = 'Sampling planet terrain…';
      const [region, weather] = await Promise.all([
        bakePlanetRegion(world, tile.frame.up, span, {
          sampleGrid: samplePlanetRegionSurface,
          cloudStyle, sunlight, includeSurroundings: true, yieldFrame: nextFrame,
          onProgress: progress => {status.textContent = `Refining local terrain… ${Math.floor(progress * 100)}%`;},
        }),
        captureWeather?.(tile.frame, span),
      ]);
      if (selected !== tile) throw new Error('Planet terrain changed. Select the region again.');
      if (weather) region.weather = weather;
      if (cloudState) region.cloudState = cloudState;
      const id = await storePlanetRegion(region);
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('demo', 'flat');
      url.searchParams.set('region', id);
      open.href = url.href;
      url.searchParams.set('demo', 'fluid');
      url.searchParams.set('view', 'flight');
      fluid.href = url.href;
      open.hidden = fluid.hidden = false;
      status.textContent = `${region.resolution} × ${region.resolution} terrain samples · ${(region.span / (region.resolution - 1)).toFixed(1)} m spacing · ${(region.span / 1000).toFixed(1)} km square${weather ? ' · Planet weather captured' : ''}`;
      if (fluidFirst && openFluidRegion) await openFluidRegion(fluid.href, region);
      else location.assign(fluidFirst ? fluid.href : open.href);
    } catch (error) {
      status.textContent = error.message;
      console.error(error);
    } finally {
      building = pickButton.disabled = spanInput.disabled = destination.disabled = false;
      buildButton.disabled = !selected;
    }
  }
  buildButton.onclick = buildLocalMap;

  return {
    get building() { return building; },
    draw(world, camera) {
      if (!warmedWorld) {
        warmedWorld = world;
        // Compile after the initial orbit frame can paint, while the user is
        // choosing a location. A click can always start the same work sooner.
        const warm = () => { if (!world.disposed) void warmPlanetRegionSurface(world).catch(() => {}); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, {timeout:500});
        else setTimeout(warm, 0);
      }
      if (selected && (selected.seed !== world.studioSeed || selected.preset !== world.preset || selected.radius !== world.radius)) {
        selected = null;
        open.hidden = fluid.hidden = true;
        buildButton.disabled = true;
        status.textContent = 'Planet changed. Pick a new local region.';
      }
      if (!selected) {
        buildButton.disabled = true;
        if (outline.width) outline.width = 0;
        return;
      }
      const width = outline.clientWidth, height = outline.clientHeight;
      if (outline.width !== width || outline.height !== height) {
        outline.width = width;
        outline.height = height;
      }
      paint.clearRect(0, 0, width, height);
      if (!selected) return;
      const half = selectedSpan() / 2;
      const corners = [[-1,-1],[1,-1],[1,1],[-1,1]];
      const points = corners.map(([x, z]) => {
        const dir = planetRegionDirection(selected.frame, x * half, z * half, world.radius);
        return projectPlanetRegionPoint(camera, dir, world.radius + world.sampleSurface(dir).height + half * 0.008);
      });
      if (points.some(point => !point)) return;
      paint.beginPath();
      points.forEach(([x, y], i) => {
        const px = (x + 1) * width / 2, py = (1 - y) * height / 2;
        if (i === 0) paint.moveTo(px, py);
        else paint.lineTo(px, py);
      });
      paint.closePath();
      paint.strokeStyle = 'rgba(137,235,255,.95)';
      paint.lineWidth = 2;
      paint.fillStyle = 'rgba(74,193,242,.12)';
      paint.fill();
      paint.stroke();
    },
  };
}
