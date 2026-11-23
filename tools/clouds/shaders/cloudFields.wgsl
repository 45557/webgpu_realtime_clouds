// Flat-volume fields are shared between independent compute entrypoints. Density
// is regenerated for scene/noise changes; lighting for density or sun changes.
struct CloudFieldParams {
  gridMin: vec4<f32>, // xyz bounds, w rain-shelf weight
  gridSize: vec4<f32>, // xyz extent, w stratus-deck weight
  dimensions: vec4<u32>,
  volume: vec4<f32>, // mask kind, rotation, major radius, tube radius / box wisp weight
  morphology: vec4<f32>, // cirrus, Kelvin-Helmholtz/fluctus, asperitas, ray-only turbulence
  pattern: vec4<f32>, // axis (0 volume, 1 X, 2 Y, 3 Z), first, last, stride
  patternMotion: vec4<f32>, // material-space scroll, enabled
  patternStyle: vec4<f32>, // repeat scale, slice thickness in cells
  regionWeather: vec4<f32>, // x: captured span, y: initial Planet billow phase
  regionUp: vec4<f32>, // xyz reflected tangent frame, w tangent coordinate scale
  regionEast: vec4<f32>, // w Planet shell bottom
  regionSouth: vec4<f32>, // w Planet shell top
  regionShape: vec4<f32>, // xyz axis scale, w Planet domain scale
  regionMotion: vec4<f32>, // radius, longitude, meridian, warp amount
  regionWarp: vec4<f32>, // warp phase, local datum radius, radial layer bottom, reciprocal thickness
  regionRotation: vec4<f32>, // cosine and sine pairs for longitude, then meridian
  regionEddies: vec4<f32>, // two half-phases followed by their amplitude factors
};
@group(2) @binding(1) var cloudDensityField: texture_3d<f32>;
@group(2) @binding(2) var cloudLightField: texture_3d<f32>;
@group(2) @binding(3) var cloudFieldSampler: sampler;
@group(2) @binding(4) var<uniform> FIELD: CloudFieldParams;
@group(2) @binding(5) var cloudDensityOut: texture_storage_3d<rgba16float, write>;
@group(2) @binding(6) var cloudLightOut: texture_storage_3d<rgba16float, write>;

// Nonzero only in the specialized Flat cumulus ray pipelines. Density and
// light bakes use the uniform and retain their shared pipelines.
override CLOUD_FLAT_TOWER_FORM: f32 = 0.0;
override CLOUD_FLAT_TOWER_PROJECTED: u32 = 0u;
// Fixed-form Flat volumes retain the normal projection, tiling and lighting rules.
override CLOUD_FLAT_VOLUME_FORM: f32 = 0.0;

fn flatFormType() -> f32 {
  if (CLOUD_FLAT_VOLUME_FORM > 0.0) { return CLOUD_FLAT_VOLUME_FORM; }
  if (CLOUD_FLAT_TOWER_FORM > 0.0) { return CLOUD_FLAT_TOWER_FORM; }
  return TUNE.formType;
}

fn fieldIsTiled() -> bool {
  return CLOUD_FLAT_TOWER_FORM == 0.0 && FIELD.dimensions.w > 0u;
}

fn cloudFieldUV(p: vec3<f32>) -> vec3<f32> {
  let uv=(p - FIELD.gridMin.xyz) / max(FIELD.gridSize.xyz, vec3<f32>(EPS));
  return select(uv,vec3<f32>(fract(uv.x),uv.y,fract(uv.z)),fieldIsTiled() || (CLOUD_FROZEN_PATTERN!=0u && FIELD.patternMotion.w>0.5));
}
fn fieldPeriodicScale(scale:vec3<f32>)->vec3<f32> {
  if(FIELD.dimensions.w==0u){return scale;}
  return vec3<f32>(max(1.0,round(abs(scale.x)*FIELD.gridSize.x))*sign(scale.x)/FIELD.gridSize.x,
    scale.y,max(1.0,round(abs(scale.z)*FIELD.gridSize.z))*sign(scale.z)/FIELD.gridSize.z);
}
fn fieldWeatherUV(p:vec3<f32>,scale:f32)->vec2<f32> {
  if(FIELD.dimensions.w==0u){return weatherUV_from(p,scale);}
  let axis=axisOrOne3(NTransform.weatherAxisScale);
  let rate=fieldPeriodicScale(axis*0.5*max(B.uvScale,EPS)*scale);
  return (p.xz+NTransform.weatherOffsetWorld.xz-B.center.xz)*rate.xz;
}
fn fieldSampleAtLod(p: vec3<f32>, lod: f32) -> vec4<f32> {
  let uv = cloudFieldUV(p);
  if (any(uv < vec3<f32>(0.0)) || any(uv > vec3<f32>(1.0))) { return vec4<f32>(0.0, 0.0, 0.0, -0.15); }
  return textureSampleLevel(cloudDensityField, cloudFieldSampler, uv, lod);
}
fn fieldSampleAt(p: vec3<f32>) -> vec4<f32> {
  return fieldSampleAtLod(p, 0.0);
}
fn fieldDensityAt(p: vec3<f32>) -> vec2<f32> {
  return fieldSampleAt(p).rg;
}
fn cloudCellRandom(cell: vec2<f32>, offset: f32) -> f32 {
  var id=cell;
  if(FIELD.dimensions.w>0u){let count=round(FIELD.gridSize.xz/max(TUNE.puffScale,0.75));id=cell-floor(cell/count)*count;}
  return hash11Fast(dot(id, vec2<f32>(127.1, 311.7)) + offset);
}
fn cloudEllipsoid(p: vec3<f32>, center: vec3<f32>, radius: vec3<f32>) -> f32 {
  return 1.0 - length((p - center) / max(radius, vec3<f32>(0.01)));
}

fn cloudSoftUnion(a: f32, b: f32) -> f32 {
  let h = max(0.26 - abs(a - b), 0.0) / 0.26;
  return max(a, b) + h * h * 0.065;
}

fn capturedWeather(uv: vec2<f32>) -> vec4<f32> {
  let inset = 0.5 / vec2<f32>(textureDimensions(weather2D));
  return textureSampleLevel(weather2D, samp2D, clamp(uv, inset, 1.0 - inset), 0i, 0.0);
}

fn localPlanetWeather(p: vec3<f32>) -> vec4<f32> {
  if (FIELD.regionWeather.x > 0.0) {
    return capturedWeather(p.xz / FIELD.regionWeather.x + 0.5);
  }
  let spacing = max(TUNE.puffScale, 0.75);
  let position = rotateXZ((p.xz + NTransform.weatherOffsetWorld.xz) / spacing, 0.34);
  let latitude = position.y * 0.19;
  // A continuous projection keeps weather fronts from mirroring at the poles
  // of the atlas. Keep the authored moisture and opening channels correlated.
  let uv = vec2<f32>(position.x * 0.074 + 0.27 + 0.09 * atan(latitude),
    0.47 + latitude * inverseSqrt(1.0 + latitude * latitude) * 0.44);
  return wrap2D(weather2D, samp2D, uv, 0i, 0.0);
}
fn localPlanetFilament(form: f32) -> bool {
  return form == 2.51 || form == 2.53 || form == 2.58 || form == 2.59 || form == 1.41;
}
fn localPlanetShape(p: vec3<f32>, ph: f32, form: f32, weather: vec4<f32>, spacing: vec3<f32>) -> vec4<f32> {
  let scale = 0.53 / max(TUNE.puffScale, 0.75) * clamp(abs(NTransform.shapeScale) / 0.20, 0.25, 4.0);
  let axis = abs(axisOrOne3(NTransform.shapeAxisScale));
  let material = (p - B.center + NTransform.shapeOffsetWorld) * scale * axis;
  let filament = localPlanetFilament(form);
  // Bend the body at weather scale, keeping nearby fibers on the same
  // trajectory. The directional lobes and forks are already in the Planet
  // texture and must survive independently of Flat's density cache.
  let horizontal = rotateXZ(material.xz, 0.31);
  let phase = ph - 0.5;
  let warpUV = vec3<f32>(horizontal.x * 0.22, material.y * 0.16, horizontal.y * 0.22);
  let warp = textureSampleLevel(shape3D, sampShape, warpUV + vec3<f32>(0.21, 0.56, 0.73), 1.0);
  let bend = select(vec3<f32>(0.72, 0.22, 0.72), vec3<f32>(0.33, 0.12, 0.33), filament)
    + select(vec3<f32>(0.0), vec3<f32>(0.18, 0.11, 0.18), form == 2.58);
  let shear = vec2<f32>(0.085, -0.13) * phase * (0.55 + weather.b);
  let position = horizontal + select(vec2<f32>(0.0), shear, filament);
  let warped = vec3<f32>(position.x, material.y, position.y) + (warp.rga - 0.5) * bend;
  let domain = planetWeatherShapeDomain(warped, weather, ph, form, 1.0) + vec3<f32>(0.39, 0.57, 0.19);
  let evolution = FIELD.regionWeather.y + NTransform.shapeOffsetWorld.y * 0.24;
  let uv = select(planetEvolvingDomain(domain, evolution), domain, isBigBlob(form));
  let texelFootprint = spacing * axis * scale * vec3<f32>(textureDimensions(shape3D));
  let lod = log2(max(max(texelFootprint.x, max(texelFootprint.y, texelFootprint.z)), 1.0));
  let primary = evolvePlanetCloudShape(textureSampleLevel(shape3D, sampShape, uv, lod), evolution, form);
  let fineUV = planetEvolvingDomain(uv * vec3<f32>(2.11, 1.66, 2.11) + vec3<f32>(0.11, 0.32, 0.57), evolution);
  let breakup = textureSampleLevel(shape3D, sampShape, fineUV, lod + 1.08);
  let bandWeights = select(vec4<f32>(0.08, 0.23, 0.31, 0.0), vec4<f32>(0.03, 0.28, 0.24, 0.0), filament);
  var bands = primary + (breakup - 0.5) * bandWeights;
  if (lod < 1.4) {
    // Use the same wind-bent field for fine frays. At a grazing angle the
    // footprint will suppress them before they become horizontal stripes.
    let fineBands = textureSampleLevel(shape3D, sampShape,
      uv * vec3<f32>(3.82, 3.35, 3.82) + vec3<f32>(0.49, 0.17, 0.72), lod + 1.93);
    let weight = (1.0 - smoothstep(0.35, 1.4, lod)) * select(0.11, 0.19, filament);
    bands += (fineBands - 0.5) * vec4<f32>(0.12, 0.62, 1.0, 0.0) * weight;
  }
  return clamp(0.5 + (bands - 0.5) * 1.13 + NTransform.shapeBias, vec4<f32>(0.0), vec4<f32>(1.0));
}

// A standalone flat scene covers a small portion of the planet weather
// atlas. Give that patch its own wet cells and dry lanes at local scale.
fn localPlanetWeatherPatch(p: vec3<f32>, weather: vec4<f32>, frequency: f32, stretch: vec2<f32>) -> f32 {
  let material = (p.xz + NTransform.weatherOffsetWorld.xz) / max(TUNE.puffScale, .75);
  let shape = rotateXZ(material, .61) * stretch;
  let broad = smoothCellHash2D(shape + vec2<f32>(6.9, 11.3), frequency);
  let smaller = smoothCellHash2D(shape + vec2<f32>(19.2, 2.8), frequency * 2.19);
  return dot(vec3<f32>(broad, smaller, max(weather.r, weather.a)), vec3<f32>(.57, .24, .19));
}

fn localPlanetTower(form: f32) -> bool {
  return form == 2.25 || form == 2.38;
}

fn localConvectiveBank(p: vec3<f32>, ph: f32, weather: vec4<f32>, coverage: f32, form: f32, footprint: f32, skipClear: bool) -> vec2<f32> {
  let cellSize = max(TUNE.puffScale, 0.75);
  let material = (p - B.center + NTransform.shapeOffsetWorld) / cellSize;
  let tall = abs(form - 2.38) < 0.004 || abs(form - 2.41) < 0.004;
  let island = abs(form - 2.43) < 0.004;
  let moisture = mix(weather.r, weather.g, 0.26);
  var weatherLimit = (moisture - mix(0.68, 0.26, coverage)) * 1.12;
  if (island) {
    let maritime = localPlanetWeatherPatch(p, weather, .23, vec2<f32>(1.0, .84));
    weatherLimit = (maritime - mix(.66, .34, coverage)) * 1.28;
  }
  if (weatherLimit <= select(-0.25, 0.0, skipClear)) { return vec2<f32>(-0.30); }

  // Continuous, non-repeating fields place the banks. The tiled Planet
  // volume shapes their billows only after this field has placed a bank.
  let horizontal = rotateXZ(material.xz, 0.53);
  let drift = vec2<f32>(smoothCellHash2D(horizontal + vec2<f32>(11.7, 2.6), 0.12),
    smoothCellHash2D(rotateXZ(horizontal, 0.91) + vec2<f32>(3.2, 14.1), 0.15)) - 0.5;
  let shear = vec2<f32>(0.76, -0.45) + drift * 0.62;
  let site = horizontal + drift * 3.4 - shear * ph * ph;
  let banks = smoothCellHash2D(site + vec2<f32>(4.1, 8.3), select(0.30, 0.21, tall));
  let cells = smoothCellHash2D(rotateXZ(site, -0.74) + vec2<f32>(8.1, 2.7), 0.41);
  let lanes = rotateXZ(site, -1.02) * vec2<f32>(1.22, 0.64);
  let dryLane = smoothCellHash2D(lanes + vec2<f32>(13.2, 5.6), 0.33);
  let support = mix(banks, cells, select(0.46, 0.35, tall));
  let thermal = mix(banks, cells, select(0.59, 0.66, tall)) + (weather.g - 0.5) * 0.17;
  let updraft = smoothstep(0.47, 0.81, thermal);
  let threshold = mix(0.68, select(0.51, 0.49, tall), coverage) - select(0.0, .078, island);
  let heightVariation = clamp(TUNE.towerHeightVariation, 0.0, 0.9);
  let lift = (dryLane - 0.5) * 0.32 + (cells - 0.5) * 0.21;
  let feederBase = clamp(0.19 + lift * (0.56 + heightVariation) + (weather.a - 0.5) * 0.16
    - updraft * 0.08, 0.035, 0.49);
  let feederTop = feederBase + mix(0.11, 0.25, support) + weather.b * 0.035;

  // Low feeder clouds can join rooted updrafts. Between them, the base
  // lifts and the upper cloud narrows into independently leaning towers.
  let convectiveFeederProfile = min((ph - feederBase) * 1.40, (feederTop - ph) * 1.21);
  let underneath = 1.0 - smoothstep(feederBase + 0.028, feederBase + 0.18, ph);
  let leeAir = 1.0 - smoothstep(0.35, 0.70, mix(dryLane, cells, 0.54));
  let undercut = underneath * leeAir * mix(0.23, 0.07, updraft);
  let feederSide = (support - threshold - 0.043) * 1.42 + (moisture - 0.5) * 0.12 - undercut;
  let rise = smoothstep(0.13, 0.93, ph);
  let towerBase = feederBase + mix(0.046, -0.066, updraft);
  let towerTop = mix(feederTop + 0.047, select(0.71, 0.98, tall), updraft);
  let towerProfile = min((ph - towerBase) * 1.35, (towerTop - ph) * 0.86);
  let towerSide = (thermal - threshold - 0.055) * 1.52 - mix(0.26, 0.075, updraft) * rise;
  let alley = (mix(dryLane, cells, 0.18) - mix(0.61, 0.33, coverage)) * 0.97 + updraft * 0.065;
  let envelope = max(min(feederSide, convectiveFeederProfile), min(towerSide, towerProfile));
  if (min(envelope, alley) <= -0.25) {
    return vec2<f32>(-0.30);
  }

  // The winds tilt the rolls through the full volume. Sample large shoulders
  // and smaller billows in different directions, at the actual voxel pitch.
  let scale = 0.21 * clamp(abs(NTransform.shapeScale) / 0.20, 0.25, 4.0);
  let tower = localPlanetTower(form);
  let roll = vec3<f32>(site.x, material.y * select(1.22, .90, tower) + site.y * 0.28, site.y - material.y * 0.35) * scale;
  let texels = footprint * scale * f32(textureDimensions(shape3D).x) / cellSize;
  let rollLod = max(log2(max(texels, 1.0)), 0.0);
  let shoulderDomain = roll + vec3<f32>(0.47, 0.31, 0.72);
  let phase = FIELD.regionWeather.y + NTransform.shapeOffsetWorld.y * .24;
  // The broad updraft sets the shape of the bank. Planet's evolving domain
  // carries both large shoulders and small folds around that same updraft.
  var shoulderUV = shoulderDomain;
  if (tower) {
    let turn = material.y * .64 + dryLane * 2.1 + phase * .46;
    let eddy = vec2<f32>(sin(turn), cos(turn)) * (.13 + .20 * updraft);
    shoulderUV = planetEvolvingDomain(shoulderDomain + vec3<f32>(eddy.x, 0.0, eddy.y), phase);
  }
  let shoulders = textureSampleLevel(shape3D, sampShape, shoulderUV, rollLod);
  // A resolved ray can discard this sample before probing the secondary folds.
  // The shadow cache and sunward probes still need the original signed mass.
  let opening = min(weatherLimit, alley + (shoulders.g - 0.5) * 0.16);
  if (skipClear && opening <= 0.0) { return vec2<f32>(-0.30); }
  let foldDomain = select(roll, shoulderUV, tower);
  let crosswise = rotateXZ(foldDomain.xz, 1.13);
  let billow = vec3<f32>(crosswise.x, foldDomain.y * select(.83, .47, tower), crosswise.y) * 2.21
    + (shoulders.arg - 0.5) * select(.15, .30, tower);
  let foldLod = max(log2(max(texels * 2.21, 1.0)), 0.0);
  let folds = textureSampleLevel(shape3D, sampShape, billow + vec3<f32>(0.19, 0.62, 0.36), foldLod);

  let lobeWeights = select(vec4<f32>(.24, .43, 0.0, .17), vec4<f32>(.19, .17, .30, .10), tower);
  let lobes = dot(shoulders - 0.5, lobeWeights);
  // Drier air nibbles into the lower lip. Bias that edge with a different
  // band of the shaping texture so it has scallops between the deeper cores.
  let baseErosion = underneath * leeAir * (0.022 + (0.45 - folds.g) * 0.18);
  let feederMass = min(feederSide + lobes * 0.82, convectiveFeederProfile + lobes * 0.66) - baseErosion;
  let towerMass = min(towerSide + lobes, towerProfile + lobes * mix(0.73, 1.04, rise));
  var mass = cloudSoftUnion(feederMass * 2.8, towerMass * 2.8) / 2.8 + NTransform.shapeBias;
  if (tower) {
    let towerHeight = (ph - feederBase + .070) / max(towerTop - feederBase + .15, .18);
    let liftedWeather = vec4<f32>(mix(weather.r, thermal, .53) + .12, weather.gba);
    let streaks = clamp(shoulders + (folds - .5) * vec4<f32>(.47, .55, .68, .32),
      vec4<f32>(0.0), vec4<f32>(1.0));
    let risingVolume = convectiveTowerForm(towerHeight, liftedWeather, streaks, coverage, form == 2.25).x;
    // Keep the columns and openings placed by the regional scaffold, then
    // let the planet profile build the depth inside each of those columns.
    let silhouette = mass + mix(.075, .13, updraft);
    let liftedMass = mix(mass, risingVolume + .018, mix(.75, .88, rise));
    let join = max(.09 - abs(silhouette - liftedMass), 0.0) / .09;
    mass = min(silhouette, liftedMass) - join * join * .0225;
  }
  let edge = 1.0 - smoothstep(0.075, 0.29, abs(mass));
  if (edge <= 0.0) { return vec2<f32>(min(opening, mass)); }
  let weights = select(vec3<f32>(.08, .17, .12), vec3<f32>(.20, .37, .39), tower);
  var foldedRim = dot(folds.rgb - 0.5, weights);
  if (tower && foldLod < 2.3) {
    let strands = textureSampleLevel(shape3D, sampShape,
      planetEvolvingDomain(billow * 1.89 + vec3<f32>(.51, .22, .73), phase), foldLod + .90);
    foldedRim += (strands.b - .5) * .29 * (1.0 - smoothstep(.65, 2.3, foldLod));
  }
  return vec2<f32>(min(opening, mass + foldedRim * edge), min(opening, mass));
}

