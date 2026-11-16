// Shared cloud coordinates for raymarch, mesh extraction and mesh color.
// Two smooth spherical twists carry the baked curls through one another.
// No noise evaluation, simulation grid, texture rebake or additional reads.
fn gasZonalAngle(latitude:f32,wind:f32)->f32 {
 return wind+sin(wind*.7)*sin(latitude*14.0)*.12;
}
fn gasFlowTwist(d:vec3<f32>,axis:vec3<f32>,angle:f32)->vec3<f32> {
 // Small bounded angles permit a second-order rotation, avoiding
 // another sin/cos pair per twist. Normalize to keep the domain on the shell.
 return normalize(d+cross(axis,d)*angle+(axis*dot(axis,d)-d)*(angle*angle*.5));
}
fn planetFlowEddies(direction:vec3<f32>,strength:f32,phase:f32)->vec3<f32> {
 let a=vec3<f32>(.31045048,.91132238,.27039235);
 let b=vec3<f32>(-.73157458,.28060395,.62133731);
 let phaseA=dot(direction,a)*11.0;
 let d=gasFlowTwist(direction,a,(sin(phaseA+phase*10.0)-sin(phaseA))*.065*strength);
 let phaseB=dot(d,b)*17.0;
 return gasFlowTwist(d,b,(sin(phaseB-phase*7.7)-sin(phaseB))*.040*strength);
}
fn planetWarpDirection(direction:vec3<f32>,wind:f32,form:f32,amount:f32,phase:f32)->vec3<f32> {
 let ordinary=form>=.5 && form<4.5;
 // Puffy/realistic clouds use gentle eddies without the gas giants' jet belts.
 let zonalGas=form>=5.125&&form<6.5;
 var angle=select(wind+(gasZonalAngle(direction.y,phase)-phase)*amount,wind,ordinary);
 if(zonalGas){
  // Alternating east-west drift leaves each belt at its latitude.
  let latitude=asin(clamp(direction.y,-1.0,1.0));
  let rate=select(select(24.0,21.0,form==5.125),select(18.5,16.0,form>=5.5),form>=5.375);
  angle+=sin(phase*.7)*sin(latitude*rate+sin(latitude*4.6+.3)*1.10)*.095*amount;
 }
 let d=vec3<f32>(direction.x*cos(angle)-direction.z*sin(angle),direction.y,direction.x*sin(angle)+direction.z*cos(angle));
 if(amount<=0.0 || phase==0.0 || zonalGas){return d;}
 // Neptune retains its quiet zonal streaks. Hail Mary gets stronger eddies;
 // Jupiter's smaller cross-jet displacement preserves its broad belts.
 if(ordinary || form>=6.5 || (form>=4.5 && form<5.5)){
  let streetScale=select(1.0,0.28,isTradeWindStreet(form));
  let strength=select(select(.55,1.0,form>=6.5),.38,ordinary)*amount*streetScale;
  return planetFlowEddies(d,strength,phase);
 }
 return d;
}

// Ordinary clouds carry their 3D billows and fine erosion with the same flow
// as coverage. Preserve radius and the existing custom/gas shape rotation.
fn planetWarpPosition(p:vec3<f32>,wind:f32,form:f32,amount:f32,phase:f32)->vec3<f32> {
 if(form>=.5 && form<4.5){
  let radius=max(length(p),.000001);
  return planetWarpDirection(p/radius,wind,form,amount,phase)*radius;
 }
 return vec3<f32>(p.x*cos(wind)-p.z*sin(wind),p.y,p.x*sin(wind)+p.z*cos(wind));
}

fn isTradeWindStreet(form: f32) -> bool {
  return abs(form - 2.54) < 0.004;
}

// Move billows locally in their cached 3D field. The slower shared weather
// motion keeps fronts and wind streets coherent as their edges evolve.
fn planetEvolvingDomain(p:vec3<f32>,phase:f32)->vec3<f32> {
 let swell=vec3<f32>(sin(p.y*5.7+phase),sin(p.z*6.3-phase*.71),sin(p.x*5.1+phase*.47));
 let eddies=vec3<f32>(sin(p.z*13.2-phase*1.8),sin(p.x*11.3+phase*1.4),sin(p.y*14.1+phase*1.9));
 return p+vec3<f32>(.014,.009,-.011)*phase+swell*.064+eddies*.023;
}

