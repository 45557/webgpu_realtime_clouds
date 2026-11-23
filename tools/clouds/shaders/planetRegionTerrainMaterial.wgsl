struct RegionMaterialFrame {
  up: vec3<f32>, radius: f32,
  east: vec3<f32>, metersPerUnit: f32,
  south: vec3<f32>, datum: f32,
  spacing: f32, seed: u32, hasSea: u32, skylightHalf: f32,
  rock: RegionRockAnchor,
}

fn region_shore_coverage(shore: vec3<f32>) -> f32 {
  // Interpolate signed elevations before filtering. A blend of wet and dry
  // vertex flags would spread water across the entire last land triangle.
  let width = max(fwidth(shore.y) * .65, 1e-7);
  return mix(shore.x, 1.0 - smoothstep(-width, width, shore.y), shore.z);
}

fn region_land_color(p: vec3<f32>, baseHeight: f32, normal: vec3<f32>, albedo: vec3<f32>,
    sun: vec3<f32>, sunVisibility: f32, skyVisibility: f32, footprint: f32, frame: RegionMaterialFrame) -> vec3<f32> {
  var n = normalize(normal);
  var tint = 1.0;
  var baseColor = albedo;
  var stoneDirect = 1.0;
  var stoneAmbient = 1.0;
  if (footprint < regionDetailScales[0] * .34) {
    let ground = p * frame.metersPerUnit;
    let radial = normalize(frame.up + (frame.east * ground.x + frame.south * ground.z) / frame.radius);
    let surface = radial * frame.radius;
    // Prevent the finest bands from stepping at f32 precision on larger planets.
    let detailFootprint = max(footprint, frame.radius * 1.8e-7);
    let stone = region_detail_strength(sqrt(max(0.0, 1.0 - n.y * n.y)));
    var gradient = vec3<f32>(0.0);
    for (var i = 0u; i < 9u; i++) {
      let scale = regionDetailScales[i];
      let projected = region_detail_weight(scale, detailFootprint);
      if (projected <= 0.0) { break; }
      // Carry the slope energy into the image below what the mesh can hold.
      let beyondMesh = 1.0 - region_detail_weight(scale, frame.spacing);
      let bandPoint = surface + radial * (frame.datum + baseHeight * frame.metersPerUnit) * select(0.0, .75, i >= 5u);
      let sample = region_detail_band(bandPoint, i, frame.seed);
      tint += sample.x / regionDetailAmplitudes[i] * projected * mix(.080, .17, stone);
      gradient += sample.yzw * projected * beyondMesh;
    }
    let relative = region_rock_point(vec3<f32>(ground.x, frame.datum + baseHeight * frame.metersPerUnit, ground.z),
      frame.up, frame.east, frame.south, frame.radius);
    let groundNormal = normalize(frame.east * n.x + radial * n.y + frame.south * n.z);
    let worldSun = normalize(frame.east * sun.x + radial * sun.y + frame.south * sun.z);
    let rock = region_rock_material(relative, frame.rock, frame.seed, footprint, albedo, radial,
      groundNormal, worldSun, sunVisibility > .07 && sun.y > .02);
    baseColor = rock.color;
    stoneDirect = rock.direct;
    stoneAmbient = rock.ambient;
    gradient = gradient * stone + rock.slope;
    let detail = vec3<f32>(dot(gradient, frame.east), dot(gradient, radial), dot(gradient, frame.south));
    n = normalize(n - (detail - n * dot(n, detail)));
  }
  let ambient = mix(vec3<f32>(.23, .29, .37), vec3<f32>(.38, .43, .50), n.y);
  let daylight = vec3<f32>(1.05, .97, .87) * max(dot(n, sun), 0.0) * (.88 * sunVisibility * stoneDirect * smoothstep(-.005, .05, sun.y));
  // The sky is cooler than the ground bounce that remains in enclosed folds.
  let groundBounce = ambient * vec3<f32>(.53, .47, .42);
  return baseColor * tint * (mix(groundBounce, ambient, skyVisibility) * stoneAmbient + daylight);
}
