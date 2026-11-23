import test from 'node:test';
import assert from 'node:assert/strict';
import { fluidObstacleShapes, intersectFluidObstacle, obstacleRadius } from '../fluidCloudShapes.js';

test('fluid plate and airfoil use closed, convex footprints with outward clipping planes', () => {
  for (const shape of fluidObstacleShapes.slice(1)) {
    const neighbors = shape.planes.map(([nx,nz,offset], i) => {
      const [mx,mz,nextOffset] = shape.planes[(i+1) % shape.planes.length];
      const det = nx*mz - mx*nz;
      assert.ok(Math.abs(det) > 0.00001);
      return [(offset*mz - nextOffset*nz)/det, (nx*nextOffset - mx*offset)/det];
    });
    for (const [nx,nz,offset] of shape.planes) {
      assert.ok(offset > 0);
      assert.ok(neighbors.every(([x,z]) => nx*x + nz*z <= offset + 0.00001));
    }
  }
});

test('rotating a narrow fluid obstacle changes its hit area and does not change its collision bound', () => {
  const down = (x,z) => ({origin:[x,2,z], direction:[0,-1,0]});
  for (const kind of [1,2]) {
    const obstacle = {x:0,z:0,radius:0.71,kind,angle:0};
    const turned = {...obstacle,angle:Math.PI/2};
    assert.ok(Number.isFinite(intersectFluidObstacle(down(0.84,0), obstacle, 0)));
    assert.equal(intersectFluidObstacle(down(0,0.84), obstacle, 0), Infinity);
    assert.ok(Number.isFinite(intersectFluidObstacle(down(0,0.84), turned, 0)));
    assert.equal(intersectFluidObstacle(down(0.84,0), turned, 0), Infinity);
    assert.equal(obstacleRadius(obstacle), obstacleRadius(turned));
  }
});

test('rays at waterline height can hit obstacle sides above and below the horizon', () => {
  for (const kind of [0,1,2]) {
    const obstacle = {x:0,z:0,radius:0.71,kind,angle:0};
    const grazing = (y,dy) => ({origin:[-4,y,0], direction:[1,dy,0]});
    const horizontal = intersectFluidObstacle(grazing(0.36,0), obstacle, 0);
    assert.ok(horizontal > 2.7 && horizontal < 3.4);
    assert.equal(intersectFluidObstacle(grazing(0.36,0.04), obstacle, 0), horizontal);
    assert.equal(intersectFluidObstacle(grazing(0.36,-0.04), obstacle, 0), horizontal);
    assert.equal(intersectFluidObstacle(grazing(0.74,0), obstacle, 0), Infinity);
    assert.equal(intersectFluidObstacle(grazing(0.36,0.12), obstacle, 0), Infinity);
  }
});