// Independently phased volume channels change which regions cross the density
// threshold. The wind can move a whole cloud while its billows grow or decay.
fn evolvePlanetCloudShape(shape:vec4<f32>,phase:f32,form:f32)->vec4<f32> {
 if(form<.5 || form>=4.5 || phase==0.0 || isLenticular(form)){return shape;}
 let wispy=abs(form-2.51)<.004 || abs(form-2.53)<.004;
 let growth=sin(phase*1.66+shape.a*8.5)-sin(shape.a*8.5);
 let breakup=sin(phase*2.31+shape.r*8.9+shape.b*2.7)-sin(shape.r*8.9+shape.b*2.7);
 let strength=select(select(.26,.57,wispy),.055,form==2.0);
 let drift=vec4<f32>((shape.g-.5)*growth,(shape.b-.5)*breakup,
  (shape.g-.5)*breakup*.75,growth*.12)*strength;
 return clamp(shape+drift,vec4<f32>(0),vec4<f32>(1));
}

// Default wrappers preserve external callers and the GPU benchmark baseline.
fn gasWeatherDirection(d:vec3<f32>,wind:f32,form:f32)->vec3<f32> {
 return planetWarpDirection(d,wind,form,1.0,wind);
}
fn planetCloudFlowPosition(p:vec3<f32>,wind:f32,form:f32)->vec3<f32> {
 return planetWarpPosition(p,wind,form,1.0,wind);
}

fn isDetailedCumulus(form: f32) -> bool {
  return form > 2.32 && form < 2.65;
}

fn isFineCumulus(form: f32) -> bool {
  return form > 2.39 && form < 2.65;
}

fn isLenticular(form: f32) -> bool {
  return abs(form - 2.56) < 0.004;
}

fn isCumulusBank(form: f32) -> bool {
  return (form > 2.20 && form < 2.30) || isDetailedCumulus(form);
}

// The horizontal footprint stays fixed through the height of each lens.
// Its two tapered cross-sections thin continuously into the surrounding sky.
fn lenticularForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let region = smoothstep(0.39, 0.72, weather.r * 0.68 + weather.g * 0.32);
  let footprint = dot(shape.rg, vec2<f32>(0.64, 0.36)) + (region - 0.5) * 0.20;
  let threshold = mix(0.73, 0.47, clamp(coverage, 0.0, 1.0));
  let thickness = smoothstep(threshold - 0.03, threshold + 0.17, footprint);
  let center = 0.42 + (weather.b - 0.5) * 0.21 + (shape.a - 0.5) * 0.15;
  let lowerLens = thickness * 0.17 - abs(ph - center);
  let upperLens = thickness * mix(0.03, 0.10, region) - abs(ph - center - 0.25);
  let form = min((footprint - threshold) * 1.35, max(lowerLens, upperLens) * 1.50);
  return vec2<f32>(form, smoothstep(-0.02, 0.05, form));
}

// Bring out the narrow cellular strands near a cloud's boundary. Strong
// updrafts retain their volume and empty sky stays empty.
fn cellularCloudFringe(form:f32,detail:f32,strength:f32)->f32 {
  let edge=smoothstep(-.17,-.025,form)*(1.0-smoothstep(.025,.19,form));
  return form+(detail-.5)*strength*edge;
}

