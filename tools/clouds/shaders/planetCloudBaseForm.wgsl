fn genericPlanetCloudForm(ph: f32, wm: vec4<f32>, s: vec4<f32>, amount: f32, formType: f32) -> vec2<f32> {
  let cute = clamp(formType - 1.0, 0.0, 1.0);
  let coverage = clamp(amount * mix(0.72, 1.0, max(wm.r, wm.g * 0.65)), 0.0, 1.0);
  let scattered = formType >= 3.5 && formType < 4.5;
  let gas = formType >= 4.5;
  let hemisphere = select(1.0,wm.a,formType >= 2.5 && formType < 3.5);
  let threshold = select(mix(0.82, 0.46, coverage), 0.63, scattered) - select(0.0,0.030,cute>0.5&&!gas);
  // Smooth volumetric FBM, not a thresholded Worley edge texture extruded
  // through a shell. Broad bands form the mass, fine erosion only the rim.
  let gasMass = 0.58 + wm.a * 0.18 + (s.g-0.5)*0.12 + select(0.0,0.075,gas && formType<6.5);
  var mass = select(s.r * 0.72 + s.g * 0.20 + s.b * 0.08, gasMass, gas);
  let lower = smoothstep(0.025, mix(0.16, 0.22, cute), ph);
  let summit = clamp(0.78 + (s.a - 0.5) * mix(0.24, 0.42, cute), 0.48, 0.97);
  let upper = 1.0 - smoothstep(summit - 0.28, summit, ph);
  var form = mass - threshold - (1.0 - lower * upper) * 0.24 - (1.0-hemisphere)*0.55;
  if(cute>0.5&&!gas){
    // Broad cores rise higher; weaker outskirts round back into the base.
    // Existing 3D bands vary height/width and roughen the entire hull, avoiding
    // identical spherical primitives or a uniformly extruded shell patch.
    let center=0.43+(s.a-0.5)*0.16;
    let halfHeight=0.40+(s.b-0.5)*0.10;
    let radial=(ph-center)/halfHeight;
    form-=radial*radial*0.16;
  }
  return vec2<f32>(form,lower*upper);
}
