import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanetRegionMesh,createTerrainMesh,terrainHeight,createRegionDetailIndices,
 selectRegionDetail,regionDetailDrawRanges,regionDrawBounds,visibleRegionDrawRanges,regionShadowDrawRanges,regionShadowProjection,REGION_DETAIL_CELLS,REGION_DETAIL_SUBDIVISIONS,REGION_NEAR_DETAIL_CELLS,REGION_NEAR_DETAIL_SUBDIVISIONS} from '../cloudTerrainMesh.js';
import {bakePlanetRegion, pickPlanetRegion, planetRegionDirection, planetRegionFrame,
 planetRegionSun, projectPlanetRegionPoint, writePlanetRegionRockAnchor, LOCAL_REGION_UNITS} from '../../planet/planetRegion.js';
test('regional culling preserves visible draw order and the refined window gap', () => {
  const vertices = new Float32Array([
    -1,0,8, 0,1,0,   1,0,8, 0,1,0,   0,1,8, 0,1,0,
    20,0,8, 0,1,0,  22,0,8, 0,1,0,  21,1,8, 0,1,0,
    -1,0,-8, 0,1,0,  1,0,-8, 0,1,0,  0,1,-8, 0,1,0,
    8.01,0,8, 0,1,0,  9,0,8, 0,1,0,  9,1,8, 0,1,0,
  ]);
  const batch = 16 * 16 * 6;
  const indices = Uint32Array.from({length: batch * 4}, (_, i) => Math.floor(i / batch) * 3 + i % 3);
  const bounds = regionDrawBounds(vertices, indices, indices.length, 0);
  const draw = allowed => visibleRegionDrawRanges(bounds, allowed, [0, 0, 0],
    [1, 0, 0], [0, 1, 0], [0, 0, 1], Math.PI / 2, 1);
  assert.deepEqual(draw([[0, 12], [24, indices.length - 24]]), [[0, 12], [24, indices.length - 24]]);
  assert.deepEqual(draw([[0, batch], [batch + 24, 3 * batch - 24]]), [[0, batch], [3 * batch, batch]]);
  assert.deepEqual(draw([[0, indices.length]]), [[0, indices.length]]);
  const lightFrame = new Float32Array([
    1,0,0,0, 0,1,0,0, 0,0,.125,0, 1/2048,0,0,1,
  ]);
  assert.deepEqual(regionShadowDrawRanges(bounds, indices.length, lightFrame), [[0, batch]]);
});

test('close-flight culling trims existing draws without splitting or crossing their ranges', () => {
  const batch = 16 * 16 * 6;
  const children = [0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0].map((visible, i) => ({
    first: i * batch, last: (i + 1) * batch,
    minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: visible ? 7 : -8, maxZ: visible ? 8 : -7,
  }));
  const groups = [{first: 0, last: 13 * batch, minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: -8, maxZ: 8, children}];
  const ranges = [[0, 6 * batch], [7 * batch, 6 * batch]];
  const draw = oneDrawPerRange => visibleRegionDrawRanges(groups, ranges, [0, 0, 0],
    [1, 0, 0], [0, 1, 0], [0, 0, 1], Math.PI / 2, 1, oneDrawPerRange);
  assert.deepEqual(draw(false), [[batch, batch], [5 * batch, batch], [7 * batch, batch], [11 * batch, batch]]);
  assert.deepEqual(draw(true), [[batch, 5 * batch], [7 * batch, 5 * batch]]);
});

test('shared terrain vertices extend the bounds of every batch that uses them', () => {
  const vertices = new Float32Array([
    0, 0, 0, 0, 1, 0,
    1, 1, 1, 0, 1, 0,
    5, 6, 7, 0, 1, 0,
  ]);
  const stride = 16 * 18;
  const indices = new Uint32Array(stride * 2).fill(1);
  indices[0] = 2;
  indices[stride] = 2;
  const [{children}] = regionDrawBounds(vertices, indices, 0, 17);
  assert.deepEqual(children.map(({maxX, maxY, maxZ}) => [maxX, maxY, maxZ]),
    [[5, 6, 7], [5, 6, 7]]);
});

