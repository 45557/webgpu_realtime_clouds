// Physical meteoroid entry and impact, after Collins, Melosh & Marcus (2005),
// "Earth Impact Effects Program" (Meteoritics & Planetary Science 40, 817),
// with the planet treated as Earth-like (surface gravity, air density and
// scale height) at the demo's radius. All lengths in metres, times in
// seconds, energies in joules.

export const IMPACTOR_TYPES = Object.freeze({
  // Bulk density (kg/m³), strength against aerodynamic stress (Pa).
  stony: { label: 'Stony asteroid', density: 3000, strength: 5e6 },
  iron: { label: 'Iron asteroid', density: 7800, strength: 5e7 },
  icy: { label: 'Comet', density: 1000, strength: 1e5 },
});

export const EARTH = Object.freeze({
  gravity: 9.81, airDensity: 1.2, scaleHeight: 8000, drag: 2, targetDensity: 2500,
  // Transition from simple to complex craters (final diameter).
  complexDiameter: 3200,
  // Meteors light up about here.
  entryAltitude: 110e3,
});

// Simulation impactor size (0.05 to 1.5) to diameter: a log scale from about
// 25 m (airbursts like Chelyabinsk and Tunguska) through 10 km (Chicxulub at
// 1) to 200 km (late heavy bombardment basins).
export function impactorDiameter(size) {
  return 20 * 10 ** (2.7 * size);
}

// Draw an impactor for a size: its type, speed and entry angle. Asteroids hit
// at 12 to 26 km/s, comets at 25 to 70; the angle follows sin(2θ), most
// often 45° (Shoemaker 1962).
export function drawImpactor(size, random = Math.random) {
  const pick = random();
  const type = pick < 0.04 ? 'iron' : pick < 0.82 ? 'stony' : 'icy';
  const velocity = type === 'icy' ? 25e3 + 45e3 * random() : 12e3 + 14e3 * random() ** 1.5;
  const angle = Math.asin(Math.sqrt(Math.max(0.004, random())));
  return { type, diameter: impactorDiameter(size), velocity, angle, azimuth: 2 * Math.PI * random() };
}

// Slant distance along a path of elevation `angle` from a ground point up to
// an altitude, on a sphere of radius R.
export function slantToAltitude(altitude, angle, R) {
  const s = Math.sin(angle);
  return R * (Math.sqrt(s * s + 2 * altitude / R + (altitude / R) ** 2) - s);
}

