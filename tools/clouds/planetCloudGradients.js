import { REFERENCE_LOOK_PRESETS } from './cloudLookPresets.js';

// Planet grading works on resolved radiance. These stops are display swatches
// for shadow, transmitted midtone, and highlight, followed by the highlight
// pivot and feather in linear radiance. Flat-demo looks keep their own stops.
const gradients = {
  17: ['744a68', 'b97886', 'ffd4d2', .30, .24], // Rosewater Dusk
  18: ['879db6', 'c4d7e4', 'fff6df', .28, .32], // Porcelain Daylight
  22: ['887fc1', 'c7b6eb', 'fff6fa', .27, .27], // Lavender Pearl
  24: ['303f79', '8096c8', 'e9edf6', .35, .21], // Silver Indigo
  25: ['6f434d', 'bf796a', 'f4c292', .28, .32], // Copper Atmosphere
  26: ['34224e', '784fa7', 'e6c8f5', .36, .20], // Lavender Ink
  27: ['2c3039', '707984', 'e9f0f3', .37, .18], // Silver Outline
  28: ['142963', '4264cb', '9bccff', .32, .21], // Cobalt Ink
  29: ['665a88', 'a999d5', 'eee2fd', .32, .30], // Lavender Gouache
  30: ['283268', '6a75b2', 'cbd0f1', .30, .24], // Indigo Gouache
  31: ['833b58', 'df8e9b', 'ffe1a5', .31, .25], // Rose Gold Wash
  32: ['6a4936', 'bf893b', 'f7dda5', .27, .24], // Copper Ochre Gouache
  33: ['794e9e', 'd497df', 'fff0fb', .24, .34], // Lavender Glaze
  34: ['422648', '7c58d0', 'c4b5fb', .36, .26], // Violet Underpainting
  35: ['614775', 'bd779f', 'ffd6a3', .27, .25], // Lavender Sunwash
  36: ['242d42', '777c8f', 'd0e2f8', .34, .23], // Silver Ink Wash
  37: ['4a294e', 'ad6eae', 'f5cce7', .32, .21], // Lilac Ink Wash
  38: ['283b85', '536fc6', 'b5d6f8', .24, .24], // Indigo Ink Currents
  39: ['45576d', 'a3b9bf', 'f9fff0', .27, .30], // Pearl Ink Wisps
  40: ['232246', '554a95', 'a8acf0', .41, .19], // Indigo Layered Ink
  41: ['425481', '8e8cd4', 'f9d3f0', .32, .27], // Lavender Layered Wash
  42: ['123d46', '238c89', '8ae6d6', .31, .28], // Cyan Layered Ink
  43: ['262839', '484b6a', 'e9ca95', .39, .16], // Indigo Sumi Crests
  44: ['263b4e', '6d9baf', 'fff0cf', .30, .20], // Indigo Sumi Filaments
  45: ['49738f', '9dc3dd', 'fff5db', .25, .34], // Blue Sky Dawn
  47: ['384958', '839ba7', 'd7e5ea', .35, .28], // Storm Silver
  48: ['926564', 'e3a276', 'ffe2b7', .25, .28], // Apricot Gouache
  49: ['875061', 'df9295', 'ffe2dc', .30, .26], // Coral Porcelain
};

function linearColor(hex) {
  return [0, 2, 4].map(index => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
}

export function resolvePlanetCloudGradient(style) {
  if (!style?.colorPresetSource || style.planetGradient) return style;
  const id = style.colorPresetId;
  const recipe = gradients[id];
  const reference = REFERENCE_LOOK_PRESETS[id];
  if (!recipe || !reference) return style;
  const [shadow, midtone, highlight, pivot, feather] = recipe;
  const swatches = { cloudShadowTint: shadow, cloudLitTint: highlight, edgeTint: highlight };
  const updated = { ...style, cloudMidTint: style.cloudMidTint ?? linearColor(midtone),
    planetGradient: { pivot, feather } };
  for (const [key, hex] of Object.entries(swatches)) {
    // Existing saves may already have hand-edited swatches.
    if (!Array.isArray(style[key]) || style[key].every((channel, index) => channel === reference[key][index])) {
      updated[key] = linearColor(hex);
    }
  }
  return updated;
}