// Broad weather joins the low shoulders. The strongest 3D lobes reach
// through the upper envelope as turrets, with open gaps between banks.
fn cumulusBankForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32, formType: f32) -> vec2<f32> {
  if(abs(formType-2.25)<.004 || abs(formType-2.38)<.004){
    let bank=abs(formType-2.25)<.004;
    return convectiveTowerForm(ph,weather,shape,coverage,bank);
  }
  let detailed = isDetailedCumulus(formType);
  let fine = isFineCumulus(formType);
  let layered = formType >= 2.48 && formType < 2.58;
  let streets = isTradeWindStreet(formType);
  let weatherSignal = weather.r * 0.72 + weather.g * 0.28;
  let weatherSupport = smoothstep(0.28, 0.72, weatherSignal);
  let baseWeights = select(vec3<f32>(0.50, 0.37, 0.13), vec3<f32>(0.46, 0.38, 0.16), detailed);
  let weights = select(baseWeights, vec3<f32>(0.43, 0.37, 0.20), fine);
  var body = dot(shape.rgb, weights);
  if (abs(formType - 2.51) < 0.004 || abs(formType - 2.53) < 0.004) {
    body = dot(shape.rgb, vec3<f32>(0.35, 0.55, 0.10));
  }
  if (abs(formType - 2.55) < 0.004) {
    let rippleHeight = 0.44 + (weather.b - 0.5) * 0.24 + (shape.a - 0.5) * 0.13;
    let ripple = 1.0 - smoothstep(0.06, 0.22, abs(ph - rippleHeight));
    let mesh = dot(shape.rgb, vec3<f32>(0.23, 0.60, 0.17));
    let threshold = mix(0.68, 0.45, clamp(coverage, 0.0, 1.0));
    let openings = smoothstep(0.35, 0.73, weatherSignal);
    return vec2<f32>(mesh-threshold+(openings-.5)*.33-(1.0-ripple)*.38,ripple);
  }
  let turret = smoothstep(0.39, select(0.73, 0.68, detailed), body * 0.70 + shape.a * 0.30);
  let rise = smoothstep(0.19, 0.98, ph);
  let crest = (weather.b - 0.5) * select(select(0.29, 0.64, layered), 0.19, streets);
  let rollingBase = clamp(0.075 + crest * 0.22 + (shape.a - 0.5) * 0.16 + (shape.g - 0.5) * 0.11, 0.01, 0.21);
  let baseHeight = select(0.045 + (weather.b - 0.5) * 0.06, rollingBase, fine);
  let lower = smoothstep(baseHeight, baseHeight + 0.15, ph);
  let billowTop = clamp(0.68 + crest + (body - 0.53) * 0.48 + (shape.b - 0.5) * 0.13, 0.39, 0.99);
  let upper = 1.0 - smoothstep(billowTop - 0.18, billowTop, ph);
  let threshold = mix(0.77, 0.47, clamp(coverage, 0.0, 1.0)) + select(0.0, 0.074, detailed);
  let regionalStrength = select(select(0.21, 0.38, detailed), 0.49, fine);
  // Keep larger gaps between fine cloud fields. Coverage still controls the
  // amount of cloud inside the active weather regions.
  let clearing = select(0.0, (1.0 - smoothstep(0.35, 0.58, weatherSignal)) * 0.10, fine);
  let roll = select(0.0, (weather.b - 0.5) * 0.19 * upper, layered);
  let streetGap = select(0.0, (1.0 - smoothstep(0.32, 0.65, weather.b)) * 0.15, streets);
  let naturalTower = abs(formType - 2.425) < .009;
  // A connected foot gives way to successive smaller, notched billows.
  let ruffles = (shape.b - .52) * smoothstep(.12,.58,ph) * .25;
  let form = body - threshold + (weatherSupport - 0.5) * regionalStrength
    + (1.0 - rise) * weatherSupport * 0.11 - rise * mix(0.33, 0.12, turret)
    - (1.0 - lower * upper) * 0.39 - clearing + roll - streetGap
    + select(0.0,ruffles,naturalTower);
  if(naturalTower || abs(formType-2.40)<.004){
    return vec2<f32>(cellularCloudFringe(form,shape.b,.25+.19*rise),lower*upper);
  }
  return vec2<f32>(form, lower * upper);
}

fn planetCumulusForm(ph:f32,weather:vec4<f32>,shape:vec4<f32>,coverage:f32,formType:f32)->vec2<f32>{
  if(formType>2.565 && formType<2.595){
    let ribbon=abs(formType-2.58)<.004;
    let frost=formType>2.585;
    let center=.48+(weather.b-.5)*select(.10,.44,ribbon)+(shape.a-.5)*.20;
    let halfHeight=select(.43,select(.21,.27,frost),ribbon || frost);
    let envelope=1.0-smoothstep(halfHeight*.28,halfHeight,abs(ph-center));
    let threshold=mix(.66,select(.21,.29,ribbon),clamp(coverage,0.0,1.0));
    let field=shape.g+(shape.b-.5)*.16-(1.0-envelope)*.72-threshold;
    let opening=(weather.a-mix(.55,.12,coverage))*.94;
    return vec2<f32>(min(field,opening),envelope);
  }
  let amount=clamp(coverage,0.0,1.0);
  if(abs(formType-2.41)<.004){
    let lift=smoothstep(.20,.73,weather.r);
    let top=mix(.41,.91,lift)+(shape.g-.5)*.24+(weather.g-.5)*.14;
    let layer=smoothstep(.09,.22,ph)*(1.0-smoothstep(top-.13,top,ph));
    let body=dot(shape.rgb,vec3<f32>(.25,.64,.11))-mix(.69,.36,amount);
    let core=body+(lift-.5)*.20-(1.0-layer)*.69;
    let opening=(weather.a-mix(.56,.10,amount))*.99;
    return vec2<f32>(min(core,opening),layer);
  }
  if(abs(formType-2.50)<.004){
    let base=.14+(weather.g-.5)*.23;
    let top=base+.33+weather.r*.17+(shape.r-.5)*.22;
    let layer=smoothstep(base,base+.12,ph)*(1.0-smoothstep(top-.16,top,ph));
    let body=dot(shape.rgb,vec3<f32>(.37,.46,.17))-mix(.69,.36,amount);
    let roll=body+(weather.r-.5)*.16-(1.0-layer)*.64;
    let opening=(weather.a-mix(.56,.11,amount))*1.08;
    return vec2<f32>(min(roll,opening),layer);
  }
  var geometry=cumulusBankForm(ph,weather,shape,coverage,formType);
  if(abs(formType-2.43)<.004){
    let opening=(weather.a-mix(.66,.17,amount))*1.38;
    geometry.x=min(geometry.x,opening);
  }
  return geometry;
}