fn localAnvilStorm(p: vec3<f32>, ph: f32, weather: vec4<f32>, coverage: f32, footprint: f32) -> vec3<f32> {
  let humidity = mix(weather.r, weather.g, 0.24);
  if (humidity < 0.08) { return vec3<f32>(-0.30, -0.30, 0.0); }
  let dryEdge = 1.0 - smoothstep(0.08, 0.35, humidity);

  let puff = max(TUNE.puffScale, 0.75);
  let siteSpacing = 4.15 * puff;
  let material = p - B.center + NTransform.shapeOffsetWorld;
  let wind = vec2<f32>(0.879, -0.477);
  let across = vec2<f32>(-wind.y, wind.x);
  let position = vec2<f32>(dot(material.xz, wind), dot(material.xz, across)) / siteSpacing;
  // Give strong cells headroom without stretching the feeder layer or its
  // shaping noise when the preset opens up the taller volume.
  let layerDepth = max(FIELD.gridSize.y, EPS);
  let feederDepth = min(layerDepth, puff * 2.54);
  let feederFraction = feederDepth / layerDepth;
  let feederPhase = ph / feederFraction;

  // Cross the texture's Y axis with the updraft. This makes lobes turn into
  // and out of the tower as they rise instead of tracing vertical streaks.
  let materialHeight = material.y + (layerDepth - feederDepth) * 0.5;
  let q = vec3<f32>(position.x * siteSpacing, materialHeight, position.y * siteSpacing);
  let tilt = rotateXZ(q.xy, -0.64);
  let scale = 0.18 * clamp(abs(NTransform.shapeScale) / 0.20, 0.25, 4.0) / puff;
  let uv = vec3<f32>(tilt.x, tilt.y, q.z + q.y * 0.38) * scale;
  let texels = footprint * scale * f32(textureDimensions(shape3D).x);
  let rolls = textureSampleLevel(shape3D, sampShape, uv + vec3<f32>(0.17, 0.62, 0.37), max(log2(max(texels, 1.0)), 0.0));
  let crossUV = vec3<f32>(uv.y, uv.z, uv.x) * 2.19 + (rolls.gar - 0.5) * 0.13;
  let folds = textureSampleLevel(shape3D, sampShape, crossUV + vec3<f32>(0.71, 0.31, 0.19),
    max(log2(max(texels * 2.19, 1.0)), 0.0));
  let lobes = dot(rolls.rga - 0.5, vec3<f32>(0.20, 0.52, 0.19));
  let basalLod = max(log2(max(texels * 0.54, 1.0)), 0.0);
  let broadRoll = textureSampleLevel(shape3D, sampShape,
    uv.zxy * 0.54 + vec3<f32>(0.32, 0.18, 0.52), basalLod);
  let belowShoulder = 1.0 - smoothstep(0.20, 0.56, feederPhase);
  let basalRoll = dot(broadRoll.ra - 0.5, vec2<f32>(0.65, 0.35));
  let sculpted = position + (rolls.ga - 0.5) * vec2<f32>(0.24, 0.29)
    + (broadRoll.bg - 0.5) * vec2<f32>(0.14, 0.21) * belowShoulder;
  let altitude = ph + ((rolls.r - 0.5) * 0.16 + basalRoll * belowShoulder * 0.34) * feederFraction;
  let cell = floor(sculpted);
  // The higher ice outflow can reach beyond the immediately adjacent cell.
  let highOutflow = feederPhase > 0.39;
  let startAlong = select(-1, -2, highOutflow);
  let maxReach = select(1.56, 2.08, highOutflow);
  let maxAcross = select(0.82, 1.12, highOutflow);
  var storm = -0.42;
  var ice = 0.0;

  for (var z = -1; z <= 1; z++) {
    for (var x = startAlong; x <= 1; x++) {
      let id = cell + vec2<f32>(f32(x), f32(z));
      let seed = vec4<f32>(cloudCellRandom(id, 13.1), cloudCellRandom(id, 57.3),
        cloudCellRandom(id, 91.7), cloudCellRandom(id, 151.3));
      let root = id + 0.5 + (seed.xy - 0.5) * 0.64;
      let delta = sculpted - root;
      if (delta.x < -0.71 || delta.x > maxReach || abs(delta.y) > maxAcross) { continue; }

      // The root's Planet weather limits the whole storm, including the high
      // outflow downwind. The local weather still bounds its far edge.
      let rootPosition = B.center.xz - NTransform.shapeOffsetWorld.xz + (wind * root.x + across * root.y) * siteSpacing;
      let source = localPlanetWeather(vec3<f32>(rootPosition.x, p.y, rootPosition.y));
      let wet = mix(source.r, source.g, 0.28);
      let activity = smoothstep(0.42, 0.67, wet * 0.67 + seed.z * 0.33 + (coverage - 0.5) * 0.28);
      if (activity < 0.10) { continue; }

      let maturity = smoothstep(0.30, 0.79, mix(seed.z, source.g, 0.27));
      let buoyancy = smoothstep(0.27, 0.78, mix(wet, source.g, 0.34));
      let dominant = smoothstep(0.54, 0.84, 0.55 * maturity + 0.45 * buoyancy)
        * smoothstep(0.18, 0.64, activity);
      let bottom = (0.075 + seed.y * 0.12 + (source.a - 0.5) * 0.08) * feederFraction;
      let ordinaryTop = mix(0.45, 0.96, maturity) * feederFraction;
      let towerSurge = dominant * min(max(0.96 - ordinaryTop, 0.0), 0.36);
      let top = ordinaryTop + towerSurge * 0.46;
      let halfHeight = (top - bottom) * 0.5;
      let climb = smoothstep(bottom, top, altitude);
      let lean = vec2<f32>(0.18, (seed.x - 0.5) * 0.28) * climb * climb;
      let width = mix(0.21, 0.34, seed.w) * (0.79 + 0.17 * activity + 0.16 * dominant);
      var stem = cloudEllipsoid(vec3<f32>(delta.x - lean.x, altitude, delta.y - lean.y),
        vec3<f32>(0.0, bottom + halfHeight, 0.0),
        vec3<f32>(width * 1.03, halfHeight, width * 0.87));
      if (towerSurge > 0.025 && altitude > bottom + halfHeight * 0.79) {
        // Only a vigorous turret rises above the spreading anvil. Its axis
        // turns with height and joins the broad shoulder that supplied it.
        let turretBase = top - halfHeight * 0.83;
        let turretTop = min(0.96, ordinaryTop + towerSurge + 0.032);
        let turretHeight = (turretTop - turretBase) * 0.5;
        let rising = smoothstep(turretBase, turretTop, altitude);
        let turretLean = vec2<f32>(0.09 - rising * 0.11, (seed.x - 0.5) * (0.11 + rising * 0.19));
        let turretCenter = vec3<f32>(turretLean.x, turretBase + turretHeight, turretLean.y);
        let turret = cloudEllipsoid(vec3<f32>(delta.x, altitude, delta.y), turretCenter,
          vec3<f32>(width * mix(0.43, 0.76, dominant), turretHeight, width * mix(0.50, 0.80, seed.y)));
        stem = cloudSoftUnion(stem, turret - (1.0 - dominant) * 0.27);
      }

      // A shorter feeder wraps into the main updraft. The clear air under
      // the lee canopy remains open all the way down to this lower branch.
      let branchSide = select(-1.0, 1.0, seed.x >= 0.5);
      let feeder = cloudEllipsoid(vec3<f32>(delta.x, altitude, delta.y),
        vec3<f32>(-width * 0.63 + 0.063 * climb, bottom + halfHeight * 0.70, branchSide * width * 0.49),
        vec3<f32>(width * 1.12, halfHeight * 0.81, width * 0.72));
      // A second roll turns under the updraft, opposite the feeder.
      // The broad, low-frequency warp puts air between the lower shoulders
      // while their higher cores still merge into the same rising cloud.
      let lowerCenter = vec3<f32>(width * (0.44 + basalRoll * 0.39), bottom + halfHeight * (0.48 + seed.x * 0.29),
        -branchSide * width * (0.46 + seed.w * 0.18));
      let lowerRoll = cloudEllipsoid(vec3<f32>(delta.x, altitude, delta.y), lowerCenter,
        vec3<f32>(width * 0.86, halfHeight * 0.78, width * 0.68));
      let pairedShoulders = cloudSoftUnion(stem, lowerRoll + basalRoll * 0.26 - 0.11);
      let overlap = cloudSoftUnion(pairedShoulders, feeder - 0.09);
      let lowerFold = dot(rolls.ar - 0.5, vec2<f32>(0.58, 0.42)) * 0.32;
      let stemMass = overlap + lobes * 1.18 + lowerFold * belowShoulder;
      var outflowMass = -0.42;
      if (altitude > 0.46 * feederFraction && maturity > 0.41) {
        let downwind = max(delta.x - 0.18, 0.0);
        let roof = top + towerSurge * 0.21
          + (-0.105 - downwind * mix(0.13, 0.23, seed.w) + (rolls.a - 0.5) * 0.086) * feederFraction;
        let depth = (mix(0.082, 0.132, maturity) - downwind * 0.064) * feederFraction;
        let fanCenter = vec3<f32>(0.27 + width * 0.51 + dominant * 0.04, roof,
          lean.y * 0.82 + downwind * (seed.y - 0.5) * 0.33);
        let fanRadius = vec3<f32>(width * (mix(1.19, 1.95, maturity) + 0.28 * dominant),
          max(depth, 0.040 * feederFraction), width * mix(0.84, 1.22, seed.y));
        let fanPosition = vec3<f32>(delta.x, altitude, delta.y);
        let fan = cloudEllipsoid(fanPosition, fanCenter, fanRadius);
        // A curl hangs under one shoulder. On its other side a wider,
        // slanting pocket opens into the lee, leaving the canopy roof intact.
        let fold = dot(rolls.ag - 0.5, vec2<f32>(0.64, 0.36));
        let lipCenter = fanCenter + fanRadius * vec3<f32>(-0.21 + fold * 0.39,
          -0.55 + fold * 0.54, branchSide * (0.43 + fold * 0.31));
        let lipRadius = fanRadius * vec3<f32>(mix(0.44, 0.67, seed.x),
          mix(0.63, 0.91, maturity), 0.55);
        let lip = cloudEllipsoid(fanPosition, lipCenter, lipRadius);
        let hollowCenter = fanCenter + fanRadius * vec3<f32>(0.37 + fold * 0.43, -0.96,
          branchSide * (-0.22 + downwind * 0.50 + fold * 0.26));
        let hollow = cloudEllipsoid(fanPosition, hollowCenter,
          fanRadius * vec3<f32>(0.81, mix(0.66, 0.94, seed.w), 0.46));
        let rolled = cloudSoftUnion(fan, lip + lobes * 0.24 - 0.10);
        let recess = smoothstep(-0.30, 0.67, hollow + (rolls.g - 0.5) * 0.34);
        let thinning = smoothstep(0.58, 1.11, delta.x) * maturity;
        outflowMass = rolled - recess * 0.83 + lobes * 0.94 - (1.0 - maturity) * 0.31 - thinning * 0.24;

        // Ice leaves the mature canopy in two thinner layers. Their crosswind
        // drift and fall speeds differ, leaving clear air between strands.
        let iceFeed = smoothstep(0.52, 0.83, maturity) * smoothstep(0.20, 0.66, activity);
        let peelFrom = fanCenter.x + fanRadius.x * 0.42;
        let extent = width * (2.38 + 0.63 * dominant + 0.28 * seed.x);
        let run = (delta.x - peelFrom) / extent;
        if (iceFeed > 0.025 && run > -0.18 && run < 1.0
          && abs(altitude - roof) < 0.23 * feederFraction) {
          let age = saturate(run);
          let stream = vec3<f32>(q.x * 0.36, q.y * 0.92 - q.x * 0.09, q.z * 1.29 + q.y * 0.31);
          let streamUV = stream * scale + vec3<f32>(0.19, 0.76, 0.23) + (rolls.rag - 0.5) * 0.15;
          let streamLod = max(log2(max(texels * 1.29, 1.0)), 0.0);
          let fibers = textureSampleLevel(shape3D, sampShape, streamUV, streamLod);
          let acrossFlow = (delta.y - fanCenter.z) / fanRadius.z;
          let meander = (fibers.a - 0.5) * 0.51 + (seed.x - 0.5) * age * age;
          let veil = smoothstep(0.34, 0.69, dot(fibers.rgb, vec3<f32>(0.35, 0.46, 0.19)));
          let slits = smoothstep(0.39, 0.70, fibers.g * 0.68 + fibers.a * 0.32);
          let spread = mix(0.68, 1.02, age);
          let upperCross = 1.0 - smoothstep(0.22, spread, abs(acrossFlow - meander - branchSide * (0.10 + 0.52 * age)));
          let lowerCross = 1.0 - smoothstep(0.14, spread * 0.69, abs(acrossFlow - meander + branchSide * (0.36 + 0.55 * age)));
          let upperHeight = roof + ((fibers.r - 0.5) * 0.063 + age * 0.097) * feederFraction;
          let lowerHeight = roof - (0.061 + 0.070 * age + (fibers.a - 0.5) * 0.039) * feederFraction;
          let thickness = mix(0.043, 0.021, age) * feederFraction;
          let upperLayer = 1.0 - smoothstep(thickness * 0.19, thickness, abs(altitude - upperHeight));
          let lowerLayer = 1.0 - smoothstep(thickness * 0.12, thickness * 0.67, abs(altitude - lowerHeight));
          let tail = smoothstep(-0.18, 0.27, run) * (1.0 - smoothstep(0.63, 1.0, run));
          let iceBands = upperLayer * upperCross * veil + lowerLayer * lowerCross * slits * 0.74;
          ice = max(ice, iceBands * tail * iceFeed);
        }
      }
      let body = cloudSoftUnion(stemMass, outflowMass) - (1.0 - activity) * 0.48;
      storm = max(storm, body);
    }
  }
  // Apply local humidity to the edge without stamping every small feature
  // of the horizontal weather map through the full height of the updraft.
  let mass = storm * 0.47 + NTransform.shapeBias * 0.50 - dryEdge * 0.38;
  let skin = 1.0 - smoothstep(0.035, 0.21, abs(mass));
  let foldedSurface = dot(folds.rgb, vec3<f32>(0.22, 0.53, 0.25));
  let underside = 1.0 - smoothstep(0.29, 0.73, feederPhase);
  let rollBreaks = smoothstep(0.30, 0.68, dot(rolls.ra, vec2<f32>(0.58, 0.42)));
  let foldAmplitude = mix(0.062, 0.116, rollBreaks) + underside * 0.033;
  let basalRelief = (smoothstep(0.29, 0.71, foldedSurface) - 0.5) * foldAmplitude;
  let fringe = (dot(folds.rgb - 0.5, vec3<f32>(0.06, 0.12, 0.09)) + basalRelief) * skin;
  // Mid-sized folds live in the shadow field too. Keep the center solid
  // while letting adjacent rolls cast coherent shadows onto the same folds.
  let iceDensity = ice * mix(0.27, 0.08, dryEdge);
  return vec3<f32>(mass + fringe, mass + fringe * 0.76, iceDensity);
}

fn localPlanetConvectiveForm() -> bool {
  return isLocalPlanetCloud(flatFormType()) && localConvectiveForm(localPlanetForm(flatFormType()));
}

fn localPlanetAnvilForm() -> bool {
  return isLocalPlanetCloud(flatFormType()) && isAnvilCloud(localPlanetForm(flatFormType()));
}

fn localPlanetDensityProfile(signedShape: vec2<f32>, envelope: f32, coverage: f32, ice: f32,
    softEdge: f32) -> vec3<f32> {
  let presence = smoothstep(0.025, 0.24, coverage);
  let edge = mix(0.12, 0.045, cloudDefinition01());
  let body = smoothstep(-softEdge, edge + softEdge, signedShape.x);
  let bodyShadow = smoothstep(-softEdge, edge * 1.15 + softEdge, signedShape.y);
  let volume = mix(body * envelope, 1.0, ice) * presence;
  let shadow = mix(bodyShadow * envelope, 1.0, ice * 0.64) * presence;
  let shape = mix(signedShape.x, max(signedShape.x, ice * 0.49 - 0.038), smoothstep(0.0, 0.04, ice));
  return vec3<f32>(volume, shadow, clamp(shape * TUNE.puffScale * 0.55, -0.30, 2.0));
}

fn capturedPlanetVolume() -> bool {
  if (CLOUD_FLAT_TOWER_FORM > 0.0) { return CLOUD_FLAT_TOWER_PROJECTED != 0u; }
  return FIELD.regionWeather.x > 0.0 && FIELD.regionMotion.x > 0.0;
}

fn capturedCloudPosition(tangent: vec3<f32>, radius: f32) -> vec3<f32> {
  // The radius is already known. Rotate the unit direction before
  // restoring it, avoiding a second normalization of the shell position.
  let direction = normalize(tangent);
  let rotation = FIELD.regionRotation;
  var drifted = vec3<f32>(
    direction.x * rotation.x - direction.z * rotation.y, direction.y,
    direction.x * rotation.y + direction.z * rotation.x);
  if (FIELD.regionMotion.w > 0.0 && FIELD.regionWarp.x != 0.0) {
    drifted = planetPreparedEddies(drifted, FIELD.regionEddies);
  }
  let point = drifted * radius;
  return vec3<f32>(point.x, rotation.z * point.y - rotation.w * point.z,
    rotation.w * point.y + rotation.z * point.z);
}

fn capturedRadialPhase(p: vec3<f32>, offset: vec2<f32>) -> f32 {
  // Avoid subtracting planet-sized radii to measure a thin layer's height.
  let radialLift = dot(p.xz, offset) / (1.0 + sqrt(1.0 + dot(offset, offset)));
  return (p.y + radialLift - FIELD.regionWarp.z) * FIELD.regionWarp.w;
}

fn capturedPlanetCloudBody(p: vec3<f32>, flatPhase: f32, form: f32, coverage: f32,
    spacing: vec3<f32>, fullyResolved: bool) -> vec3<f32> {
  var ph = flatPhase;
  var offset = p.xz * FIELD.regionUp.w;
  var feather = 1.0;
  var verticalScale = 1.0 / FIELD.gridSize.y;
  if (FIELD.regionWarp.w > 0.0) {
    let axialRadius = FIELD.regionWarp.y + p.y;
    if (axialRadius <= 0.0) { return vec3<f32>(0.0); }
    offset = p.xz / axialRadius;
    verticalScale = FIELD.regionWarp.w;
    ph = capturedRadialPhase(p, offset);
    if (ph <= 0.0 || ph >= 1.0) { return vec3<f32>(0.0); }
    feather = localPlanetVerticalFeather(ph);
  }
  let weatherUV = select(p.xz / FIELD.regionWeather.x,
    offset / (FIELD.regionWeather.x * FIELD.regionUp.w), FIELD.regionWarp.w > 0.0);
  let weather = capturedWeather(weatherUV + 0.5);
  if (fullyResolved && usesRibbonWeatherOpening(form)) {
    // The opening bounds the signed form. The fringe can add at most .0375.
    if (ribbonWeatherOpening(weather, coverage) <= -.056) { return vec3<f32>(0.0); }
    let layer = ribbonWeatherLayer(weather, form);
    // The normalized shape channel moves the envelope by at most half its
    // variation. Outside that range its density multiplier is exactly zero.
    if (abs(ph - layer.x) > layer.y + RIBBON_CENTER_VARIATION * .5 + .00001) {
      return vec3<f32>(0.0);
    }
  }
  if (CLOUD_FLAT_TOWER_PROJECTED != 0u && fullyResolved) {
    // The earliest base and highest shelf use opposite extrema of the shared
    // tower envelope. Outside that interval no 3D noise can produce a cloud.
    let heights = convectiveTowerHeights(weather, vec4<f32>(0.0, 1.0, 1.0, 0.0));
    if (ph <= heights.x || ph >= heights.y || coverage <= 0.0) { return vec3<f32>(0.0); }
    let rise = smoothstep(.17, .92, ph);
    let updraft = convectiveTowerUpdraft(ph, heights);
    // The tower shape channels are at most one, so .43 bounds the lobe.
    // On the negative side, the strongest fringe is monotone with the mass.
    // Leave room for the separate fray texture before rejecting the sample.
    let maxMass = convectiveTowerMass(weather, coverage, abs(form - 2.25) < .004, rise, updraft, .43);
    if (maxMass <= -.056 && cellularCloudFringe(maxMass, 1.0, .33 + .30 * rise) <= -.056) {
      return vec3<f32>(0.0);
    }
  }
  let planetRadius = FIELD.regionMotion.x;
  let tangent = FIELD.regionUp.xyz + FIELD.regionEast.xyz * offset.x + FIELD.regionSouth.xyz * offset.y;
  let radius = planetRadius + mix(FIELD.regionEast.w, FIELD.regionSouth.w, ph);
  let scale = FIELD.regionShape.w;
  let base = capturedCloudPosition(tangent, radius) * FIELD.regionShape.xyz * scale;
  let phase = FIELD.regionWeather.y + NTransform.shapeOffsetWorld.y * .24;
  let uv = planetEvolvingDomain(planetWeatherShapeDomain(base, weather, ph, form, planetRadius / radius), phase);
  let rate = max(FIELD.regionUp.w * radius, abs(FIELD.regionSouth.w - FIELD.regionEast.w) * verticalScale);
  let footprint = max(spacing.x, max(spacing.y, spacing.z)) * rate * abs(scale);
  let lod = log2(max(1.0, footprint * f32(textureDimensions(shape3D).x)));
  let source = evolvePlanetCloudShape(textureSampleLevel(shape3D, sampShape, uv, lod), phase, form);
  let body = planetWeatherVolumeForm(ph, weather, source, coverage, form, phase);

  // Reuse the source volume at the same spherical coordinates. A second
  // band only frays exposed surfaces at local scale.
  let presence = body.y * smoothstep(0.0, .10, coverage) * feather;
  let edge = 1.0 - smoothstep(.044, .16, abs(body.x));
  let fineDetail = 1.0 - smoothstep(.82, 2.0, lod);
  let transition = select(.085, .14, form == 2.0 || form == 2.125);
  var fray = 0.0;
  if (presence != 0.0 && edge > 0.0 && fineDetail > 0.0) {
    // The normalized detail channel moves the signed shape by at most half its amplitude.
    // Inside saturated or empty regions the density is independent of grain.
    let maxFray = .03751 * edge * fineDetail;
    if (body.x + maxFray > -.018 && body.x - maxFray < transition) {
      let grain = textureSampleLevel(shape3D, sampShape, uv * 3.1 + vec3<f32>(.47, .19, .62), lod + 1.65).b;
      fray = (grain - .5) * edge * .075 * fineDetail;
    }
  }
  let density = smoothstep(-.018, transition, body.x + fray) * presence;
  let shadow = smoothstep(-.018, transition, body.x) * presence;
  return vec3<f32>(density, shadow, clamp(body.x * TUNE.puffScale * .55, -.30, 2.0));
}

