import {PLANET_CLOUD_STYLES, planetCloudStyleOptions, planetGasWeatherMode} from './planetCloudStyles.js';

// A separate range inside Flat's form selector keeps its authored recipes
// independent. Binary-exact IDs survive the existing f32 tuning uniform.
export const LOCAL_PLANET_CLOUDS = Object.freeze(PLANET_CLOUD_STYLES
  .filter(({id}) => id !== 'legacy' && !planetGasWeatherMode(id))
  .map((style, index) => ({
    ...style, preset: 'planet_' + style.id, form: 1.5 + index / 64,
    options: planetCloudStyleOptions(style.id, 200),
  })));

const byForm = new Map(LOCAL_PLANET_CLOUDS.map(style => [style.form, style]));
const convectiveForms = [2.25, 2.38, 2.40, 2.41, 2.43, 2.44];

export function isLocalPlanetConvectiveForm(form) {
  return convectiveForms.includes(byForm.get(form)?.options.tuning.formType);
}
export function localPlanetCloudForm(form) {
  return byForm.get(form);
}

export function localPlanetCloudPreset(style) {
  return LOCAL_PLANET_CLOUDS.find(preset => preset.id === style)?.preset;
}

const types = LOCAL_PLANET_CLOUDS.map(style => style.options.tuning.formType.toFixed(5)).join(',');
const isConvectiveFormWGSL = convectiveForms.map(form => 'form == ' + form.toFixed(2)).join(' || ');
export const localPlanetFormsWGSL = `
const localPlanetForms = array<f32, ${LOCAL_PLANET_CLOUDS.length}>(${types});
fn localConvectiveForm(form: f32) -> bool {
  return ${isConvectiveFormWGSL};
}
fn isLocalPlanetCloud(form: f32) -> bool {
  return form >= 1.5 && form < 1.5 + f32(${LOCAL_PLANET_CLOUDS.length}) / 64.0;
}
fn localPlanetForm(form: f32) -> f32 {
  return localPlanetForms[min(u32(max((form - 1.5) * 64.0, 0.0)), ${LOCAL_PLANET_CLOUDS.length - 1}u)];
}
`;