fn isAnvilCloud(form:f32)->bool {
  return abs(form-2.44)<.004;
}

fn convectiveTowerForm(ph:f32,weather:vec4<f32>,shape:vec4<f32>,coverage:f32,bank:bool)->vec2<f32> {
  let amount=clamp(coverage,0.0,1.0);
  let threshold=mix(.73,select(.46,.41,bank),amount);
  let rise=smoothstep(.17,.92,ph);
  let start=.035+weather.a*.13+(shape.a-.5)*.09;
  let shelf=clamp(.35+weather.g*.56+(shape.g-.5)*.30+(shape.b-.5)*.18,.24,.98);
  let updraft=smoothstep(start,start+.12,ph)*(1.0-smoothstep(shelf-.16,shelf,ph));
  let lobe=dot(shape.rgb-vec3<f32>(.5),vec3<f32>(.19,.43,.24));
  let shoulders=weather.b*select(.08,.25,bank)*(1.0-rise);
  let turret=weather.r-threshold+lobe+shoulders-rise*select(.24,.15,bank);
  let form=turret-(1.0-updraft)*.78;
  return vec2<f32>(cellularCloudFringe(form,shape.b,.33+.30*rise),updraft);
}

fn anvilCloudForm(ph:f32,weather:vec4<f32>,shape:vec4<f32>,coverage:f32)->vec2<f32> {
  let amount=clamp(coverage,0.0,1.0);
  let threshold=mix(.79,.37,amount);
  let rise=smoothstep(.18,.83,ph);
  let base=smoothstep(.045+weather.a*.11,.16+weather.a*.11,ph);
  let core=smoothstep(.38,.87,weather.r);
  let roof=.60+weather.g*.24+(shape.a-.5)*.046;
  let updraftTop=roof+core*(.034+.10*shape.g);
  let column=base*(1.0-smoothstep(updraftTop-.077,updraftTop+.043,ph));
  // Use cellular detail at the sides and a steadier density in the shaft.
  let lobes=(shape.g-.5)*mix(.25,.46,rise);
  let stemMass=weather.r-threshold+.10+(shape.r-.5)*.22+lobes
    +(shape.b-.5)*mix(.15,.32,rise)-rise*.12-(1.0-column)*.94;
  let stem=cellularCloudFringe(stemMass,shape.b,mix(.37,.21,core)+.14*rise);

  // The upper shelf is thick where the updraft feeds it and frays into
  // thin, wind-sheared ice downwind. Both use the same sampled volume.
  let feed=core*smoothstep(.30,.67,weather.b);
  let canopyDepth=mix(.11,.28,feed);
  let outflow=smoothstep(roof-canopyDepth,roof-.055,ph)*(1.0-smoothstep(roof-.013,roof+.050,ph));
  let fringe=dot(shape.rgb-vec3<f32>(.5),vec3<f32>(.10,.24,mix(.46,.23,feed)));
  let canopyMass=weather.b-threshold+.035+fringe+feed*.095-(1.0-outflow)*.94;
  let canopy=cellularCloudFringe(canopyMass,shape.b,mix(.70,.32,feed));
  return vec2<f32>(max(stem,canopy),mix(column,outflow,smoothstep(-.08,.08,canopy-stem)));
}