fn localPlanetWeatherBody(p: vec3<f32>, ph: f32, form: f32, weather: vec4<f32>, coverage: f32,
    spacing: vec3<f32>) -> vec3<f32> {
  let shape = localPlanetShape(p, ph, form, weather, spacing);
  let geometry = planetWeatherVolumeForm(ph, weather, shape, coverage, form, NTransform.shapeOffsetWorld.y);
  let envelope = saturate(geometry.y);
  var formDistance = geometry.x;
  var presence = envelope;
  if (form == 4.0) {
    // The globe-wide threshold can leave a small local box entirely dry.
    // Place well-separated puffs and let the 3D noise shape each silhouette.
    let q = (p.xz - B.center.xz + NTransform.weatherOffsetWorld.xz) / max(TUNE.puffScale, .75);
    let drift = (shape.ga - .5) * vec2<f32>(.54, .68) + (ph - .44) * vec2<f32>(.22, -.28);
    let first = length((q + drift - vec2<f32>(-.70, -.64)) / vec2<f32>(.62, .77));
    let second = length((q + drift - vec2<f32>(.90, -1.35)) / vec2<f32>(.49, .68));
    let third = length((q + drift - vec2<f32>(.18, -2.28)) / vec2<f32>(.43, .50));
    let outline = min(first, min(second, third));
    let rise = (ph - .43 - (shape.a - .5) * .25) / .43;
    let billow = dot(shape.rgb - .5, vec3<f32>(.22, .47, .31));
    let profile = outline * outline + rise * rise;
    let loft = (shape.g - .5) * .22 * smoothstep(.35, .70, ph);
    formDistance = (mix(.31, 1.56, coverage) - profile) * .32 + billow * .81 + loft;
    presence = 1.0 - smoothstep(.63, 1.06, abs(rise));
  } else if (isBigBlob(form) || form == 2.0) {
    let blob = isBigBlob(form);
    let shoulder = dot(shape.rgb, vec3<f32>(.19, .54, .27));
    let center = .42 + (shape.a - .5) * .23 + (weather.b - .5) * .13;
    let height = (ph - center) / select(.37, .45, blob);
    let folds = (shape.b - shape.r) * .20;
    let lobe = shoulder + folds - mix(.73, .24, coverage) - height * height * .41;
    var opening = (localPlanetWeatherPatch(p, weather, .30, vec2<f32>(.92, 1.13))
      - mix(.71, .43, coverage)) * 1.46;
    if (blob) {
      // One cloud with an off-centre crown and smaller connected shoulders.
      let q = (p.xz - B.center.xz + NTransform.weatherOffsetWorld.xz) / max(TUNE.puffScale, .75);
      let bent = rotateXZ(q + vec2<f32>(.12, .53), -.29);
      let crown = length((bent + vec2<f32>(-.23, .13)) / vec2<f32>(.83, 1.07));
      let shoulderRadius = length((bent + vec2<f32>(.51, -.13)) / vec2<f32>(.60, .74));
      let outline = min(crown, shoulderRadius) + (shape.a - .5) * .38 + (shoulder - .5) * .51;
      opening = (mix(.49, 1.31, coverage) - outline) * .54;
      presence = max(envelope, 1.0 - smoothstep(.68, 1.06, abs(height)));
    } else {
      let slot = localPlanetWeatherPatch(p, weather, .51, vec2<f32>(1.31, .89));
      opening += min(slot - mix(.65, .30, coverage) + folds, 0.0) * .46;
    }
    let seam = max(.105 - abs(lobe - opening), 0.0) / .105;
    formDistance = min(max(formDistance, lobe), opening) - seam * seam * .021;
  } else if (form == 2.42 || isPlanetFront(form) || isEmberstorm(form)) {
    let front = isPlanetFront(form);
    let ember = isEmberstorm(form);
    let site = localPlanetWeatherPatch(p, weather, select(.45, .29, front || ember),
      select(vec2<f32>(1.0), vec2<f32>(.54, 1.49), front || ember));
    let threshold = mix(select(.69, .78, ember), select(select(.39, .45, front), .38, ember), coverage);
    var lane = (site - threshold) * 1.85;
    let scallops = dot(shape.rgb - .5, vec3<f32>(.16, .34, .32));
    var crest = formDistance + select(.045, .025, front) + scallops * .65;
    if (form == 2.42) {
      let q = (p.xz - B.center.xz + NTransform.weatherOffsetWorld.xz) / max(TUNE.puffScale, .75);
      let nearCells = localPlanetWeatherPatch(p, weather, .67, vec2<f32>(1.0, 1.09));
      let lobes = (shape.ga - .5) * vec2<f32>(.69, .51);
      let bank = length((q + vec2<f32>(1.15, .47) + lobes) / vec2<f32>(1.25, 1.7));
      let scattered = max(nearCells - .45, (.83 - bank) * .52);
      let rise = (ph - .43 - (shape.a - .5) * .23 - scattered * .28) / .46;
      let puff = dot(shape.rgb, vec3<f32>(.20, .53, .27))
        - mix(.80, .32, coverage) - rise * rise * .47;
      crest = mix(crest + .008, puff, .78);
      lane = min(max(lane, (.77 - bank) * .71), scattered * 1.26);
      presence = max(envelope, 1.0 - smoothstep(.66, 1.12, abs(rise)));
    }
    if (front || ember) {
      // Alternating bands of moist air and a dry intrusion wind between
      // the deeper cells. The intrusion survives a long grazing ray.
      let q = (p.xz - B.center.xz + NTransform.weatherOffsetWorld.xz) / max(TUNE.puffScale, .75);
      let wind = rotateXZ(q, select(-.45, .54, ember));
      let meander = smoothCellHash2D(vec2<f32>(wind.y * 1.4, 4.8), .38) - .5;
      let lean = (ph - .34) * (.44 + meander);
      let curl = (shape.g - .5) * .44 + (shape.a - .5) * .26;
      let drySlot = abs(wind.x + select(.52, -.27, ember) + meander * 1.48 + lean + curl);
      let intrusion = (drySlot - mix(.91, .25, coverage) + scallops * .36) * .53;
      lane = min(lane, intrusion);
    }
    let seam = max(.10 - abs(crest - lane), 0.0) / .10;
    formDistance = min(crest, lane) - seam * seam * .025;
  } else if (form == 2.58 || form == 2.59) {
    // At eye level the silhouette is viewed side-on, through a short path.
    // Leave enough optical depth in the bent stems and let the cross-cut
    // band show through them. The Planet weather channel still opens gaps.
    let ribbon = form == 2.58;
    let strands = dot(shape.rgb, select(vec3<f32>(0.04, 0.62, 0.34), vec3<f32>(0.06, 0.79, 0.15), ribbon));
    let edge = mix(select(0.55, 0.61, ribbon), select(0.12, 0.21, ribbon), coverage);
    let center = strands - edge - (1.0 - envelope) * select(0.64, 0.57, ribbon);
    let opening = (weather.a - mix(0.53, 0.075, coverage)) * 0.72
      + (strands - 0.50) * 0.22 + select(0.13, 0.059, ribbon);
    // Soften the intersection with the regional clearing. Sharp intersections
    // leave angular seams where two otherwise smooth banks overlap.
    let smoothCut = max(0.066 - abs(center - opening), 0.0) / 0.066;
    formDistance = max(formDistance, min(center, opening) - smoothCut * smoothCut * 0.0165);
  } else if (form == 2.50) {
    // The deck has low, broken rolls. Give the smaller shoulder band an
    // independent density range, so the base does not become a white sheet.
    let rolls = dot(shape.rgb, vec3<f32>(0.27, 0.49, 0.24));
    let edge = mix(0.67, 0.16, coverage);
    let ceiling = rolls - edge - (1.0 - envelope) * 0.63 + (weather.r - 0.5) * 0.13;
    let opening = (weather.a - mix(0.53, 0.09, coverage)) * 0.84
      + (rolls - 0.46) * 0.24 + (shape.a - 0.49) * 0.28 + 0.093;
    formDistance = max(formDistance, min(ceiling, opening));
  }
  let skin = 1.0 - smoothstep(0.012, 0.16, abs(formDistance));
  // Erode the edge with bands from the same sculpted flow. Large interiors
  // remain coherent and thin filaments stay translucent through their width.
  var grain = 0.62 * shape.b + 0.38 * shape.g;
  if (skin > 0.001) {
    let erosionRate = abs(axisOrOne3(NTransform.detailAxisScale)) *
      (0.40 * max(abs(NTransform.detailScale), 0.05) / max(TUNE.puffScale, 0.75));
    let footprint = spacing * erosionRate * vec3<f32>(textureDimensions(detail3D));
    let lod = log2(max(max(footprint.x, max(footprint.y, footprint.z)), 1.0));
    let detail = textureSampleLevel(detail3D, sampDetail,
      (p + NTransform.detailOffsetWorld) * erosionRate, lod).rgb;
    grain = mix(grain, dot(detail, vec3<f32>(0.42, 0.34, 0.24)), 0.42);
  }
  let erosionStrength = planetCloudErosionStrength(weather, form);
  let erosion = smoothstep(0.30, 0.76, grain) * skin * mix(0.022, 0.061, cloudDefinition01())
    * select(erosionStrength, max(erosionStrength, .85), isBigBlob(form) || form == 2.0);
  let threshold = select(0.0, 0.022, localPlanetFilament(form));
  let signedShape = formDistance - vec2<f32>(erosion, erosion * 0.54) - threshold;
  let softness = select(0.011, 0.024, localPlanetFilament(form));
  return localPlanetDensityProfile(signedShape, presence, coverage, 0.0, softness);
}

fn localPlanetCloudBody(p: vec3<f32>, ph: f32, spacing: vec3<f32>) -> vec3<f32> {
  let form = localPlanetForm(TUNE.formType);
  let coverage = saturate(C.globalCoverage);
  if (capturedPlanetVolume()) {
    return capturedPlanetCloudBody(p, ph, form, coverage, spacing, false);
  }
  let weather = localPlanetWeather(p);
  let footprint = max(max(spacing.x, spacing.y), spacing.z);
  if (isAnvilCloud(form)) {
    let storm = localAnvilStorm(p, ph, weather, coverage, footprint);
    return localPlanetDensityProfile(storm.xy, 1.0, coverage, storm.z, 0.0);
  }
  if (!localConvectiveForm(form)) {
    return localPlanetWeatherBody(p, ph, form, weather, coverage, spacing);
  }
  let bank = localConvectiveBank(p, ph, weather, coverage, form, footprint, false);
  return localPlanetDensityProfile(bank, 1.0, coverage, 0.0, 0.0);
}

fn localPlanetVerticalFeather(ph: f32) -> f32 {
  return smoothstep(.005, .065, ph) * (1.0 - smoothstep(.94, 1.0, ph));
}

fn localPlanetDensityScale(uv: vec3<f32>) -> f32 {
  let curved = FIELD.regionWarp.w > 0.0;
  let feather = select(localPlanetVerticalFeather(uv.y), 1.0, curved);
  let inverseThickness = select(1.0 / FIELD.gridSize.y, FIELD.regionWarp.w, curved);
  let border = min(min(uv.x, 1.0 - uv.x) * FIELD.gridSize.x, min(uv.z, 1.0 - uv.z) * FIELD.gridSize.z);
  let fadeWidth = select(TUNE.puffScale * .55, FIELD.gridSize.x * .12, FIELD.regionWeather.x > 0.0);
  // Planet measures extinction across its shell. In Flat that same
  // shell can span many more world units, particularly for a small tile.
  let extinctionScale = select(1.6,
    .34 * inverseThickness / max(VIEW_EXTINCTION_SCALE, EPS * inverseThickness), capturedPlanetVolume());
  return max(C.globalDensity, 0.0) * extinctionScale * feather * smoothstep(0.0, max(fadeWidth, .1), border);
}

fn marineCumulusForm() -> bool {
  return flatFormType() > 1.0 && flatFormType() < 1.5;
}

