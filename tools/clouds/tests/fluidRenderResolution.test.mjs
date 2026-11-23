import test from 'node:test';
import assert from 'node:assert/strict';
import {createFluidRenderResolution} from '../fluidRenderResolution.js';

function recordFrames(resolution, count, ms, nativePixels = 2560 * 1440) {
  for (let i = 0; i < count; i++) resolution.recordFrame(ms, nativePixels);
}

test('Fluid starts at the old pixel cap and grows only with sustained headroom', () => {
  const resolution = createFluidRenderResolution();
  assert.equal(resolution.pixelBudget, 800_000);
  recordFrames(resolution, 30, 4);
  assert.equal(resolution.pixelBudget, 800_000);
  recordFrames(resolution, 240, 4);
  assert.equal(resolution.pixelBudget, 4_000_000);
});

test('Fluid does not grow its quality budget after reaching the display size', () => {
  const resolution = createFluidRenderResolution();
  recordFrames(resolution, 120, 4, 960 * 540);
  assert.equal(resolution.pixelBudget, 800_000);
  recordFrames(resolution, 180, 4, 1280 * 720);
  assert.equal(resolution.pixelBudget, 1_100_000);
});

test('Fluid backs off during sustained overload and avoids retrying at the same cost', () => {
  const resolution = createFluidRenderResolution();
  recordFrames(resolution, 45, 8.8);
  assert.equal(resolution.pixelBudget, 1_100_000);
  recordFrames(resolution, 14, 19);
  assert.equal(resolution.pixelBudget, 800_000);
  recordFrames(resolution, 300, 8.8);
  assert.equal(resolution.pixelBudget, 800_000);
  recordFrames(resolution, 60, 5);
  assert.ok(resolution.pixelBudget > 800_000);
});

test('Fluid can return to a previously stable tier after a temporary load spike', () => {
  const resolution = createFluidRenderResolution();
  recordFrames(resolution, 360, 5);
  assert.equal(resolution.pixelBudget, 4_000_000);
  recordFrames(resolution, 22, 23);
  assert.ok(resolution.pixelBudget < 4_000_000);
  recordFrames(resolution, 400, 5);
  assert.equal(resolution.pixelBudget, 4_000_000);
});

test('Fluid refines paused inspections after settling and preserves the live tier', () => {
  const resolution = createFluidRenderResolution();
  recordFrames(resolution, 45, 6);
  const live = {pixelBudget: 1_100_000, inspection: false};
  const detail = {pixelBudget: 4_000_000, inspection: true};
  assert.deepEqual(resolution.frameQuality(0, false, false), live);
  assert.deepEqual(resolution.frameQuality(299, true, false), live);
  assert.deepEqual(resolution.frameQuality(300, true, false), detail);
  assert.deepEqual(resolution.frameQuality(400, true, true), live);
  assert.deepEqual(resolution.frameQuality(699, true, false), live);
  assert.deepEqual(resolution.frameQuality(700, true, false), detail);
  assert.deepEqual(resolution.frameQuality(800, false, false), live);
  assert.equal(resolution.pixelBudget, 1_100_000);
});