test('mountain mesh has valid indexed triangles and unit upward normals',()=>{
 const {vertices,indices}=createTerrainMesh(33,128);
 assert.equal(vertices.length,(33*33+8)*6);assert.equal(indices.length,32*32*6+24);
 for(const index of indices)assert.ok(index<33*33+8);
 for(let i=0;i<vertices.length;i+=6){
  assert.ok(Math.abs(Math.hypot(...vertices.slice(i+3,i+6))-1)<1e-6);
  assert.ok(vertices[i+4]>0);
  assert.ok(Number.isFinite(vertices[i+1]));assert.ok(vertices[i+1]>=-6);
  if(i<33*33*6){
   const x=(i/6)%33,z=Math.floor(i/6/33);
   const at=k=>vertices[k*6];
   const span=Math.max(at(Math.min(x+1,32))-at(Math.max(x-1,0)),at(Math.min(z+1,32))-at(Math.max(z-1,0)))*.5;
   assert.ok(Math.abs(vertices[i+1]-terrainHeight(vertices[i],vertices[i+2],1,span))<1e-4);
  }
 }
});

test('slope erosion carves ridges deterministically and preserves the basin and apron',()=>{
 let changed=0,carved=0;
 for(let z=-75;z<=75;z+=3)for(let x=-75;x<=75;x+=3){
  const base=terrainHeight(x,z,0),eroded=terrainHeight(x,z);
  assert.equal(eroded,terrainHeight(x,z));assert.ok(Number.isFinite(eroded));
  assert.ok(eroded>=-6 && Math.abs(eroded-base)<10);
  if(Math.abs(eroded-base)>.1)changed++;
  if(eroded<base-.5)carved++;
 }
 assert.ok(changed>500 && carved>300);
 for(const [x,z] of [[0,0],[10,0],[0,10],[180,180],[-192,0]])assert.equal(terrainHeight(x,z),-6);
});

test('erosion drops unresolved gullies rather than aliasing them into coarse terrain',()=>{
 for(const [x,z] of [[40,40],[-50,30],[65,-20]])assert.equal(terrainHeight(x,z,1,100),terrainHeight(x,z,0));
});
test('mountain basin has a lower central floor and surrounding alpine ridges',()=>{
 assert.equal(terrainHeight(0,0),-6);
 let peaks=0;
 for(let i=0;i<360;i++){const angle=i*Math.PI/180;peaks=Math.max(peaks,terrainHeight(Math.cos(angle)*52,Math.sin(angle)*52));}
 assert.ok(peaks>8);assert.equal(terrainHeight(180,180),-6);
});

test('basin geometry concentrates detail without exceeding the terrain frame budget',()=>{
 const {vertices,indices}=createTerrainMesh();
 assert.ok(indices.length/3<200000);
 // Near-floor spacing is finer than the flat, distant apron.
 const size=Math.sqrt(vertices.length/6-8),middle=(size-1)/2;
 const inner=vertices[(middle+1)*6]-vertices[middle*6];
 const outer=vertices[6]-vertices[0];
 assert.ok(inner>0 && inner<outer*.3);
});

test('planet region frame is square and continuous at the poles and longitude seam', () => {
 const tolerance=1e-10;
 const radius=320000, extent=8000;
 for (const radial of [[0,1,0],[0,-1,0],[1,0,0],[-1,0,-0.000001]]) {
  const frame=planetRegionFrame(radial);
  const corner=planetRegionDirection(frame,extent,extent,radius);
  const opposite=planetRegionDirection(frame,-extent,-extent,radius);
  assert.ok(Math.abs(Math.hypot(...corner)-1)<tolerance);
  assert.ok(Math.hypot(...corner.map((value,i)=>value-opposite[i]))>0.06);
  const sum=corner.map((value,i)=>value+opposite[i]);
  assert.ok(Math.hypot(...sum.map((value,i)=>value/Math.hypot(...sum)-frame.up[i]))<tolerance);
  assert.ok(Math.abs(planetRegionSun(frame,frame.up).elDeg-90)<0.00001);
 }
});

test('cursor selects visible surface and projects back to the same screen point', () => {
 const camera={position:[2,0,0],forward:[-1,0,0],right:[0,0,-1],up:[0,1,0],tanX:1,tanY:1,near:0.01};
 const direction=pickPlanetRegion(camera,0.12,-0.16,1,()=>0.06);
 const projected=projectPlanetRegionPoint(camera,direction,1.06);
 assert.ok(Math.abs(projected[0]-.12)<1e-9);
 assert.ok(Math.abs(projected[1]+.16)<1e-9);
 assert.equal(pickPlanetRegion(camera,4,2,1,()=>0),null);
 const belowDatum={...camera,position:[0.95,0,0]};
 const valley=pickPlanetRegion(belowDatum,0,0,1,()=>-0.13);
 assert.deepEqual(valley,[1,0,0]);
});