export function impactEffects(impactor, { radius = 6.371e6, env = EARTH, water = 0 } = {}) {
  const { gravity: g, airDensity: rho0, scaleHeight: H, drag: Cd } = env;
  const kind = IMPACTOR_TYPES[impactor.type] ?? IMPACTOR_TYPES.stony;
  const { diameter: L, velocity: v0, angle } = impactor;
  const rhoI = kind.density, sin = Math.max(0.05, Math.sin(angle));
  const mass = rhoI * Math.PI / 6 * L ** 3;
  const energy = 0.5 * mass * v0 * v0;
  // Atmospheric entry: break-up where ram pressure exceeds strength, then the
  // fragments flatten (pancake) and may burst in the air (Collins eqs 10-18).
  const ramAtGround = rho0 * v0 * v0;
  let breakup = ramAtGround > kind.strength ? H * Math.log(ramAtGround / kind.strength) : 0;
  let burst = 0, velocity = v0;
  // Speed lost to drag above the break-up altitude.
  const slowdown = (z) => Math.exp(-3 * rho0 * Math.exp(-z / H) * Cd * H / (4 * rhoI * L * sin));
  if (breakup > 0) {
    const vb = v0 * slowdown(breakup);
    const rhoB = rho0 * Math.exp(-breakup / H);
    const dispersion = L * sin * Math.sqrt(rhoI / (Cd * rhoB));
    const pancake = 7;
    burst = breakup - 2 * H * Math.log(1 + dispersion / (2 * H) * Math.sqrt(pancake * pancake - 1));
    velocity = vb;
    if (burst <= 0) {
      // Reaches the ground as a spreading swarm. The cloud has widened by
      // the ground (Collins eq 16), so the air below break-up slows it more.
      burst = 0;
      const widen = 1 + (2 * H / dispersion) ** 2 * (Math.exp(breakup / (2 * H)) - 1) ** 2;
      const column = 3 * Cd * rho0 * H * (1 - Math.exp(-breakup / H)) / (4 * rhoI * L * sin);
      velocity = vb * Math.exp(-column * (1 + widen) / 2);
    }
  } else {
    velocity = v0 * slowdown(0);
  }
  const airburst = burst > 0;
  const groundEnergy = airburst ? 0 : 0.5 * mass * velocity * velocity;
  // Transient and final crater (Collins eqs 21, 22, 27; depth eq 28).
  let craterDiameter = 0, craterDepth = 0, transient = 0, cavity = 0, complex = false;
  if (!airburst) {
    const v = velocity, rhoT = env.targetDensity;
    transient = 1.161 * (rhoI / rhoT) ** (1 / 3) * L ** 0.78 * v ** 0.44 * g ** -0.22 * Math.cbrt(sin);
    cavity = transient;
    // Water absorbs part of the blow; deep water leaves no sea-floor crater.
    if (water > 0) transient *= Math.max(0, 1 - water / (2 * L));
    const simple = 1.25 * transient;
    complex = simple > env.complexDiameter;
    craterDiameter = complex ? 1.17 * transient ** 1.13 / env.complexDiameter ** 0.13 : simple;
    craterDepth = complex ? 1000 * 0.294 * (craterDiameter / 1000) ** 0.301 : 0.2 * craterDiameter;
  }
  // Fireball (eq 32), seismic magnitude (eq 40) and thermal reach: the
  // distance where radiant fluence ignites vegetation (~1 MJ/m², η = 3e-3).
  const burstEnergy = airburst ? energy : groundEnergy;
  const fireball = 0.002 * Math.cbrt(burstEnergy);
  const thermal = Math.sqrt(3e-3 * burstEnergy / (2 * Math.PI * 1e6));
  const magnitude = groundEnergy > 0 ? 0.67 * Math.log10(groundEnergy) - 5.87 : 0;
  // Excavation takes about 0.8 sqrt(D_tc / g); at sea the water cavity opens
  // on the same time scale even when the sea floor is left untouched.
  const excavation = cavity ? 0.8 * Math.sqrt(cavity / g) : 0;
  const pathLength = slantToAltitude(env.entryAltitude, angle, radius) - (airburst ? slantToAltitude(burst, angle, radius) : 0);
  // Mean speed over the luminous path.
  const flight = pathLength / (0.5 * (v0 + velocity));
  return {
    type: impactor.type, label: kind.label, diameter: L, mass, energy, megatons: energy / 4.184e15,
    entryVelocity: v0, impactVelocity: velocity, angle, azimuth: impactor.azimuth,
    breakup, airburst, burstAltitude: burst, craterDiameter, craterDepth, complex, transient,
    fireball, thermal, magnitude, excavation, flight, pathLength,
  };
}

// The cavity an impact opens in the sea (transient crater before the water
// damps it) and the wave height at its rim (Ward & Asphaug 2000: about a
// third of the cavity depth, never more than the sea is deep).
export function waterCavity(physics, depth) {
  if (!physics || physics.airburst || !(depth > 0)) return { radius: 0, amplitude: 0 };
  const density = (IMPACTOR_TYPES[physics.type] ?? IMPACTOR_TYPES.stony).density;
  const cavity = 1.161 * (density / 1000) ** (1 / 3) * physics.diameter ** 0.78 *
    physics.impactVelocity ** 0.44 * 9.81 ** -0.22 * Math.cbrt(Math.sin(physics.angle));
  return { radius: cavity / 2, amplitude: Math.min(depth, cavity / 2.8) };
}