// Return fine density, macro density and signed form independently. Coverage
// activates growing billows from the base upward, never rescales tower height.
// Cell identity, weather and shape noise travel together with horizontal wind.
// Only the rounded presets use this field; the original layer is untouched.
fn roundedCloudBody(p: vec3<f32>, shape: vec4<f32>, detail: vec3<f32>) -> vec3<f32> {
  let cellSize = max(TUNE.puffScale, 0.75);
  let windOffset = NTransform.shapeOffsetWorld.xz;
  let cell = floor((p.xz + windOffset) / cellSize);
  let stormSystem = TUNE.formType >= 2.5;
  let layerHeight = FIELD.gridSize.y;
  var body = -1.0;
  var fine = 0.0;
  var macroAmount = 0.0;
  // Rain Shelf's useful structure comes from remapping the base against its
  // other three shape bands, not from adding noise to a filled primitive's skin.
  // Keep that small density closure in this entrypoint, outside the cell loop;
  // do not pull the legacy ray/light call graph into the field compiler.
  let definition = cloudDefinition01();
  let fbm = dot(shape.gba, vec3<f32>(0.625, 0.25, 0.125));
  let baseShape = contrast01(shape.r, 1.24 + definition * 0.38);
  let shelfShape = saturate((baseShape - fbm * 0.72) / max(1.0 - fbm * 0.72, 0.08));
  let detailMid = dot(detail, vec3<f32>(0.42, 0.34, 0.24));
  let scallopSignal = mix_f(max(max(detail.r, detail.g), detail.b),
    1.0 - min(min(detail.r, detail.g), detail.b), 0.42);
  let valley = pow(1.0 - ridge01(contrast01(scallopSignal, 2.4)), 1.35);
  // Noise shapes the entire volume, but fine erosion must not turn a mature
  // thunderhead into disconnected translucent vapor. A noisy interior support
  // below preserves bulk while the same breakup still defines its outer folds.
  let structure = (shelfShape - 0.22) * 0.55 + (fbm - 0.5) * 0.20;
  let erosion = (detailMid * 0.10 + valley * mix_f(0.08, 0.18, definition));
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let id = cell + vec2<f32>(f32(x), f32(z));
      let r0 = cloudCellRandom(id, 3.1);
      let r1 = cloudCellRandom(id, 17.3);
      let r2 = cloudCellRandom(id, 41.7);
      let materialCenterXZ = (id + 0.5 + (vec2<f32>(r0, r1) - 0.5) * 0.42) * cellSize;
      let centerXZ = materialCenterXZ - windOffset;
      let weatherScale = select(NTransform.weatherScale, 1.0, NTransform.weatherScale == 0.0);
      // Sample weather in the co-moving domain, not underneath a stationary
      // lattice. Its separate slow offset can evolve cells without wind itself
      // pumping their height. Anatomy is selected independently below.
      let weather = wrap2D(weather2D, samp2D, fieldWeatherUV(vec3<f32>(materialCenterXZ.x, B.center.y, materialCenterXZ.y), weatherScale), 0i, 0.0);
      // A storm scene is a population, not a wall of identical thunderheads.
      // Stable material-cell identity selects scattered convective storms;
      // the remaining cells form lower fair-weather cumulus in the same box.
      // Selection travels with wind and does not toggle as weather evolves.
      // Never compare the identity seed with moving weather: that replaced
      // small cumulus with a full thunderhead in one frame at the threshold.
      // Weather controls continuous development, not this cell's anatomy.
      let stormCell = cloudCellRandom(id, 237.9) < 0.27;
      let anvil = select(C.cloudAnvilAmount > 0.65, stormCell, stormSystem);
      let convective = anvil || (TUNE.formType >= 1.5 && TUNE.formType < 2.5);
      // Material-cell variation survives wind and weather transitions. Rotate
      // the anatomy, not the noise, so adjacent storms have different outflow
      // directions without seams or another texture lookup per lobe.
      let variant = cloudCellRandom(id, 312.7);
      // Independent width seed: broad storms need not share noise/lean variants.
      // 30% have a full broad base; another 28% span intermediate widths.
      let widthVariant = cloudCellRandom(id, 383.1);
      let broadBase = select(0.0, 1.0 - smoothstep(0.30,0.58,widthVariant), convective);
      let aspect = select(1.0, mix_f(0.85, 1.15, variant), convective);
      let turn = cloudCellRandom(id, 329.1) * 6.283185;
      let cs = cos(turn); let sn = sin(turn);
      let relative = p.xz - centerXZ;
      let anatomyP = select(p, vec3<f32>(centerXZ.x + (relative.x * cs + relative.y * sn) / aspect,
        p.y, centerXZ.y + (-relative.x * sn + relative.y * cs) * aspect), convective);
      let shear = select(vec2<f32>(0.0), (vec2<f32>(r1, variant) - 0.5) * cellSize * mix_f(0.29, 0.40, r0) * 0.30, convective);
      let cellBands = mix(shape.gba, shape.abg, select(0.0, variant, convective));
      let cellFbm = dot(cellBands, vec3<f32>(0.625, 0.25, 0.125));
      let cellBase = contrast01(mix_f(shape.r, shape.g, select(0.0, variant * 0.22, convective)), 1.24 + definition * 0.38);
      let cellShelf = saturate((cellBase - cellFbm * 0.72) / max(1.0 - cellFbm * 0.72, 0.08));
      let cellStructure = select(structure, (cellShelf - 0.22) * mix_f(0.49, 0.67, variant) + (cellFbm - 0.5) * 0.20, convective);
      let coverage = clamp(C.globalCoverage * mix_f(0.78, 1.0, saturate(weather.r)) * mix_f(1.0, 0.72, saturate(TUNE.sparsity)), 0.0, 1.0);
      let weatherMaturity = smoothstep(r2 - 0.38, r2 + 0.38, coverage);
      // Cycle storms develop upper billows, never stretch the whole column.
      let stormDevelopment = smoothstep(0.08, 1.0, C.cloudAnvilAmount);
      let maturity = select(weatherMaturity, mix_f(min(weatherMaturity, 0.28), weatherMaturity, stormDevelopment), TUNE.formType > 3.5 && stormCell);
      // Include noisy/scalloped lobes in the neighborhood bound, not just the
      // hidden ellipsoids. With center jitter <= .21 cells, this 1.28-cell
      // support ends before a center can drop out of the 3x3 search (.21+1.28<1.5).
      let footprintFade = select(1.0, 1.0 - smoothstep(cellSize * 1.12, cellSize * 1.28,
        max(abs(relative.x),abs(relative.y))), convective);
      let presence = maturity * footprintFade * smoothstep(0.0, 0.12, C.globalCoverage) * (1.0 - smoothstep(0.85, 1.0, weather.b));
      if (presence <= 0.00001) { continue; }
      let heightVariation = clamp(TUNE.towerHeightVariation, 0.0, 0.9);
      let heightFraction = mix_f(0.93, 0.93 - heightVariation, r1);
      // Weather-organized storm families share feeder banks, not a regiment of
      // equally tall stalks. Cell-local height/width remain stable under wind.
      let stormHeight = mix_f(0.52, 1.0, cloudCellRandom(id, 347.3));
      let columnHeight = layerHeight * heightFraction * select(1.0, stormHeight, anvil) * mix_f(1.0, 0.85, broadBase)
        * select(1.0, mix_f(0.22, 0.54, r0), stormSystem && !stormCell);
      let base = FIELD.gridMin.y + layerHeight * 0.07;
      let radiusXZ = cellSize * mix_f(0.29, select(0.43, 0.40, anvil), r0)
        * select(1.0, mix_f(0.68, 1.35, cloudCellRandom(id, 361.7)), convective);
      // The existing per-voxel edge fade lets drifting cells enter/leave the
      // volume smoothly. Rejecting whole centers here would make them pop.
      let coreGrowth = max(0.03, sqrt(smoothstep(0.0, 0.65, maturity)));
      let coreRadiusY = min(columnHeight * 0.22, radiusXZ * mix_f(0.80,0.66,broadBase));
      let coreY = base + coreRadiusY * coreGrowth;
      let coreCenter = vec3<f32>(centerXZ.x, coreY, centerXZ.y);
      // No clamped-Y extrusion: that made a dense straight stalk beneath a cap.
      // Base breadth is independent of the crown: broad storm decks feed a
      // rising neck alongside slimmer columns, rather than scaling an entire
      // cloud up/down. Broad footprints remain inside the 3x3 cell search.
      var localBody = cloudEllipsoid(anatomyP, coreCenter, vec3<f32>(radiusXZ * mix_f(1.14,1.95,broadBase), coreRadiusY, radiusXZ * mix_f(0.98,1.75,broadBase)) * coreGrowth);
      var localForm = localBody;
      // Three staggered tiers of billows wrap the whole body, including its
      // underside. The wide lower shoulders connect to the upper cauliflower.
      for (var lobe = 0; lobe < 9; lobe++) {
        let seed = f32(lobe) * 19.71 + 63.2;
        let a = cloudCellRandom(id, seed);
        let b = cloudCellRandom(id, seed + 7.9);
        let tier = f32(lobe / 3);
        let lobeAge = smoothstep(tier * 0.14, tier * 0.14 + 0.70, maturity);
        if (lobeAge <= 0.00001) { continue; }
        let puffGrowth = sqrt(lobeAge);
        let angle = f32(lobe % 3) * 2.0944 + tier * 1.12 + r0 * 6.28318;
        // Roll out of the connected parent mass, rather than materializing a
        // little sphere at its final detached position and expanding there.
        let lean = (vec2<f32>(r1, r2) - 0.5) * radiusXZ * tier * 0.65 + shear * tier;
        let offset = (vec2<f32>(cos(angle), sin(angle)) * radiusXZ * mix_f(0.52, 0.78, a) + lean) * puffGrowth;
        let lowerShoulder = 1.0 + broadBase * (1.0 - saturate(tier)) * 0.32;
        let fullHeadRadius = radiusXZ * mix_f(0.58, 0.82, b) * clamp(TUNE.fluffFactor / 4.0, 0.85, 1.15) * select(1.0, 0.86, anvil) * lowerShoulder;
        let headRadius = fullHeadRadius * puffGrowth;
        // Storm billows feed the canopy from below instead of growing rounded
        // turrets through it and hiding its flattened, spreading silhouette.
        let headY = base + columnHeight * (0.20 + tier * select(0.24, 0.215, anvil) + (a - 0.5) * 0.12);
        let fullRadiusY = min(fullHeadRadius * mix_f(0.94, 1.18, a), columnHeight * select(0.24, 0.16, anvil));
        let parentLift = fullRadiusY + columnHeight * 0.10 * tier;
        let head = vec3<f32>(centerXZ.x + offset.x, headY - parentLift * (1.0 - puffGrowth), centerXZ.y + offset.y);
        let radiusY = fullRadiusY * puffGrowth;
        // Newly born billows must gain density as well as radius; otherwise a
        // sub-voxel puff immediately has a fully opaque core and appears to pop.
        let lobeDensityLimit = mix_f(-0.12, 0.40, lobeAge);
        let lobeAspect = select(1.0, mix_f(0.74, 1.25, a), convective);
        let headForm = cloudEllipsoid(anatomyP, head, vec3<f32>(headRadius * lobeAspect, radiusY * select(1.0, mix_f(0.85, 1.18, b), convective), headRadius / lobeAspect));
        localForm = cloudSoftUnion(localForm, headForm);
        localBody = cloudSoftUnion(localBody, min(headForm, lobeDensityLimit));
        // Smaller attached buds give the large shoulders a cauliflower outline.
        // Their minimum radius stays above the field's horizontal texel size.
        let budRadius = max(fullHeadRadius * 0.55, min(FIELD.gridSize.x / f32(FIELD.dimensions.x) * 1.35, fullHeadRadius * 0.68)) * puffGrowth;
        let budOffset = vec2<f32>(offset.x - offset.y * (b - 0.5), offset.y + offset.x * (a - 0.5));
        let bud = head + vec3<f32>(budOffset.x * mix(0.17, 0.30, a),
          radiusY * select(mix(0.42, 0.70, b), mix(0.26, 0.43, b), anvil), budOffset.y * mix(0.20, 0.34, b));
        let budAspect = mix(0.81, 1.18, a);
        let budY = min(budRadius, columnHeight * select(0.17, 0.10, anvil) * puffGrowth);
        let budForm = cloudEllipsoid(anatomyP, bud, vec3<f32>(budRadius * budAspect, budY, budRadius / budAspect));
        localForm = cloudSoftUnion(localForm, budForm);
        localBody = cloudSoftUnion(localBody, min(budForm, lobeDensityLimit));
      }
      if (anvil && maturity > 0.40) {
        // The old late onset left most weather cells with only tiny caps. They
        // could never outspread the lower billows, even at the Anvil preset.
        let capGrowth = sqrt(smoothstep(0.40, 0.84, maturity));
        let capDensityLimit = mix_f(-0.12, 0.40, capGrowth * capGrowth);
        let spread = clamp(C.cloudAnvilAmount * max(TUNE.anvilLift, 0.0) / 0.60, 0.0, 1.5);
        let shoulder = vec3<f32>(centerXZ.x + radiusXZ * 0.15 + shear.x * 1.7, base + columnHeight * 0.72, centerXZ.y + shear.y * 1.7);
        let shoulderForm = cloudEllipsoid(anatomyP, shoulder, vec3<f32>(radiusXZ * 1.12, columnHeight * 0.16, radiusXZ * 1.08) * capGrowth);
        localForm = cloudSoftUnion(localForm, shoulderForm);
        localBody = cloudSoftUnion(localBody, min(shoulderForm, capDensityLimit));
        // A connected wind-spread fan, not one smooth UFO-shaped disk. Slightly
        // staggered lobes retain a broken edge as the cap spreads downwind.
        for (var fan = 0; fan < 5; fan++) {
          let f = f32(fan) / 4.0;
          let jitter = cloudCellRandom(id, 181.0 + f32(fan) * 7.3);
          // Broad and shallow at a common outflow level, with an asymmetric
          // downwind reach. Same noise closure/erosion as the body preserves
          // breakup throughout the canopy rather than adding a smooth disk.
          // Bound the footprint to the existing 3x3 neighborhood: no extra
          // field probes, loop iterations or raymarch work are introduced.
          let lateralSpread = saturate(spread / 1.15);
          let capCenter = vec3<f32>(centerXZ.x + shear.x * 1.7 + radiusXZ * mix_f(-0.55, mix_f(0.55, 0.85, variant), f) * lateralSpread,
            base + columnHeight * (mix_f(0.83, 0.87, variant) + (jitter - 0.5) * 0.045),
            centerXZ.y + shear.y * 1.7 + radiusXZ * (jitter - 0.5) * 0.42 * lateralSpread);
          let capRadius = vec3<f32>(radiusXZ * mix_f(0.55, mix_f(1.20, 1.60, f), lateralSpread),
            columnHeight * mix_f(0.095, 0.065, f) * mix_f(0.72, 1.34, r2), radiusXZ * mix_f(0.55, mix_f(1.30, 1.60, f), lateralSpread));
          let capForm = cloudEllipsoid(anatomyP, capCenter, capRadius * capGrowth);
          localForm = cloudSoftUnion(localForm, capForm);
          localBody = cloudSoftUnion(localBody, min(capForm, capDensityLimit));
        }
      }
      let macroSigned = localBody * 0.85 + cellStructure;
      let fineSigned = macroSigned - erosion;
      // Only developed, embedded material gets support. It follows the noisy
      // body and young-billow density limit, not a filled hidden ellipsoid;
      // growing lobes/edges remain tenuous and coverage zero stays empty.
      let interior = smoothstep(0.04, 0.42, localBody + cellStructure * 0.40 - erosion * 0.20)
        * smoothstep(0.20, 1.00, maturity);
      // Optical thickness belongs in the interior, not an image-space alpha
      // boost that would also turn faint edges and newborn puffs into cards.
      let coreDensity = interior * 2.0;
      let fineDensity = max(smoothstep(-0.025, 0.24, fineSigned), coreDensity);
      let macroDensity = max(smoothstep(-0.025, 0.24, macroSigned), coreDensity);
      let volumeVariation = mix_f(0.65, 1.0, shelfShape);
      fine = max(fine, presence * fineDensity * volumeVariation);
      macroAmount = max(macroAmount, presence * macroDensity * volumeVariation);
      // Opacity limits for young puffs must not flatten their shading normals.
      // Lighting follows the same noise-defined folds as density, not the
      // hidden ellipsoids. Preserve the unsaturated signed field for gradients.
      // Retain noisy folds without letting the smallest erosion valleys dominate
      // every lighting normal. Density/breakup is unchanged; broad shoulders
      // should carry coherent light and shade underneath the finer texture.
      body = max(body, localForm * 0.85 + cellStructure * 0.65 - erosion * 0.35 - (1.0 - presence) * 0.45);
    }
  }
  if (stormSystem) {
    // Broken, low feeder banks link some towers into larger storm complexes.
    // Already sampled shape bands supply the organization; no extra reads or
    // larger neighborhood are needed. Sparse coverage still opens real gaps.
    let center = FIELD.gridMin.y + layerHeight * (0.13 + fbm * 0.065);
    let band = 1.0 - abs(p.y-center) / max(layerHeight * 0.12, 0.30);
    let connected = min(band, shelfShape * 0.72 + fbm * 0.28 - mix_f(0.85, 0.34, saturate(C.globalCoverage)));
    let bank = smoothstep(-0.035, 0.22, connected - erosion * 0.45) * smoothstep(0.0, 0.12, C.globalCoverage);
    fine = max(fine, bank * 0.72);
    macroAmount = max(macroAmount, bank * 0.82);
    body = max(body, connected - erosion * 0.35);
  }
  return vec3<f32>(fine, macroAmount, body);
}

// A world-space distance lets small lobes join bigger ones without getting
// the same transition width as the parent. All three scales cast shadows.
// Feed the same stem, roof and outflow channels as Planet Clouds from cells
// on the flat weather plane. The density shader below shapes the volume.
fn marineConvectiveWeather(p: vec3<f32>, cover: f32, humidity: f32) -> vec4<f32> {
  let puff = max(TUNE.puffScale, 0.75);
  let rise = saturate((p.y - FIELD.gridMin.y) / FIELD.gridSize.y);
  let q = (p.xz + NTransform.shapeOffsetWorld.xz) / puff + vec2<f32>(-0.12, 0.052) * rise * rise;
  let cell = floor(q);
  let wind = vec2<f32>(0.91, -0.415);
  let across = vec2<f32>(-wind.y, wind.x);
  var stem = 0.0;
  var roof = 0.0;
  var anvil = 0.0;
  var base = 0.0;
  var weight = 0.0;
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let id = cell + vec2<f32>(f32(x), f32(z));
      let seed = vec3<f32>(cloudCellRandom(id, 3.1), cloudCellRandom(id, 17.3), cloudCellRandom(id, 41.7));
      let delta = q - (id + 0.5 + (seed.xy - 0.5) * 0.54);
      let activation = smoothstep(seed.z - 0.18, seed.z + 0.26, cover + (humidity - 0.5) * 0.30);
      let heightSeed = cloudCellRandom(id, 211.3);
      let maturity = 1.0 - 0.38 * smoothstep(0.32, 0.86, heightSeed);
      let amount = activation * maturity;
      if (amount < 0.001 || dot(delta, delta) > 2.1) { continue; }

      let curl = (seed.xy - 0.5) * (rise * (1.0 - rise) * 0.87);
      let tilt = vec2<f32>(heightSeed - 0.5, seed.z - 0.5) * smoothstep(0.16, 0.88, rise) * 0.54;
      let bend = curl + tilt;
      let along = dot(delta - bend, wind);
      let crosswind = abs(dot(delta - bend, across));
      let width = mix(0.37, 0.66, seed.x);
      // Towers widen above the condensation level and taper as they feed
      // their anvils. Vary the widest level with the cell's own height.
      let widest = mix(0.28, 0.54, seed.y);
      let shoulder = 1.0 - smoothstep(0.15, 0.48, abs(rise - widest));
      let coreWidth = width * (0.65 + 0.43 * shoulder);
      let core = 1.0 - smoothstep(coreWidth * 0.15, coreWidth, length(vec2<f32>(along, crosswind * 1.10)));
      let fanWidth = width * mix(0.77, 1.40, smoothstep(0.0, 0.55, along));
      let fan = length(vec2<f32>((along - width * 0.45) / (width * 1.56), crosswind / fanWidth));
      let outflow = 1.0 - smoothstep(0.19, 1.0, fan);
      stem = max(stem, amount * core);
      anvil = max(anvil, amount * outflow);
      let support = amount * max(core, outflow * 0.68);
      let spread = support * support;
      let heightVariation = saturate(TUNE.towerHeightVariation);
      // Vary the growth stage independently of location and width.
      // Low cumulus and mature towers then share the same air mass.
      let cumulusRoof = mix(0.77, mix(0.44, 0.96, 1.0 - heightSeed),
        0.69 + heightVariation * 0.29);
      let height = cumulusRoof - along * 0.33;
      roof += spread * height;
      base += spread * (0.12 + seed.z * 0.48);
      weight += spread;
    }
  }
  return vec4<f32>(stem, saturate(roof / max(weight, EPS)), anvil, saturate(base / max(weight, EPS)));
}

// One updraft feeds a broad lee-side anvil. Both are weather envelopes
// for the same rounded density field, so the tower grows into the anvil
// and the smaller cloud banks remain at the condensation level.
fn coastalAnvilWeather(p: vec3<f32>, ph: f32, regionalShape: vec4<f32>, billows: vec4<f32>, coverage: f32) -> vec4<f32> {
  let puff = max(TUNE.puffScale, 0.75);
  let center = B.center.xz + vec2<f32>(-0.66, -0.84) * puff;
  // Advect the material noise through the updraft. Keep the storm inside its finite volume.
  let q = (p.xz - center) / puff;
  let wind = vec2<f32>(-0.916, -0.401);
  let across = vec2<f32>(-wind.y, wind.x);
  let rise = smoothstep(0.12, 0.88, ph);
  let along = dot(q, wind) - (0.28 * rise + 0.20 * rise * rise) + (regionalShape.r - 0.5) * 0.62;
  let crosswind = dot(q, across) + rise * 0.16 + (billows.a - 0.5) * 0.46;

  // The neighboring updrafts have different tops and lean away from each other.
  // Preserve a cleft between their upper shoulders where the sky can show through.
  let primary = vec2<f32>((along + 0.28 * rise) / mix(1.08, 0.69, rise), crosswind / mix(0.89, 0.67, rise));
  let mainTower = 1.0 - smoothstep(0.22, 1.15, length(primary));
  let secondary = vec2<f32>((along - 0.72 - 0.38 * rise) / 0.82, (crosswind - 0.54 + 0.18 * rise) / 0.71);
  let adjoiningTower = (1.0 - smoothstep(0.24, 1.16, length(secondary))) * (1.0 - smoothstep(0.53, 0.81, ph));
  // Feeder clouds rise into the main column on a slope. Rounded 3D lobes
  // replace a fixed footprint with a height cutoff, which made a long shelf.
  let feederHeight = ph - 0.35 + along * 0.13 + (billows.g - 0.5) * 0.10;
  let feeder = vec3<f32>((along + 0.84 - 0.59 * rise) / 0.74,
    feederHeight / 0.32, (crosswind + 0.55 - 0.29 * rise) / 0.62);
  let lowerTower = 1.0 - smoothstep(0.26, 1.18, length(feeder));
  let billowSupport = mix(0.77, 1.10, smoothstep(0.24, 0.75, billows.r));
  let upperStem = max(mainTower * billowSupport, adjoiningTower * 0.96);
  let feederSupport = lowerTower * 0.82;
  let join = max(0.19 - abs(upperStem - feederSupport), 0.0);
  let stem = max(upperStem, feederSupport) + join * join
    * smoothstep(0.10, 0.44, min(upperStem, feederSupport)) / 0.76;

  let lee = smoothstep(-0.12, 2.28, along);
  let fanWidth = mix(0.60, 1.35, lee);
  let fanSpace = vec2<f32>((along - 1.35) / 2.33, (crosswind - 0.24 * lee) / fanWidth);
  let fan = (1.0 - smoothstep(0.31, 1.14, length(fanSpace))) * mix(0.73, 1.0, lee);
  let outflow = max(fan, mainTower * 0.68);
  let roof = clamp(0.90 - lee * 0.16 + (regionalShape.g - 0.5) * 0.22, 0.53, 0.96);
  let floorLift = clamp(0.21 + (regionalShape.a - 0.5) * 0.43 + 0.09 * lee, 0.0, 0.57);
  let activity = smoothstep(0.22, 0.72, coverage);
  return vec4<f32>(stem * activity, roof, outflow * activity, floorLift);
}

