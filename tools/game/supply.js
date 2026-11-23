// Resource-limited production for the roadmap game: what each launch, ship
// and outpost costs in engines, propellant, power and money, and how those
// costs fall with experience. Chemistry and the learning-curve law are exact;
// money figures are calibrations, labelled as such, because SpaceX does not
// publish them.
import { STARSHIP_V3 } from './physics.js';

// Methalox chemistry. Raptor burns CH4 + 2 O2 at O/F ≈ 3.6 (oxygen-rich of
// the 4.0 stoichiometric ratio), so a load of propellant splits as below.
export function propellantSplit(mass, mixture = STARSHIP_V3.mixtureRatio) {
  const methane = mass / (1 + mixture);
  return { methane, oxygen: mass - methane };
}

// Full stack (booster + ship) propellant per launch, kg.
export const STACK_PROPELLANT = STARSHIP_V3.boosterPropellant + STARSHIP_V3.shipPropellant;

// One large air-separation train makes about 3,500 t/day of oxygen (world-scale
// ASU trains run 3,000 to 5,000 t/day). Methane comes from pipeline gas, which
// is not the limit; liquid oxygen is.
export const ASU_TRAIN_TONNES_PER_DAY = 3500;
export function launchesPerDayFromOxygen(trains) {
  return trains * ASU_TRAIN_TONNES_PER_DAY * 1000 / propellantSplit(STACK_PROPELLANT).oxygen;
}

// Mars ISRU by the Sabatier route: CO2 + 4 H2 → CH4 + 2 H2O, with the water
// electrolysed again, so the net reaction is CO2 + 2 H2O → CH4 + 2 O2.
// Per kg CH4: 2.25 kg water mined, 4.0 kg O2 produced (more than the 3.6 kg
// the engine needs), and 0.5 kg H2 electrolysed per pass.
const M_CH4 = 16.043, M_H2O = 18.015, M_O2 = 31.998, M_H2 = 2.016;
export const ISRU = Object.freeze({
  waterPerMethane: 2 * M_H2O / M_CH4,
  oxygenPerMethane: 2 * M_O2 / M_CH4,
  hydrogenPerMethane: 4 * M_H2 / M_CH4,
  // Practical PEM electrolysis is ~50-55 kWh per kg H2 (HHV limit 39.4).
  electrolysisKWhPerKgH2: 52,
  // CO2 capture and compression from the 6 mbar atmosphere, plus
  // liquefaction of both products (estimate).
  auxiliaryKWhPerKgCH4: 4,
});
export function isruEnergyPerKgPropellant(mixture = STARSHIP_V3.mixtureRatio) {
  const perCH4 = ISRU.hydrogenPerMethane * ISRU.electrolysisKWhPerKgH2 + ISRU.auxiliaryKWhPerKgCH4;
  return perCH4 / (1 + mixture); // kWh per kg of loaded propellant (O2 is a by-product)
}

// Mars surface solar: 590 W/m² at the top of the atmosphere, dust and night
// leave a mean of about a fifth of rated panel output (capacity factor,
// estimate from Mars rover experience).
export const MARS_SOLAR_CAPACITY_FACTOR = 0.2;
export const MOON_SOLAR_CAPACITY_FACTOR = 0.45; // 14-day night, polar sites do better
// Deployed thin-film array with structure, kg per kW rated (estimate).
export const SOLAR_KG_PER_KW = 10;

// Propellant (kg) a rated power (kW) can make per day on Mars.
export function marsPropellantPerDay(ratedKW) {
  return ratedKW * MARS_SOLAR_CAPACITY_FACTOR * 24 / isruEnergyPerKgPropellant();
}

// Wright's law (1936): each doubling of cumulative output cuts unit cost to
// `rate` of what it was. Aerospace programmes typically run 80-90 %.
export function learningCost(firstUnit, cumulative, rate = 0.85) {
  return firstUnit * Math.max(1, cumulative) ** Math.log2(rate);
}

// Engines per vehicle (stated V3 counts).
export const RAPTORS = Object.freeze({ ship: STARSHIP_V3.raptorsPerShip, booster: STARSHIP_V3.raptorsPerBooster });

// Money calibrations, US$ billions (estimates, not SpaceX figures).
export const COSTS = Object.freeze({
  shipFirst: 0.09, boosterFirst: 0.12, raptorFirst: 0.002, // first-unit costs; Raptor 3 target is $0.25M at rate
  raptorFloor: 0.00025, shipFloor: 0.015, boosterFloor: 0.02,
  propellantPerLaunch: 0.0012, // ~4,900 t of methalox at bulk LNG and LOX prices
  launchOpsFirst: 0.03, launchOpsFloor: 0.002,
  shipLine: 2.0, raptorLine: 1.0, pad: 0.8, asuTrain: 0.6, gigasatLine: 6.0,
});

// Capacity each investment adds per year (estimates for the game).
export const CAPACITY = Object.freeze({
  shipLine: 50,      // ships (or boosters) per year per Gigabay line
  raptorLine: 365,   // engines per year per line ("a Raptor a day")
  gigasatLine: 1,    // GW of AI compute satellites per year per factory line
});
