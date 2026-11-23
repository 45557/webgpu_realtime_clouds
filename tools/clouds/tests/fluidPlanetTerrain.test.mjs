import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlanetRegionMesh} from '../cloudTerrainMesh.js';
import {prepareFluidPlanetTerrain} from '../fluidPlanetTerrain.js';
import {SEA_LEVEL} from '../fluidCloudShapes.js';

test('the Fluid grid and rendered mesh keep the saved terrain in the same orientation and scale', () => {
  const resolution = 3, span = 32000, min = 100, peak = 600;
  const region = {resolution, span, min, peak, radius:262144,
    elevations:new Float32Array([100,200,300,250,350,450,400,500,600]),
    water:new Uint8Array([1,0,0,0,0,0,0,0,0])};
  const {field, mesh, normalizedCutoff, layerHeight, cutoff, waterLevel} = prepareFluidPlanetTerrain(region, 16, 128);
  const coordinate = (x, z) => 2 * (z * 128 + x);
  assert.equal(field[coordinate(0, 64) + 1], 0);
  assert.equal(field[coordinate(64, 64) + 1], 1);
  assert.ok(field[coordinate(85, 64)] > field[coordinate(32, 64)]);
  assert.ok(field[coordinate(64, 85)] > field[coordinate(64, 32)]);
  assert.ok(Math.abs(mesh.vertices[0] + 7.2) < 1e-6);
  assert.ok(Math.abs(mesh.vertices[1] - SEA_LEVEL) < 1e-6);
  assert.ok(mesh.vertices[4] < 0, 'water type survives conversion');
  assert.ok(Math.abs(mesh.vertices[25] - layerHeight(350)) < 1e-6);
  assert.equal(normalizedCutoff(350), .5);
  assert.equal(waterLevel, SEA_LEVEL);
  assert.ok(normalizedCutoff(cutoff) > .20 && normalizedCutoff(cutoff) < .90);
});

test('a flat coastal tile still has a finite cutoff and an open inflow perimeter', () => {
  const region = {resolution:3, span:4000, min:800, peak:800, radius:262144,
    elevations:new Float32Array(9).fill(800), water:new Uint8Array(9).fill(1)};
  const terrain = prepareFluidPlanetTerrain(region, 16, 128);
  assert.ok(terrain.maxCutoff > terrain.minCutoff);
  assert.ok(terrain.cutoff > region.min);
  assert.ok(terrain.field.every(Number.isFinite));
  for (let i = 0; i < terrain.field.length; i += 2) assert.equal(terrain.field[i], 0);
});


test('surrounding terrain reaches the wind apron on every side of the selected square', () => {
  const resolution = 3, contextResolution = 25;
  const region = {resolution, span:32000, min:0, peak:60, radius:262144,
    elevations:new Float32Array(9).fill(30), water:new Uint8Array(9),
    context:{resolution:contextResolution, elevations:new Float32Array(contextResolution ** 2).fill(60),
      water:new Uint8Array(contextResolution ** 2)}};
  const gridSize = 128;
  const {field} = prepareFluidPlanetTerrain(region, 16, gridSize);
  for (const [x, z] of [[4,64],[123,64],[64,4],[64,123]]) {
    const index = 2 * (z * gridSize + x);
    assert.equal(field[index], 1);
    assert.equal(field[index + 1], 1);
  }
  for (const [x, z] of [[0,64],[127,64],[64,0],[64,127]]) {
    assert.equal(field[2 * (z * gridSize + x) + 1], 0);
  }
});

test('Fluid can prepare the flow field and sample the tile center without building the 3D mesh', () => {
  const resolution = 3;
  const elevations = new Float32Array(resolution ** 2).fill(20);
  const materials = new Uint8Array(elevations.length * 4);
  let reads = 0;
  const region = {resolution, span:32000, min:0, peak:20, radius:262144, elevations,
    water:new Uint8Array(elevations.length), get materials() { reads++; return materials; }};
  const terrain = prepareFluidPlanetTerrain(region, 16, 8);
  assert.equal(terrain.field[2 * (4 * 8 + 4)], 1);
  assert.equal(terrain.surfaceHeightAt(0, 0), terrain.layerHeight(20));
  assert.equal(reads, 0);

  const mesh = terrain.mesh;
  assert.ok(mesh.indices.length > 0);
  assert.ok(reads > 0);
  const afterBuild = reads;
  assert.equal(terrain.mesh, mesh);
  assert.equal(reads, afterBuild);
});