fn isMixedPlanetWeather(form:f32)->bool {
  return abs(form-2.64)<.004;
}

// Base and thickness of each standalone profile within the shared shell.
// The region order matches mixedWeatherFootprint in the weather baker.
const mixedWeatherAltitude=array<vec2<f32>,12>(
  vec2<f32>(.05,.19), // Broken stratocumulus
  vec2<f32>(.04,.28), // Fair-weather puffs
  vec2<f32>(.035,.43), // Island cumulus
  vec2<f32>(.035,.72), // Towering cumulus
  vec2<f32>(.06,.87), // Anvil thunderstorms
  vec2<f32>(.13,.21), // Trade-wind streets
  vec2<f32>(.28,.19), // Altocumulus ripples
  vec2<f32>(.39,.22), // Lenticular waves
  vec2<f32>(.12,.53), // Frontal wave bands
  vec2<f32>(.36,.40), // Wind-swept wisps
  vec2<f32>(.57,.37), // High ice filaments
  vec2<f32>(.26,.64), // Sparse fronts and cirrus
);

fn mixedWeatherForm(region:u32,ph:f32,weather:vec4<f32>,shape:vec4<f32>,coverage:f32,phase:f32)->vec2<f32>{
  let altitude=mixedWeatherAltitude[region];
  let h=(ph-altitude.x)/altitude.y;
  if(h<=0.0 || h>=1.0){return vec2<f32>(-.35,0.0);}
  let fields=vec4<f32>(weather.rgb,weather.g);
  var form:vec2<f32>;
  switch region {
    case 0u: {form=cumulusBankForm(h,fields,shape,coverage,2.50);}
    case 1u: {form=cumulusBankForm(h,fields,shape,coverage,2.42);}
    case 2u: {form=cumulusBankForm(h,fields,shape,coverage,2.43);}
    case 3u: {form=convectiveTowerForm(h,fields,shape,coverage,true);}
    case 4u: {form=anvilCloudForm(h,fields,shape,coverage);}
    case 5u: {form=cumulusBankForm(h,fields,shape,coverage,2.54);}
    case 6u: {form=cumulusBankForm(h,fields,shape,coverage,2.55);}
    case 7u: {form=lenticularForm(h,fields,shape,coverage);}
    case 8u: {form=planetFrontForm(h,fields,shape,coverage);}
    default: {
      let ice=region==10u;
      let wisps=region==9u;
      let high=vec4<f32>(weather.r,weather.g,weather.g,weather.b);
      let fibers=vec4<f32>(shape.r,shape.a,shape.b,shape.a);
      form=realisticSatelliteForm(h,high,fibers,coverage,select(1.38,1.41,ice || wisps),phase);
    }
  }
  // Gaps in the regional footprint remain open even when the 3D texture is dense.
  let opening=max(weather.r,select(0.0,weather.b,region==4u || region>=9u));
  let edge=smoothstep(0.0,.08,h)*(1.0-smoothstep(.94,1.0,h));
  return vec2<f32>(form.x+(smoothstep(.16,.62,opening)-.5)*.09-(1.0-smoothstep(.045,.22,opening))*.23-(1.0-edge)*.35,form.y*edge);
}

fn mixedPlanetWeatherForm(ph:f32,weather:vec4<f32>,shape:vec4<f32>,coverage:f32,phase:f32)->vec2<f32> {
  let climate=clamp(weather.a,0.0,1.0)*11.0;
  let region=u32(floor(climate));
  let blend=smoothstep(.26,.74,fract(climate));
  let firstRegion=region+select(0u,1u,blend>=1.0);
  let lastRegion=region+select(0u,1u,blend>0.0);
  var first=vec2<f32>(0.0);
  var second=vec2<f32>(0.0);
  // A single call site keeps the compiler from inlining the whole weather
  // switch four times. Only transitions need a second evaluation.
  for(var i=firstRegion;i<=lastRegion;i++){
    let form=mixedWeatherForm(i,ph,weather,shape,coverage,phase);
    if(firstRegion==lastRegion){return form;}
    if(i==region){first=form;}else{second=form;}
  }
  // Fade each cloud layer in place. Interpolating altitude or averaging
  // against empty space would either move a cloud or erase its neighbor.
  let a=vec2<f32>(mix(first.x,-.08,blend),first.y);
  let b=vec2<f32>(mix(-.08,second.x,blend),second.y);
  return vec2<f32>(max(a.x,b.x),mix(a.y,b.y,smoothstep(-.055,.055,b.x-a.x)));
}

