import { adoptField, createDisclosure } from './cloudLabUi.js';

// Planet rail specifics. The shared look lives in cloudLabUi.js; this only
// pins the apply bar to the bottom of the planet rail and sizes the
// advanced editor grids for the 360px rail.
export function stylePlanetPanel(hud, id = 'planet-controls') {
  hud.id = id;
  const style = document.createElement('style');
  style.textContent = `
    #planet-controls #planet-edit-actions { position:sticky; bottom:calc(-1 * var(--space-5)); z-index:2;
      margin:var(--space-5) calc(-1 * var(--space-5)) calc(-1 * var(--space-5)); border-top:1px solid var(--line); }
    #planet-controls .cl-tabs { margin-top:var(--space-4); }
    #planet-controls .cl-legacy > div[style*="display: grid"], #planet-controls .cl-legacy > div[style*="display:grid"] { gap:var(--space-4) !important; }
    #planet-controls .cl-disclosure + .cl-disclosure, #planet-controls .cl-legacy .cl-disclosure { margin-top:var(--space-4); }
    #planet-controls .cl-legacy label { gap:var(--space-2) !important; }
    #planet-controls .cl-section-menu { display:grid; gap:var(--space-2); margin:var(--space-4) 0; }
    #planet-controls .cl-section-menu input[type=range] { width:100%; }
    #planet-controls .cl-btngrid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--space-3); }
    #planet-controls .cl-btngrid > .cl-btn { width:100%; }
    #planet-controls .cl-btngrid > .cl-hint { grid-column:1 / -1; }
  `;
  style.textContent = style.textContent.replaceAll('#planet-controls', '#' + id);
  hud.prepend(style);
}

// The rail's shared disclosure, so planet sections match every other panel.
export function planetDisclosure(title, ...nodes) {
  return createDisclosure(title, nodes);
}

// The world sections of the planet rail, in menu order. Sections whose
// features are not built yet show a short note instead of controls.
export const PLANET_SECTIONS = Object.freeze([
  'Camera controls',
  'Lifeforms',
  'First Life habitat',
  'Planet life',
  'Climate and biomes',
  'Meteorites',
  'Lightning and wildfires',
]);

export function planetSectionMenu(doc, contents = {}, open = []) {
  const menu = doc.createElement('div');
  menu.id = 'planet-sections';
  menu.className = 'cl-section-menu';
  for (const title of PLANET_SECTIONS) {
    const nodes = contents[title]?.filter(Boolean) ?? [];
    if (!nodes.length) {
      const note = doc.createElement('p');
      note.className = 'cl-hint';
      note.textContent = 'Coming soon.';
      nodes.push(note);
    }
    const section = planetDisclosure(title, ...nodes);
    section.dataset.section = title.toLowerCase().replace(/[^a-z]+/g, '-');
    section.open = open.includes(title);
    menu.append(section);
  }
  return menu;
}

// Mouse wheel zoom: step the existing height slider (log2 of altitude) and
// let its input handler move the camera, so zoom follows the same path as
// dragging the slider.
export function wheelZoom(target, altitude, { octavesPerPixel = 0.004 } = {}) {
  const onWheel = (event) => {
    if (altitude.disabled || event.ctrlKey) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    const min = Number(altitude.min), max = Number(altitude.max);
    const next = Math.min(max, Math.max(min, Number(altitude.value) + pixels * octavesPerPixel));
    if (next === Number(altitude.value)) return;
    altitude.value = String(next);
    altitude.dispatchEvent(new Event('input', { bubbles: true }));
  };
  target.addEventListener('wheel', onWheel, { passive: false });
  return () => target.removeEventListener('wheel', onWheel);
}

// Bring the planet demo's original controls (buttons, check rows, the height
// row) onto the shared Cloud Lab controls, keeping every id and listener.
export function unifyPlanetControls(root) {
  const doc = root.ownerDocument;
  for (const id of ['sceneAnimation', 'hideInterface']) {
    root.querySelector('#' + id)?.classList.add('cl-btn', 'cl-btn--sm');
  }
  for (const group of root.querySelectorAll('.buttons')) {
    group.classList.add('cl-btngrid');
    for (const button of group.querySelectorAll('button')) button.classList.add('cl-btn', 'cl-btn--sm');
    group.querySelector('#flightHelp')?.classList.add('cl-hint');
  }
  for (const label of root.querySelectorAll('label.checks')) {
    if (label.querySelector('input[type=checkbox]')) adoptField(label, { text: label.textContent.trim() });
  }
  // <div class=row><label for=x>Text <output/></label><input id=x/></div>
  for (const row of root.querySelectorAll('div.row')) {
    const caption = row.querySelector('label[for]');
    const input = caption && row.querySelector(`#${CSS.escape(caption.htmlFor)}`);
    if (!input) continue;
    const value = caption.querySelector('output');
    const text = [...caption.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const label = doc.createElement('label');
    label.append(input);
    row.replaceWith(adoptField(label, { text, value }));
  }
  const weather = root.querySelector('#planet-weather-current');
  if (weather) { weather.removeAttribute('style'); weather.classList.add('cl-hint'); }
}
