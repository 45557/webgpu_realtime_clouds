// Shared by volumetric and mesh clouds. Pigments are baked in the same map;
// palette choice is a uniform, not another shader pipeline or texture read.
fn gasWeatherColor(weather:vec4<f32>,form:f32)->vec3<f32> {
 let pigment=clamp(weather.a,0.0,1.0);
 if(form>=6.5){
  // Bright emerald banks, tangerine storms and golden lime filaments. Lift
  // pigment reflectance before lighting so shaded curls retain their color;
  // opacity stays independent so the terrain can show through either mode.
  let filament=smoothstep(.08,.88,weather.b);
  let red=mix(vec3<f32>(.62,.115,.012),vec3<f32>(1.12,.48,.045),filament);
  let green=mix(vec3<f32>(.018,.58,.035),vec3<f32>(.36,1.02,.075),filament);
  let body=mix(red,green,smoothstep(.15,.85,pigment));
  return body*(.96+weather.g*.16);
 }
 if(form>=5.5){
  let cobalt=mix(vec3<f32>(.014,.043,.24),vec3<f32>(.10,.33,.72),smoothstep(.08,.72,pigment));
  let ice=mix(cobalt,vec3<f32>(.50,.84,1.0),smoothstep(.62,.98,pigment)*(.66+.34*weather.g));
  let storm=mix(vec3<f32>(.016,.020,.12),vec3<f32>(.34,.57,.94),smoothstep(.42,.84,weather.g));
  return mix(ice,storm,smoothstep(.08,.72,weather.b));
 }
 if(form==5.125){
  let lilac=mix(vec3<f32>(.16,.085,.34),vec3<f32>(.62,.45,.85),weather.g);
  let jade=mix(vec3<f32>(.10,.38,.37),vec3<f32>(.58,.94,.77),weather.g);
  let body=mix(lilac,jade,smoothstep(.18,.86,pigment));
  return mix(body,vec3<f32>(.81,.70,.96),smoothstep(.17,.78,weather.b)*.77);
 }
 if(form==5.25){
  let bronze=mix(vec3<f32>(.25,.075,.025),vec3<f32>(.65,.23,.10),weather.g);
  let amber=mix(vec3<f32>(.66,.32,.064),vec3<f32>(.98,.81,.40),weather.g);
  let body=mix(bronze,amber,smoothstep(.09,.89,pigment));
  return mix(body,mix(vec3<f32>(.32,.06,.082),vec3<f32>(.83,.28,.18),weather.g),
    smoothstep(.10,.76,weather.b));
 }
 let ochre=mix(vec3<f32>(.20,.065,.025),vec3<f32>(.73,.36,.13),smoothstep(.02,.55,pigment));
 let cream=mix(ochre,vec3<f32>(.95,.92,.82),smoothstep(.45,.91,pigment));
 let rust=mix(vec3<f32>(.35,.009,.009),vec3<f32>(.72,.038,.018),weather.g);
 return mix(cream,rust,smoothstep(.08,.62,weather.b));
}