fn planetWeatherShapeDomain(domain:vec3<f32>,weather:vec4<f32>,ph:f32,form:f32,surfaceProjection:f32)->vec3<f32>{
  if(isMixedPlanetWeather(form)){
    let regime=clamp(weather.a,0.0,1.0)*11.0;
    let fiber=smoothstep(8.2,9.7,regime);
    let ripple=1.0-smoothstep(.25,1.30,abs(regime-5.9));
    let lens=1.0-smoothstep(.24,.86,abs(regime-7.0));
    let tower=1.0-smoothstep(.4,1.7,abs(regime-3.4));
    let along=vec3<f32>(.36,.48,.80);
    let across=vec3<f32>(-.80,.60,0);
    let stretch=max(fiber,ripple*.65);
    let shear=(1.0-smoothstep(.3,.88,abs(regime-4.0)))*smoothstep(.32,.79,ph);
    let plane=mix(1.0,surfaceProjection,lens);
    let shift=(across*dot(domain,across)*1.08-along*dot(domain,along)*.57)*stretch;
    let scale=1.12-tower*.34-lens*.25+ripple*.22+fiber*.28;
    return (domain*plane+shift-along*(dot(domain,along)*.34+.19)*shear)*scale;
  }
  if(form==1.0){
    let along=vec3<f32>(.36,.48,.80);
    let across=vec3<f32>(-.80,.60,0);
    // Stretch the field at a constant scale. Changing the scale with
    // altitude sweeps the repeated volume through the thin radial layer.
    let stretched=domain+(across*dot(domain,across)*.52-along*dot(domain,along)*.31)*.40;
    let shear=smoothstep(.13,.94,ph)*mix(.018,.080,weather.g);
    return stretched-along*shear;
  }
  if(form==2.0 || form==2.125){
    let along=vec3<f32>(.36,.48,.80);
    let storybook=form==2.125;
    let stretch=select(.40,.60,storybook);
    let shear=ph*select(.018,.036,storybook)*(weather.g-.24);
    // Carry most of each lobe along the bank footprint. Its height comes
    // from the tapered crest profile, with a little radial billow motion.
    let footprint=domain*mix(surfaceProjection,1.0,select(.46,.38,storybook));
    return footprint-along*(dot(footprint,along)*stretch+shear);
  }
  if(isAnvilCloud(form)){
    // Winds aloft stretch and displace the thin canopy relative to the stem.
    let outflow=smoothstep(.51,.83,ph)*smoothstep(.22,.66,weather.b);
    let wind=vec3<f32>(.36,.48,.80);
    return domain-wind*(.29*dot(domain,wind)+.12)*outflow;
  }
  return domain;
}

fn planetCloudErosionStrength(weather:vec4<f32>,form:f32)->f32{
  if(isMixedPlanetWeather(form)){return mix(1.11,1.78,weather.a);}
  if(isSatelliteForm(form)){return mix(1.30,1.10,smoothstep(.28,.80,weather.r));}
  if(isAnvilCloud(form)){return 1.47;}
  if(form==1.0 || abs(form-2.38)<.004){return 1.56;}
  if(form==2.0){return .32;}
  return 1.0;
}

fn isSatelliteForm(form: f32) -> bool {
  return abs(form - 1.29) < .004 || abs(form - 1.35) < .004 || abs(form - 1.38) < .004 || abs(form - 1.41) < .004;
}

fn isThinOrDiorama(form: f32) -> bool {
  return form == 1.0 || form == 2.0;
}

// A ragged low deck and occasional higher wisps occupy different heights.
// Clear pockets keep the deck open even where the billow field is strong.
fn thinCloudForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let amount = clamp(coverage, 0.0, 1.0);
  let deck = smoothstep(.22, .77, weather.r);
  let clearing = smoothstep(.18, .68, weather.a);
  let start = .095 + (weather.b - .5) * .19 + (shape.a - .5) * .18;
  let top = clamp(.43 + deck * .32 + (shape.g - .5) * .45 + (shape.b - .5) * .13, .28, .94);
  let layer = smoothstep(start, start + .18, ph) * (1.0 - smoothstep(top - .19, top, ph));
  let mass = dot(shape.rgb, vec3<f32>(.27,.40,.33));
  let threshold = mix(.73,.51,amount);
  // Break up low-coverage banks before the volume accumulates into a veil.
  let edgeCut = (1.0 - smoothstep(.29,.65,deck)) * (1.0 - shape.b) * .085;
  let body = mass - threshold + (deck - .46) * .38 - (1.0 - clearing) * .14 - (1.0 - layer) * .39 - edgeCut;
  let wisps = smoothstep(.46,.67,ph) * (1.0-smoothstep(.76,.96,ph));
  let veil = dot(shape.gb, vec2<f32>(.46,.54)) - threshold - .095
    + (deck - .5) * .28 + (weather.g - .52) * .20 - (1.0 - wisps) * .46;
  return vec2<f32>(max(body,veil), max(layer,wisps*.42));
}

