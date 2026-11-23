// Rocket and orbital physics for the 2100 roadmap game. Everything here is
// textbook mechanics (Tsiolkovsky, vis-viva, Kepler, patched conics) fed with
// published constants; vehicle numbers are SpaceX's stated figures where they
// exist and are marked as estimates where they do not. SI units throughout.

export const G0 = 9.80665;                    // standard gravity, m/s²
export const AU = 1.495978707e11;             // m (IAU 2012)
export const DAY = 86400;
export const YEAR = 365.25 * DAY;
export const MU_SUN = 1.32712440018e20;       // m³/s² (IAU / JPL DE)

// Planetary constants (JPL / NASA fact sheets). Mean longitudes at J2000 and
// sidereal periods give circular-orbit positions good to a few weeks for
// launch-window timing, which is what the game needs.
export const BODIES = Object.freeze({
  earth: { name: 'Earth', mu: 3.986004418e14, radius: 6.371e6, a: 1.00000261 * AU, period: 365.256363 * DAY, L0: 100.46457166 },
  mars: { name: 'Mars', mu: 4.282837e13, radius: 3.3895e6, a: 1.52371034 * AU, period: 686.98 * DAY, L0: -4.55343205 },
  moon: { name: 'Moon', mu: 4.9048695e12, radius: 1.7374e6 },
});
const J2000_MS = Date.UTC(2000, 0, 1, 12);

// Starship Block 3 / V3 as flown from May 2026. Stated: 33 + 6 Raptor 3,
// 280 tf sea-level thrust, ~100 t reusable to LEO, ~3,400 t booster
// propellant, >1,500 t ship propellant (V2 figure). Estimates: dry masses and
// vacuum Isp, which SpaceX has not published for V3.
export const STARSHIP_V3 = Object.freeze({
  shipPropellant: 1500e3,     // kg, stated V2 figure ("more than" on V3)
  shipDry: 120e3,             // kg, estimate
  boosterPropellant: 3400e3,  // kg, stated
  ispVacuum: 375,             // s, blended 3 RVac + 3 sea-level (estimate)
  ispSeaLevel: 350,           // s, Raptor 3 figure as reported
  payloadLEO: 100e3,          // kg, Musk: ">100 tons" reusable
  raptorsPerShip: 6,
  raptorsPerBooster: 33,
  mixtureRatio: 3.6,          // O/F by mass for Raptor (methalox)
});

export function rocketDeltaV(isp, wetMass, dryMass) {
  if (!(wetMass > dryMass && dryMass > 0)) return 0;
  return isp * G0 * Math.log(wetMass / dryMass);
}

// Propellant needed to give `deltaV` to a dry mass (vehicle + payload).
export function propellantFor(deltaV, isp, dryMass) {
  return dryMass * (Math.exp(deltaV / (isp * G0)) - 1);
}

export function circularSpeed(mu, r) { return Math.sqrt(mu / r); }
export function escapeSpeed(mu, r) { return Math.sqrt(2 * mu / r); }

// Burn at periapsis of a parking orbit to leave with hyperbolic excess v∞
// (the Oberth effect: v_p = sqrt(v∞² + v_esc²)).
export function departureBurn(vInf, body = BODIES.earth, altitude = 250e3) {
  const r = body.radius + altitude;
  return Math.sqrt(vInf * vInf + escapeSpeed(body.mu, r) ** 2) - circularSpeed(body.mu, r);
}
// Inverse: the v∞ a periapsis burn of `deltaV` gives.
export function excessSpeed(deltaV, body = BODIES.earth, altitude = 250e3) {
  const r = body.radius + altitude;
  const vp = circularSpeed(body.mu, r) + deltaV;
  return Math.sqrt(Math.max(0, vp * vp - escapeSpeed(body.mu, r) ** 2));
}
// Atmospheric entry speed after falling in from v∞.
export function entrySpeed(vInf, body = BODIES.mars) {
  return Math.sqrt(vInf * vInf + escapeSpeed(body.mu, body.radius) ** 2);
}

