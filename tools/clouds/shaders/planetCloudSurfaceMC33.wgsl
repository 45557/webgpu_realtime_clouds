const PI: f32 = 3.141592653589793;

struct Params {
  angularCells: u32,
  radialCells: u32,
  visibleFaceMask: u32,
  maxVertices: u32,

  planetRadius: f32,
  cloudBottom: f32,
  cloudTop: f32,
  coverageThreshold: f32,

  heightScale: f32,
  minThickness: f32,
  maxThickness: f32,
  bulgeStrength: f32,

  cavityStrength: f32,
  lowPush: f32,
  curlPush: f32,
  detailPush: f32,

  weatherTime: f32,
  shapeTime: f32,
  detailTime: f32,
  normalEpsilon: f32,

  camPos: vec3<f32>,
  tanHalfFovY: f32,
  camRight: vec3<f32>,
  aspect: f32,
  camUp: vec3<f32>,
  frustumGuard: f32,
  camFwd: vec3<f32>,
  horizonGuard: f32,

  weatherScale: vec2<f32>,
  shapeScale: vec2<f32>,
  detailScale: vec2<f32>,
  fieldBlend: f32,
  previousFieldValid: u32,
  maxActiveCells: u32,
  projectionStrength: f32,
  projectionMaxStep: f32,
  occlusionRadiusScale: f32,
  previousFieldFaceMask: u32,
  tileCells: u32,
  tilesPerAxis: u32,
  totalTiles: u32,
  tileHistoryValid: u32,
  isoHysteresis: f32,
  tileCoverageGuard: f32,
  tileFrustumGuard: f32,
  tileHorizonGuard: f32,
  tileRadialGuard: f32,
  useTileCulling: u32,
  historyCount: u32,
  voxelPersistenceBand: f32,
  voxelHistoryWeight: f32,
  formType: f32,
  worldScale: f32,
  warpAmount: f32,
  warpPhase: f32,
  _warpPad: vec2<f32>,
}

@group(0) @binding(0) var weatherTex: texture_2d_array<f32>;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_2d_array<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<storage, read> table: array<u32>;
@group(0) @binding(5) var<storage, read_write> outPositions: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outNormals: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> outCounter: atomic<u32>;
@group(0) @binding(8) var<uniform> params: Params;
@group(0) @binding(9) var<storage, read_write> outIndirect: array<u32>;
@group(0) @binding(10) var<storage, read> previousField: array<f32>;
@group(0) @binding(11) var<storage, read_write> currentField: array<f32>;
@group(0) @binding(12) var<storage, read_write> activeCells: array<u32>;
@group(0) @binding(13) var<storage, read_write> activeCounter: atomic<u32>;
@group(0) @binding(14) var<storage, read_write> extractDispatch: array<u32>;
@group(0) @binding(15) var<storage, read_write> statusFlags: array<atomic<u32>>;
@group(0) @binding(16) var<storage, read_write> projectionDispatch: array<u32>;
@group(0) @binding(17) var<storage, read_write> currentTileFlags: array<u32>;
@group(0) @binding(18) var<storage, read> previousTileFlags: array<u32>;
@group(0) @binding(19) var<storage, read> olderField: array<f32>;

fn saturate(v: f32) -> f32 {
  return clamp(v, 0.0, 1.0);
}

fn wrap_uv(uv: vec2<f32>) -> vec2<f32> {
  let poleInset=0.5/f32(textureDimensions(weatherTex).y);
  return vec2<f32>(fract(uv.x),clamp(uv.y,poleInset,1.0-poleInset));
}

fn cube_face_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let p = uv * 2.0 - vec2<f32>(1.0);
  switch face {
    case 0u: { return normalize(vec3<f32>(1.0, p.y, -p.x)); }
    case 1u: { return normalize(vec3<f32>(-1.0, p.y, p.x)); }
    case 2u: { return normalize(vec3<f32>(p.x, 1.0, -p.y)); }
    case 3u: { return normalize(vec3<f32>(p.x, -1.0, p.y)); }
    case 4u: { return normalize(vec3<f32>(p.x, p.y, 1.0)); }
    default: { return normalize(vec3<f32>(-p.x, p.y, -1.0)); }
  }
}