fn marineCloudBody(p: vec3<f32>, shape: vec4<f32>, billows: vec4<f32>, smallRolls: vec4<f32>,
  towerRolls: vec4<f32>) -> vec3<f32> {
  let size = FIELD.gridSize.y;
  let ph = (p.y - FIELD.gridMin.y) / size;
  let coverage = saturate(C.globalCoverage);
  let presence = smoothstep(0.0, 0.14, coverage);
  if (ph < 0.01 || presence <= 0.0) { return vec3<f32>(0.0, 0.0, -0.30); }

  let weatherScale = select(NTransform.weatherScale, 1.0, NTransform.weatherScale == 0.0);
  let horizontal = vec3<f32>(p.x, FIELD.gridMin.y, p.z);
  let weather = wrap2D(weather2D, samp2D, fieldWeatherUV(horizontal, weatherScale * 0.44), 0i, 0.0);
  let humidity = dot(weather.rg, vec2<f32>(0.75, 0.25));
  let sparse = cloudSparsity01();
  let regionalMass = dot(shape.ra, vec2<f32>(0.67, 0.33)) * 0.88 + humidity * 0.12;
  let region = smoothstep(0.47, 0.72, regionalMass);
  let cover = saturate(coverage * (1.11 - 0.25 * sparse) + (region - 0.44) * 0.15);
  let bankWeather = vec4<f32>(region, mix(region, weather.g, 0.33), mix(shape.a, billows.a, 0.50), weather.a);
  // Broad volumes support the billows. Build the fringe from a separate
  // octave so the small curls don't trace the same regional contours.
  let cells = vec4<f32>(mix(billows.r, shape.r, 0.32),
    mix(billows.g, smallRolls.r, 0.18), mix(billows.b, smallRolls.g, 0.46),
    mix(billows.a, shape.a, 0.48));
  let storm = TUNE.formType == 1.4375;
  let squall = TUNE.formType == 1.375;
  let towers = TUNE.formType == 1.25;
  let bandHeight = select(select(1.20, 1.48, squall), 3.22, storm);
  // Vary the bank's condensation height and depth with neighboring rolls.
  // A fixed depth makes a horizontally gated bank look like an extrusion.
  let baseFold = dot(towerRolls.ga - 0.5, vec2<f32>(0.34, 0.23));
  let baseRuffle = dot(smallRolls.gb - 0.5, vec2<f32>(0.18, 0.10));
  let raisedBase = select(0.0, (baseFold + baseRuffle) * (1.0 - smoothstep(0.26, 0.61, ph)), squall);
  let bankPhase = ph * bandHeight + (billows.a - 0.5) * 0.18 + (shape.a - 0.5) * 0.11 + raisedBase;
  let bank = cumulusBankForm(bankPhase, bankWeather, cells, cover, 2.40);
  let isShallowBank = TUNE.formType == 1.125;
  let wetThreshold = select(0.613, 0.636, isShallowBank);
  let regionalThreshold = mix(0.75, select(select(wetThreshold, 0.598, squall), 0.709, storm), coverage);
  let moistMass = regionalMass + (billows.g - 0.53) * 0.105 + (billows.r - 0.52) * 0.075;
  let opening = smoothstep(regionalThreshold - 0.077, regionalThreshold + 0.078, moistMass);
  // A broad dry intrusion undercuts the low part of the squall without
  // breaking its upper canopy into small independently lit puffs.
  let broadPocket = 1.0 - smoothstep(0.40, 0.63, dot(shape.ag, vec2<f32>(0.72, 0.28)));
  let lowCloud = 1.0 - smoothstep(0.22, 0.59, bankPhase);
  // Dry areas remain fully transparent, even along a long grazing ray.
  var form = bank.x + 0.037 - (1.0 - opening) * 0.39;
  if (squall) {
    // Regional dry air lifts whole sections of the condensation base.
    // A separate, smaller field shapes the hanging rolls along those cuts.
    let recess = smoothstep(0.36, 0.68, dot(towerRolls.gr, vec2<f32>(0.66, 0.34)));
    let notch = broadPocket * recess;
    form -= lowCloud * (0.071 + notch * 0.31 + broadPocket * 0.067);
    let foot = 0.29 + (shape.a - 0.5) * 0.27 + (towerRolls.b - 0.5) * 0.19
      + (smallRolls.r - 0.5) * 0.16;
    let footDepth = 0.20 + billows.a * 0.13;
    let lowerRoll = dot(vec3<f32>(towerRolls.r, billows.g, smallRolls.g), vec3<f32>(0.43, 0.43, 0.14));
    let overlap = lowerRoll - 0.53 - abs(bankPhase - foot) * footDepth
      - (1.0 - opening) * 0.27 - notch * 0.23;
    form = cloudSoftUnion(form, overlap);
    // Let the smaller folds cast their own shadows through both density
    // fields. Offset the lower skin where it is close to an existing roll.
    let foldSupport = smoothstep(-0.13, -0.018, form) * (1.0 - smoothstep(0.07, 0.25, form));
    let lobes = smoothstep(0.30, 0.71, dot(smallRolls.gb, vec2<f32>(0.68, 0.32)));
    let cleft = smoothstep(0.48, 0.79, smallRolls.a) * (1.0 - lobes);
    let relief = (lobes - 0.47) * 0.27 - cleft * 0.071;
    form += relief * foldSupport * mix(0.53, 1.0, lowCloud);
  }
  if (storm || towers) {
    var convection: vec4<f32>;
    var tower: vec2<f32>;
    if (storm) {
      convection = coastalAnvilWeather(p, ph, shape, billows, coverage);
      let unevenLift = (shape.a - 0.5) * 0.10 + (billows.g - 0.5) * 0.062;
      tower = anvilCloudForm(ph + unevenLift, convection, cells, cover);
    } else {
      convection = marineConvectiveWeather(p, cover, humidity);
      tower = convectiveTowerForm(ph * 1.14, convection, cells, cover, false);
    }
    // Tie cloud birth to the weather cells. Prevent fine cellular noise from
    // filling the clear sky around an inactive column.
    let supported = max(convection.r, convection.b * 0.78);
    let activity = supported * select(mix(0.45, 1.0, region), 1.0, storm);
    var core = tower.x - (1.0 - smoothstep(0.17, 0.48, activity)) * 0.43;
    if (storm) {
      // Give attached billows enough depth to interrupt the long shoulders.
      // The coarser volume controls the clefts, and the existing smaller
      // volumes shape their edges. Neither can seed a cloud in clear air.
      let shoulder = smoothstep(-0.29, -0.05, core) * (1.0 - smoothstep(0.23, 0.51, core));
      let rolls = smoothstep(0.28, 0.71, dot(towerRolls.rg, vec2<f32>(0.25, 0.75)));
      let scallops = (rolls - 0.49) * 0.70 + (billows.g - 0.52) * 0.21;
      core += scallops * shoulder * smoothstep(0.19, 0.56, activity);
    }
    var bankForm = form - 0.028;
    if (storm) {
      // Break the low layer into banks on each side of an open corridor.
      let q = (p.xz - B.center.xz) / max(TUNE.puffScale, 0.75);
      let corridor = q.x - q.y * 0.28 + (billows.a - 0.5) * 0.72;
      let dryAir = (1.0 - smoothstep(0.47, 1.68, abs(corridor))) * smoothstep(-1.30, 1.0, q.y);
      bankForm -= 0.086 + 0.35 * dryAir;
    }
    let join = max(0.076 - abs(bankForm - core), 0.0);
    form = max(bankForm, core) + join * join / (0.076 * 4.0);
  }

  // Make the smaller rolls part of the boundary the light sees. Give
  // connected shoulders more relief and leave the dense interior intact.
  let skin = smoothstep(-0.075, 0.016, form) * (1.0 - smoothstep(0.091, 0.245, form));
  let shoulder = smoothstep(0.28, 0.69, mix(billows.r, billows.a, 0.32));
  let roll = smoothstep(0.30, 0.76, mix(smallRolls.g, smallRolls.r, 0.23));
  let lowBank = 1.0 - smoothstep(0.18, 0.57, bankPhase);
  let broadRoll = smoothstep(0.25, 0.75, dot(billows.gr, vec2<f32>(0.64, 0.36)));
  let folds = (roll - 0.55) * (0.109 + 0.10 * shoulder) * (1.0 - lowBank * 0.52)
    + (broadRoll - 0.49) * (0.076 * lowBank);
  let edge = mix(0.112, 0.068, cloudDefinition01());
  let scallop = (smallRolls.b - 0.5) * (0.052 + shoulder * 0.047);
  let surface = form - 0.023 + (folds + select(0.0, scallop, squall || storm)) * skin;
  let peak = 0.61 + clamp(TUNE.fluffFactor * 0.19, 0.34, 0.93) * smoothstep(0.00, 0.18, surface);
  let density = smoothstep(0.0, edge, surface) * peak * presence;
  let shadow = smoothstep(0.0, edge * 1.13, surface) * peak * presence;
  let signed = surface * min(max(TUNE.puffScale, 0.75) * 0.55, size * 0.85);
  return vec3<f32>(density, shadow, signed);
}

// Rare cloud features use analytic, co-moving scaffolds plus the same baked
// bands. These are cached volume fields, never extra procedural work per ray.
// Return fine/macro density and an unsaturated surface for lighting gradients.
fn flatWavePhase(position: vec2<f32>, rate: vec2<f32>) -> f32 {
  return dot(position, fieldPeriodicScale(vec3<f32>(rate.x, 0.0, rate.y) / 6.283185).xz * 6.283185);
}

fn featureWeatherBody(p: vec3<f32>, shape: vec4<f32>, detail: vec3<f32>, weights: vec3<f32>) -> vec3<f32> {
  let material = p + NTransform.shapeOffsetWorld;
  let alongWind = vec2<f32>(0.94, 0.342);
  let crossWind = vec2<f32>(-0.342, 0.94);
  let u = dot(material.xz, alongWind);
  let v = dot(material.xz, crossWind);
  let base = FIELD.gridMin.y;
  let height = FIELD.gridSize.y;
  let spacingY = height / f32(FIELD.dimensions.y);
  let coverage = saturate(C.globalCoverage);
  let weatherScale = select(NTransform.weatherScale, 1.0, NTransform.weatherScale == 0.0);
  let weather = wrap2D(weather2D, samp2D, fieldWeatherUV(material, weatherScale), 0i, 0.0);
  let presence = smoothstep(0.0, 0.12, coverage) * (1.0 - smoothstep(0.85, 1.0, weather.b));
  let grain = dot(detail, vec3<f32>(0.42, 0.34, 0.24));
  var density = 0.0;
  var macroDensity = 0.0;
  var signed = -1.0;
  if (weights.x > 0.0) {
    // Long feathered ice streaks: slow bends along wind, finer cross-wind
    // filaments. No vertical squash or sub-voxel transparent sheet.
    let along = flatWavePhase(material.xz, alongWind * 0.23);
    let across = flatWavePhase(material.xz, crossWind * 1.43);
    let drift = along + (weather.g - 0.5) * 3.9;
    let phase = across + sin(drift) * 2.35 + (shape.g - 0.5) * 3.7 + (weather.r - 0.5) * 1.75;
    let feather = pow(0.5 + 0.5 * sin(phase), 2.15);
    let offshoot = pow(0.5 + 0.5 * sin(phase * 2.0 + sin(drift) * 1.3 + 1.27), 3.3);
    let fibers = feather * 0.76 + offshoot * 0.26;
    let weatherPatch = dot(vec3<f32>(weather.g, shape.r, shape.a), vec3<f32>(0.47, 0.32, 0.21));
    let fragments = smoothstep(0.25, 0.57, weatherPatch + sin(drift) * 0.12);
    let wave = flatWavePhase(material.xz, alongWind * 0.18 + crossWind * 0.10);
    let center = base + height * (0.76 + (weather.b - 0.5) * 0.15)
      + sin(wave) * 0.32 + (shape.a - 0.5) * 0.39;
    let halfDepth = max(spacingY * 1.75, 0.30) + 0.13 * offshoot;
    let band = 1.0 - abs(p.y - center) / halfDepth;
    let form = min(band, fibers * 0.79 + weatherPatch * 0.52 - mix_f(0.83, 0.42, coverage));
    density += weights.x * smoothstep(-0.055, 0.23, form - grain * 0.11) * fragments * 0.36;
    macroDensity += weights.x * smoothstep(-0.055, 0.23, form) * fragments * 0.36;
    signed = max(signed, form - (1.0 - weights.x) * 0.35);
  }
  if (weights.y > 0.0) {
    // A breaking wave has a broad sloping back and a steep forward face.
    // The curl is only its crest; the rising wedge below supplies its mass.
    let width = max(TUNE.puffScale, 3.6);
    let phase = u + sin(v * 0.21) * 0.65 + (shape.g - 0.5) * 0.45;
    let waveId = floor(phase / width);
    // Stable but independently evolving rolls, not repeated identical hooks.
    // The support ends before the cell boundary, so irregular spacing does not
    // introduce seams. Existing volume bands shear/break their whole surface.
    let seed = cloudCellRandom(vec2<f32>(waveId, 0.0), 419.7);
    let lean = cloudCellRandom(vec2<f32>(waveId, 0.0), 431.3);
    let x = (fract(phase / width) - 0.5 + (lean - 0.5) * 0.22) * width;
    let growth = smoothstep(0.27, 0.68, weather.g * 0.59 + shape.a * 0.41);
    let radius = width * (mix_f(0.20, 0.26, seed) + shape.g * 0.018 + 0.015 * sin(v * 0.27)
      + (growth - 0.5) * 0.038);
    let floorY = base + height * 0.20 + sin(v * 0.34) * 0.12 + sin(u * 0.22 + v * 0.16) * 0.16
      + (weather.b - 0.5) * 0.14;
    let roughQ = vec2<f32>(x + (shape.g - 0.5) * width * 0.13, p.y - floorY - radius + (shape.b - 0.5) * width * 0.10);
    let turn = (lean - 0.5) * 0.90;
    let q = vec2<f32>(cos(turn)*roughQ.x+sin(turn)*roughQ.y,-sin(turn)*roughQ.x+cos(turn)*roughQ.y);
    let thickness = max(spacingY * 1.6, width * mix_f(0.038, 0.063, lean));
    let curlRadius = radius * (1.0 + sin(atan2(q.y,q.x)*2.0 + seed*6.283185) * 0.16);
    let ring = (thickness - abs(length(q) - curlRadius)) / thickness;
    let openHook = min(ring, max(-q.x - radius * mix_f(0.02,0.28,seed), q.y + radius * mix_f(0.10,0.42,lean)) / thickness);
    let rise = clamp((p.y-floorY)/max(radius*1.65,0.01),0.0,1.0);
    let back = mix_f(-width*0.46,-radius*0.42,rise);
    let face = mix_f(radius*0.42,-radius*0.30,rise);
    let wedge = min(min((x-back)/thickness,(face-x)/thickness),
      min((p.y-floorY+thickness)/thickness,(floorY+radius*1.65-p.y)/thickness));
    let tornLip = (shape.r - shape.b) * 0.37 + (detail.g - 0.5) * 0.20;
    let crest = min(openHook + tornLip + (growth - 0.5) * 0.17,
      (p.y-floorY-radius*0.72)/thickness);
    let bank = (1.0 - abs(p.y - floorY - (shape.g-0.5)*0.65) / max(thickness * 0.85, spacingY * 1.6))
      - smoothstep(0.36,0.67,shape.b)*0.60;
    let crestRun = 0.5 + 0.5 * sin(v * 0.38 + shape.b * 1.45 + (seed - 0.5) * 0.62);
    let row = smoothstep(0.22, 0.72, crestRun * 0.89 + growth * 0.11);
    let form = min(max(cloudSoftUnion(wedge,crest), bank * 0.42), row * 1.1 - mix_f(0.90, 0.20, coverage));
    let eroded = form + (shape.r - 0.5) * 0.78 - (grain - 0.35) * 0.38 - (shape.a - 0.5) * 0.24;
    density += weights.y * smoothstep(-0.055, 0.30, eroded) * 0.60;
    macroDensity += weights.y * smoothstep(-0.055, 0.30, form) * 0.60;
    signed = max(signed, eroded - (1.0 - weights.y) * 0.35);
  }
  if (weights.z > 0.0) {
    // Asperitas is a connected turbulent underside, with differently directed
    // waves and deep irregular troughs, rather than an array of hanging balls.
    let surge = flatWavePhase(material.xz, alongWind * 0.39);
    let cross = flatWavePhase(material.xz, crossWind * 0.54);
    let turn = flatWavePhase(material.xz, crossWind * 0.20 + alongWind * 0.12);
    let bend = (weather.g - .5) * 4.6 + (shape.a - .5) * 1.8;
    let waveA = sin(surge + bend + sin(turn) * 1.9 + (shape.g - 0.5) * 2.6);
    let waveB = sin(cross - bend * .71 + sin(surge) * 0.82 + (shape.b - 0.5) * 2.5);
    let trough = pow(0.5 + 0.5 * sin(surge + cross + bend + shape.a * 1.55), 2.6);
    let swell = mix(0.52, 1.36, smoothstep(0.28, 0.74, weather.g * 0.58 + shape.r * 0.42));
    let fold = shape.g * 0.44 + shape.b * 0.32 + weather.g * 0.24;
    let undercut = smoothstep(0.39, 0.72, fold) * (0.45 + 0.55 * waveB * waveB);
    let underside = base + height * (0.37 + undercut * 0.25)
      + (waveA * 0.33 + waveB * 0.46 - trough * 0.62) * swell + (shape.r - 0.5) * 0.75;
    let ceiling = base + height * 0.76 + (shape.b - 0.5) * 0.46;
    let band = min(p.y - underside, ceiling - p.y) / max(height * 0.16, 0.5);
    let opening = shape.r * 0.47 + shape.g * 0.25 + weather.r * 0.28
      - mix_f(0.88, 0.18, coverage) - undercut * 0.22;
    // Open irregular sky between wave banks as coverage drops.
    let site = localPlanetWeatherPatch(p, weather, .25, vec2<f32>(.69, 1.48));
    let wind = rotateXZ((p.xz - B.center.xz + NTransform.weatherOffsetWorld.xz)
      / max(TUNE.puffScale, .75), -.30);
    let meander = smoothCellHash2D(vec2<f32>(wind.y * 1.4, 8.4), .29) - .5;
    let drySlot = abs(wind.x + meander * 1.62 + .24);
    let channel = (drySlot - mix(1.16, -.16, coverage) + (shape.r - .5) * .34) * .53;
    let lane = (site - .50 + (coverage - .73) * .72) * 2.1;
    let form = min(band, min(opening, min(lane, channel)));
    let shear = (shape.b - shape.r) * .23 * (1.0 - smoothstep(.04, .31, abs(form)));
    let eroded = form + shear - (grain - 0.35) * 0.085;
    density += weights.z * max(smoothstep(-0.06, 0.23, eroded), smoothstep(0.08, 0.35, eroded) * 1.25);
    macroDensity += weights.z * max(smoothstep(-0.06, 0.23, form), smoothstep(0.08, 0.35, form) * 1.25);
    signed = max(signed, eroded - (1.0 - weights.z) * 0.35);
  }
  return vec3<f32>(density * presence, macroDensity * presence, signed);
}

// Continuous layer systems for the weather director. Reuse the already sampled
// four shape bands/detail, and the same co-moving weather domain. Shelf material
// has its own resolved ripple scale, without pulling in the legacy ray/light
// call graph or changing the noise domain of the remaining convective clouds.
fn layeredWeatherBody(p:vec3<f32>, shape:vec4<f32>, detail:vec3<f32>, weights:vec3<f32>, shelfShapeBands:vec4<f32>, shelfDetail:vec3<f32>) -> vec3<f32> {
  let fbm=dot(shape.gba,vec3<f32>(0.625,0.25,0.125));
  let baseShape=contrast01(shape.r,1.35);
  let shelfShape=saturate((baseShape-fbm*0.72)/max(1.0-fbm*0.72,0.08));
  let detailMid=dot(detail,vec3<f32>(0.42,0.34,0.24));
  let material=p+NTransform.shapeOffsetWorld;
  let weatherScale=select(NTransform.weatherScale,1.0,NTransform.weatherScale==0.0);
  let weather=wrap2D(weather2D,samp2D,fieldWeatherUV(material,weatherScale),0i,0.0);
  let coverage=saturate(C.globalCoverage*mix_f(0.78,1.0,saturate(weather.r)));
  let threshold=mix_f(0.62,0.06,coverage);
  let presence=smoothstep(0.0,0.12,C.globalCoverage)*(1.0-smoothstep(0.85,1.0,weather.b));
  let base=FIELD.gridMin.y;
  var fine=0.0;
  var macroDensity=0.0;
  var signed=-1.0;
  if(weights.x>0.0) {
    // Port the layer's band-remap, scallops and crease signals, not its harsh
    // high-frequency carve or thin-box height remapping. Keep folded, connected
    // rain banks with a dense body and softer rippled edges through the cycle.
    let s=shelfShapeBands;
    let d=shelfDetail;
    let shelfFBM=dot(s.gba,vec3<f32>(0.625,0.25,0.125));
    let shelfBase=contrast01(s.r,1.24+cloudDefinition01()*0.38);
    let remapped=saturate((shelfBase-shelfFBM*0.90)/max(1.0-shelfFBM*0.90,0.08));
    let mid=dot(d,vec3<f32>(0.42,0.34,0.24));
    let scallopSignal=mix_f(max(max(d.r,d.g),d.b),1.0-min(min(d.r,d.g),d.b),0.42);
    let scallop=ridge01(contrast01(scallopSignal*0.72+ridge01(contrast01(mid,2.1))*0.28,2.25));
    let valley=(1.0-scallop)*(1.0-scallop);
    let crease=ridge01(contrast01(d.r*0.36+(1.0-d.g)*0.34+d.b*0.20+(1.0-s.r)*0.10,2.15));
    let fold=ridge01(contrast01(s.g*0.54+s.b*0.30+s.a*0.16,1.9));
    let center=base+1.95+(shape.g-0.5)*0.65+(s.g-s.b)*0.38;
    let halfHeight=0.90+shelfShape*0.60+fold*0.32;
    let band=1.0-abs(p.y-center)/halfHeight;
    let structure=(remapped-0.28)*0.68+(shelfFBM-0.5)*0.14;
    let form=min(band,band*0.42+structure-threshold*0.45);
    // Erosion is bounded and reduced inside the bank: breakup exposes folds
    // without punching a mature shelf into the default preset's rough wisps.
    let shell=1.0-smoothstep(0.08,0.38,form);
    let erosion=(mid*0.035+valley*0.095+crease*0.040)*mix_f(0.55,1.0,shell);
    let eroded=form-erosion;
    fine+=weights.x*max(smoothstep(-0.045,0.24,eroded),smoothstep(0.08,0.38,eroded)*1.45);
    macroDensity+=weights.x*max(smoothstep(-0.045,0.24,form-erosion*0.45),smoothstep(0.08,0.38,eroded)*1.45);
    signed=max(signed,form-erosion*0.65-(1.0-weights.x)*0.35);
  }
  if(weights.y>0.0) {
    // A connected ceiling which opens into broken banks as coverage falls.
    let center=base+3.35+(shape.g-0.5)*0.80;
    let band=1.0-abs(p.y-center)/(0.80+fbm*0.85);
    let form=min(band,0.14+baseShape*0.45+fbm*0.30-threshold);
    let eroded=form-detailMid*0.07;
    fine+=weights.y*max(smoothstep(-0.05,0.24,eroded),smoothstep(0.06,0.34,eroded)*1.35);
    macroDensity+=weights.y*max(smoothstep(-0.05,0.24,form),smoothstep(0.06,0.34,form)*1.35);
    signed=max(signed,eroded-(1.0-weights.y)*0.35);
  }
  if(weights.z>0.0) {
    // High, sparse wisps stay above the low weather. A minimum three-voxel
    // thickness keeps the thin material resolved instead of blinking away.
    let center=base+FIELD.gridSize.y*0.82+(shape.g-0.5)*0.55;
    let halfHeight=max(FIELD.gridSize.y/f32(FIELD.dimensions.y)*1.6,0.28);
    let band=1.0-abs(p.y-center)/halfHeight;
    let form=min(band,shelfShape-threshold*0.75-detailMid*0.08);
    fine+=weights.z*smoothstep(-0.045,0.25,form)*0.22;
    macroDensity+=weights.z*smoothstep(-0.045,0.25,form)*0.22;
    signed=max(signed,form-(1.0-weights.z)*0.35);
  }
  return vec3<f32>(fine*presence,macroDensity*presence,signed);
}