test('a local mesh scales the actual spherical sample heights and retains the shore mask', async () => {
 const radius=64000;
 const sample=new Float32Array([0,1,2,0,1,2,0,1,2]);
 const world={radius,studioSeed:17,studioMap:{},preset:'test',terrainSampling:'procedural',oceanLevel:10,
  sampleSurface(direction,raw) {
   const height=raw*12;
   return {height:Math.max(10,height),depth:Math.max(0,10-height)};
  }};
 const region=await bakePlanetRegion(world,[1,0,0],1000,{resolution:3,
  sampleProcedural:(target,frame,span,side)=>{
   assert.equal(target,world);assert.deepEqual(frame.up,[1,0,0]);
   assert.equal(span,1000);assert.equal(side,3);
   return sample;
  }});
 assert.equal(region.min,10);
 assert.equal(region.peak,24);
 assert.deepEqual(Array.from(region.water),[1,0,0,1,0,0,1,0,0]);
 const {vertices,indices}=createPlanetRegionMesh(region);
 assert.deepEqual(Array.from(vertices.slice(0,6)),[-128,0,-128,0,Math.fround(-1 - 10 * .256),0]);
 assert.ok(Math.abs(vertices[13]-14*.256)<1e-6);
 assert.equal(vertices[12],128);
 assert.equal(indices.length,24);
});

test('surroundings use the same planet and retain the selected square', async () => {
 const radius=320000, span=32000;
 const world={radius,studioSeed:42,studioMap:{},preset:'test',terrainSampling:'cached',oceanLevel:null,
  sampleSurface(direction) {
   return {height:1600+direction[2]*180,depth:0};
  }};
 const region=await bakePlanetRegion(world,[1,0,0],span,{resolution:5,includeSurroundings:true});
 const {resolution,elevations}=region.context;
 const middle=(resolution-1)/2, at=(x,z)=>elevations[z*resolution+x];
 assert.equal(region.radius,radius);
 assert.equal(resolution,577);
 assert.equal(at(middle-48,middle),region.elevations[10]);
 assert.equal(at(middle+48,middle),region.elevations[14]);
 assert.ok(at(middle*2,middle)>region.peak);
});

test('surrounding geometry shares every fine boundary edge without holes', () => {
 const resolution=5, contextSide=13;
 const region={resolution,span:32000,radius:320000,min:50,
  elevations:new Float32Array(resolution**2).fill(50),water:new Uint8Array(resolution**2),
  context:{resolution:contextSide,elevations:new Float32Array(contextSide**2).fill(50),water:new Uint8Array(contextSide**2)}};
 const {vertices,indices,coreIndexCount}=createPlanetRegionMesh(region);
 const edgeUse=new Map();
 for(let i=0;i<indices.length;i+=3){
  const [a,b,c]=indices.subarray(i,i+3);
  const ax=vertices[a*6],az=vertices[a*6+2];
  const dx=vertices[b*6]-ax,dz=vertices[b*6+2]-az;
  const ex=vertices[c*6]-ax,ez=vertices[c*6+2]-az;
  assert.ok(dz*ex-dx*ez>0,'triangles face up in both grids and through the seam');
  for(const [x,y] of [[a,b],[b,c],[c,a]]){
   const key=Math.min(x,y)+','+Math.max(x,y);
   edgeUse.set(key,(edgeUse.get(key)??0)+1);
  }
 }
 assert.equal(coreIndexCount,(resolution-1)**2*6);
 assert.ok(indices.subarray(0,coreIndexCount).every(i=>i<resolution**2));
 assert.equal([...edgeUse.values()].filter(n=>n===1).length,4*(contextSide-1));
 assert.ok([...edgeUse.values()].every(n=>n===1||n===2));
 assert.ok(vertices[resolution**2*6+1]<0,'distant terrain recedes with planet curvature');
});