test('Fluid retains the saved Flat grid, triangles, and aspect ratio', () => {
  const resolution = 513, span = 32000;
  const elevations = Float32Array.from({length:resolution ** 2}, (_, i) => 700 + (i % resolution) * 3);
  const region = {resolution, span, min:700, peak:2236, radius:262144, seed:19, direction:[1,0,0],
    elevations, water:new Uint8Array(elevations.length), materials:new Uint8Array(elevations.length * 4), terrainDetail:true};
  const flat = createPlanetRegionMesh(region);
  const fluid = prepareFluidPlanetTerrain(region, 16, 128);
  assert.equal(fluid.detailRegion, region);
  assert.equal(fluid.mesh.canRefine, true);
  assert.deepEqual(fluid.mesh.indices, flat.indices);
  const scale = 14.4 / 256;
  for (const index of [1, resolution + 17, elevations.length - 1]) {
    const vertex = index * 6;
    assert.ok(Math.abs(fluid.mesh.vertices[vertex] - scale * flat.vertices[vertex]) < 1e-6);
    assert.ok(Math.abs(fluid.mesh.vertices[vertex + 1] - SEA_LEVEL - scale * flat.vertices[vertex + 1]) < 1e-6);
    assert.ok(Math.abs(fluid.mesh.vertices[vertex + 2] - scale * flat.vertices[vertex + 2]) < 1e-6);
  }
  assert.equal(fluid.rock.horizontalMeters, fluid.rock.verticalMeters);
});

test('Fluid starts from the saved Planet moisture in local map coordinates', () => {
  const resolution = 3;
  const weatherResolution = 8;
  const pixels = new Uint8Array(weatherResolution ** 2 * 4);
  for (let z = 0; z < weatherResolution; z++) {
    for (let x = 0; x < weatherResolution; x++) {
      const offset = (z * weatherResolution + x) * 4;
      pixels[offset] = x < 4 ? 0 : 255;
      pixels[offset + 1] = z < 4 ? 0 : 255;
    }
  }
  const region = {resolution, span:160000, min:0, peak:10, radius:262144,
    elevations:new Float32Array(resolution ** 2), water:new Uint8Array(resolution ** 2)};
  assert.equal(prepareFluidPlanetTerrain(region, 16, 8).initialMoisture, undefined);
  const weather = {resolution:weatherResolution, coverage:.7, pixels};
  const {initialMoisture} = prepareFluidPlanetTerrain({...region, weather}, 16, 8);
  const sample = (x, z) => initialMoisture.subarray((z * 8 + x) * 2, (z * 8 + x + 1) * 2);
  assert.equal(sample(1, 1)[0], 0);
  assert.ok(sample(6, 1)[0] > .6, 'cloud banks stay on the east side of the tile');
  assert.ok(sample(1, 6)[1] > sample(1, 1)[1], 'south keeps its source vapor');
  assert.ok(sample(4, 1)[0] > sample(3, 1)[0], 'the weather comparison stays centered on the tile');
});

test('Fluid flight uses the rendered height beyond the selected square', () => {
  const resolution = 5, side = 25, span = 160000, min = -3000, peak = 7200;
  const region = {resolution, span, min, peak, radius:262144, elevations:new Float32Array(resolution ** 2).fill(1370),
    water:new Uint8Array(resolution ** 2),
    context:{resolution:side, elevations:new Float32Array(side ** 2).fill(3400), water:new Uint8Array(side ** 2)}};
  const fluid = prepareFluidPlanetTerrain(region, 16, 128);
  const at = (resolution ** 2 + 12 * side + 20) * 6;
  const [x, y, z] = fluid.mesh.vertices.subarray(at, at + 3);
  assert.ok(x > 7.2);
  assert.ok(Math.abs(fluid.surfaceHeightAt(x, z) - y) < .001);
  assert.ok(y < fluid.layerHeight(3400), 'the real elevation falls away with the planet');
});