// Example arbitrary domain: rotate an analytic torus in place while its cloud
// material keeps advecting independently through it. Bounds are only an
// allocation/ray intersection box; no mesh or marching cubes are involved.
// Quantized cell periods match both value and slope across a repeated field.
// Offsets remain continuous, so animated noise travels through the join.
fn fieldNoise2D(p:vec2<f32>, frequency:vec2<f32>, offset:vec2<f32>)->f32 {
  let tiled=FIELD.dimensions.w>0u;
  let cells=max(round(frequency*FIELD.gridSize.xz),vec2<f32>(1.0));
  let rate=select(frequency,cells/FIELD.gridSize.xz,tiled);
  let q=p*rate+offset; let cell=floor(q); let f=fract(q);
  var a=cell; var b=cell+vec2<f32>(1.0,0.0);
  var c=cell+vec2<f32>(0.0,1.0); var d=cell+vec2<f32>(1.0);
  if(tiled){a-=floor(a/cells)*cells;b-=floor(b/cells)*cells;
    c-=floor(c/cells)*cells;d-=floor(d/cells)*cells;}
  let u=f*f*(3.0-2.0*f);
  return mix_f(mix_f(hash13_i(vec3<i32>(vec2<i32>(a),0)),hash13_i(vec3<i32>(vec2<i32>(b),0)),u.x),
    mix_f(hash13_i(vec3<i32>(vec2<i32>(c),0)),hash13_i(vec3<i32>(vec2<i32>(d),0)),u.x),u.y);
}

// A morning sky has two distinct scales: a broad low front and a broken,
// ruffled upper deck. Both are volumetric density, not camera-facing cards or
// repeated cumulus balls. Reuse the bake's filtered material bands.
fn morningRuffleBody(p:vec3<f32>, shape:vec4<f32>, detail:vec3<f32>, spacingY:f32)->vec3<f32> {
  let material = p + NTransform.shapeOffsetWorld;
  let height = FIELD.gridSize.y; let base = FIELD.gridMin.y;
  // Independent wind domains evolve the deck instead of translating a frozen
  // pattern. Existing animation offsets supply time, so Pause really freezes
  // the field and moving the camera cannot change the cloud anatomy.
  let evolution = NTransform.detailOffsetWorld.xz - NTransform.shapeOffsetWorld.xz;
  let weatherDrift = NTransform.weatherOffsetWorld.xz - NTransform.shapeOffsetWorld.xz;
  let broad = fieldNoise2D(material.xz,vec2<f32>(0.10),vec2<f32>(7.3,19.1));
  let broadOther = fieldNoise2D(material.xz+weatherDrift,vec2<f32>(0.17),vec2<f32>(23.7,4.6));
  let coverage = saturate(C.globalCoverage);
  let presence = smoothstep(0.0, 0.12, C.globalCoverage);
  let curl = vec2<f32>(fieldNoise2D(material.xz,vec2<f32>(0.25),evolution*0.45+vec2<f32>(1.7,8.3)),
    fieldNoise2D(material.xz,vec2<f32>(0.25),evolution*0.45+vec2<f32>(19.1,2.7))) - 0.5;
  let ruffleRate=vec2<f32>(1.0,1.65)/max(TUNE.puffScale,0.30);
  let ruffleWarp=vec2<f32>(broadOther-0.5,broad-0.5)*2.8+curl*1.2;
  let ruffleCoarse=fieldNoise2D(material.xz,ruffleRate,ruffleWarp+vec2<f32>(13.7,2.1));
  let ruffleFine=fieldNoise2D(material.xz,ruffleRate*2.1,ruffleWarp*2.1-evolution*0.8+vec2<f32>(3.1,21.7));
  let ripple = ridge01(ruffleCoarse * 0.72 + ruffleFine * 0.28);
  let upperCenter = base + height * (0.74 + (broad - 0.5) * 0.11)
    + (ruffleCoarse - 0.5) * height * 0.035 + (shape.b - 0.5) * 0.12;
  let upperHalf = max(spacingY * 2.2, height * (0.018 + ripple * 0.024));
  let upperBand = 1.0 - abs(p.y - upperCenter) / upperHalf;
  let upperOpening = broad * 0.63 + broadOther * 0.24 + shape.r * 0.13
    - mix_f(0.72, 0.36, coverage);
  let upperForm = min(upperBand, min(upperOpening * 2.8,
    (ruffleCoarse * 0.65 + ruffleFine * 0.35 - 0.46) * 3.4));
  let upperFine = upperForm - (detail.r * 0.5 + detail.g * 0.3 + detail.b * 0.2) * 0.055;
  // An irregular wind front occupies one region of the sky. Its underside is
  // lower and denser than the cloudlets, giving a slate bank near the horizon.
  let frontEdge = material.z + sin(material.x * 0.13) * 3.2 + (broad - 0.5) * 4.0;
  let periodicFront=sin(material.z*6.283185/FIELD.gridSize.z)
    +sin(material.x*6.283185/FIELD.gridSize.x)*0.35+(broad-0.5)*0.4;
  let front = select(1.0-smoothstep(-7.0,-2.0,frontEdge),
    1.0-smoothstep(-0.35,0.15,periodicFront),FIELD.dimensions.w>0u);
  let lowerCenter = base + height * (0.18 + (broadOther - 0.5) * 0.06)
    + (shape.g - 0.5) * height * 0.035;
  let lowerBand = 1.0 - abs(p.y - lowerCenter) / max(spacingY * 2.5,
    height * (0.075 + (shape.r * 0.6 + ruffleCoarse * 0.4) * 0.035));
  let lowShoulders = 0.62 * broadOther + 0.23 * shape.r + 0.15 * ruffleCoarse;
  let softBreaks = 1.0 - smoothstep(0.32, 0.57, lowShoulders);
  let lowerForm = min(lowerBand + (ruffleCoarse - 0.5) * 0.23,
    front * 1.25 - 0.18 - softBreaks * 0.44 + (shape.g - 0.5) * 0.22);
  let fine = smoothstep(-0.035, 0.22, upperFine) * 0.72
    + smoothstep(-0.035, 0.24, lowerForm - detail.g * 0.035) * 1.20;
  let macroDensity = smoothstep(-0.035, 0.22, upperForm) * 0.72
    + smoothstep(-0.035, 0.24, lowerForm) * 1.20;
  return vec3<f32>(fine * presence, macroDensity * presence, max(upperFine, lowerForm));
}

// Thick connected folds on the cached volume path. All horizontal variation
// comes from periodic material textures, so wide skies keep their voxel detail
// and join at tile boundaries without camera-dependent procedural slices.
fn cachedInkFoldBody(p:vec3<f32>, shape:vec4<f32>, detail:vec3<f32>)->vec3<f32> {
  let ph = (p.y - FIELD.gridMin.y) / FIELD.gridSize.y;
  let roll = sin(shape.g * 6.283185 + shape.b * 2.4);
  let center = 0.49 + (shape.g - shape.b) * 0.48 + roll * 0.12;
  let thickness = 0.19 + shape.r * 0.16 + shape.a * 0.08;
  let mainBand = 1.0 - abs(ph - center) / thickness;
  // A second rolling shoulder grows out of the main mass, rather than a
  // disconnected planar deck. Each noise channel shifts its height and width.
  let shoulderCenter=center+0.16+(shape.b-0.5)*0.22;
  let shoulder=1.0-abs(ph-shoulderCenter)/(thickness*0.62);
  let band=max(mainBand,shoulder*(0.45+shape.g*0.45));
  let fbm=dot(shape.gba,vec3<f32>(0.625,0.25,0.125));
  let remapped=saturate((contrast01(shape.r,1.8)-fbm*0.90)/max(1.0-fbm*0.90,0.08));
  let closure = remapped - mix_f(0.76,0.22,saturate(C.globalCoverage));
  let form = min(band, closure * 3.2);
  let grain = dot(detail, vec3<f32>(0.42,0.34,0.24));
  let crease = pow(1.0 - ridge01(detail.g * 0.55 + shape.b * 0.45), 2.0);
  let erosion = (grain * 0.07 + crease * 0.10) * (1.0 - smoothstep(0.04,0.35,form) * 0.65);
  let signedForm = form - erosion;
  let presence = smoothstep(0.0,0.12,C.globalCoverage);
  return vec3<f32>(smoothstep(-0.035,0.20,signedForm) * presence,
    smoothstep(-0.035,0.20,form-erosion*0.4) * presence,signedForm);
}

// Analytic organization reuses the bake's filtered cloud-noise bands.
fn cloudSeaBody(p:vec3<f32>,shape:vec4<f32>,detail:vec3<f32>)->vec3<f32> {
  // Integer wave vectors close exactly over the cached tile. Independent
  // phase speeds make the sea slosh, instead of translating a frozen surface.
  let k=6.283185/FIELD.gridSize.xz;
  let pos=p.xz+NTransform.shapeOffsetWorld.xz;
  // The broad swell clock is independent of the slower fine-detail drift.
  let phase=NTransform.shapeOffsetWorld.x*0.65+NTransform.shapeOffsetWorld.z*0.30;
  let q=pos*k;
  // Tile-wide weather regions bend the swells and vary their energy. Warp
  // with periodic functions, rather than rotating/scaling tile coordinates:
  // both the heights and their slopes still agree at opposite tile edges.
  let region=0.5+0.5*sin(q.x+sin(q.y)*0.65)*cos(q.y-0.4);
  let warped=q+vec2<f32>(sin(q.y+sin(q.x)*0.4),sin(q.x-q.y+0.7))*0.48;
  let a=dot(warped,vec2<f32>(3.0,2.0))+phase;
  let b=dot(warped,vec2<f32>(-2.0,5.0))-phase*0.73;
  let c=dot(warped,vec2<f32>(7.0,9.0))+phase*1.21;
  let energy=0.30+region*0.90;
  let primary=sin(a+sin(b)*0.35);
  let crest=primary+0.30*(primary*primary-0.5);
  let swell=(crest*0.066+sin(b)*0.034+sin(c)*0.016)*energy
    +sin(q.x-q.y+0.4)*0.028;
  let height=FIELD.gridSize.y;
  // Filtered volume bands break up the smooth swell into cloud-sized billows.
  // Move the surface itself, retaining a solid sea underneath the rough skin.
  // More relief comes from the filtered, irregular bands than from the smooth
  // carrier waves. Short crossing ripples fray the crests without punching
  // holes through the filled volume; integer harmonics retain exact tiling.
  let ripples=sin(dot(warped,vec2<f32>(13.0,-7.0))+phase*1.6)*0.014
    +sin(dot(warped,vec2<f32>(9.0,15.0))-phase*1.3)*0.010;
  let scallop=abs(shape.g-shape.b)-0.25;
  let billows=((shape.r-0.5)*0.18+(shape.g-0.5)*0.09
    +(shape.b-0.5)*0.055+(detail.g-0.5)*0.04+scallop*0.065)*(0.70+region*0.30)+ripples;
  let surface=FIELD.gridMin.y+height*(0.53+swell+billows);
  let band=min((surface-p.y)/(height*0.065),(p.y-FIELD.gridMin.y-height*0.04)/(height*0.08));
  let skin=1.0-smoothstep(0.1,0.8,band);
  let form=band-(dot(detail,vec3<f32>(0.12,0.09,0.07))+abs(detail.r-detail.b)*0.28)*skin;
  let presence=smoothstep(0.0,0.12,C.globalCoverage);
  return vec3<f32>(smoothstep(-0.06,0.28,form)*presence,
    smoothstep(-0.06,0.28,band)*presence,form);
}

// Stretching texture alone cannot organize independent puffs into cloud streets.
fn parallelCloudBandBody(p:vec3<f32>,shape:vec4<f32>,detail:vec3<f32>)->vec3<f32> {
  let material=p+NTransform.shapeOffsetWorld;
  let width=max(TUNE.puffScale,1.0)*2.0;
  let along=material.z*6.283185/FIELD.gridSize.z;
  let bend=sin(along*2.0)*width*0.045+(shape.g-0.5)*width*0.045;
  let drift = flatWavePhase(material.xz,vec2<f32>(0.13,0.38));
  let stripe=cos((material.x+bend)*6.283185/width+sin(drift)*0.34);
  let center=FIELD.gridMin.y+FIELD.gridSize.y*(0.38+(shape.b-0.5)*0.24);
  let halfHeight=FIELD.gridSize.y*(0.14+shape.g*0.15);
  let band=1.0-abs(p.y-center)/max(halfHeight,0.1);
  let cross= (stripe-mix_f(0.82,0.05,saturate(C.globalCoverage)))*1.8;
  let billows=(shape.r-0.5)*0.90+(shape.a-0.5)*0.45+(shape.b-0.5)*0.25;
  let gaps = 1.0 - smoothstep(0.33, 0.66, shape.a * 0.49 + shape.r * 0.35 + (0.5 + 0.5 * sin(drift)) * 0.16);
  let form=min(band + (shape.g - 0.5) * 0.18,cross)+billows-gaps*0.28;
  let eroded=form-dot(detail,vec3<f32>(0.09,0.06,0.04))-abs(detail.r-detail.g)*0.20;
  let presence=smoothstep(0.0,0.12,C.globalCoverage);
  return vec3<f32>(smoothstep(-0.06,0.24,eroded)*presence,
    smoothstep(-0.06,0.24,form)*presence,eroded);
}

fn stormSpin()->f32 {
  // Existing material clocks freeze with Pause/capture; camera motion cannot
  // rotate the anatomy. No independent wall clock or extra texture is needed.
  return NTransform.shapeOffsetWorld.x*0.78;
}
fn stormMaterialPosition(p:vec3<f32>)->vec3<f32> {
  let center=FIELD.gridMin.xyz+FIELD.gridSize.xyz*0.5;
  let q=p-center;
  // Fine material rotates far more slowly than the analytic storm anatomy.
  // Sharing the full spin swept high-frequency bands across Balanced voxels.
  let fineSpin=stormSpin()*select(0.10,0.05,TUNE.formType>11.5);
  let turn=fineSpin+q.y/FIELD.gridSize.y*0.9;
  return center+vec3<f32>(cos(turn)*q.x+sin(turn)*q.z,q.y,-sin(turn)*q.x+cos(turn)*q.z);
}

fn hurricaneWallRadius(angle:f32,y:f32)->f32 {
  // Shallow, closely spaced helical riffles over a continuous widening wall.
  // The former large radial terraces made the eye read as folded sheets.
  return 0.25+y*0.22+sin(angle*5.0-y*30.0)*0.016
    +sin(angle*13.0-y*62.0+sin(angle*5.0-y*30.0)*0.25)*0.007;
}

// Finite storm scaffolds. The same cached 3D bands give them volumetric
// billows, so these are neither stacked cards nor a camera-dependent shell.
fn rotatingStormBody(p:vec3<f32>,shape:vec4<f32>,detail:vec3<f32>,rolls:vec4<f32>)->vec3<f32> {
  let center=FIELD.gridMin.xyz+FIELD.gridSize.xyz*0.5;
  let extent=min(FIELD.gridSize.x,FIELD.gridSize.z)*0.5;
  let q=(p-center)/vec3<f32>(extent,FIELD.gridSize.y,extent);
  let r=length(q.xz);
  let y=q.y+0.5;
  let angle=atan2(q.z,q.x)+stormSpin();
  let hurricane=TUNE.formType>11.5;
  let grain=dot(detail,vec3<f32>(0.42,0.34,0.24));
  let billow=(shape.r-0.5)*1.45+(shape.g-0.5)*0.90+(shape.b-0.5)*0.60;
  var form=-1.0;
  var rain=0.0;
  if(TUNE.formType<11.5) {
    // A broad layered mesocyclone, sloped shoulders and a lowered wall cloud.
    let phase = y * 33.0 + angle * 2.0 - r * 9.0 + (shape.g - 0.5) * 2.5;
    let rise = (rolls.g - 0.5) * 0.062 + (rolls.b - 0.5) * 0.025;
    let terraces = sin(phase + (rolls.a - 0.5) * 2.3)
      * mix(0.012, 0.043, smoothstep(0.25, 0.71, shape.a)) + rise;
    let outer=0.22+y*0.65+terraces+sin(angle*3.0-y*9.0)*0.025+(shape.g-0.5)*0.035;
    let shelf=min((outer-r)*5.0,min((y-0.36)*9.0,(0.83-y)*9.0));
    let wallCenter = vec2<f32>(sin(y * 5.0), cos(y * 6.0)) * (rolls.g - 0.5) * 0.09;
    let wallXZ = (q.xz - wallCenter) / 0.26;
    let wall = 1.0 - length(vec3<f32>(wallXZ.x, (y - 0.36) / 0.15, wallXZ.y)) + rise * 3.0;
    let anvil=(1.0-length(vec3<f32>(q.x/0.77,(y-0.79)/0.15,q.z/0.77)))*2.5;
    form=cloudSoftUnion(cloudSoftUnion(shelf,wall),anvil);
    // One broad translucent precipitation sector descends from the flank.
    // Coherent vertical streaks stay thicker than the balanced field voxels.
    let sector=smoothstep(-0.25,0.45,cos(angle-0.65));
    let curtainR=0.46+sin(angle*2.0-y*4.0)*0.055+y*0.08;
    let curtain=min((0.12-abs(r-curtainR))*7.0,min((y-0.02)*8.0,(0.46-y)*8.0));
    let curtainPhase=angle*19.0+r*23.0+stormSpin()*0.6;
    let streak=0.50+0.29*sin(curtainPhase+(shape.r-0.5)*2.1)
      +0.17*sin(curtainPhase*2.0+3.0)+(shape.g-0.5)*0.14;
    rain=smoothstep(-0.06,0.18,curtain)*sector*streak*0.18;
  } else {
    // A solid radial body supports the riffles: no density modulation through
    // its interior and no large displacement that separates it into folds.
    let circulation = (rolls.g - 0.5) * 0.105 + (rolls.b - 0.5) * 0.055;
    let inner = hurricaneWallRadius(angle,y) + circulation + (shape.b - 0.5) * 0.034;
    let outer=0.79+sin(angle*5.0-y*30.0)*0.012+(shape.g-0.5)*0.012;
    let wall=min((r-inner)*7.0,(outer-r)*6.0);
    let heightBand=min((y-0.05)*8.0,(0.96-y)*10.0);
    form=min(wall,heightBand);
    // Wispy rain on the inner wall leaves the center entirely empty.
    rain=smoothstep(-0.04,0.10,min((r-inner+0.045)*8.0,(inner+0.07-r)*8.0))
      *smoothstep(0.03,0.18,y)*(1.0-smoothstep(0.50,0.76,y))*0.04;
  }
  // A broad outflow deck wraps around the upper storm. Spiral ridges vary its
  // thickness and outer edge, instead of reading as a smooth ellipsoid. The
  // hurricane retains its open eye through this deck as well as through the wall.
  let spiral=angle*3.0-r*18.0-y*3.0;
  let arm=sin(spiral+sin(angle*2.0-r*7.0)*0.35);
  let upperCenter=0.79+arm*select(0.055,0.018,hurricane)+(r-0.6)*0.06
    +(shape.g-0.5)*select(0.060,0.024,hurricane)+(rolls.g-0.5)*0.039;
  let upperHalf=0.070+smoothstep(-0.65,0.85,arm)*0.055;
  let upperOuter=0.94+arm*0.025+(shape.b-0.5)*0.035;
  let upperInner=select(0.30,hurricaneWallRadius(angle,y)+(rolls.b-0.5)*0.054,hurricane);
  let upper=min(min((r-upperInner)*8.0,(upperOuter-r)*10.0),
    (upperHalf-abs(y-upperCenter))*12.0);
  form=cloudSoftUnion(form,upper);
  // Both decks taper to zero before the finite cache boundary.
  form=min(form,(0.985-r)*12.0);
  // Roughen only a bounded skin. Dense interiors and the empty eye remain
  // intact, rather than carving the whole volume into detached wisps.
  let skin=(1.0-smoothstep(0.45,1.2,max(form,0.0)))
    *(1.0-smoothstep(0.10,0.65,max(-form,0.0)));
  let looseRoughness=clamp(billow,-0.80,0.70)-(grain-0.35)*0.34-abs(detail.r-detail.b)*0.24;
  let tightRoughness=clamp((shape.r-0.5)*0.32+(shape.g-0.5)*0.20+(shape.b-0.5)*0.12,-0.16,0.14)
    -(grain-0.35)*0.06-abs(detail.r-detail.b)*0.05;
  let roughOffset=select(looseRoughness,tightRoughness,hurricane);
  // Positive noise cannot seed a second population in empty space outside the
  // storm. Keep the breakup attached to the scaffold's existing surface.
  let attachedOffset=min(roughOffset,max(form+0.04,0.0)*1.2);
  let eroded=min(form+attachedOffset*skin,
    (0.98-r)*12.0);
  let presence=smoothstep(0.0,0.15,C.globalCoverage)*(1.0-smoothstep(0.94,0.985,r));
  return vec3<f32>((smoothstep(-0.05,0.27,eroded)*0.75+rain)*presence,
    (smoothstep(-0.05,0.27,form)*0.75+rain)*presence,eroded);
}