test('material sampling follows the actual coastline on either side of the shore', async () => {
 const radius=320000;
 const world={radius,studioSeed:42,studioMap:{},preset:'test',terrainSampling:'cached',oceanLevel:10,
  sampleSurface(direction) {
   const land=direction[2]*1000;
   return {land,height:Math.max(10,10+land),depth:Math.max(0,-land)};
  }};
 const region=await bakePlanetRegion(world,[1,0,0],12000,{
  resolution:3,
  includeSurroundings:true,
  sampleMaterials(target,frame,span,side,inputs) {
   assert.equal(target,world);
   assert.deepEqual(frame.up,[1,0,0]);
   assert.ok(span===12000||span===72000);
   const colors = new Uint8Array(side*side*4);
   for(let i=0;i<inputs.length;i+=2) {
    const coast=inputs[i+1];
    assert.ok(Math.abs(inputs[i]+coast)<1e-3);
    colors.set(coast>0?[32,126,176,255]:[194,142,88,255],i*2);
   }
   return colors;
  },
 });
 const {materials, context}=createPlanetRegionMesh(region);
 assert.equal(materials.length,(region.resolution**2+context.resolution**2)*4);
 assert.deepEqual(Array.from(materials.slice(0,4)),[32,126,176,255]);
 assert.deepEqual(Array.from(materials.slice(8,12)),[194,142,88,255]);
 assert.deepEqual(Array.from(materials.slice(region.resolution**2*4,region.resolution**2*4+4)),[32,126,176,255]);
});

test('GPU region relief drives elevation, coastline and material in the same grid', async () => {
 const studioMap={};
 const world={radius:320000,studioSeed:12,studioMap,preset:'test',oceanLevel:10};
 const elevations=new Float32Array([8,11,12,9,14,17,10,17,25]);
 const materials=new Uint8Array(36).fill(255);
 const region=await bakePlanetRegion(world,[1,0,0],4000,{resolution:3,
  sampleGrid(target,frame,span,side) {
   assert.equal(target.studioMap,studioMap);
   assert.deepEqual(frame.up,[1,0,0]);
   assert.equal(span,4000);
   assert.equal(side,3);
   return {elevations,materials};
  },
 });
 assert.equal(region.min,10);
 assert.equal(region.peak,25);
 assert.deepEqual(Array.from(region.elevations),[10,11,12,10,14,17,10,17,25]);
 assert.deepEqual(Array.from(region.water),[1,0,0,1,0,0,0,0,0]);
 assert.equal(region.materials,materials);
 assert.equal(region.terrainDetail,true);
});

test('the fine window replaces exactly its coarse cells and preserves all context indices', () => {
 const resolution=129;
 const tile={resolution,span:32000,radius:262144,min:0,terrainDetail:true,
  elevations:new Float32Array(resolution**2),water:new Uint8Array(resolution**2),
  materials:new Uint8Array(resolution**2*4)};
 const mesh=createPlanetRegionMesh(tile);
 assert.equal(mesh.canRefine,true);
 const window=selectRegionDetail(tile,[21,1,-28],[0,0,-1]);
 const protectedContext=2048;
 const covered=new Uint8Array(mesh.coreIndexCount+protectedContext);
 const ranges=regionDetailDrawRanges(resolution,covered.length,window);
 for(const [start,count] of ranges) covered.fill(1,start,start+count);
 for(let i=0;i<mesh.coreIndexCount;i+=6){
  const vertex=mesh.indices[i];
  const x=vertex%resolution, z=Math.floor(vertex/resolution);
  const replaced=x>=window.startX && x<window.startX+REGION_DETAIL_CELLS &&
   z>=window.startZ && z<window.startZ+REGION_DETAIL_CELLS;
  assert.equal(covered[i],Number(!replaced));
 }
 assert.ok(covered.subarray(mesh.coreIndexCount).every(Boolean));
 const fine=createRegionDetailIndices();
 const side=REGION_DETAIL_CELLS*REGION_DETAIL_SUBDIVISIONS+1;
 assert.equal(fine.length,(side-1)**2*6);
 assert.deepEqual(fine.slice(0,6),new Uint32Array([0,side,1,1,side,side+1]));
 assert.equal(fine.at(-1),side**2-1);
});

