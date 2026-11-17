import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {REFERENCE_LOOK_PRESETS,SCULPTED_LOOK_IDS} from '../cloudLookPresets.js';
import { resolvePlanetCloudGradient } from '../planetCloudGradients.js';
import { applyPlanetLightSwatches, PLANET_CLOUD_GRADE_FLOATS, writePlanetCloudGrade } from '../planetCloudGrade.js';

// Exercise the planet's actual palette converter without initializing terrain
// or Babylon. Applying a look must preserve cloud anatomy and sampling budget.
const source=await (Promise.all(['planetStudioPanel.js','noisePlanetTest.js'].map(file => readFile(new URL('../../noise/' + file,import.meta.url),'utf8'))).then(parts => parts.join('\n')));
const registry=source.slice(source.indexOf('export const CLOUD_LIGHTING_COLOR_PRESETS'),source.indexOf('function makeFullNoiseLayer')).replaceAll('export const','const');
const converter=source.slice(source.indexOf('function colorVec3FromPreset'),source.indexOf('function makeNoiseLayerFromMode'));
const convert=new Function('REFERENCE_LOOK_PRESETS','SCULPTED_LOOK_IDS','resolvePlanetCloudGradient',registry+converter+'return cloudColorPresetToConfigPatch;')(REFERENCE_LOOK_PRESETS,SCULPTED_LOOK_IDS,resolvePlanetCloudGradient);

test('planet reference looks transfer lighting without changing cloud shapes or performance',()=>{
 for(const [id,look] of Object.entries(REFERENCE_LOOK_PRESETS)){
  const patch=convert(id);
  assert.equal(patch.style.colorPresetLabel,look.label);
  assert.equal(patch.tuning.lightingFinish,SCULPTED_LOOK_IDS.includes(Number(id))?2:1);
  assert.deepEqual(Object.keys(patch).sort(),['params','style','tuning']);
  assert.deepEqual(Object.keys(patch.params).sort(),['frontLightColor','shadowLightColor','silverIntensity','sunBloom','sunColor']);
  assert.ok(patch.params.sunColor.every(Number.isFinite));
  assert.ok(Number.isFinite(patch.params.silverIntensity));
  assert.equal(patch.tuning.formType,undefined);
 }
 assert.notDeepEqual(convert('20').params.frontLightColor,convert('21').params.frontLightColor);
});

test('planet grade applies edits to the intended light without double tinting a saved look', () => {
  const { params, style } = convert('20');
  assert.deepEqual(applyPlanetLightSwatches(params, style, style), params);

  const edited = applyPlanetLightSwatches(params, {
    ...style, transmissiveLightTint: style.transmissiveLightTint.map(channel => channel * .5),
  }, style);
  assert.ok(edited.sunColor.every((channel, index) => channel < params.sunColor[index]));
  assert.deepEqual(edited.frontLightColor, params.frontLightColor);
  assert.deepEqual(edited.shadowLightColor, params.shadowLightColor);

  const custom = { ...params, sunColor: [6, 0, 2.5] };
  assert.deepEqual(applyPlanetLightSwatches(custom, style, style), custom);
});

test('planet grade uses authored tones and bypasses the palette for specialized cloud materials', () => {
  const { style } = convert('23');
  const data = new Float32Array(PLANET_CLOUD_GRADE_FLOATS + 4);
  const options = { style, cloudStyle: 'storybook', tuning: { formType: 2.125 } };
  writePlanetCloudGrade(data, 4, options);
  assert.deepEqual(Array.from(data.slice(4, 7)), style.cloudLitTint.map(Math.fround));
  assert.deepEqual(Array.from(data.slice(8, 11)), style.cloudShadowTint.map(Math.fround));
  assert.deepEqual(Array.from(data.slice(12, 15)), style.edgeTint.map(Math.fround));
  assert.deepEqual(Array.from(data.slice(24, 27)), style.transmissiveLightTint.map(Math.fround));
  assert.equal(data[18], Math.fround(style.styleMidLift));
  assert.ok(data[19] > 0);

  for (const special of [{ auroraMode: true }, { cloudStyle: 'emberstorm' }, {
    cloudStyle: 'jupiter_map', tuning: { formType: 6.25 },
  }]) {
    writePlanetCloudGrade(data, 4, { ...options, ...special });
    assert.equal(data[19], 0);
  }
  assert.deepEqual(Array.from(data.slice(0, 4)), [0, 0, 0, 0]);
});

test('calibrated grades have separate midtones and preserve hand-edited swatches in saved looks', () => {
  const colors = [26, 29, 33, 35, 37, 41].map(id => convert(id).style);
  assert.equal(new Set(colors.map(style => JSON.stringify(style.cloudMidTint))).size, colors.length);
  assert.ok(colors.every(style => style.planetGradient.pivot > 0));
  assert.equal(convert(20).style.planetGradient, null);
  const saved = {
    colorPresetSource: 'flat-cloud-test-v-grade', colorPresetId: 30,
    cloudLitTint: [1, .87, .79], cloudShadowTint: REFERENCE_LOOK_PRESETS[30].cloudShadowTint,
  };
  const refreshed = resolvePlanetCloudGradient(saved);
  assert.deepEqual(refreshed.cloudLitTint, saved.cloudLitTint);
  assert.notDeepEqual(refreshed.cloudShadowTint, saved.cloudShadowTint);
  assert.equal(resolvePlanetCloudGradient(refreshed), refreshed);
});