fn cloudTorusDistance(p: vec3<f32>) -> f32 {
  let v = p - (FIELD.gridMin.xyz + FIELD.gridSize.xyz * 0.5);
  let c = cos(FIELD.volume.y);
  let s = sin(FIELD.volume.y);
  let tilted = vec3<f32>(v.x, c * v.y + s * v.z, -s * v.y + c * v.z);
  let q = vec3<f32>(cos(0.35) * tilted.x + sin(0.35) * tilted.y,
    -sin(0.35) * tilted.x + cos(0.35) * tilted.y, tilted.z);
  let extent = min(min(FIELD.gridSize.x, FIELD.gridSize.y), FIELD.gridSize.z) * 0.5;
  return length(vec2<f32>(length(q.xz) - extent * FIELD.volume.z, q.y)) - extent * FIELD.volume.w;
}

fn galleryRotate(p:vec3<f32>, angle:f32) -> vec3<f32> {
  let a=vec3<f32>(cos(angle)*p.x+sin(angle)*p.z,p.y,-sin(angle)*p.x+cos(angle)*p.z);
  let b=angle*0.73;
  return vec3<f32>(a.x,cos(b)*a.y+sin(b)*a.z,-sin(b)*a.y+cos(b)*a.z);
}
fn cloudGalleryDistance(p:vec3<f32>) -> f32 {
  let extent=min(min(FIELD.gridSize.x,FIELD.gridSize.y),FIELD.gridSize.z)*0.5;
  let v=(p-(FIELD.gridMin.xyz+FIELD.gridSize.xyz*0.5))/extent;
  let t=FIELD.volume.y;
  let ring=galleryRotate(v,t);
  var distance=length(vec2<f32>(length(ring.xz)-0.38,ring.y))-0.105;
  let cube=abs(galleryRotate(v-vec3<f32>(-.62,.39,0),t*1.7))-vec3<f32>(.175);
  distance=min(distance,length(max(cube,vec3<f32>(0)))+min(max(max(cube.x,cube.y),cube.z),0.0));
  let egg=galleryRotate(v-vec3<f32>(.62,.39,0),t*2.3);
  distance=min(distance,(length(egg/vec3<f32>(.23,.13,.17))-1.0)*.13);
  var capsule=galleryRotate(v-vec3<f32>(-.60,-.43,0),t*2.8);
  capsule.y-=clamp(capsule.y,-.16,.16);
  distance=min(distance,length(capsule)-.11);
  let diamond=abs(galleryRotate(v-vec3<f32>(.60,-.43,0),t*3.2));
  distance=min(distance,(diamond.x+diamond.y+diamond.z-.30)*0.57735);
  return distance*extent;
}

fn arbitraryCloudBody(p: vec3<f32>, shape: vec4<f32>, detail: vec3<f32>) -> vec3<f32> {
  // A fully three-dimensional noise population, rather than extruding the
  // flat layer's common base through a torus. The mask can be replaced by any
  // other signed-distance function without changing raymarch/lighting stages.
  let fbm = dot(shape.gba, vec3<f32>(0.625, 0.25, 0.125));
  let baseShape = contrast01(shape.r, 1.24 + cloudDefinition01() * 0.38);
  let shelfShape = saturate((baseShape - fbm * 0.72) / max(1.0 - fbm * 0.72, 0.08));
  let macroSigned = 0.24 + (shelfShape - 0.22) * 0.55 + (fbm - 0.5) * 0.20;
  let scallop = mix_f(max(max(detail.r, detail.g), detail.b), 1.0 - min(min(detail.r, detail.g), detail.b), 0.42);
  let erosion = dot(detail, vec3<f32>(0.42, 0.34, 0.24)) * 0.10 + pow(1.0 - ridge01(contrast01(scallop, 2.4)), 1.35) * 0.14;
  let material = p + NTransform.shapeOffsetWorld;
  let weatherScale = select(NTransform.weatherScale, 1.0, NTransform.weatherScale == 0.0);
  let weather = wrap2D(weather2D, samp2D, fieldWeatherUV(material, weatherScale), 0i, 0.0);
  let presence = smoothstep(0.0, 0.15, C.globalCoverage) * mix_f(0.65, 1.0, saturate(weather.r)) * (1.0 - smoothstep(0.85, 1.0, weather.b));
  let variation = mix_f(0.55, 1.0, shelfShape) * presence;
  return vec3<f32>(smoothstep(-0.065, 0.28, macroSigned - erosion) * variation,
    smoothstep(-0.065, 0.28, macroSigned) * variation, macroSigned - erosion * 0.65);
}

@compute @workgroup_size(4, 4, 4)
fn buildCloudDensityField(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  initCloudWorkgroup(lid);
  if (any(gid >= FIELD.dimensions.xyz)) { return; }
  let uv = (vec3<f32>(gid) + 0.5) / vec3<f32>(FIELD.dimensions.xyz);
  let p = FIELD.gridMin.xyz + uv * FIELD.gridSize.xyz;
  let spacing = FIELD.gridSize.xyz / vec3<f32>(FIELD.dimensions.xyz);
  let localPlanet = isLocalPlanetCloud(TUNE.formType);
  if (localPlanet && FIELD.volume.x <= 0.5) {
    // Planet-equivalent volumes sample their own weather and 3D shape domains.
    let body = localPlanetCloudBody(p, uv.y, spacing);
    storeCloudDensity(gid, body, localPlanetDensityScale(uv));
    return;
  }
  var materialP=p;
  if(TUNE.formType>10.5 && TUNE.formType<12.5){materialP=stormMaterialPosition(p);}
  let ph = uv.y;
  // These forms already have a vertical scaffold and an anvil. Applying the
  // thin-layer's anvil warp/vertical retiling again aliases that texture into
  // horizontal stripes/speckles, especially in tall storms. Use world-space,
  // voxel-bandlimited noise here; keep the original mapping in Layer mode.
  let shapeAxisInput = axisOrOne3(NTransform.shapeAxisScale);
  let detailAxisInput = axisOrOne3(NTransform.detailAxisScale);
  // Tall presets used thin-layer Y compression, producing horizontal noise
  // rings on the towers. In a true volume use near-isotropic rolling structure.
  let shapeAxis = vec3<f32>(shapeAxisInput.x, sign(shapeAxisInput.y) * sqrt(abs(shapeAxisInput.y)), shapeAxisInput.z);
  let detailAxis = vec3<f32>(detailAxisInput.x, sign(detailAxisInput.y) * sqrt(abs(detailAxisInput.y)), detailAxisInput.z);
  // Thin-layer noise repeated too rapidly across tall bodies, breaking every
  // shoulder into vapor. Separate the broad rolling mass from detail erosion.
  let shapeScale = wg_scaleS * select(NTransform.shapeScale, 1.0, NTransform.shapeScale == 0.0)
    * select(0.35,0.85,TUNE.formType>8.5);
  let featureShapeScale=shapeScale*select(select(select(1.0,2.2,TUNE.formType>9.5),3.2,TUNE.formType>12.5),
    select(4.0,5.2,TUNE.formType>11.5),TUNE.formType>10.5 && TUNE.formType<12.5);
  // Thin-layer detail repeats several times per world unit. At field resolution
  // that selects the final 1x1 mip and erases every valley. Map those same bands
  // to resolvable billow-sized features; still use the actual voxel footprint.
  let detailScale = wg_scaleD * select(NTransform.detailScale, 1.0, NTransform.detailScale == 0.0)
    * select(0.04,0.065,TUNE.formType>11.5 && TUNE.formType<12.5);
  // Include the sheared storm material mapping in its filter footprint. This
  // keeps fine bands below the voxel limit without raising cache resolution.
  let stormFilter=select(1.0,1.6,TUNE.formType>10.5 && TUNE.formType<12.5);
  let shapeFootprint = spacing * abs(shapeAxis * featureShapeScale) * wg_shapeDim * stormFilter;
  let detailFootprint = spacing * abs(detailAxis * detailScale) * wg_detailDim * stormFilter;
  let shapeLOD = clamp(log2(max(max(shapeFootprint.x, shapeFootprint.y), max(shapeFootprint.z, 1.0))), 0.0, wg_maxMipS);
  let detailLOD = clamp(log2(max(max(detailFootprint.x, detailFootprint.y), max(detailFootprint.z, 1.0))), 0.0, wg_maxMipD);
  let detailAdvection=NTransform.detailOffsetWorld*select(1.0,0.15,TUNE.formType>10.5 && TUNE.formType<12.5);
  let detail = wrap3D_detail(detail3D, sampDetail, (materialP + detailAdvection) * fieldPeriodicScale(detailAxis * detailScale), detailLOD).rgb;
  // The independently moving detail domain bends shoulders as well as eroding
  // them. This is continuous volumetric billowing, not a time-varying Y scale.
  let detailWarp = (detail - 0.5) * max(TUNE.puffScale, 0.75) * vec3<f32>(0.16, 0.12, 0.16);
  // Tight surface billows drift more slowly than the organizing storm/sea
  // scaffold, retaining its rotation and swells without rapid small features.
  let shapeAdvection=NTransform.shapeOffsetWorld*select(select(1.0,0.35,TUNE.formType>10.5),0.025,TUNE.formType>10.5 && TUNE.formType<12.5);
  let shape = wrap3D_shape(shape3D, sampShape, (materialP + detailWarp + shapeAdvection) * fieldPeriodicScale(shapeAxis * featureShapeScale), shapeLOD);
  // All four prefiltered shape bands contribute: broad domain distortion hides
  // the scaffold; the Rain Shelf closure gives the whole volume broken density.
  // No additional texture fetches or per-ray procedural noise are required.
  let distortion = (shape.gba - 0.5) * max(TUNE.puffScale, 0.75) * vec3<f32>(0.32, 0.18, 0.32) + detailWarp;
  var body: vec3<f32>;
  var baseFade = 1.0;
  if (FIELD.volume.x > 0.5) {
    body = arbitraryCloudBody(p, shape, detail);
    var distance = cloudTorusDistance(p);
    if(FIELD.volume.x > 1.5) { distance=cloudGalleryDistance(p); }
    let feather = max(max(spacing.x, spacing.y), spacing.z) * 1.2;
    let irregularDistance=distance+(shape.g-0.5)*max(feather*2.0,TUNE.puffScale*0.16)+(detail.g-0.5)*feather*0.5;
    let mask = 1.0 - smoothstep(-feather, feather, irregularDistance);
    body = vec3<f32>(body.xy * mask, min(body.z, -irregularDistance / max(feather * 4.0, EPS)));
  } else if (TUNE.formType > 12.5) {
    body=cloudSeaBody(p,shape,detail);
  } else if (TUNE.formType > 10.5) {
    // The material-space octave moves the storm shoulders and the eyewall
    // surface in broad folds. Keep its footprint resolved when the grid changes.
    let rollRate = 0.36 / max(TUNE.puffScale, 0.75);
    let rollFootprint = max(max(spacing.x * wg_shapeDim.x, spacing.y * wg_shapeDim.y), spacing.z * wg_shapeDim.z) * rollRate * stormFilter;
    let rollLod = clamp(log2(max(rollFootprint, 1.0)), 0.0, wg_maxMipS);
    let rolls = textureSampleLevel(shape3D, sampShape,
      (materialP + shapeAdvection) * rollRate + vec3<f32>(0.49, 0.31, 0.71), rollLod);
    body=rotatingStormBody(p,shape,detail,rolls);
  } else if (TUNE.formType > 9.5) {
    body=parallelCloudBandBody(p,shape,detail);
  } else if (TUNE.formType > 8.5) {
    body = cachedInkFoldBody(p, shape, detail);
    baseFade = smoothstep(0.02, 0.08, ph) * (1.0 - smoothstep(0.92, 0.98, ph));
  } else if (TUNE.formType > 7.5) {
    body = morningRuffleBody(p, shape, detail, spacing.y);
    baseFade = smoothstep(0.02, 0.08, ph) * (1.0 - smoothstep(0.96, 1.0, ph));
  } else if (marineCumulusForm()) {
    let relativeScale = clamp(abs(NTransform.shapeScale) / 0.20, 0.25, 4.0);
    let anvil = TUNE.formType == 1.4375;
    let rollScale = select(1.0, 1.32, anvil);
    let billowScale = fieldPeriodicScale(abs(shapeAxis) * vec3<f32>(0.51, 0.61, 0.51) * (relativeScale * rollScale / max(TUNE.puffScale, 0.75)));
    let billowFootprint = spacing * billowScale * wg_shapeDim;
    let billowLod = clamp(log2(max(max(billowFootprint.x, billowFootprint.y), max(billowFootprint.z, 1.0))), 0.0, wg_maxMipS);
    let planarRegionScale = fieldPeriodicScale(billowScale * 0.19);
    let regionScale = vec3<f32>(planarRegionScale.x,
      max(billowScale.y * 0.37, min(planarRegionScale.x, planarRegionScale.z)), planarRegionScale.z);
    let domain = p + shapeAdvection;
    let height = p.y - FIELD.gridMin.y;
    let regionalUV = domain * regionScale + vec3<f32>(height * regionScale.y * 0.48, 0.0, -height * regionScale.y * 0.35);
    // Planet noise is periodic already. Sampling its tile directly preserves
    // both sides of the volume seam at the grid's integral horizontal periods.
    let shapeBias = vec4<f32>(NTransform.shapeBias);
    let regionalShape = clamp(textureSampleLevel(shape3D, sampShape,
      regionalUV + vec3<f32>(0.62, 0.11, 0.28), 0.0) + shapeBias, vec4<f32>(0.0), vec4<f32>(1.0));
    let rolled = domain + (regionalShape.arg - 0.5) * TUNE.puffScale * vec3<f32>(0.40, 0.23, 0.38);
    // Tilt the storm's billow coordinates so the rising cells are broken at
    // different heights across the face instead of repeating horizontal rolls.
    var billowDomain = rolled;
    if (anvil) {
      let q = rolled - B.center;
      let tilt = vec2<f32>(dot(q.xy, vec2<f32>(0.94, -0.342)), dot(q.xy, vec2<f32>(0.342, 0.94)));
      let curl = (regionalShape.b - 0.5) * TUNE.puffScale * 0.38;
      billowDomain = B.center + vec3<f32>(tilt.x, tilt.y + 0.20 * q.z + curl, q.z - 0.28 * curl);
    }
    let billowUV = billowDomain * billowScale;
    let billows = clamp(textureSampleLevel(shape3D, sampShape,
      billowUV + vec3<f32>(0.28, 0.47, 0.71), billowLod) + shapeBias, vec4<f32>(0.0), vec4<f32>(1.0));
    let smallRolls = textureSampleLevel(shape3D, sampShape,
      billowUV * 2.0 + (billows.arg - 0.5) * 0.18 + vec3<f32>(0.72, 0.26, 0.19),
      min(wg_maxMipS, billowLod + 1.0));
    var towerRolls = billows;
    if (TUNE.formType == 1.375) {
      let rollScale = fieldPeriodicScale(billowScale * 0.42);
      let baseDomain = vec3<f32>(rolled.x, p.y * 0.52 + B.center.y * 0.48, rolled.z);
      towerRolls = textureSampleLevel(shape3D, sampShape,
        baseDomain * rollScale + (regionalShape.gab - 0.5) * 0.16 + vec3<f32>(0.60, 0.21, 0.46),
        max(billowLod - 1.0, 0.0));
    }
    if (anvil) {
      // Sample larger rolls in an independent 3D orientation. The two scales
      // then break up the storm at different heights and viewing angles.
      let q = rolled - B.center + (regionalShape.gbr - 0.5) * TUNE.puffScale * 0.40;
      let turn = vec3<f32>(dot(q, vec3<f32>(0.79, 0.0, -0.61)),
        dot(q, vec3<f32>(0.23, 0.93, 0.30)),
        dot(q, vec3<f32>(0.56, -0.38, 0.74)));
      let towerUV = turn * billowScale * 0.52 + (billows.bra - 0.5) * 0.085;
      towerRolls = textureSampleLevel(shape3D, sampShape, towerUV + vec3<f32>(0.39, 0.79, 0.24), max(billowLod - 0.75, 0.0));
    }
    body = marineCloudBody(p + (regionalShape.arg - 0.5) * TUNE.puffScale * vec3<f32>(0.30, 0.08, 0.31),
      regionalShape, billows, smallRolls, towerRolls);
    if (TUNE.formType == 1.25 && ph > 0.64) {
      let ice = featureWeatherBody(p, shape, detail, vec3<f32>(0.15, 0.0, 0.0));
      body = vec3<f32>(body.xy + ice.xy, max(body.z, ice.z));
    }
    baseFade = smoothstep(0.015, 0.07, ph) * (1.0 - smoothstep(0.94, 1.0, ph));
  } else {
    let weights=clamp(vec3<f32>(FIELD.gridMin.w,FIELD.gridSize.w,FIELD.volume.w),vec3<f32>(0.0),vec3<f32>(1.0));
    var featureWeights = clamp(FIELD.morphology.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    if (TUNE.formType > 4.5) {
      featureWeights = vec3<f32>(select(0.0, 1.0, TUNE.formType < 5.5),
        select(0.0, 1.0, TUNE.formType >= 5.5 && TUNE.formType < 6.5), select(0.0, 1.0, TUNE.formType >= 6.5));
    }
    let layeredWeight=saturate(weights.x+weights.y+weights.z+featureWeights.x+featureWeights.y+featureWeights.z);
    let convectiveWeight=1.0-layeredWeight;
    body=vec3<f32>(0.0,0.0,-1.0);
    if(convectiveWeight>0.0) {
      let convective=roundedCloudBody(p+distortion,shape,detail);
      body=vec3<f32>(convective.xy*convectiveWeight,convective.z-layeredWeight*0.35);
    }
    if(weights.x+weights.y+weights.z>0.0) {
      var shelfBands=shape;
      var shelfDetail=detail;
      if(weights.x>0.0) {
        // Two shelf-only filtered reads during the cached density bake, never
        // per screen ray. Separate coordinates avoid warping the towers during
        // a crossfade; each band's LOD follows the actual density-voxel footprint.
        let rippleShapeScale=shapeScale*2.35;
        let rippleDetailScale=detailScale*2.50;
        let rippleShapeFP=spacing*abs(shapeAxis*rippleShapeScale)*wg_shapeDim;
        let rippleDetailFP=spacing*abs(detailAxis*rippleDetailScale)*wg_detailDim;
        let rippleShapeLOD=clamp(log2(max(max(rippleShapeFP.x,rippleShapeFP.y),max(rippleShapeFP.z,1.0))),0.0,wg_maxMipS);
        let rippleDetailLOD=clamp(log2(max(max(rippleDetailFP.x,rippleDetailFP.y),max(rippleDetailFP.z,1.0))),0.0,wg_maxMipD);
        shelfBands=wrap3D_shape(shape3D,sampShape,(p+detailWarp*0.45+NTransform.shapeOffsetWorld)*shapeAxis*rippleShapeScale,rippleShapeLOD);
        shelfDetail=wrap3D_detail(detail3D,sampDetail,(p+NTransform.detailOffsetWorld)*detailAxis*rippleDetailScale,rippleDetailLOD).rgb;
      }
      let layered=layeredWeatherBody(p+distortion*vec3<f32>(1.0,0.45,1.0),shape,detail,weights,shelfBands,shelfDetail);
      body=vec3<f32>(body.xy+layered.xy,max(body.z,layered.z));
    }
    if (featureWeights.x+featureWeights.y+featureWeights.z > 0.0) {
      let feature = featureWeatherBody(p, shape, detail, featureWeights);
      body = vec3<f32>(body.xy+feature.xy, max(body.z, feature.z));
    }
    baseFade = smoothstep(0.02, 0.13, ph) * (1.0 - smoothstep(0.97, 1.0, ph));
  }
  let toMin = p.xz - FIELD.gridMin.xz;
  let toMax = FIELD.gridMin.xz + FIELD.gridSize.xz - p.xz;
  let edgeDistance = min(min(toMin.x, toMin.y), min(toMax.x, toMax.y));
  let edgeWidth = select(TUNE.puffScale * 0.55, FIELD.gridSize.x * 0.12, FIELD.regionWeather.x > 0.0);
  let edgeFade = select(smoothstep(0.0, max(edgeWidth, 0.1), edgeDistance),1.0,FIELD.dimensions.w>0u);
  var densityScale = max(C.globalDensity, 0.0) * 1.6 * baseFade * edgeFade;
  if (localPlanet) { densityScale = localPlanetDensityScale(uv); }
  storeCloudDensity(gid, body, densityScale);
}

fn storeCloudDensity(gid: vec3<u32>, body: vec3<f32>, densityScale: f32) {
  // B is a conservative density bound. Coarser levels take its maximum;
  // R/G/A retain their average filtering for visible density and lighting.
  textureStore(cloudDensityOut, vec3<i32>(gid), vec4<f32>(body.xy * densityScale, max(body.x * densityScale, 0.0), max(body.z, -0.30)));
}

const VOLUME_BILLOWS = 0u;
const VOLUME_FILAMENTS = 1u;
const VOLUME_LAYERS = 2u;
const VOLUME_ROTATING_STORM = 3u;
const VOLUME_MASK = 4u;

fn flatVolumeFamily() -> u32 {
  if (CLOUD_FLAT_TOWER_FORM > 0.0) { return VOLUME_BILLOWS; }
  if (FIELD.volume.x > 0.5) { return VOLUME_MASK; }
  let form = flatFormType();
  if (isLocalPlanetCloud(form)) {
    let local = localPlanetForm(form);
    if (localPlanetFilament(local)) {
      return VOLUME_FILAMENTS;
    }
    if (local == 2.50 || local == 2.54 || local == 2.55 || local == 2.56 || local == 2.60) {
      return VOLUME_LAYERS;
    }
  }
  if (form > 4.5 && form < 5.5) { return VOLUME_FILAMENTS; }
  if (form > 10.5 && form < 12.5) { return VOLUME_ROTATING_STORM; }
  return select(VOLUME_BILLOWS, VOLUME_LAYERS, form > 5.5);
}

fn capturedBillowLighting(form: f32) -> bool {
  return FIELD.regionWarp.w > 0.0 && (form == 2.125 || form == 2.58);
}

fn flatLightWidth(family: u32) -> f32 {
  if (flatFormType() == 1.4375) { return 0.112; }
  if (localPlanetAnvilForm()) { return 0.091; }
  if (flatFormType() == 6.0 || flatFormType() == 9.0) { return 0.054; }
  let widths = array<f32, 5>(0.044, 0.037, 0.074, 0.065, 0.056);
  return widths[family];
}

fn broadFlatSkylight(p: vec3<f32>, spacing: vec3<f32>) -> f32 {
  // The diffuse sky spans a hemisphere. Use several inclined paths with
  // wider density footprints as they spread, so a tiny hollow cannot
  // become an isolated pocket of painted shadow.
  let directions = array<vec3<f32>, 4>(
    vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.77, 0.64, 0.0),
    vec3<f32>(-0.385, 0.64, 0.667), vec3<f32>(-0.385, 0.64, -0.667));
  let voxel = max(max(spacing.x, spacing.z), spacing.y);
  let near = max(voxel * 1.45, TUNE.puffScale * 0.16);
  let far = max(near * 2.55, min(FIELD.gridSize.y * 0.55, TUNE.puffScale * 0.80));
  let nearLod = clamp(log2(max(near / voxel, 1.0)), 0.9, 2.2);
  let farLod = clamp(log2(max(far / voxel, 1.0)), nearLod + 0.65, 3.0);
  let body = fieldSampleAtLod(p, nearLod).g;
  var exposure = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let open = directions[i];
    let inner = fieldSampleAtLod(p + open * near, nearLod).g;
    let outer = fieldSampleAtLod(p + open * far, farLod).g;
    let depth = (0.34 * body + 0.85 * inner + 1.12 * outer) * near;
    exposure += exp(-depth * SUN_EXTINCTION_SCALE * 2.3);
  }
  return exposure * 0.25;
}