test('detail is bounded to a low camera and its window always stays inside the selected tile', () => {
 const resolution=1025;
 const tile={resolution,span:32000,min:0,elevations:new Float32Array(resolution**2)};
 assert.equal(selectRegionDetail(tile,[0,24,0],[0,0,1]),null);
 assert.equal(selectRegionDetail(tile,[-256,1,0],[1,0,0]),null);
 const near=selectRegionDetail(tile,[0,1,0],[1,0,0]);
 assert.equal(near.strength,1);
 assert.ok(near.focusX>0);
 const edge=selectRegionDetail(tile,[128,1,-128],[1,0,-1]);
 assert.equal(edge.cells,REGION_DETAIL_CELLS*2);
 assert.equal(edge.startX+edge.cells,resolution-1);
 assert.equal(edge.startZ,0);
});

test('the close terrain grid follows the focus and stays inside the replacement window', () => {
 const resolution=1025;
 const tile={resolution,span:12000,min:0,elevations:new Float32Array(resolution**2)};
 const step=256/(resolution-1);
 const near=selectRegionDetail(tile,[1.6,step,-3.7],[0,-1,0]);
 const nearCenter=(start,offset)=>(start+offset+REGION_NEAR_DETAIL_CELLS*.5)*step-128;
 assert.equal(near.nearStrength,1);
 assert.ok(Math.abs(nearCenter(near.startX,near.nearX)-near.focusX)<=2*step);
 assert.ok(Math.abs(nearCenter(near.startZ,near.nearZ)-near.focusZ)<=2*step);
 const edge=selectRegionDetail(tile,[128,step,-128],[0,-1,0]);
 assert.equal(edge.nearX,edge.cells-REGION_NEAR_DETAIL_CELLS);
 assert.equal(edge.nearZ,0);
 const middle=selectRegionDetail(tile,[0,8*step,0],[0,-1,0]);
 assert.ok(middle.nearStrength>0 && middle.nearStrength<near.nearStrength);
 const far=selectRegionDetail(tile,[0,13*step,0],[0,-1,0]);
 assert.equal(far.nearStrength,0);
 const indices=createRegionDetailIndices(true);
 const cells=(REGION_DETAIL_CELLS-REGION_NEAR_DETAIL_CELLS)*REGION_DETAIL_SUBDIVISIONS+
   REGION_NEAR_DETAIL_CELLS*REGION_NEAR_DETAIL_SUBDIVISIONS;
 assert.equal(indices.length,cells**2*6);
 assert.equal(indices.at(-1),(cells+1)**2-1);
});

test('sun projection fits the local receivers and keeps nearby casters in depth range', () => {
 const bounds={coreHeights:[0,85],surroundingsHeights:[-195,164]};
 assert.equal(regionShadowProjection(bounds,[1,0,0],2048),null);
 const angle=.19;
 const sun=[0,Math.sin(angle),Math.cos(angle)];
 const frame=regionShadowProjection(bounds,sun,2048);
 const project=(p,k)=>p[0]*frame[k]+p[1]*frame[k+1]+p[2]*frame[k+2]+frame[k+3];
 for(const x of [-128,128])for(const z of [-128,128])for(const y of bounds.coreHeights){
  assert.ok(Math.abs(project([x,y,z],0))<1);
  assert.ok(Math.abs(project([x,y,z],4))<1);
 }
 for(const x of [-768,768])for(const z of [-768,768])for(const y of bounds.surroundingsHeights){
  const depth=project([x,y,z],8);
  assert.ok(depth>0 && depth<1);
 }
 const floor=[0,7,0], blocker=floor.map((v,i)=>v+24*sun[i]);
 for(const k of [0,4]) assert.ok(Math.abs(project(floor,k)-project(blocker,k))<1e-6);
 assert.ok(project(blocker,8)<project(floor,8));
 assert.ok(regionShadowProjection(bounds,[0,1,0],2048).every(Number.isFinite));
});

test('rock anchors retain centimeter-scale positions on the largest planets', () => {
 const {up}=planetRegionFrame([-0.45,0.38,0.81]);
 const radius=1966080;
 const descriptor=new ArrayBuffer(96);
 writePlanetRegionRockAnchor(descriptor,64,up,radius);
 const origin=new Int32Array(descriptor,64,3);
 const remainder=new Float32Array(descriptor,80,3);
 for(let axis=0;axis<3;axis++){
  const meters=up[axis]*radius;
  assert.ok(remainder[axis]>=0 && remainder[axis]<128);
  assert.ok(Math.abs(origin[axis]*128+remainder[axis]-meters)<0.00001);
  assert.ok(Math.abs(origin[axis]*4096)<2**31);
 }
});

