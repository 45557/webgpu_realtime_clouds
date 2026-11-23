// Color and distance share one rasterized terrain lookup.
fn cloudTerrainSample(tex: texture_2d<f32>, uv: vec2<f32>, enabled: f32) -> vec4<f32> {
  if (enabled < 0.5) { return vec4<f32>(0.0); }
  let dims = vec2<i32>(textureDimensions(tex));
  return textureLoad(tex, clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), dims - 1), 0);
}

fn cloudTerrainDepth(tex: texture_2d<f32>, uv: vec2<f32>, enabled: f32) -> f32 {
  let distance = cloudTerrainSample(tex, uv, enabled).a;
  return select(1000000.0, distance, distance > 0.0);
}
fn cloudTerrainColor(p:vec3<f32>,n:vec3<f32>,sun:vec3<f32>)->vec3<f32> {
  let slope=clamp(n.y,0.0,1.0);
  let strata=0.5+0.5*sin(p.y*1.3+p.x*0.035+p.z*0.05);
  let stone=mix(vec3<f32>(0.14,0.17,0.20),vec3<f32>(0.25,0.24,0.22),strata*0.45);
  let meadow=mix(vec3<f32>(0.08,0.14,0.12),vec3<f32>(0.16,0.21,0.15),strata);
  let vegetation=smoothstep(0.55,0.92,slope)*(1.0-smoothstep(1.0,7.0,p.y));
  let rock=mix(stone,meadow,vegetation);
  let snowline=p.y+sin(p.x*0.12+p.z*0.08)*0.65;
  let snow=smoothstep(7.0,11.5,snowline)*smoothstep(0.38,0.80,slope);
  let albedo=mix(rock,vec3<f32>(0.79,0.84,0.87),snow);
  let sky=mix(vec3<f32>(0.21,0.27,0.37),vec3<f32>(0.40,0.47,0.54),slope);
  return albedo*(sky+vec3<f32>(1.05,0.93,0.78)*max(dot(n,sun),0.0)*0.90);
}

fn cloudOceanWavePhase(xz: vec2<f32>) -> vec3<f32> {
  let swell=dot(xz,vec2<f32>(1.9,-2.7));
  let cross=dot(xz,vec2<f32>(3.5,2.1));
  let wave0=dot(xz,vec2<f32>(7.3,14.1))+1.8*sin(cross)+0.7*sin(swell);
  let wave1=dot(xz,vec2<f32>(-21.3,8.7))+1.6*sin(swell)+0.9*sin(cross*1.3);
  let wave2=dot(xz,vec2<f32>(47.0,22.6))+1.2*sin(wave0);
  return vec3<f32>(wave0, wave1, wave2);
}

fn cloudOceanColor(phase: vec3<f32>, width: vec3<f32>, ray: vec3<f32>, sun: vec3<f32>,
    planetMaterial: vec4<f32>, sunVisibility: f32) -> vec3<f32> {
  let attenuation = 1.0 - smoothstep(vec3<f32>(0.5), vec3<f32>(3.0), width);
  let slope=vec2<f32>(0.025,0.046)*cos(phase.x)*attenuation.x+
    vec2<f32>(-0.036,0.027)*cos(phase.y)*attenuation.y+
    vec2<f32>(0.018,0.012)*cos(phase.z)*attenuation.z;
  let normal=normalize(vec3<f32>(slope.x,1.0,slope.y));
  let facing=clamp(dot(-ray,normal),0.0,1.0);
  let reflection=pow(1.0-facing,5.0);
  let diffuse=0.36+0.64*max(0.0,dot(normal,sun))*sunVisibility;
  let deep=mix(vec3<f32>(0.023,0.083,0.10),planetMaterial.rgb*diffuse,planetMaterial.a);
  let water=mix(deep,vec3<f32>(0.115,0.208,0.265),reflection);
  let glint=pow(max(0.0,dot(reflect(ray,normal),sun)),180.0);
  return water+vec3<f32>(0.85,0.74,0.55)*glint*smoothstep(0.0,0.16,sun.y)*0.90*sunVisibility;
}