// The cloud thins to a rounded nose where its planform narrows. At a dry
// boundary only the low center of the bank can remain above the isosurface.
fn roundedCloudBankProfile(ph: f32, support: f32, crest: f32, middle: f32, width: f32) -> vec2<f32> {
  let core = smoothstep(0.0, .30, support);
  let center = middle + .085 * core;
  let halfHeight = .18 + width * core + crest * .045;
  let vertical = (ph - center) / halfHeight;
  let envelope = 1.0 - smoothstep(.60, 1.21, abs(vertical));
  let baseFade = smoothstep(.025, .16, ph);
  let contour = support - vertical * vertical * .21 - (1.0 - baseFade) * .38;
  let bankThickness = smoothstep(.018, .17, support);
  return vec2<f32>(contour, envelope * baseFade * bankThickness);
}

fn dioramaCloudForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let bank = mix(weather.a, weather.r, .23);
  let lobe = shape.g - .5;
  let mass = bank * .76 + lobe * .34 + (shape.r - .5) * .11;
  let threshold = mix(.61, .235, clamp(coverage, 0.0, 1.0));
  let crest = lobe;
  let middle = .35 + (weather.g - .5) * .08;
  return roundedCloudBankProfile(ph, mass - threshold, crest, middle, mix(.035, .27, weather.b));
}

fn storybookCloudForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let bank = mix(weather.a, weather.r, .13);
  let lobe = shape.g - .5;
  let mass = bank * .79 + lobe * .28 + (shape.r - .5) * .10;
  let threshold = mix(.65, .245, clamp(coverage, 0.0, 1.0));
  let edge = 1.0 - smoothstep(.22, .59, bank);
  let nicks = smoothstep(.55, .85, shape.b) * edge * .034;
  let middle = .31 + (weather.g - .5) * .09;
  return roundedCloudBankProfile(ph, mass - threshold - nicks, lobe, middle, mix(.03, .25, weather.b));
}

fn realisticSatelliteForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32, form: f32, phase: f32) -> vec2<f32> {
  let cartoon = form < 1.32;
  let sparse = form > 1.36;
  let cirrusOnly = form > 1.40;
  let front = weather.r;
  let bottom = .08 + (clamp(weather.g,0.0,1.0)-.50)*.16;
  let ceiling = clamp(.37 + .38*weather.b + (shape.g-.5)*select(.23,.42,cartoon),.29,.90);
  let deck = smoothstep(bottom,bottom+.14,ph)*(1.0-smoothstep(ceiling-.18,ceiling,ph));
  let high = smoothstep(.46,.68,ph)*(1.0-smoothstep(.81,.99,ph));
  let threshold = mix(.70,select(.32,.25,sparse),clamp(coverage,0.0,1.0));
  let textureDetail = dot(shape.rgb-vec3<f32>(.5),vec3<f32>(.05,select(.12,.24,cartoon),.22));
  let eye = (1.0-smoothstep(-.19,.015,weather.g))*.62;
  // Keep the optical contrast of opaque cores against thin outflow.
  let marineBank = select(0.0,.16*smoothstep(.30,.59,front),!cartoon && !sparse);
  var bank = front - threshold + marineBank + textureDetail - (1.0-deck)*.64 - select(0.0,.13,cirrusOnly);
  let iceStrength = select(.84,select(.79,.93,cirrusOnly),sparse);
  // Keep thin trails visible with less optical weight than low banks.
  let iceThreshold = threshold + select(-.095,.045,cartoon || sparse);
  var cirrus = weather.a*iceStrength - iceThreshold + textureDetail*.42 - (1.0-high)*.53;
  if(!cartoon && phase != 0.0){
    // The volume channels put nearby billows in different phases of growth.
    // Shape the density threshold so new wisps can form inside moist air.
    let seed=vec2<f32>(dot(shape.ga,vec2<f32>(.58,.71))+weather.b*.23,
                        dot(shape.br,vec2<f32>(.84,.67))+weather.a*.42);
    let offset=vec2<f32>(.23,-.34)*phase;
    let wave=abs(2.0*fract(vec4<f32>(seed+offset,seed))-1.0);
    let pulse=wave*wave*(3.0-2.0*wave);
    let growth=pulse.xy-pulse.zw;
    let flank=smoothstep(.14,.38,front)*(1.0-smoothstep(.48,.78,front));
    let moistAir=smoothstep(.09,.42,weather.a);
    bank+=growth.x*flank*deck*.19;
    cirrus+=growth.y*moistAir*high*.25;
  }
  let deckDensity=select(1.0,mix(.86,1.38,smoothstep(.32,.72,front)),!cartoon && !sparse);
  let blend=smoothstep(-.05,.05,bank-cirrus);
  let profile=select(max(deck,high*.36),mix(high*.36,deck*deckDensity,blend),!cartoon && !sparse);
  return vec2<f32>(max(bank,cirrus)-eye,profile);
}