test('surroundings recover the actual radius plus the saved elevation beyond the seam', () => {
  const radius = 262144, span = 160000, datum = -2000, height = 4800;
  const resolution = 5, contextSide = 193, meters = span / LOCAL_REGION_UNITS;
  const {vertices} = createPlanetRegionMesh({resolution, span, radius, min:datum,
    elevations:new Float32Array(resolution ** 2).fill(height), water:new Uint8Array(resolution ** 2),
    context:{resolution:contextSide, elevations:new Float32Array(contextSide ** 2).fill(height),
      water:new Uint8Array(contextSide ** 2)}});
  const corner = resolution ** 2 * 6;
  assert.ok(Math.abs(Math.hypot(vertices[corner] * meters,
    vertices[corner + 1] * meters + radius + datum,
    vertices[corner + 2] * meters) - (radius + height)) < .03);
  assert.ok(Math.abs(vertices[1] * meters + datum - height) < .01);
});

test('curvature meets a flat tile without a steep drop at the first outer sample', () => {
 const resolution = 5, contextSide = 577, radius = 262144, span = 160000;
 const {vertices} = createPlanetRegionMesh({
  resolution, span, radius, min:0,
  elevations:new Float32Array(resolution ** 2), water:new Uint8Array(resolution ** 2),
  context:{resolution:contextSide, elevations:new Float32Array(contextSide ** 2),
    water:new Uint8Array(contextSide ** 2)},
 });
 const row = (contextSide - 1) / 2;
 const edgeColumn = 336; // +128 units in the six-tile-wide context grid.
 const height = column => vertices[(resolution ** 2 + row * contextSide + column) * 6 + 1];
 assert.equal(height(edgeColumn), 0);
 assert.ok(height(edgeColumn + 1) < 0 && height(edgeColumn + 1) > -.25);
 assert.ok(height(edgeColumn + 40) < height(edgeColumn + 1));
});

test('a 160 km square on the Moon joins the surrounding terrain without inverted faces', () => {
  const resolution = 5, contextSide = 193;
  const {vertices, indices, coreIndexCount} = createPlanetRegionMesh({
    resolution, span:160000, radius:98304, min:0,
    elevations:new Float32Array(resolution ** 2), water:new Uint8Array(resolution ** 2),
    context:{resolution:contextSide, elevations:new Float32Array(contextSide ** 2).fill(1500),
      water:new Uint8Array(contextSide ** 2)},
  });
  for (let i = coreIndexCount; i < indices.length; i += 3) {
    const a = indices[i] * 6, b = indices[i + 1] * 6, c = indices[i + 2] * 6;
    const signedArea = (vertices[b + 2] - vertices[a + 2]) * (vertices[c] - vertices[a])
      - (vertices[b] - vertices[a]) * (vertices[c + 2] - vertices[a + 2]);
    assert.ok(signedArea > 0, 'every surrounding or seam triangle faces up');
  }
});

test('finer surrounding geometry keeps saved elevations and puts the shore between samples', () => {
 const resolution = 5, side = 65, sea = 120;
 const signed = Float32Array.from({length: side ** 2}, (_, i) => ((i % side) - 40.25) * 10);
 const elevations = signed.map(height => sea + Math.max(0, height));
 const water = Uint8Array.from(signed, height => Number(height < 0));
 const waterDepth = signed.map(height => Math.max(0, -height));
 const {context} = createPlanetRegionMesh({
  resolution, span: 32000, radius: 262144, min: sea,
  elevations: new Float32Array(resolution ** 2).fill(sea), water: new Uint8Array(resolution ** 2),
  context: {resolution: side, elevations, water, waterDepth},
 });
 assert.equal(context.resolution, 129);
 for (let z = 0; z < side; z++) {
  for (let x = 0; x < side; x++) {
   const source = z * side + x, target = z * 2 * context.resolution + x * 2;
   assert.equal(context.elevations[target], elevations[source]);
   assert.equal(context.water[target], water[source]);
   assert.equal(context.waterDepth[target], waterDepth[source]);
  }
 }
 assert.equal(context.elevations[79], sea);
 assert.equal(context.water[79], 1);
 assert.equal(context.elevations[81], sea + 2.5);
 assert.equal(context.water[81], 0);
});