fn direction_to_uv(dir: vec3<f32>) -> vec2<f32> {
  let lon = atan2(dir.z, dir.x);
  let lat = asin(clamp(dir.y, -1.0, 1.0));
  return vec2<f32>(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}

fn sample_weather(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(weatherTex, linearSampler, wrap_uv(uv), 0, 0.0);
}






fn rotate_domain(p:vec3<f32>, angle:f32)->vec3<f32> {
  return vec3<f32>(p.x*cos(angle)-p.z*sin(angle),p.y,p.x*sin(angle)+p.z*cos(angle));
}

fn cached_field_world(pos:vec3<f32>)->f32 {
  let mapping=world_to_face_grid(pos);
  let cell=min(vec3<u32>(floor(mapping.xyz)),vec3<u32>(params.angularCells-1u,params.angularCells-1u,params.radialCells-1u));
  let face=min(u32(mapping.w+0.5),5u);
  return trilinear_field_value(clamp(mapping.xyz-vec3<f32>(cell),vec3<f32>(0),vec3<f32>(1)),load_cube_values(face,cell));
}

// Reuse the sampled, temporally filtered field. No weather/shape texture reads
// or repeated density evaluation per output vertex; probes cross cube faces.
fn smooth_world_normal(pos:vec3<f32>)->vec3<f32> {
  let e=max((params.cloudTop-params.cloudBottom)*0.035,params.planetRadius/f32(params.angularCells)*0.45);
  let gradient=vec3<f32>(cached_field_world(pos+vec3<f32>(e,0,0))-cached_field_world(pos-vec3<f32>(e,0,0)),
    cached_field_world(pos+vec3<f32>(0,e,0))-cached_field_world(pos-vec3<f32>(0,e,0)),
    cached_field_world(pos+vec3<f32>(0,0,e))-cached_field_world(pos-vec3<f32>(0,0,e)));
  return select(normalize(pos),gradient/max(length(gradient),1e-8),length(gradient)>1e-8);
}

// A texture can wrap seamlessly and still advertise its small tile. Only the
// high-frequency realistic mesh needs these extra field-stage samples. Oblique
// domains, broad noise warping and an incommensurate second scale break the
// repeated rows without more voxels, allocations or per-vertex density probes.
fn realistic_shape_domain(p:vec3<f32>)->vec3<f32> {
  return vec3<f32>(dot(p,vec3<f32>(.36,.48,.80)),
    dot(p,vec3<f32>(-.80,.60,0)),dot(p,vec3<f32>(-.48,-.64,.60)));
}

fn surface_shape(p:vec3<f32>)->vec4<f32> {
  if(isCumulusBank(params.formType)){
    // Low-pass the source at the voxel pitch to keep small billows from
    // aliasing into facets. Angular pitch is shared across cube faces.
    let pitch=2.0*params.planetRadius/f32(params.angularCells);
    let texels=pitch*params.worldScale*f32(textureDimensions(shapeTex).x);
    let lod=clamp(log2(max(texels*0.42,1.0)),0.0,f32(textureNumLevels(shapeTex))-1.0);
    return textureSampleLevel(shapeTex,linearSampler,p,lod);
  }
  if(params.formType<0.5 || params.formType>=1.5){
    return textureSampleLevel(shapeTex,linearSampler,p,0.0);
  }
  let q=realistic_shape_domain(p);
  let broad=textureSampleLevel(shapeTex,linearSampler,q*.193+vec3<f32>(.17,.53,.79),0.0);
  let warped=q+(broad.rgb-vec3<f32>(.5))*.72;
  let primary=textureSampleLevel(shapeTex,linearSampler,warped,0.0);
  let secondary=textureSampleLevel(shapeTex,linearSampler,realistic_shape_domain(q.zxy)*.739+vec3<f32>(.37,.61,.19),0.0);
  // Restore contrast lost by mixing independent fields, rather than thinning
  // away the clouds. The macro bias groups small clouds into irregular banks.
  return clamp(vec4<f32>(.5)+(mix(primary,secondary,.26)-vec4<f32>(.5))*1.275
    +vec4<f32>((broad.a-.5)*.055),vec4<f32>(0),vec4<f32>(1));
}

// Same signed billow form as the regular planet renderer. Sample Cartesian
// space first: scaling or rotating it cannot introduce a longitude seam.
fn scalar_field_world(pos:vec3<f32>)->f32 {
  let h=max(params.cloudTop-params.cloudBottom,0.001);
  let radius=length(pos);
  let ph=(radius-params.planetRadius-params.cloudBottom)/h;
  let wm=surface_weather(pos);
  var shapePosition=planetWarpPosition(pos,params.shapeTime,params.formType,params.warpAmount,params.warpPhase);
  if(isLenticular(params.formType)){shapePosition=normalize(shapePosition)*params.planetRadius;}
  let domain=planetWeatherShapeDomain(shapePosition*params.worldScale,wm,ph,params.formType,
    params.planetRadius/max(radius,.001));
  let shape=surface_shape(planetEvolvingDomain(domain,params.detailTime));
  let s=evolvePlanetCloudShape(shape,params.detailTime,params.formType);
  if(isGlowingFissures(params.formType)){
    let form=glowingFissureForm(ph,wm,s,params.coverageThreshold,params.detailTime).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isEmberstorm(params.formType)){
    let form=emberstormCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isMixedPlanetWeather(params.formType)){
    let form=mixedPlanetWeatherForm(ph,wm,s,params.coverageThreshold,params.detailTime).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isAnvilCloud(params.formType)){
    let form=anvilCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isSatelliteForm(params.formType)){
    let form=realisticSatelliteForm(ph,wm,s,params.coverageThreshold,params.formType,params.detailTime).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(params.formType==1.0){
    let form=thinCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(params.formType==2.125){
    let form=storybookCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isBigBlob(params.formType)){
    let form=bigBlobCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(params.formType==2.0){
    let form=dioramaCloudForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isPlanetFront(params.formType)){
    let form=planetFrontForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isLenticular(params.formType)){
    let form=lenticularForm(ph,wm,s,params.coverageThreshold).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  if(isCumulusBank(params.formType)){
    let form=planetCumulusForm(ph,wm,s,params.coverageThreshold,params.formType).x;
    return max(-form,-min(ph,1.0-ph)*0.5)*h;
  }
  let cute=saturate(params.formType-1.0);
  let gas=params.formType>=4.5;
  let scattered=params.formType>=3.5 && !gas;
  let hemisphere=select(1.0,wm.a,params.formType>=2.5 && params.formType<3.5);
  let coverage=saturate(params.coverageThreshold*mix(0.72,1.0,max(wm.r,wm.g*0.65)));
  let threshold=select(mix(0.82,0.46,coverage),0.63,scattered)-select(0.0,0.030,cute>0.5 && !gas);
  var mass=select(s.r*0.72+s.g*0.20+s.b*0.08,0.58+wm.a*0.18+(s.g-0.5)*0.12,gas);
  let lower=smoothstep(0.025,mix(0.16,0.22,cute),ph);
  let summit=clamp(0.78+(s.a-0.5)*mix(0.24,0.42,cute),0.48,0.97);
  let upper=1.0-smoothstep(summit-0.28,summit,ph);
  var form=mass-threshold-(1.0-lower*upper)*0.24-(1.0-hemisphere)*0.55;
  if(cute>0.5 && !gas){
    let radial=(ph-(0.43+(s.a-0.5)*0.16))/(0.40+(s.b-0.5)*0.10);
    form-=radial*radial*0.16;
  }
  // Positive outside, negative inside. Explicit shell caps ensure closed MC
  // surfaces even for dense gas bands or user-expanded coverage.
  return max(-form,min(ph,1.0-ph)*-0.5)*h;
}

fn param_to_world(face: u32, gridPos: vec3<f32>) -> vec3<f32> {
  let angular = max(f32(params.angularCells), 1.0);
  let radial = max(f32(params.radialCells), 1.0);
  let uv = gridPos.xy / angular;
  let depth = clamp(gridPos.z / radial, 0.0, 1.0);
  let dir = cube_face_direction(face, uv);
  let shellRadius = mix(shell_radial_minimum(), shell_radial_maximum(), depth);
  return dir * shellRadius;
}

fn points_per_face() -> u32 {
  let angularPoints = params.angularCells + 1u;
  return angularPoints * angularPoints * (params.radialCells + 1u);
}

fn shell_radial_minimum() -> f32 {
  let lowerMargin = (params.cloudTop-params.cloudBottom)*0.12;
  return params.planetRadius + params.cloudBottom - lowerMargin;
}

fn shell_radial_maximum() -> f32 {
  let upperMargin = (params.cloudTop-params.cloudBottom)*0.12;
  return params.planetRadius + params.cloudTop + upperMargin;
}

fn field_index(face: u32, point: vec3<u32>) -> u32 {
  let angularPoints = params.angularCells + 1u;
  return face * points_per_face() +
    point.z * angularPoints * angularPoints +
    point.y * angularPoints +
    point.x;
}

fn load_cube_values(face: u32, cell: vec3<u32>) -> CubeVals {
  var values = CubeVals(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let value = currentField[field_index(face, cell + corner_offset(corner))];
    switch corner {
      case 0u: { values.v0 = value; }
      case 1u: { values.v1 = value; }
      case 2u: { values.v2 = value; }
      case 3u: { values.v3 = value; }
      case 4u: { values.v4 = value; }
      case 5u: { values.v5 = value; }
      case 6u: { values.v6 = value; }
      default: { values.v7 = value; }
    }
  }
  return values;
}

fn pack_cell(face: u32, cell: vec3<u32>) -> u32 {
  return (cell.x & 0xffu) |
    ((cell.y & 0xffu) << 8u) |
    ((cell.z & 0x3fu) << 16u) |
    ((face & 0x7u) << 22u);
}

fn unpack_cell(packed: u32) -> vec4<u32> {
  return vec4<u32>(
    packed & 0xffu,
    (packed >> 8u) & 0xffu,
    (packed >> 16u) & 0x3fu,
    (packed >> 22u) & 0x7u
  );
}

fn nth_visible_face(mask: u32, ordinal: u32) -> u32 {
  var seen = 0u;
  for (var face = 0u; face < 6u; face += 1u) {
    if ((mask & (1u << face)) != 0u) {
      if (seen == ordinal) {
        return face;
      }
      seen += 1u;
    }
  }
  return 0u;
}

fn tiles_per_face() -> u32 {
  return params.tilesPerAxis * params.tilesPerAxis;
}

fn tile_index(face: u32, tile: vec2<u32>) -> u32 {
  return face * tiles_per_face() + tile.y * params.tilesPerAxis + tile.x;
}

fn cell_tile(cell: vec2<u32>) -> vec2<u32> {
  let tileSize = max(params.tileCells, 1u);
  return min(cell / tileSize, vec2<u32>(params.tilesPerAxis - 1u));
}

fn tile_flag_value(flagsIndex: u32, usePrevious: bool) -> u32 {
  if (usePrevious) {
    return previousTileFlags[flagsIndex];
  }
  return currentTileFlags[flagsIndex];
}

fn tile_is_active(flag: u32) -> bool {
  return (flag & 1u) != 0u;
}

fn tile_min_radial_cell(flag: u32) -> u32 {
  return (flag >> 1u) & 0x7fu;
}

fn tile_max_radial_cell(flag: u32) -> u32 {
  return (flag >> 8u) & 0x7fu;
}

fn pack_tile_range(minCell: u32, maxCell: u32) -> u32 {
  return 1u | ((minCell & 0x7fu) << 1u) | ((maxCell & 0x7fu) << 8u);
}

fn point_has_active_tile(face: u32, point: vec2<u32>, radialPoint: u32, usePrevious: bool) -> bool {
  if (params.useTileCulling == 0u) {
    return true;
  }
  if (params.tilesPerAxis == 0u || params.tileCells == 0u) {
    return false;
  }

  for (var oy = 0u; oy < 2u; oy += 1u) {
    for (var ox = 0u; ox < 2u; ox += 1u) {
      if (point.x == 0u && ox == 0u) {
        continue;
      }
      if (point.y == 0u && oy == 0u) {
        continue;
      }
      let cellX = select(point.x, point.x - 1u, ox == 0u);
      let cellY = select(point.y, point.y - 1u, oy == 0u);
      if (cellX >= params.angularCells || cellY >= params.angularCells) {
        continue;
      }
      let tile = cell_tile(vec2<u32>(cellX, cellY));
      let flag = tile_flag_value(tile_index(face, tile), usePrevious);
      if (
        tile_is_active(flag) &&
        radialPoint >= tile_min_radial_cell(flag) &&
        radialPoint <= tile_max_radial_cell(flag) + 1u
      ) {
        return true;
      }
    }
  }
  return false;
}

fn tile_sample_surface(face:u32,gridXY:vec2<f32>)->vec3<f32> {
  // Conservative bounds: a 2D mask cannot safely cull arbitrary 3D puffs.
  return vec3<f32>(1.0,shell_radial_minimum(),shell_radial_maximum());
}

fn point_is_visible_world(point: vec3<f32>, frustumGuard: f32, horizonGuard: f32) -> bool {
  let pointDir = normalize(point);
  let camDir = normalize(params.camPos);
  if (dot(pointDir, camDir) < horizonGuard) {
    return false;
  }

  let occlusionRadius = params.planetRadius * clamp(params.occlusionRadiusScale, 0.90, 1.08);
  if (segment_hits_planet(params.camPos, point, occlusionRadius)) {
    return false;
  }

  let rel = point - params.camPos;
  let vz = dot(rel, params.camFwd);
  if (vz <= 0.0) {
    return false;
  }
  let nx = abs(dot(rel, params.camRight)) / max(vz * params.tanHalfFovY * params.aspect, 1e-5);
  let ny = abs(dot(rel, params.camUp)) / max(vz * params.tanHalfFovY, 1e-5);
  return nx <= frustumGuard && ny <= frustumGuard;
}


fn segment_hits_planet(ro: vec3<f32>, point: vec3<f32>, radius: f32) -> bool {
  let segment = point - ro;
  let segmentLength = length(segment);
  let direction = segment / max(segmentLength, 1e-6);
  let b = dot(ro, direction);
  let c = dot(ro, ro) - radius * radius;
  let discriminant = b * b - c;
  if (discriminant <= 0.0) {
    return false;
  }
  let nearest = -b - sqrt(discriminant);
  return nearest > 0.0 && nearest < segmentLength - 0.02;
}

fn cell_is_visible(face: u32, cell: vec3<u32>) -> bool {
  let centerGrid = vec3<f32>(cell) + vec3<f32>(0.5);
  let centerWorld = param_to_world(face, centerGrid);
  let pointDir = normalize(centerWorld);
  let cameraDir = normalize(params.camPos);
  if (dot(pointDir, cameraDir) < -0.34) {
    return false;
  }

  let rel = centerWorld - params.camPos;
  let nearCellRadius=params.planetRadius*3.0/f32(params.angularCells)+
    (params.cloudTop-params.cloudBottom)*2.0/f32(params.radialCells);
  if(length(rel)<nearCellRadius){return true;}
  let viewDepth = dot(rel, params.camFwd);
  if (viewDepth <= 0.0) {
    return false;
  }
  let nx = abs(dot(rel, params.camRight)) / max(viewDepth * params.tanHalfFovY * params.aspect, 1e-5);
  let ny = abs(dot(rel, params.camUp)) / max(viewDepth * params.tanHalfFovY, 1e-5);
  return nx <= params.frustumGuard + 0.38 && ny <= params.frustumGuard + 0.38;
}

fn local_field_gradient(local: vec3<f32>, v: CubeVals) -> vec3<f32> {
  let tx = clamp(local.x, 0.0, 1.0);
  let ty = clamp(local.y, 0.0, 1.0);
  let tz = clamp(local.z, 0.0, 1.0);

  let dx0 = mix(v.v4 - v.v0, v.v5 - v.v1, ty);
  let dx1 = mix(v.v7 - v.v3, v.v6 - v.v2, ty);
  let dx = mix(dx0, dx1, tz);

  let dy0 = mix(v.v1 - v.v0, v.v5 - v.v4, tx);
  let dy1 = mix(v.v2 - v.v3, v.v6 - v.v7, tx);
  let dy = mix(dy0, dy1, tz);

  let dz0 = mix(v.v3 - v.v0, v.v7 - v.v4, tx);
  let dz1 = mix(v.v2 - v.v1, v.v6 - v.v5, tx);
  let dz = mix(dz0, dz1, ty);

  return vec3<f32>(dx, dy, dz);
}

fn world_normal_for_local(face: u32, gridPos: vec3<f32>, cellBase: vec3<f32>, v: CubeVals) -> vec3<f32> {
  let local = gridPos - cellBase;
  let g = local_field_gradient(local, v);
  let e = max(params.normalEpsilon, 0.01);
  let tx = param_to_world(face, gridPos + vec3<f32>(e, 0.0, 0.0)) - param_to_world(face, gridPos - vec3<f32>(e, 0.0, 0.0));
  let ty = param_to_world(face, gridPos + vec3<f32>(0.0, e, 0.0)) - param_to_world(face, gridPos - vec3<f32>(0.0, e, 0.0));
  let tz = param_to_world(face, gridPos + vec3<f32>(0.0, 0.0, e)) - param_to_world(face, gridPos - vec3<f32>(0.0, 0.0, e));
  let mapped = cross(ty, tz) * g.x + cross(tz, tx) * g.y + cross(tx, ty) * g.z;
  let len = length(mapped);
  if (len > 1e-8) {
    return mapped / len;
  }
  return normalize(param_to_world(face, gridPos));
}

fn world_to_face_grid(pos: vec3<f32>) -> vec4<f32> {
  let radius = max(length(pos), 1e-6);
  let dir = pos / radius;
  let absolute = abs(dir);
  var face = 0u;
  var facePoint = vec2<f32>(0.0);

  if (absolute.x >= absolute.y && absolute.x >= absolute.z) {
    if (dir.x >= 0.0) {
      face = 0u;
      facePoint = vec2<f32>(-dir.z / max(dir.x, 1e-6), dir.y / max(dir.x, 1e-6));
    } else {
      face = 1u;
      let denominator = max(-dir.x, 1e-6);
      facePoint = vec2<f32>(dir.z / denominator, dir.y / denominator);
    }
  } else if (absolute.y >= absolute.z) {
    if (dir.y >= 0.0) {
      face = 2u;
      facePoint = vec2<f32>(dir.x / max(dir.y, 1e-6), -dir.z / max(dir.y, 1e-6));
    } else {
      face = 3u;
      let denominator = max(-dir.y, 1e-6);
      facePoint = vec2<f32>(dir.x / denominator, dir.z / denominator);
    }
  } else if (dir.z >= 0.0) {
    face = 4u;
    facePoint = vec2<f32>(dir.x / max(dir.z, 1e-6), dir.y / max(dir.z, 1e-6));
  } else {
    face = 5u;
    let denominator = max(-dir.z, 1e-6);
    facePoint = vec2<f32>(-dir.x / denominator, dir.y / denominator);
  }

  let uv = clamp(facePoint * 0.5 + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let radialMinimum = shell_radial_minimum();
  let radialMaximum = shell_radial_maximum();
  let depth = clamp((radius - radialMinimum) / max(radialMaximum - radialMinimum, 1e-6), 0.0, 1.0);
  return vec4<f32>(
    uv * f32(params.angularCells),
    depth * f32(params.radialCells),
    f32(face)
  );
}

fn trilinear_field_value(local: vec3<f32>, values: CubeVals) -> f32 {
  let x00 = mix(values.v0, values.v4, local.x);
  let x10 = mix(values.v1, values.v5, local.x);
  let x11 = mix(values.v2, values.v6, local.x);
  let x01 = mix(values.v3, values.v7, local.x);
  let xy0 = mix(x00, x10, local.y);
  let xy1 = mix(x01, x11, local.y);
  return mix(xy0, xy1, local.z);
}

@compute @workgroup_size(64)
fn classify_tiles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileId = gid.x;
  if (tileId >= params.totalTiles || params.tilesPerAxis == 0u) {
    return;
  }

  let perFace = tiles_per_face();
  let face = tileId / perFace;
  let localTile = tileId - face * perFace;
  let tileY = localTile / params.tilesPerAxis;
  let tileX = localTile - tileY * params.tilesPerAxis;
  var tileActive = false;

  if ((params.visibleFaceMask & (1u << face)) != 0u) {
    let tileSize = max(params.tileCells, 1u);
    let x0 = tileX * tileSize;
    let y0 = tileY * tileSize;
    let x1 = min(x0 + tileSize, params.angularCells);
    let y1 = min(y0 + tileSize, params.angularCells);
    let fx0 = f32(x0);
    let fy0 = f32(y0);
    let fx1 = f32(x1);
    let fy1 = f32(y1);
    let center = vec2<f32>((fx0 + fx1) * 0.5, (fy0 + fy1) * 0.5);
    let shellDepth = f32(params.radialCells) * 0.56;

    var visible = false;
    var maximumCoverage = 0.0;
    var minimumInnerRadius = 1e30;
    var maximumOuterRadius = -1e30;
    let samples = array<vec2<f32>, 9>(
      vec2<f32>(fx0, fy0),
      vec2<f32>(fx1, fy0),
      vec2<f32>(fx0, fy1),
      vec2<f32>(fx1, fy1),
      center,
      vec2<f32>(center.x, fy0),
      vec2<f32>(center.x, fy1),
      vec2<f32>(fx0, center.y),
      vec2<f32>(fx1, center.y)
    );

    for (var sampleIndex = 0u; sampleIndex < 9u; sampleIndex += 1u) {
      let gridXY = samples[sampleIndex];
      let surfaceSample = tile_sample_surface(face, gridXY);
      maximumCoverage = max(maximumCoverage, surfaceSample.x);
      minimumInnerRadius = min(minimumInnerRadius, surfaceSample.y);
      maximumOuterRadius = max(maximumOuterRadius, surfaceSample.z);
      let sampleDirection = cube_face_direction(face, clamp(gridXY / max(f32(params.angularCells), 1.0), vec2<f32>(0.0), vec2<f32>(1.0)));
      let sampleRadius = mix(surfaceSample.y, surfaceSample.z, 0.62);
      let sampleWorld = sampleDirection * sampleRadius;
      visible = visible || point_is_visible_world(
        sampleWorld,
        params.tileFrustumGuard,
        params.tileHorizonGuard
      );
    }

    tileActive = visible && maximumCoverage >= params.coverageThreshold - params.tileCoverageGuard;
    if (tileActive) {
      currentTileFlags[tileId] = pack_tile_range(0u, params.radialCells - 1u);
      atomicAdd(&statusFlags[2], 1u);
      return;
    }
  }

  currentTileFlags[tileId] = 0u;
}

@compute @workgroup_size(128)
fn evaluate_field(@builtin(global_invocation_id) gid: vec3<u32>) {
  let visibleFaceCount = countOneBits(params.visibleFaceMask);
  let pointCount = points_per_face() * visibleFaceCount;
  let visiblePointId = gid.x;
  if (visiblePointId >= pointCount || visibleFaceCount == 0u) {
    return;
  }

  let faceOrdinal = visiblePointId / points_per_face();
  let face = nth_visible_face(params.visibleFaceMask, faceOrdinal);
  let localId = visiblePointId - faceOrdinal * points_per_face();
  let angularPoints = params.angularCells + 1u;
  let planePoints = angularPoints * angularPoints;
  let z = localId / planePoints;
  let planeId = localId - z * planePoints;
  let y = planeId / angularPoints;
  let x = planeId - y * angularPoints;
  let pointXY = vec2<u32>(x, y);
  let destinationIndex = field_index(face, vec3<u32>(x, y, z));
  let pointIsActive = point_has_active_tile(face, pointXY, z, false);
  let pointWasActive = params.tileHistoryValid != 0u && point_has_active_tile(face, pointXY, z, true);
  let faceWasValid = params.previousFieldValid != 0u &&
    (params.previousFieldFaceMask & (1u << face)) != 0u &&
    pointWasActive;
  let previousValue = previousField[destinationIndex];
  let olderValue = olderField[destinationIndex];
  var historyValue = max(params.maxThickness, 1.0);
  if (faceWasValid && params.historyCount >= 2u) {
    let historyWeight = clamp(params.voxelHistoryWeight, 0.0, 0.98);
    historyValue = previousValue * historyWeight + olderValue * (1.0 - historyWeight);
  } else if (faceWasValid && params.historyCount >= 1u) {
    historyValue = previousValue;
  }

  if (!pointIsActive) {
    if (faceWasValid) {
      let releaseTarget = max(params.maxThickness, 1.0);
      let releaseBlend = min(clamp(params.fieldBlend, 0.02, 0.12) * 0.30, 0.045);
      currentField[destinationIndex] = mix(historyValue, releaseTarget, releaseBlend);
    } else {
      currentField[destinationIndex] = max(params.maxThickness, 1.0);
    }
    return;
  }

  let gridPos = vec3<f32>(f32(x), f32(y), f32(z));
  let rawValue = scalar_field_world(param_to_world(face, gridPos));

  var stableValue = rawValue;
  if (faceWasValid) {
    let blendAlpha = clamp(params.fieldBlend, 0.018, 0.65);
    stableValue = mix(historyValue, rawValue, blendAlpha);

    let persistenceBand = max(params.voxelPersistenceBand, 0.0);
    if (historyValue < 0.0 && stableValue < persistenceBand) {
      stableValue = -max(abs(stableValue), 1e-5);
    } else if (historyValue >= 0.0 && stableValue > -persistenceBand) {
      stableValue = max(abs(stableValue), 1e-5);
    }
  }

  let hysteresis = max(params.isoHysteresis, 0.0);
  if (faceWasValid && hysteresis > 0.0 && abs(stableValue) < hysteresis) {
    stableValue = select(hysteresis, -hysteresis, historyValue < 0.0);
  }
  currentField[destinationIndex] = stableValue;
}

@compute @workgroup_size(128)
fn classify_cells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cellsPerFace = params.angularCells * params.angularCells * params.radialCells;
  let visibleFaceCount = countOneBits(params.visibleFaceMask);
  let totalCells = cellsPerFace * visibleFaceCount;
  let cellId = gid.x;
  if (cellId >= totalCells || visibleFaceCount == 0u) {
    return;
  }

  let faceOrdinal = cellId / cellsPerFace;
  let face = nth_visible_face(params.visibleFaceMask, faceOrdinal);
  let faceCell = cellId - faceOrdinal * cellsPerFace;
  let x = faceCell % params.angularCells;
  let y = (faceCell / params.angularCells) % params.angularCells;
  let z = faceCell / (params.angularCells * params.angularCells);
  let cell = vec3<u32>(x, y, z);
  if (params.useTileCulling != 0u) {
    let tile = cell_tile(cell.xy);
    let tileFlag = currentTileFlags[tile_index(face, tile)];
    if (
      !tile_is_active(tileFlag) ||
      cell.z < tile_min_radial_cell(tileFlag) ||
      cell.z > tile_max_radial_cell(tileFlag)
    ) {
      return;
    }
  }

  if (!cell_is_visible(face, cell)) {
    return;
  }

  let values = load_cube_values(face, cell);
  let index = cube_index(values);
  if (index == 0u || index == 255u) {
    return;
  }

  let slot = atomicAdd(&activeCounter, 1u);
  if (slot < params.maxActiveCells) {
    activeCells[slot] = pack_cell(face, cell);
  } else {
    atomicStore(&statusFlags[1], 1u);
  }
}

@compute @workgroup_size(1)
fn prepare_extract_dispatch(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x != 0u) {
    return;
  }
  let count = min(atomicLoad(&activeCounter), params.maxActiveCells);
  extractDispatch[0] = (count + 127u) / 128u;
  extractDispatch[1] = 1u;
  extractDispatch[2] = 1u;
}

fn reserve_vertices(count: u32) -> u32 {
  // One reservation per cell. A CAS retry loop serialized entire workgroups
  // under contention; atomicAdd has no shader-side spin/retry or live lock.
  let base=atomicAdd(&outCounter,count);
  if(base>=params.maxVertices){
    atomicStore(&statusFlags[0],1u);
    return 0xffffffffu;
  }
  if(count>params.maxVertices-base){atomicStore(&statusFlags[0],1u);}
  return base;
}

@compute @workgroup_size(128)
fn extract_active(@builtin(global_invocation_id) gid: vec3<u32>) {
  let activeCount = min(atomicLoad(&activeCounter), params.maxActiveCells);
  let activeId = gid.x;
  if (activeId >= activeCount) {
    return;
  }

  let packed = unpack_cell(activeCells[activeId]);
  let cell = packed.xyz;
  let face = packed.w;
  let vals = load_cube_values(face, cell);
  let cubeIdx = cube_index(vals);
  if (cubeIdx == 0u || cubeIdx == 255u) {
    return;
  }

  let info = pattern_info(cubeIdx, vals);
  var pcase = info.pcase;
  var triCodes: array<vec3<u32>, 12>;
  var triCount = 0u;

  loop {
    if (pcase >= 2310u) {
      break;
    }
    let patternWord = table[pcase];
    let c0 = patternWord & 0xFu;
    let c1 = (patternWord >> 4u) & 0xFu;
    let c2 = (patternWord >> 8u) & 0xFu;
    if (c0 <= 12u && c1 <= 12u && c2 <= 12u && c0 != c1 && c1 != c2 && c0 != c2) {
      if (triCount < 12u) {
        triCodes[triCount] = vec3<u32>(c0, c1, c2);
      }
      triCount += 1u;
    }
    if ((patternWord & 0x1000u) == 0u) {
      break;
    }
    pcase += 1u;
  }

  if (triCount == 0u) {
    return;
  }

  let safeTriCount = min(triCount, 12u);
  let emitVertexCount = safeTriCount * 3u;
  let base = reserve_vertices(emitVertexCount);
  if (base == 0xffffffffu) {
    return;
  }

  let cellBase = vec3<f32>(f32(cell.x), f32(cell.y), f32(cell.z));
  // The counter records requested capacity, but indirect dispatch/draw clamp
  // it. Emit complete triangles into the final partial reservation as well,
  // so every vertex below the clamp is initialized even during overflow.
  let writableTriCount=min(safeTriCount,(params.maxVertices-base)/3u);
  for (var triangle = 0u; triangle < writableTriCount; triangle += 1u) {
    let codes = triCodes[triangle];
    let dst = base + triangle * 3u;
    var g0 = vertex_grid_for_code(codes.x, cell, vals);
    var g1 = vertex_grid_for_code(codes.y, cell, vals);
    var g2 = vertex_grid_for_code(codes.z, cell, vals);

    if (info.reverse) {
      let temporary = g1;
      g1 = g2;
      g2 = temporary;
    }

    let p0 = param_to_world(face, g0);
    let p1 = param_to_world(face, g1);
    let p2 = param_to_world(face, g2);
    outPositions[dst] = vec4<f32>(p0, 1.0);
    outPositions[dst + 1u] = vec4<f32>(p1, 1.0);
    outPositions[dst + 2u] = vec4<f32>(p2, 1.0);
    outNormals[dst] = vec4<f32>(world_normal_for_local(face, g0, cellBase, vals), 0.0);
    outNormals[dst + 1u] = vec4<f32>(world_normal_for_local(face, g1, cellBase, vals), 0.0);
    outNormals[dst + 2u] = vec4<f32>(world_normal_for_local(face, g2, cellBase, vals), 0.0);
  }
}

@compute @workgroup_size(128)
fn project_vertices(@builtin(global_invocation_id) gid: vec3<u32>) {
  let vertexId = gid.x;
  let vertexCount = min(atomicLoad(&outCounter), params.maxVertices);
  if (vertexId >= vertexCount) {
    return;
  }

  let mapping = world_to_face_grid(outPositions[vertexId].xyz);
  let maximumCell = vec3<u32>(params.angularCells - 1u, params.angularCells - 1u, params.radialCells - 1u);
  let floored = vec3<u32>(floor(mapping.xyz));
  let cell = min(floored, maximumCell);
  let local = clamp(mapping.xyz - vec3<f32>(cell), vec3<f32>(0.0), vec3<f32>(1.0));
  let face = min(u32(mapping.w + 0.5), 5u);
  let values = load_cube_values(face, cell);
  let value = trilinear_field_value(local, values);
  let normal = smooth_world_normal(outPositions[vertexId].xyz);
  let displacement = clamp(
    value * clamp(params.projectionStrength, 0.0, 1.0),
    -max(params.projectionMaxStep, 0.0),
    max(params.projectionMaxStep, 0.0)
  );
  let projectedPosition = outPositions[vertexId].xyz - normal * displacement;
  outPositions[vertexId] = vec4<f32>(projectedPosition, 1.0);
  outNormals[vertexId] = vec4<f32>(normal, 0.0);
}

@compute @workgroup_size(1)
fn prepare_draw_indirect(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x != 0u) {
    return;
  }
  let vertexCount = min(atomicLoad(&outCounter), params.maxVertices);
  outIndirect[0] = vertexCount;
  outIndirect[1] = 1u;
  outIndirect[2] = 0u;
  outIndirect[3] = 0u;
  projectionDispatch[0] = (vertexCount + 127u) / 128u;
  projectionDispatch[1] = 1u;
  projectionDispatch[2] = 1u;
}

fn surface_weather(pos: vec3<f32>) -> vec4<f32> {
  var weatherDir=normalize(rotate_domain(pos,params.weatherTime));
  if(params.formType>=.5){weatherDir=planetWarpDirection(normalize(pos),params.weatherTime,params.formType,params.warpAmount,params.warpPhase);}
  let uv=vec2<f32>(fract(atan2(weatherDir.z,weatherDir.x)/(2.0*PI)),acos(clamp(weatherDir.y,-1.0,1.0))/PI);
  return sample_weather(uv);
}

@compute @workgroup_size(8, 8)
fn capturePlanetRegionWeather(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = regionWeatherWidth();
  if (id.x >= width || id.y >= width) { return; }
  let direction = regionWeatherDirection(id.xy, width);
  regionWeatherPixels[id.y * width + id.x] = pack4x8unorm(surface_weather(direction));
}