fn isPlanetFront(form: f32) -> bool {
  return (form > 1.2 && form < 1.5) || abs(form-2.60)<.004;
}

fn planetFrontForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let core = smoothstep(0.27, 0.84, weather.r);
  let crest = (weather.b - 0.5) * 0.34;
  let base = clamp(0.06 + crest * 0.20 + (shape.a - 0.5) * 0.19 + (shape.g - 0.5) * 0.14, 0.01, 0.22);
  let top = clamp(0.36 + core * 0.51 + crest + (shape.g - 0.5) * 0.16, 0.28, 0.99);
  let envelope = smoothstep(base, base + 0.16, ph) * (1.0 - smoothstep(top - 0.24, top, ph));
  let detail = dot(shape.rgb - vec3<f32>(0.5), vec3<f32>(0.20, 0.20, 0.12));
  let mass = weather.r * 0.67 + detail;
  let threshold = mix(0.61, 0.22, clamp(coverage, 0.0, 1.0));
  return vec2<f32>(mass - threshold - (1.0 - envelope) * 0.58, envelope);
}

fn isEmberstorm(form: f32) -> bool {
  return abs(form - 2.68) < 0.004;
}

fn emberstormCloudForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32) -> vec2<f32> {
  let base=.068+(shape.a-.5)*.24+(shape.g-.5)*.08;
  let summit=clamp(.62+(shape.g-.5)*.42+(weather.g-.5)*.36,.36,.97);
  let envelope=smoothstep(base,base+.13,ph)*(1.0-smoothstep(summit-.22,summit,ph));
  let mass=dot(shape.rg,vec2<f32>(.27,.49))+weather.r*.30;
  let threshold=mix(.76,.43,clamp(coverage,0.0,1.0));
  return vec2<f32>(mass-threshold-(1.0-envelope)*.38-shape.b*.055,envelope);
}

fn planetWeatherVolumeForm(ph: f32, weather: vec4<f32>, shape: vec4<f32>, coverage: f32, form: f32, phase: f32) -> vec2<f32> {
 if(isEmberstorm(form)){
  return emberstormCloudForm(ph,weather,shape,coverage);
 }
 if(isMixedPlanetWeather(form)){
  return mixedPlanetWeatherForm(ph,weather,shape,coverage,phase);
 }
 if(isAnvilCloud(form)){
  return anvilCloudForm(ph,weather,shape,coverage);
 }
 if(isSatelliteForm(form)){
  return realisticSatelliteForm(ph,weather,shape,coverage,form,phase);
 }
 if(form==1.0){
  return thinCloudForm(ph,weather,shape,coverage);
 }
 if(form==2.125){
  return storybookCloudForm(ph,weather,shape,coverage);
 }
 if(form==2.0){
  return dioramaCloudForm(ph,weather,shape,coverage);
 }
 if(isPlanetFront(form)){
  return planetFrontForm(ph,weather,shape,coverage);
 }
 if(isLenticular(form)){
  return lenticularForm(ph,weather,shape,coverage);
 }
 if(isCumulusBank(form)){
  return planetCumulusForm(ph,weather,shape,coverage,form);
 }
 return genericPlanetCloudForm(ph,weather,shape,coverage,form);
}
