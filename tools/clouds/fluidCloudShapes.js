const foilUpper = [
  [-1.70, 0], [-1.62, 0.19], [-1.40, 0.29], [-0.86, 0.34], [-0.25, 0.32],
  [0.44, 0.26], [1.17, 0.15], [1.63, 0.05], [1.70, 0],
];
const foilLower = foilUpper.slice(1, -1).reverse().map(([x,z]) => [x,-z]);
const shapes = [
  {name:'Round buoy', outline:[]},
  {name:'Plate', outline:[
    [-1.37, -0.15], [-1.19, -0.27], [1.19, -0.27], [1.37, -0.15],
    [1.37, 0.15], [1.19, 0.27], [-1.19, 0.27], [-1.37, 0.15],
  ]},
  {name:'Airfoil', outline:[...foilLower, ...foilUpper]},
];

function makeShape({name, outline}, id) {
  const planes = outline.map(([x,z], i) => {
    const [nextX,nextZ] = outline[(i+1) % outline.length];
    const dx = nextX - x, dz = nextZ - z;
    const length = Math.hypot(dx,dz);
    // Both outlines are convex. Orient each clipping plane from its center.
    const sign = dz*x - dx*z < 0 ? -1 : 1;
    const nx = sign*dz/length, nz = -sign*dx/length;
    return [nx,nz,nx*x+nz*z];
  });
  return {id,name,planes,bound:Math.max(1, ...outline.map(([x,z]) => Math.hypot(x,z)))};
}

export const fluidObstacleShapes = shapes.map(makeShape);
export const obstacleRadius = object => object.radius * fluidObstacleShapes[object.kind ?? 0].bound;
export const SEA_LEVEL = -0.66;
export const obstacleTop = id => 0.61 + id * 0.057;

const plate = fluidObstacleShapes[1];
const airfoil = fluidObstacleShapes[2];
const literal = n => n.toFixed(8);
const wgslPlanes = shape => shape.planes.map(plane => `vec3<f32>(${plane.map(literal).join(',')})`).join(',\n');

export const fluidObstacleGeometryWGSL = `
  const seaLevel = ${literal(SEA_LEVEL)};
  fn obstacleTop(id: u32) -> f32 { return 0.61 + f32(id) * 0.057; }
  const platePlanes = array<vec3<f32>, ${plate.planes.length}>(${wgslPlanes(plate)});
  const airfoilPlanes = array<vec3<f32>, ${airfoil.planes.length}>(${wgslPlanes(airfoil)});
  fn obstaclePlaneCount(kind: u32) -> u32 { return select(${plate.planes.length}u, ${airfoil.planes.length}u, kind == 2u); }
  fn obstaclePlane(kind: u32, i: u32) -> vec3<f32> {
    if (kind == 2u) { return airfoilPlanes[i]; }
    return platePlanes[i];
  }
  fn footprintBoundScale(kind: u32) -> f32 {
    return select(select(1.0, ${literal(plate.bound)}, kind == 1u), ${literal(airfoil.bound)}, kind == 2u);
  }
  fn obstacleLocal(delta: vec2<f32>, axis: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(dot(delta, axis), dot(delta, vec2<f32>(-axis.y, axis.x)));
  }
  fn obstacleWorld(local: vec2<f32>, axis: vec2<f32>) -> vec2<f32> {
    return axis * local.x + vec2<f32>(-axis.y, axis.x) * local.y;
  }
  fn footprintDistance(delta: vec2<f32>, size: f32, kind: u32, axis: vec2<f32>) -> f32 {
    if (kind == 0u) { return length(delta) - size; }
    let local = obstacleLocal(delta, axis);
    var result = -size * 2.0;
    for (var i = 0u; i < obstaclePlaneCount(kind); i++) {
      let plane = obstaclePlane(kind, i);
      result = max(result, dot(plane.xy, local) - plane.z * size);
    }
    return result;
  }
`;

export function intersectFluidObstacle(ray, object, id, padding = 0) {
  const {origin,direction} = ray;
  const [dx,dy,dz] = direction;
  const top = obstacleTop(id);
  let near = 0, far = Infinity;
  if (Math.abs(dy) < 0.000001) {
    if (origin[1] < SEA_LEVEL || origin[1] > top) return Infinity;
  } else {
    const floorHit = (SEA_LEVEL - origin[1]) / dy;
    const topHit = (top - origin[1]) / dy;
    near = Math.max(0, Math.min(floorHit, topHit));
    far = Math.max(floorHit, topHit);
    if (near > far) return Infinity;
  }
  const ox = origin[0] - object.x, oz = origin[2] - object.z;
  const shape = fluidObstacleShapes[object.kind ?? 0];
  if (shape.id === 0) {
    const radius = object.radius + padding;
    const a = dx*dx + dz*dz;
    const c = ox*ox + oz*oz - radius*radius;
    if (a < 0.000001) {
      if (c > 0) return Infinity;
    } else {
      const b = ox*dx + oz*dz;
      const discriminant = b*b - a*c;
      if (discriminant < 0) return Infinity;
      const root = Math.sqrt(discriminant);
      near = Math.max(near, (-b-root)/a);
      far = Math.min(far, (-b+root)/a);
    }
  } else {
    const cos = Math.cos(object.angle), sin = Math.sin(object.angle);
    const localX = ox*cos + oz*sin, localZ = -ox*sin + oz*cos;
    const localDx = dx*cos + dz*sin, localDz = -dx*sin + dz*cos;
    for (const [nx,nz,offset] of shape.planes) {
      const signed = nx*localX + nz*localZ - offset*object.radius - padding;
      const slope = nx*localDx + nz*localDz;
      if (Math.abs(slope) < 0.000001) {
        if (signed > 0) return Infinity;
        continue;
      }
      const t = -signed/slope;
      if (slope < 0) near = Math.max(near,t);
      else far = Math.min(far,t);
      if (near > far) return Infinity;
    }
  }
  return near <= far && near > 0 ? near : Infinity;
}
