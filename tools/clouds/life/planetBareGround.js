// Bare ground until plants grow: the terrain palettes paint lowlands green
// as if vegetated. While the life simulation runs, green palette stops are
// turned into soil and rock of the same lightness, and the renderer's own
// vegetation tint is switched off, so green on the globe comes only from
// the life layer where photosynthetic colonies actually live.

function hexToHsl(hex) {
  const r = (hex >> 16 & 255) / 255, g = (hex >> 8 & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].reduce((hex, c) => hex * 256 + Math.round(Math.min(1, Math.max(0, c)) * 255), 0);
}

// Greens and yellow-greens (hue 65 to 170) become brown soil and grey rock
// of the same lightness. Water blues and everything else stay.
export function bareStops(stops) {
  return stops.map(stop => {
    const [h, s, l] = hexToHsl(stop);
    if (h < 65 || h > 170 || s < 0.1) return stop;
    return hslToHex(28 + 10 * (l > 0.5 ? 1 : 0), Math.min(0.32, s * 0.45), l);
  });
}

// Keep the renderer's palette bare while `on`; restore it when off. Safe to
// call every frame: it only uploads when the world's profile changes.
export function applyBareGround(world, on) {
  if (!world?.profile || typeof world.uploadStyle !== 'function') return false;
  const state = world.__bareGround ??= { original: null, patched: null };
  if (world.profile !== state.patched) { state.original = world.profile; state.patched = null; }
  if (on && !state.patched) {
    state.patched = { ...state.original, stops: bareStops(state.original.stops ?? []), vegetation: 0 };
    world.profile = state.patched;
    world.uploadStyle();
    return true;
  }
  if (!on && state.patched) {
    world.profile = state.original;
    state.patched = null;
    world.uploadStyle();
    return true;
  }
  return false;
}
