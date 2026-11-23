import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOHMANN_MARS_VINF, SYNODIC_PERIOD_DAYS, STARSHIP_V3, departureBurn, entrySpeed, kardashev, marsTransfer, nextMarsWindow,
  propellantFor, rocketDeltaV, shipDeltaV,
} from '../physics.js';
import { ISRU, STACK_PROPELLANT, isruEnergyPerKgPropellant, launchesPerDayFromOxygen, learningCost, propellantSplit } from '../supply.js';
import {
  advance, build, createGame, launchCapacity, marsMissionLaunches, moonMissionLaunches, reliability, startResearch, yearOf,
} from '../game.js';
import { MILESTONES, QUOTES } from '../roadmap.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

test('Hohmann Earth-Mars transfer matches the textbook figures', () => {
  near(HOHMANN_MARS_VINF, 2945, 10, 'departure v∞ (m/s)');
  const t = marsTransfer(HOHMANN_MARS_VINF);
  near(t.days, 259, 2, 'transfer days');
  near(t.arrivalVInf, 2649, 15, 'arrival v∞ (m/s)');
  near(departureBurn(HOHMANN_MARS_VINF), 3600, 30, 'trans-Mars injection from LEO (m/s)');
  near(SYNODIC_PERIOD_DAYS, 780, 1, 'synodic period');
});

test('faster transfers cost more departure speed and arrive hotter', () => {
  const slow = marsTransfer(HOHMANN_MARS_VINF), fast = marsTransfer(5000);
  assert.ok(fast.days < slow.days - 60);
  assert.ok(entrySpeed(fast.arrivalVInf) > entrySpeed(slow.arrivalVInf));
  near(entrySpeed(0), 5027, 5, 'Mars escape speed at the surface');
});

test('launch windows fall on the real 2026, 2028-29 and 2031 Mars windows', () => {
  const dates = [];
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++) { t = nextMarsWindow(t); dates.push(new Date(t)); t += 60 * 86400e3; }
  assert.deepEqual(dates.map(d => d.getUTCFullYear()), [2026, 2029, 2031]);
  assert.ok(dates[0].getUTCMonth() >= 9 && dates[0].getUTCMonth() <= 11, 'late-2026 window');
});

test('rocket equation and Starship V3 numbers', () => {
  near(rocketDeltaV(300, Math.E, 1), 300 * 9.80665, 1e-6, 'Δv = Isp g0 ln(e)');
  near(propellantFor(rocketDeltaV(350, 10, 2), 350, 2), 8, 1e-9, 'propellantFor inverts the rocket equation');
  const dv = shipDeltaV(STARSHIP_V3.payloadLEO);
  assert.ok(dv > 7000 && dv < 8000, `refilled ship with 100 t has ${dv} m/s`);
});

test('methalox and Sabatier stoichiometry', () => {
  const { methane, oxygen } = propellantSplit(4600);
  near(oxygen / methane, 3.6, 1e-9, 'O/F');
  near(ISRU.waterPerMethane, 2.246, 0.002, 'kg water per kg CH4');
  near(ISRU.oxygenPerMethane, 3.989, 0.002, 'kg O2 per kg CH4');
  near(ISRU.hydrogenPerMethane, 0.5027, 0.001, 'kg H2 per kg CH4');
  const kwh = isruEnergyPerKgPropellant();
  assert.ok(kwh > 5 && kwh < 8, `${kwh} kWh per kg of propellant`);
  near(STACK_PROPELLANT, 4.9e6, 1, 'stack propellant');
  assert.ok(launchesPerDayFromOxygen(1) > 0.8 && launchesPerDayFromOxygen(1) < 1);
});

test("Wright's law halves cost after the right number of doublings", () => {
  near(learningCost(100, 1), 100, 1e-9, 'first unit');
  near(learningCost(100, 2, 0.85), 85, 1e-9, 'second unit');
  near(learningCost(100, 1024, 0.85), 100 * 0.85 ** 10, 1e-6, 'ten doublings');
});

test('Kardashev scale', () => {
  near(kardashev(1e16), 1, 1e-12, 'Type I');
  near(kardashev(2e13), 0.73, 0.001, 'Earth today');
});

test('a new game starts after Flight 14 with the real record and real limits', () => {
  const game = createGame();
  assert.equal(new Date(game.date).toISOString().slice(0, 10), '2026-12-01');
  near(reliability(game), 9 / 14, 0.01, 'starting reliability');
  const cap = launchCapacity(game);
  assert.ok(cap.launches > 0 && cap.launches < 5, `${cap.launches} launches/month at the start`);
  assert.ok(marsMissionLaunches(game) >= 10 && marsMissionLaunches(game) <= 20, 'Mars needs 8-20 launches per ship');
  assert.ok(moonMissionLaunches(game) < marsMissionLaunches(game));
});

test('research, building and time move the state forward deterministically', () => {
  const play = () => {
    const game = createGame({ seed: 3 });
    assert.ok(startResearch(game, 'shipCatch'));
    assert.ok(!startResearch(game, 'shipCatch'), 'no double research');
    assert.ok(!startResearch(game, 'marsEDL'), 'needs refilling first');
    assert.ok(build(game, 'pad'));
    for (let i = 0; i < 24; i++) advance(game);
    return game;
  };
  const a = play(), b = play();
  assert.equal(a.tech.shipCatch, 1);
  assert.equal(yearOf(a.date) > 2028.9, true);
  assert.deepEqual(a.counters, b.counters, 'same seed, same history');
  assert.ok(a.counters.launches > 0);
});

test('every milestone has a quote that exists and a dated source', () => {
  for (const m of MILESTONES) {
    assert.ok(QUOTES[m.quote], `${m.id} quote`);
    assert.ok(m.extrapolated || m.source?.url, `${m.id} source`);
  }
  for (const [id, q] of Object.entries(QUOTES)) assert.match(q.source.url, /^https:\/\//, id);
});

test('a full game reaches 2100 without NaN', () => {
  const game = createGame({ seed: 11 });
  for (const id of ['shipCatch', 'refilling']) startResearch(game, id);
  game.moonPlan = { shipsPerMonth: 1, crewed: 0 };
  while (!game.over) advance(game);
  for (const value of [game.cash, game.kardashev, game.mars.population, game.moon.cargo, game.ai.gw]) assert.ok(Number.isFinite(value));
  assert.ok(game.achieved['ship-catch'] && game.achieved.refill);
});