fn coastalDuskStrength(sunHeight: f32) -> f32 {
  return smoothstep(-0.14, -0.01, sunHeight) * (1.0 - smoothstep(0.12, 0.36, sunHeight));
}

// A low sun brightens the air along the horizon beneath a bank. Trace the
// near folds and the intervening air toward that part of the sky. This term
// supplies gradual color variation when the direct ray is fully occluded.
fn coastalHorizonAccess(p: vec3<f32>, sunDir: vec3<f32>, spacing: vec3<f32>) -> f32 {
  let sunward = normalizeOr(vec3<f32>(sunDir.x, 0.0, sunDir.z), vec3<f32>(0.0, 0.0, 1.0));
  let side = vec3<f32>(-sunward.z, 0.0, sunward.x);
  let voxel = max(max(spacing.x, spacing.z), spacing.y);
  let near = max(voxel * 1.35, TUNE.puffScale * 0.14);
  let far = max(near * 3.0, TUNE.puffScale * 0.71);
  let mid = mix(near, far, 0.36);
  let midMip = clamp(log2(max(mid * 0.42 / voxel, 1.0)), 0.0, 2.0);
  let farMip = clamp(log2(max(far * 0.36 / voxel, 1.0)), 0.5, 2.6);
  var irradiance = 0.0;
  for (var i = 0u; i < 3u; i++) {
    let spread = f32(i) - 1.0;
    let direction = normalize(sunward + side * spread * 0.54 + vec3<f32>(0.0, 0.072 - abs(spread) * 0.16, 0.0));
    let fold = fieldSampleAtLod(p + direction * near, 0.75).g;
    let passage = fieldSampleAtLod(p + direction * mid, midMip).g;
    let exit = fieldSampleAtLod(p + direction * far, farMip).g;
    let depth = (fold * near + passage * mid * 0.76 + exit * far * 0.52) * SUN_EXTINCTION_SCALE;
    irradiance += exp(-depth * 2.65) * select(0.27, 0.46, i == 1u);
  }
  return irradiance;
}

// Cool diffuse light from below and across the bank is occluded by
// different folds than the warm horizon light. A pair of distances keeps
// shallow folds distinct without making the response sensitive to voxel pitch.
fn squallUndersideAccess(p: vec3<f32>, sunDir: vec3<f32>, spacing: vec3<f32>, localField: vec4<f32>) -> f32 {
  let away = normalizeOr(vec3<f32>(-sunDir.x, 0.0, -sunDir.z), vec3<f32>(0.0, 0.0, -1.0));
  let side = vec3<f32>(-away.z, 0.0, away.x);
  let horizontal = max(spacing.x, spacing.z);
  let near = max(horizontal * 0.96, TUNE.puffScale * 0.084);
  let far = max(near * 2.85, TUNE.puffScale * 0.30);
  let farLod = clamp(log2(max(far * 0.64 / horizontal, 1.0)), 0.70, 2.50);
  var access = 0.0;
  for (var i = 0u; i < 3u; i++) {
    let azimuth = f32(i) - 1.0;
    let direction = normalize(away * (0.52 + 0.27 * abs(azimuth)) + side * azimuth * 0.74
      + vec3<f32>(0.0, -0.80 + abs(azimuth) * 0.47, 0.0));
    let inner = fieldSampleAtLod(p + direction * near, 0.54);
    let outer = fieldSampleAtLod(p + direction * far, farLod).g;
    let pathDepth = (0.21 * localField.g + 0.86 * inner.g) * near
      + (far - near) * (0.36 * inner.g + 0.64 * outer);
    let visibility = exp(-pathDepth * SUN_EXTINCTION_SCALE * 5.40);
    let falloff = (localField.a - inner.a) / near;
    let facing = smoothstep(-0.30, 0.53, falloff);
    access += visibility * mix(0.43, 1.0, facing);
  }
  return access / 3.0;
}

@compute @workgroup_size(4, 4, 4)
fn buildCloudLightField(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= FIELD.dimensions.xyz)) { return; }
  let uv = (vec3<f32>(gid) + 0.5) / vec3<f32>(FIELD.dimensions.xyz);
  let p = FIELD.gridMin.xyz + uv * FIELD.gridSize.xyz;
  let spacing = FIELD.gridSize.xyz / vec3<f32>(FIELD.dimensions.xyz);
  // This invocation is already at the centre of the density texel.
  let localField = textureLoad(cloudDensityField, vec3<i32>(gid), 0);
  let current = localField.g;
  let offsets = array<vec3<f32>, 6>(vec3<f32>(1,0,0), vec3<f32>(-1,0,0), vec3<f32>(0,1,0), vec3<f32>(0,-1,0), vec3<f32>(0,0,1), vec3<f32>(0,0,-1));
  var neighbors: array<f32, 6>;
  let localBank = localPlanetConvectiveForm();
  let bankLighting = marineCumulusForm() || localBank;
  let family = flatVolumeFamily();
  let volumeLighting = TUNE.formType > 0.5;
  let lightWidth = flatLightWidth(family);
  let normalSpacing = spacing * select(1.5, 0.96, bankLighting);
  let sunDir = normalizeOr(L.sunDir, vec3<f32>(0.0, 1.0, 0.0));
  var needsNeighbors = !volumeLighting;
  if (volumeLighting && current < 0.0001) {
    // Keep light around wisps using the same physical footprint at every grid
    // resolution. Occupied voxels and the mip halo already need real lighting.
    let horizontal = max(spacing.x, spacing.z);
    let haloLod = clamp(log2(max(TUNE.puffScale * max(0.085, lightWidth) / horizontal, 2.0)), 1.0, 3.0);
    needsNeighbors = fieldSampleAtLod(p, haloLod).b < 0.0001;
  }
  if (needsNeighbors) {
    var nearbyDensity = current;
    for (var i = 0u; i < 6u; i++) {
      let neighbor = fieldSampleAt(p + offsets[i] * normalSpacing);
      neighbors[i] = neighbor.a;
      nearbyDensity = max(nearbyDensity, neighbor.g);
      if (volumeLighting && nearbyDensity >= 0.0001) { break; }
    }
    if (nearbyDensity < 0.0001) {
      textureStore(cloudLightOut, vec3<i32>(gid), vec4<f32>(max(sunDir.y, 0.0), 1.0, 1.0, 1.0));
      return;
    }
  }
  let reach = min(4.6, max(TUNE.puffScale * 0.95, FIELD.gridSize.y * 0.85));
  // Midpoint quadrature, with two samples per crossed density cell. The cap
  // bounds cached-field work; no secondary march is added to screen-space rays.
  let sunVoxelStep = 1.0 / max(max(abs(sunDir.x) / spacing.x, abs(sunDir.y) / spacing.y), abs(sunDir.z) / spacing.z);
  let shadowSteps = u32(clamp(ceil(reach / sunVoxelStep * 2.0), 16.0,
    select(48.0,24.0,TUNE.formType>8.5)));
  let step = reach / f32(shadowSteps);
  var opticalDepth = 0.0;
  var localOpticalDepth = 0.0;
  if (volumeLighting) {
    // Follow sunlight past the small surface lobes and through the rest of a
    // bank. Nearby samples stay fine; larger distant intervals use density
    // mips. This still uses the same number of cached lighting samples.
    let reachLimit = max(reach, min(FIELD.gridSize.x, FIELD.gridSize.z) * 0.56);
    // At low sun the neighboring banks cast substantially longer shadows.
    // Keep the same tap budget and spend the additional reach on coarse mips.
    let grazingReach = 1.0 + select(0.0, 0.85 * (1.0 - smoothstep(0.07, 0.48, abs(sunDir.y))), localBank);
    let widerBank = max(FIELD.gridSize.y * 1.46, TUNE.puffScale * 2.25) * grazingReach;
    // Thin ice needs only a modest local path. Larger layered and rotating
    // forms catch shadows from across the trough or opposite storm shoulder.
    let reachFactor = array<f32, 5>(1.42, 1.18, 1.80, 2.80, 1.52);
    let formReach = max(reach * reachFactor[family], TUNE.puffScale * 1.30);
    let wideReach = clamp(select(formReach, widerBank, bankLighting), reach, reachLimit);
    let sunwardEdge = select(FIELD.gridMin.y, FIELD.gridMin.y + FIELD.gridSize.y, sunDir.y > 0.0);
    let verticalExit = abs(sunwardEdge - p.y) / max(abs(sunDir.y), EPS);
    let boxHit = intersectAABB_robust(p, sunDir, FIELD.gridMin.xyz, FIELD.gridMin.xyz + FIELD.gridSize.xyz);
    let tiled = FIELD.dimensions.w > 0u || (CLOUD_FROZEN_PATTERN != 0u && FIELD.patternMotion.w > 0.5);
    let span = min(wideReach, select(max(boxHit.y, 0.0), verticalExit, tiled));
    let localReach = clamp(TUNE.puffScale * 0.19, 0.66, 2.65);
    let volumeFootprint = TUNE.puffScale * select(min(lightWidth, 0.064), 0.044, marineCumulusForm());
    let sunUv = sunDir / max(FIELD.gridSize.xyz, vec3<f32>(EPS));
    var lo = 0.0;
    for (var i = 0u; i < shadowSteps; i++) {
      let f = f32(i + 1u) / f32(shadowSteps);
      let hi = span * f * (0.18 + 0.82 * f * f);
      let sampleDistance = (lo + hi) * 0.5;
      let sampleLength = hi - lo;
      // Scattering broadens the distant shadow. Leave the nearest lobes
      // at native resolution so the lit and shaded faces remain distinct.
      let shadowFootprint = max(volumeFootprint, max(sampleLength, sampleDistance * 0.065));
      let lod = clamp(log2(max(shadowFootprint / sunVoxelStep, 1.0)), 0.0, 3.0);
      var at = uv + sunUv * sampleDistance;
      if (tiled) { at = vec3<f32>(fract(at.x), at.y, fract(at.z)); }
      let density = textureSampleLevel(cloudDensityField, cloudFieldSampler, at, lod).g;
      let wideWeight = mix(1.0, 0.49, smoothstep(2.0, 8.0, sampleDistance));
      let extinction = density * SUN_EXTINCTION_SCALE;
      opticalDepth += extinction * sampleLength * wideWeight;
      localOpticalDepth += extinction * clamp(localReach - lo, 0.0, sampleLength);
      lo = hi;
    }
  } else {
    for (var i = 0u; i < shadowSteps; i++) {
      opticalDepth += fieldDensityAt(p + sunDir * ((f32(i) + 0.5) * step)).y * step * SUN_EXTINCTION_SCALE;
    }
  }
  let beer = max(C.cloudBeer, EPS);
  let sunVisibility = exp(-opticalDepth * beer);
  if (volumeLighting) {
    var skyAccess = broadFlatSkylight(p, spacing);
    let twilight = select(0.0, coastalDuskStrength(sunDir.y), marineCumulusForm());
    if (twilight > 0.001) {
      let horizonAccess = coastalHorizonAccess(p, sunDir, spacing);
      skyAccess = mix(skyAccess, horizonAccess, twilight * 0.71);
      if (TUNE.formType == 1.375) {
        // Close, diagonal probes in the signed density field distinguish
        // exposed folds from covered ones even when solar visibility is zero.
        let openDirection = normalizeOr(vec3<f32>(sunDir.x, -0.32, sunDir.z), vec3<f32>(0.0, -0.32, 1.0));
        let offset = max(max(spacing.x, spacing.z) * 1.15, TUNE.puffScale * 0.105);
        let nearForm = fieldSampleAt(p + openDirection * offset).a;
        let outerForm = fieldSampleAt(p + openDirection * (2.0 * offset)).a;
        let falloff = (localField.a - mix(nearForm, outerForm, 0.30)) / offset;
        let facing = smoothstep(-0.22, 0.51, falloff);
        let skin = smoothstep(-0.15, 0.10, localField.a) * (1.0 - smoothstep(0.36, 1.0, localField.a));
        skyAccess = clamp(skyAccess * mix(1.0, mix(0.67, 1.27, facing), skin * twilight), 0.0, 1.0);
      }
    }
    let facetWidth = select(0.14, 0.20, family == VOLUME_LAYERS || family == VOLUME_ROTATING_STORM);
    let broadProbe = max(sunVoxelStep * 1.8, min(TUNE.puffScale * facetWidth, 1.65));
    let nearProbe = max(sunVoxelStep, broadProbe * 0.44);
    if (family == VOLUME_LAYERS || family == VOLUME_ROTATING_STORM || family == VOLUME_MASK) {
      // Use the falloff of the signed form toward the open upper hemisphere.
      // Smooth it over multiple voxels. Tiny occluded ridges should create
      // contact shading without becoming dark grid-aligned facets.
      let towardEye = normalizeOr(vec3<f32>(B.center.x - p.x, 0.0, B.center.z - p.z), vec3<f32>(0.0));
      let skyDirection = select(vec3<f32>(-sunDir.x * 0.32, 1.0, -sunDir.z * 0.32),
        towardEye * 0.86 + vec3<f32>(0.0, 0.62, 0.0), TUNE.formType == 12.0);
      let upperDir = normalize(skyDirection);
      let upperProbe = max(max(spacing.x, spacing.z) * 1.8, min(TUNE.puffScale * 0.14, 1.05));
      let upperForm = fieldSampleAt(p + upperDir * upperProbe).a;
      let deckForm = fieldSampleAt(p + upperDir * (upperProbe * 2.0)).a;
      let skySlope = (localField.a - (upperForm * 0.72 + deckForm * 0.28)) / upperProbe;
      let facing = smoothstep(-0.63, 0.95, skySlope);
      let skin = (1.0 - smoothstep(0.12, 0.90, localField.a)) * smoothstep(-0.15, 0.06, localField.a);
      let contact = mix(0.70, 1.12, facing);
      skyAccess = saturate(skyAccess * mix(1.0, contact, skin)
        + skin * facing * (1.0 - skyAccess) * select(0.16, 0.32, family == VOLUME_ROTATING_STORM));
    }
    let broadForm = fieldSampleAt(p + sunDir * broadProbe).a;
    let nearForm = fieldSampleAt(p + sunDir * nearProbe).a;
    let broadSlope = (localField.a - broadForm) / broadProbe;
    let nearSlope = (localField.a - nearForm) / nearProbe;
    let directExposure = smoothstep(0.10, 0.66, sunVisibility);
    let capturedBillow = capturedBillowLighting(localPlanetForm(TUNE.formType));
    // Reuse the narrower tap to light the individual folds. Keep the
    // broader tap dominant where thick banks block the direct path.
    let slope = mix(broadSlope, nearSlope, directExposure * select(0.37, 0.57, capturedBillow));
    let facet = smoothstep(select(-0.40, -0.29, capturedBillow),
      select(0.61, 0.49, capturedBillow), slope);
    // Thin filaments transmit light across their widths, even on a shaded face.
    let filamentContrast = select(0.56, 0.68, capturedBillow);
    var diffuse = select(facet, mix(0.46, facet, filamentContrast), family == VOLUME_FILAMENTS);
    if (capturedBillow) {
      // The radial height tracks the sheet down toward the horizon. Extra
      // open-sky fill at the top leaves the lower folds to the softer bounce.
      let tangent = p.xz / max(FIELD.regionWarp.y + p.y, EPS);
      let height = capturedRadialPhase(p, tangent);
      let skyProfile = mix(0.57, 1.0, smoothstep(0.12, 0.80, height));
      skyAccess *= mix(skyProfile, 1.0, diffuse * directExposure * 0.35);
    }
    let shade = (1.0 - smoothstep(0.018, 0.21, sunVisibility)) * smoothstep(0.0, 0.22, twilight);
    if (TUNE.formType == 1.375 && shade > 0.001) {
      // Positive values carry the direct facet. Negative values carry
      // the underside response where long-path sunlight is negligible.
      // Linear filtering can blend them near the transition.
      let below = squallUndersideAccess(p, sunDir, spacing, localField);
      diffuse = mix(diffuse, -below, shade);
    }
    let localSun = exp(-localOpticalDepth * beer);
    textureStore(cloudLightOut, vec3<i32>(gid), vec4<f32>(diffuse, localSun, sunVisibility, skyAccess));
    return;
  }
  // Legacy lighting uses the signed-form gradient for its surface normal.
  let gradient = vec3<f32>(neighbors[0] - neighbors[1], neighbors[2] - neighbors[3], neighbors[4] - neighbors[5]) / max(normalSpacing, vec3<f32>(EPS));
  let normal = normalizeOr(-gradient, vec3<f32>(0.0, 1.0, 0.0));
  let aoRadius = max(TUNE.puffScale * 0.12, min(FIELD.gridSize.y * 0.12, 0.50));
  var surrounding = 0.0;
  for (var i = 0u; i < 6u; i++) {
    let weight = 0.15 + 0.85 * max(dot(offsets[i], normal), 0.0);
    let near = fieldDensityAt(p + offsets[i] * aoRadius).y;
    let far = fieldDensityAt(p + offsets[i] * aoRadius * 2.4).y;
    surrounding += (max(near - current * 0.20, 0.0) * 0.6 + max(far - current * 0.10, 0.0) * 0.4) * weight;
  }
  let ambientVisibility = clamp(exp(-surrounding * aoRadius * 0.065), 0.18, 1.0);
  let diffuse = max(dot(normal, sunDir), 0.0);
  let skyOrLocalSun = saturate(normal.y * 0.5 + 0.5);
  textureStore(cloudLightOut, vec3<i32>(gid), vec4<f32>(diffuse, skyOrLocalSun, sunVisibility, ambientVisibility));
}