// Coplanar, circular Earth-to-Mars transfer leaving tangentially with
// heliocentric excess v∞. Solves the conic for the time to reach Mars's orbit
// (Kepler's equation) and the arrival v∞. A Hohmann transfer is v∞ ≈ 2.94 km/s
// and ~259 days; more v∞ is a faster, hotter arrival.
export function marsTransfer(vInf) {
  const r1 = BODIES.earth.a, r2 = BODIES.mars.a;
  const v1 = circularSpeed(MU_SUN, r1) + vInf;
  const energy = v1 * v1 / 2 - MU_SUN / r1;
  if (energy >= 0) return null;
  const a = -MU_SUN / (2 * energy);
  const h = r1 * v1;
  const e = Math.sqrt(Math.max(0, 1 - h * h / (MU_SUN * a)));
  if (a * (1 + e) < r2) return null; // does not reach Mars
  const cosNu = (a * (1 - e * e) / r2 - 1) / e;
  const nu = Math.acos(Math.max(-1, Math.min(1, cosNu)));
  const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
  const M = E - e * Math.sin(E);
  const seconds = M * Math.sqrt(a ** 3 / MU_SUN);
  // Arrival velocity vector against Mars's circular velocity.
  const vr = Math.sqrt(MU_SUN / (a * (1 - e * e))) * e * Math.sin(nu);
  const vt = h / r2;
  const arrivalVInf = Math.hypot(vr, vt - circularSpeed(MU_SUN, r2));
  return { days: seconds / DAY, arrivalVInf, transferAngle: nu, semiMajorAxis: a, eccentricity: e };
}

export const HOHMANN_MARS_VINF = Math.sqrt(MU_SUN / BODIES.earth.a) * (Math.sqrt(2 * BODIES.mars.a / (BODIES.earth.a + BODIES.mars.a)) - 1);

// Heliocentric longitude (deg) of a planet on its mean circular orbit.
export function meanLongitude(body, timeMs) {
  const t = (timeMs - J2000_MS) / 1000;
  return ((body.L0 + 360 * t / body.period) % 360 + 360) % 360;
}

// Mars leads Earth by this phase angle at a Hohmann departure.
export const HOHMANN_PHASE_DEG = 180 - 360 * (marsTransfer(HOHMANN_MARS_VINF)?.days ?? 259) * DAY / BODIES.mars.period;
export const SYNODIC_PERIOD_DAYS = 1 / (1 / 365.256363 - 1 / 686.98);

// Next date (ms) on or after `fromMs` when the Earth-Mars phase matches a
// Hohmann departure: the centre of a launch window, every ~26 months.
export function nextMarsWindow(fromMs) {
  const phase = t => ((meanLongitude(BODIES.mars, t) - meanLongitude(BODIES.earth, t)) % 360 + 360) % 360;
  const rate = 360 / (SYNODIC_PERIOD_DAYS * DAY * 1000); // phase falls at this rate, deg per ms
  let behind = (phase(fromMs) - HOHMANN_PHASE_DEG + 360) % 360;
  return fromMs + behind / rate;
}

// Δv from LEO to each destination for the ship, with landing. Lunar numbers
// are the standard LEO→TLI 3.1, LOI 0.9, descent 1.9 km/s budget; Mars uses
// aerobraking and a ~0.8 km/s propulsive landing (estimate for Starship).
export function missionDeltaV(target, vInf = HOHMANN_MARS_VINF) {
  if (target === 'moon') return { outbound: 3100 + 900 + 1900, landing: 0 };
  return { outbound: departureBurn(vInf), landing: 800 };
}

// Ship Δv from LEO, full tanks, with a payload.
export function shipDeltaV(payload, ship = STARSHIP_V3, propellant = ship.shipPropellant) {
  return rocketDeltaV(ship.ispVacuum, ship.shipDry + payload + propellant, ship.shipDry + payload);
}

// Tanker flights to refill a ship in LEO: what it burned reaching orbit
// (essentially all of it) divided by what each tanker can hand over.
export function tankersToRefill(propellantNeeded, tankerDelivery) {
  return Math.ceil(propellantNeeded / Math.max(1, tankerDelivery));
}

// Best transfer the ship can fly with a payload: spend what remains after
// keeping the landing reserve, capped at what the arrival heat shield takes.
export function bestMarsTransfer(payload, { maxEntrySpeed = 7500, ship = STARSHIP_V3 } = {}) {
  const available = shipDeltaV(payload, ship) - missionDeltaV('mars').landing;
  let vInf = excessSpeed(available);
  for (let i = 0; i < 60; i++) {
    const transfer = marsTransfer(vInf);
    if (transfer && entrySpeed(transfer.arrivalVInf) <= maxEntrySpeed) return { vInf, ...transfer, entrySpeed: entrySpeed(transfer.arrivalVInf) };
    vInf *= 0.97;
  }
  const hohmann = marsTransfer(HOHMANN_MARS_VINF);
  return { vInf: HOHMANN_MARS_VINF, ...hohmann, entrySpeed: entrySpeed(hohmann.arrivalVInf) };
}

// Kardashev rating from harnessed power in watts (Sagan 1973 interpolation).
export function kardashev(watts) { return (Math.log10(Math.max(watts, 1)) - 6) / 10; }
