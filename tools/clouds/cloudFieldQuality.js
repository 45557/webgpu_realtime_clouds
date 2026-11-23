import { localPlanetCloudForm } from './localPlanetClouds.js';

// Independent spatial fidelity for the cached flat-cloud density + lighting.
// Both textures are rgba16float (16 bytes together per voxel). Dimensions stay
// uniforms, so changing quality reuses the same compute pipelines.
export const CLOUD_FIELD_QUALITIES = Object.freeze({
  low: Object.freeze({label:'Low / fast', dimensions:Object.freeze([96,48,96])}),
  balanced: Object.freeze({label:'Balanced / default', dimensions:Object.freeze([128,64,128])}),
  high: Object.freeze({label:'High / finer clouds', dimensions:Object.freeze([192,96,192])}),
  ultra: Object.freeze({label:'Screenshot / 256', dimensions:Object.freeze([256,128,256])}),
  cinematic: Object.freeze({label:'Capture / 384 · 494 MiB', dimensions:Object.freeze([384,192,384])}),
  reference: Object.freeze({label:'Reference / 512 · 1.14 GiB', dimensions:Object.freeze([512,256,512])}),
});

const MARINE_BALANCED_DIMENSIONS = Object.freeze([208,80,208]);
const MARINE_HIGH_DIMENSIONS = Object.freeze([224,96,224]);
const LOCAL_PLANET_BALANCED_DIMENSIONS = Object.freeze([208,88,208]);
const THUNDERHEAD_BALANCED_DIMENSIONS = Object.freeze([256,104,256]);
const THUNDERHEAD_HIGH_DIMENSIONS = Object.freeze([256,116,256]);

export function cloudFieldDimensions(quality, formType) {
  // A long coastal field is wide but shallow. Spend the default cache on
  // lateral billows, where the generic balanced volume had the coarsest pitch.
  if (localPlanetCloudForm(formType)) {
    if (quality === 'balanced') return LOCAL_PLANET_BALANCED_DIMENSIONS;
    if (quality === 'high') return MARINE_HIGH_DIMENSIONS;
  }
  if (formType === 1.4375) {
    if (quality === 'balanced') return THUNDERHEAD_BALANCED_DIMENSIONS;
    if (quality === 'high') return THUNDERHEAD_HIGH_DIMENSIONS;
  }
  if (formType > 1 && formType < 1.5) {
    if (quality === 'balanced') return MARINE_BALANCED_DIMENSIONS;
    if (quality === 'high') return MARINE_HIGH_DIMENSIONS;
  }
  return CLOUD_FIELD_QUALITIES[quality].dimensions;
}

export function normalizeCloudFieldQuality(value) {
  return Object.hasOwn(CLOUD_FIELD_QUALITIES,value) ? value : 'balanced';
}

// Some backends initialize a 3D texture through a staging buffer as large as
// that texture. Reference needs 512 MiB per texture, above the default 256 MiB
// buffer limit. Request only this bounded allowance; it allocates no memory.
export function cloudFieldDeviceDescriptor(limits = {}) {
  const maxBufferSize = Math.min(512 * 1024**2, limits.maxBufferSize ?? 256 * 1024**2);
  return maxBufferSize > 256 * 1024**2 ? {requiredLimits:{maxBufferSize}} : {};
}

export function supportsCloudFieldQuality(quality, limits = {}) {
  const dimensions = CLOUD_FIELD_QUALITIES[quality]?.dimensions;
  return !!dimensions && dimensions.every(n => n <= (limits.maxTextureDimension3D ?? Infinity)) &&
    dimensions.reduce((bytes,n) => bytes*n,8) <= (limits.maxBufferSize ?? Infinity);
}
