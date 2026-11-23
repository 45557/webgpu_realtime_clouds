// The roadmap game's simulation: one step is one month from December 2026 to
// December 2100. Nothing here touches the DOM or the GPU, so it runs under
// node:test. Physical limits come from physics.js and supply.js; the player
// spends money on factories, pads, oxygen plants and research, and sets what
// the launches are for.
import { createRandom } from '../clouds/life/planetLifeSim.js';
import {
  BODIES, DAY, STARSHIP_V3, bestMarsTransfer, entrySpeed, kardashev, missionDeltaV, nextMarsWindow, propellantFor, tankersToRefill,
} from './physics.js';
import {
  CAPACITY, COSTS, RAPTORS, SOLAR_KG_PER_KW, MOON_SOLAR_CAPACITY_FACTOR, MARS_SOLAR_CAPACITY_FACTOR,
  launchesPerDayFromOxygen, learningCost, marsPropellantPerDay,
} from './supply.js';
import { MILESTONES, QUOTES } from './roadmap.js';

export const START = Date.UTC(2026, 11, 1);
export const END = Date.UTC(2100, 11, 1);
const MONTH_DAYS = 30.44;
const YEARS_PER_MONTH = MONTH_DAYS / 365.25;

// Research the player can fund. Costs in US$ billions, durations in months.
export const PROJECTS = Object.freeze({
  shipCatch: { name: 'Ship catch and reflight', cost: 0.5, months: 3, note: 'Ships come back to the tower instead of splashing down, so they fly again.' },
  refilling: { name: 'Orbital propellant transfer', cost: 1.5, months: 6, note: 'Tankers refill a ship in LEO. Needed for the Moon and Mars.' },
  marsEDL: { name: 'Mars entry and landing', cost: 1.0, months: 9, requires: ['refilling'], note: 'Heat shield and landing burn for 7+ km/s Mars entry.' },
  lifeSupport: { name: 'Closed-loop life support', cost: 2.0, months: 18, requires: ['refilling'], note: 'Crew can ride the 6-month transfer and live on the surface.' },
  isru: { name: 'Sabatier propellant plant', cost: 2.0, months: 18, requires: ['marsEDL'], note: 'Make CH₄/O₂ on Mars from ice and CO₂ for return flights.' },
  rapidReuse: { name: 'Rapid reuse (halve pad turnaround)', cost: 1.5, months: 12, repeatable: true, note: 'Each level halves the days between launches from a pad, down to one.' },
  tankerV4: { name: 'Stretched tanker (200 t delivered)', cost: 3.0, months: 24, requires: ['refilling'], note: 'Musk has spoken of ~200 t per tanker flight; fewer tankers per ship.' },
  raptor4: { name: 'Higher-Isp engines (+10 s)', cost: 4.0, months: 36, note: 'More Δv: faster Mars transfers and bigger payloads.' },
  gigasat: { name: 'AI compute satellites', cost: 2.0, months: 12, note: 'Solar-powered compute in orbit. Unlocks Gigasat factory lines.' },
  lunarHab: { name: 'Lunar surface habitat', cost: 1.5, months: 12, requires: ['refilling'], note: 'Crewed outposts on the Moon.' },
  massDriver: { name: 'Lunar mass driver (extrapolated)', cost: 30, months: 60, requires: ['lunarHab'], note: 'Game extrapolation: lunar factories throw solar satellites to orbit without rockets.' },
});

export const BUILDS = Object.freeze({
  shipLine: { name: 'Starship line', cost: COSTS.shipLine, note: `+${CAPACITY.shipLine} ships or boosters a year` },
  raptorLine: { name: 'Raptor line', cost: COSTS.raptorLine, note: `+${CAPACITY.raptorLine} engines a year` },
  pad: { name: 'Launch pad', cost: COSTS.pad, note: 'One more tower to launch and catch from' },
  asuTrain: { name: 'Oxygen plant', cost: COSTS.asuTrain, note: `+${launchesPerDayFromOxygen(1).toFixed(2)} launches/day of liquid oxygen` },
  gigasatLine: { name: 'Gigasat line', cost: COSTS.gigasatLine, requires: 'gigasat', note: `+${CAPACITY.gigasatLine} GW/yr of AI satellites` },
});

// Calibrations (estimates; see tools/game/README.md).
const STARLINK = { revenueStart: 14, growth: 0.15, demandCap: 300, perLaunch: 0.12, lifeYears: 5 };
const AI = { revenuePerGWYear: 8, kWPerTonne: 42, lifeYears: 6 };
const EARTH_POWER_2026 = 19.5e12, EARTH_POWER_GROWTH = 0.015; // W (Energy Institute 2024: ~620 EJ/yr)
const PEOPLE_PER_SHIP = 100;      // Musk's 2016-17 figure for a crewed Mars ship
const TONNES_PER_PERSON = 5;      // sustained cargo per settler (estimate)
const RELIABILITY_CAP = 0.995;

export function createGame({ seed = 2100 } = {}) {
  return {
    seed, month: 0, date: START, rngCalls: 0,
    cash: 25, revenue: 0, spend: 0,
    lines: { shipLine: 1, raptorLine: 1, pad: 2, asuTrain: 1, gigasatLine: 0 },
    stock: { raptors: 40, ships: 2, boosters: 2 },
    // Flight record carried into the game: 14 flights, 9 successes (28 Sep 2026).
    record: { launches: 14, successes: 9, marsAttempts: 0, marsLanded: 0 },
    tech: { shipCatch: 0, refilling: 0, marsEDL: 0, lifeSupport: 0, isru: 0, rapidReuse: 0, tankerV4: 0, raptor4: 0, gigasat: 0, lunarHab: 0, massDriver: 0 },
    research: [],
    priorities: { starlink: 60, ai: 0, moon: 20, mars: 20 },
    marsPlan: { ships: 2, crewed: 0 },
    moonPlan: { shipsPerMonth: 0, crewed: 0 },
    starlink: { capacity: STARLINK.revenueStart, cohorts: [] },
    ai: { gw: 0, cohorts: [], built: 0 },
    transit: [],
    moon: { cargo: 0, population: 0, powerKW: 0, selfSufficiency: 0 },
    mars: { cargo: 0, population: 0, powerKW: 0, propellant: 0, selfSufficiency: 0 },
    counters: { shipsBuilt: 0, boostersBuilt: 0, shipCatches: 0, marsLandings: 0, moonLandings: 0, failures: 0, launches: 0, tankers: 0 },
    rates: { launchesPerYear: 0, aiGWPerYear: 0, launchCapacity: 0, limit: '' },
    kardashev: kardashev(EARTH_POWER_2026), powerW: EARTH_POWER_2026,
    achieved: {}, log: [], over: false, lastMonth: null,
  };
}

function rng(game) {
  // Reseed per call count so a game in progress can be saved as plain JSON.
  const r = createRandom(game.seed * 7919 + game.rngCalls++)();
  return r;
}

function log(game, kind, text, extra = {}) {
  game.log.push({ date: game.date, kind, text, ...extra });
  if (game.log.length > 400) game.log.shift();
}

export function yearOf(date) {
  const d = new Date(date);
  return d.getUTCFullYear() + (d.getUTCMonth() + d.getUTCDate() / 31) / 12;
}

export function tankerDelivery(game) { return game.tech.tankerV4 ? 200e3 : 100e3; }
export function shipFor(game) { return game.tech.raptor4 ? { ...STARSHIP_V3, ispVacuum: STARSHIP_V3.ispVacuum + 10 } : STARSHIP_V3; }
export function padTurnaroundDays(game) { return Math.max(1, 30 / 2 ** game.tech.rapidReuse); }
// Duane (1964) reliability growth: the failure rate falls as a power of
// cumulative tests. Anchored on the record going in (5 failures in 14
// flights); with exponent 0.5 it reaches Falcon 9-like reliability after a
// few thousand flights.
export function reliability(game) {
  const n = Math.max(14, game.record.launches);
  return Math.min(RELIABILITY_CAP, 1 - 5 / 14 * (n / 14) ** -0.5);
}
export function marsLandingOdds(game) {
  if (!game.tech.marsEDL) return 0.25;
  // Prior worth three successes from Earth-return experience, then the record.
  return Math.min(0.98, (game.record.marsLanded + 3) / (game.record.marsAttempts + 4));
}

// Launches each kind of mission takes: the ship itself plus tankers.
export function moonMissionLaunches(game, payload = STARSHIP_V3.payloadLEO) {
  const ship = shipFor(game);
  const prop = propellantFor(missionDeltaV('moon').outbound, ship.ispVacuum, ship.shipDry + payload);
  return 1 + tankersToRefill(Math.min(prop, ship.shipPropellant), tankerDelivery(game));
}
export function marsMissionLaunches(game) {
  return 1 + tankersToRefill(shipFor(game).shipPropellant, tankerDelivery(game));
}

export function marsWindow(game) {
  const next = nextMarsWindow(game.date - 45 * DAY * 1000);
  const open = Math.abs(game.date - next) <= 45 * DAY * 1000;
  return { next: open ? next : nextMarsWindow(game.date), open };
}

export function canStart(game, id) {
  const p = PROJECTS[id];
  if (!p) return false;
  if (!p.repeatable && game.tech[id]) return false;
  if (game.research.some(r => r.id === id)) return false;
  if (p.repeatable && game.tech[id] >= 5) return false;
  if ((p.requires ?? []).some(r => !game.tech[r])) return false;
  return game.cash >= p.cost;
}

export function startResearch(game, id) {
  if (!canStart(game, id)) return false;
  const p = PROJECTS[id];
  game.cash -= p.cost;
  game.research.push({ id, left: p.months });
  log(game, 'research', `Started: ${p.name} (${p.months} months, $${p.cost}B).`);
  return true;
}

export function canBuild(game, id) {
  const b = BUILDS[id];
  return !!b && (!b.requires || game.tech[b.requires]) && game.cash >= b.cost;
}
export function build(game, id) {
  if (!canBuild(game, id)) return false;
  game.cash -= BUILDS[id].cost;
  game.lines[id]++;
  log(game, 'build', `Built: ${BUILDS[id].name} (now ${game.lines[id]}).`);
  return true;
}

export function setPriorities(game, priorities) {
  game.priorities = { ...game.priorities, ...priorities };
}

// Monthly launch capacity and its binding constraint.
export function launchCapacity(game) {
  const turnaround = padTurnaroundDays(game);
  const limits = {
    pads: game.lines.pad * MONTH_DAYS / turnaround,
    oxygen: launchesPerDayFromOxygen(game.lines.asuTrain) * MONTH_DAYS,
    boosters: game.stock.boosters * MONTH_DAYS / Math.max(turnaround, 2),
    // A caught ship flies again after a turnaround; otherwise each launch uses one up.
    ships: game.tech.shipCatch ? game.stock.ships * MONTH_DAYS / Math.max(turnaround, 2) : game.stock.ships,
  };
  const [limit, value] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0];
  return { launches: Math.max(0, value), limit, limits };
}

function produce(game) {
  const raptorsMade = game.lines.raptorLine * CAPACITY.raptorLine / 12;
  game.stock.raptors += raptorsMade;
  let slots = game.lines.shipLine * CAPACITY.shipLine / 12;
  // Keep about two boosters per pad, then build ships.
  while (slots >= 1 && game.stock.boosters < game.lines.pad * 2 && game.stock.raptors >= RAPTORS.booster) {
    const cost = learningCost(COSTS.boosterFirst, game.counters.boostersBuilt + 1) + RAPTORS.booster * raptorCost(game);
    if (game.cash < cost) break;
    game.cash -= cost; game.spend += cost; game.stock.raptors -= RAPTORS.booster; game.stock.boosters++; game.counters.boostersBuilt++; slots--;
  }
  game.shipBuildCarry = (game.shipBuildCarry ?? 0) + slots;
  while (game.shipBuildCarry >= 1 && game.stock.ships < shipTarget(game) && game.stock.raptors >= RAPTORS.ship) {
    const cost = Math.max(COSTS.shipFloor, learningCost(COSTS.shipFirst, game.counters.shipsBuilt + 1)) + RAPTORS.ship * raptorCost(game);
    if (game.cash < cost) break;
    game.cash -= cost; game.spend += cost; game.stock.raptors -= RAPTORS.ship; game.stock.ships++; game.counters.shipsBuilt++; game.shipBuildCarry--;
  }
  game.shipBuildCarry = Math.min(game.shipBuildCarry, 2);
}
// Ships worth keeping on hand: enough for a month of launches, the next Mars
// fleet and the Moon flights.
export function shipTarget(game) {
  const cap = launchCapacity({ ...game, stock: { ...game.stock, ships: Infinity } }).launches;
  const flying = game.tech.shipCatch ? cap / (MONTH_DAYS / Math.max(padTurnaroundDays(game), 2)) : cap;
  return Math.ceil(flying + game.marsPlan.ships + game.moonPlan.shipsPerMonth * 2 + 2);
}
function raptorCost(game) {
  const made = (game.counters.shipsBuilt * RAPTORS.ship + game.counters.boostersBuilt * RAPTORS.booster) + 1;
  return Math.max(COSTS.raptorFloor, learningCost(COSTS.raptorFirst, made));
}
function launchCost(game) {
  return Math.max(COSTS.launchOpsFloor, learningCost(COSTS.launchOpsFirst, game.counters.launches + 1)) + COSTS.propellantPerLaunch;
}

// Fly `count` launches; returns successes. Each failure loses the ship and
// sometimes the booster.
function fly(game, count, { expendShip }) {
  let ok = 0;
  const p = reliability(game);
  for (let i = 0; i < count; i++) {
    const cost = launchCost(game);
    game.cash -= cost; game.spend += cost;
    game.counters.launches++; game.record.launches++;
    if (rng(game) < p) {
      ok++; game.record.successes++;
      if (expendShip) game.stock.ships = Math.max(0, game.stock.ships - 1);
      else if (game.tech.shipCatch) game.counters.shipCatches++;
    } else {
      game.counters.failures++;
      game.stock.ships = Math.max(0, game.stock.ships - 1);
      if (rng(game) < 0.4) game.stock.boosters = Math.max(0, game.stock.boosters - 1);
    }
  }
  return ok;
}

function step(game) {
  const events = [];
  // Research.
  for (const r of game.research) r.left--;
  for (const r of game.research.filter(r => r.left <= 0)) {
    game.tech[r.id] = (game.tech[r.id] || 0) + 1;
    log(game, 'tech', `Done: ${PROJECTS[r.id].name}.`);
  }
  game.research = game.research.filter(r => r.left > 0);

  produce(game);
  const cap = launchCapacity(game);
  let budget = Math.floor(cap.launches + (game.launchCarry ?? 0));
  game.launchCarry = cap.launches + (game.launchCarry ?? 0) - budget;
  const launched = { starlink: 0, ai: 0, moon: 0, mars: 0, tankers: 0 };
  const reusable = !!game.tech.shipCatch;

  // Mars departures in an open window: one ship plus its tankers each.
  const window = marsWindow(game);
  if (window.open && game.tech.refilling && game.marsPlan.ships > 0) {
    const per = marsMissionLaunches(game);
    const sent = game.departedThisWindow === window.next ? game.departedWindowCount : 0;
    const want = Math.max(0, game.marsPlan.ships - sent);
    const affordable = Math.min(want, Math.floor(budget * Math.min(1, game.priorities.mars / 100 + 0.5) / per), game.stock.ships);
    if (affordable === 0 && want > 0 && game.warnedWindow !== window.next) {
      game.warnedWindow = window.next;
      log(game, 'mars', `Mars window open, but one ship needs ${per} launches (itself + ${per - 1} tankers) and you have ${budget} this month${game.stock.ships ? '' : ' and no ship ready'}. Add pads, oxygen or rapid reuse.`);
    }
    if (affordable > 0) {
      const transfer = bestMarsTransfer(STARSHIP_V3.payloadLEO, { ship: shipFor(game) });
      const tankers = (per - 1) * affordable;
      const tankerOk = fly(game, tankers, { expendShip: false });
      const shipsUp = fly(game, affordable, { expendShip: false });
      const departing = Math.min(shipsUp, Math.floor(tankerOk / (per - 1)));
      game.stock.ships = Math.max(0, game.stock.ships - departing); // they stay on Mars
      budget -= tankers + affordable;
      launched.mars += departing; launched.tankers += tankers;
      game.counters.tankers += tankers;
      const crewed = game.tech.lifeSupport ? Math.min(departing, game.marsPlan.crewed) : 0;
      game.transit.push({ to: 'mars', ships: departing, crewed, arrive: game.date + transfer.days * DAY * 1000, entrySpeed: transfer.entrySpeed, days: transfer.days });
      game.departedThisWindow = window.next;
      game.departedWindowCount = sent + departing;
      if (departing) {
        log(game, 'mars', `${departing} Starship${departing > 1 ? 's' : ''} left for Mars${crewed ? ` (${crewed} crewed)` : ''}: ${Math.round(transfer.days)}-day transfer, ${(transfer.entrySpeed / 1000).toFixed(1)} km/s entry, ${tankers} tanker flights.`);
        events.push({ kind: 'departure', to: 'mars', ships: departing });
      }
    }
  }

  // Moon flights: a ship and its tankers, any month.
  if (game.tech.refilling && budget > 0 && game.moonPlan.shipsPerMonth > 0) {
    const per = moonMissionLaunches(game);
    const want = Math.min(game.moonPlan.shipsPerMonth, Math.floor(budget * game.priorities.moon / 100 / per) || (game.priorities.moon > 0 && budget >= per ? 1 : 0), game.stock.ships);
    if (want > 0) {
      const tankers = (per - 1) * want;
      const tankerOk = fly(game, tankers, { expendShip: false });
      const shipsUp = fly(game, want, { expendShip: false });
      const going = Math.min(shipsUp, Math.floor(tankerOk / Math.max(1, per - 1)));
      game.stock.ships = Math.max(0, game.stock.ships - going);
      budget -= tankers + want;
      launched.moon += going; launched.tankers += tankers; game.counters.tankers += tankers;
      if (going) game.transit.push({ to: 'moon', ships: going, crewed: game.tech.lunarHab ? Math.min(going, game.moonPlan.crewed) : 0, arrive: game.date + 4 * DAY * 1000, entrySpeed: 0, days: 4 });
    }
  }

  // The rest goes to Starlink and AI compute in proportion.
  if (budget > 0) {
    const total = reusable ? budget : Math.min(budget, game.stock.ships);
    const aiShare = game.tech.gigasat ? game.priorities.ai / Math.max(1, game.priorities.ai + game.priorities.starlink) : 0;
    const aiFactory = game.lines.gigasatLine * CAPACITY.gigasatLine * 1e6 / 12; // kW/month the factories can fill
    const aiPerLaunch = AI.kWPerTonne * STARSHIP_V3.payloadLEO / 1000;
    const aiLaunches = Math.min(Math.round(total * aiShare), Math.floor(aiFactory / aiPerLaunch));
    const starlinkLaunches = game.priorities.starlink > 0 ? total - aiLaunches : 0;
    const okAI = fly(game, aiLaunches, { expendShip: !reusable });
    const okSL = fly(game, starlinkLaunches, { expendShip: !reusable });
    launched.ai = okAI; launched.starlink = okSL;
    if (okAI) { const gw = okAI * aiPerLaunch / 1e6; game.ai.gw += gw; game.ai.cohorts.push({ date: game.date, gw }); }
    if (okSL) { const cap = okSL * STARLINK.perLaunch; game.starlink.capacity += cap; game.starlink.cohorts.push({ date: game.date, cap }); }
  }

  // Lunar mass driver (extrapolated): lunar industry makes and throws solar
  // power satellites up without rockets, in proportion to its industrial base.
  if (game.tech.massDriver) {
    const gw = game.moon.cargo * 0.02 * YEARS_PER_MONTH;
    game.ai.gw += gw; game.ai.cohorts.push({ date: game.date, gw, life: 25 });
  }

  // Constellations wear out.
  const age = c => (game.date - c.date) / (365.25 * DAY * 1000);
  for (const c of game.starlink.cohorts.filter(c => age(c) > STARLINK.lifeYears)) game.starlink.capacity -= c.cap;
  game.starlink.cohorts = game.starlink.cohorts.filter(c => age(c) <= STARLINK.lifeYears);
  game.starlink.capacity -= game.month < 60 ? STARLINK.revenueStart / 60 : 0; // the 2026 fleet retires over five years
  for (const c of game.ai.cohorts.filter(c => age(c) > (c.life ?? AI.lifeYears))) game.ai.gw -= c.gw;
  game.ai.cohorts = game.ai.cohorts.filter(c => age(c) <= (c.life ?? AI.lifeYears));
  game.ai.gw = Math.max(0, game.ai.gw);

  // Arrivals.
  for (const t of game.transit.filter(t => t.arrive <= game.date + MONTH_DAYS * DAY * 1000)) {
    const target = game[t.to];
    let landed = 0, crewLanded = 0;
    for (let i = 0; i < t.ships; i++) {
      const odds = t.to === 'mars' ? marsLandingOdds(game) : Math.min(0.99, reliability(game) + 0.05);
      if (t.to === 'mars') game.record.marsAttempts++;
      if (rng(game) < odds) {
        landed++;
        if (t.to === 'mars') game.record.marsLanded++;
        if (i < t.crewed) crewLanded++;
      }
    }
    const cargo = (landed - crewLanded) * STARSHIP_V3.payloadLEO / 1000 + crewLanded * 20;
    target.cargo += cargo;
    // A third of cargo is solar arrays and power gear.
    target.powerKW += cargo * 1000 / 3 / SOLAR_KG_PER_KW;
    target.population += crewLanded * PEOPLE_PER_SHIP;
    game.counters[t.to === 'mars' ? 'marsLandings' : 'moonLandings'] += landed;
    if (t.to === 'mars') {
      log(game, 'mars', `Mars arrival: ${landed} of ${t.ships} landed${crewLanded ? `, ${crewLanded * PEOPLE_PER_SHIP} people aboard` : ''}.`);
      events.push({ kind: 'arrival', to: 'mars', landed, lost: t.ships - landed, entrySpeed: t.entrySpeed });
    } else if (landed) {
      events.push({ kind: 'arrival', to: 'moon', landed, lost: t.ships - landed });
    }
  }
  game.transit = game.transit.filter(t => t.arrive > game.date + MONTH_DAYS * DAY * 1000);

  // Settlements: habitat limit, births once there are families, ISRU.
  for (const key of ['mars', 'moon']) {
    const s = game[key];
    s.population = Math.min(s.population, s.cargo / TONNES_PER_PERSON);
    if (s.population > 1000) s.population *= 1 + 0.01 * YEARS_PER_MONTH;
    const industry = key === 'mars' ? 1e6 : 1e5, workforce = key === 'mars' ? 1e5 : 1e4;
    s.selfSufficiency = Math.min(1, s.cargo / industry, s.population / workforce);
  }
  if (game.tech.isru) game.mars.propellant += marsPropellantPerDay(game.mars.powerKW) * MONTH_DAYS / 1000;

  // Money.
  const years = (game.date - START) / (365.25 * DAY * 1000);
  const demand = Math.min(STARLINK.demandCap, STARLINK.revenueStart * (1 + STARLINK.growth) ** years);
  game.starlink.capacity = Math.max(0, game.starlink.capacity);
  const income = (Math.min(demand, game.starlink.capacity) + game.ai.gw * AI.revenuePerGWYear + 1) / 12;
  game.cash += income;
  game.revenue = income * 12;

  // Rates and energy.
  game.rates.launchCapacity = cap.launches * 12;
  game.rates.limit = cap.limit;
  game.lastMonth = launched;
  const monthLaunches = launched.starlink + launched.ai + launched.moon + launched.mars + launched.tankers;
  game.rates.launchesPerYear = game.rates.launchesPerYear * 11 / 12 + monthLaunches;
  game.rates.aiGWPerYear = game.rates.aiGWPerYear * 11 / 12 + launched.ai * AI.kWPerTonne * STARSHIP_V3.payloadLEO / 1000 / 1e6;
  const earth = EARTH_POWER_2026 * (1 + EARTH_POWER_GROWTH) ** years;
  const space = game.ai.gw * 1e9 + game.mars.powerKW * 1e3 * MARS_SOLAR_CAPACITY_FACTOR + game.moon.powerKW * 1e3 * MOON_SOLAR_CAPACITY_FACTOR;
  game.powerW = earth + space;
  game.kardashev = kardashev(game.powerW);
  return events;
}

function checkMilestones(game, events) {
  for (const m of MILESTONES) {
    if (game.achieved[m.id] || !m.check(game)) continue;
    const year = yearOf(game.date);
    game.achieved[m.id] = year;
    const delta = year - m.target;
    const quote = QUOTES[m.quote];
    log(game, 'milestone', `${m.title}: ${delta <= 0 ? `${Math.abs(delta).toFixed(1)} yr ahead of` : `${delta.toFixed(1)} yr behind`} Musk's stated ${Math.floor(m.target)}.`, { milestone: m.id, quote });
    events.push({ kind: 'milestone', milestone: m, quote, year });
  }
}

// Advance one month. Returns what happened, for the scene to show.
export function advance(game) {
  if (game.over) return [];
  const events = step(game);
  checkMilestones(game, events);
  game.month++;
  const d = new Date(START);
  d.setUTCMonth(d.getUTCMonth() + game.month);
  game.date = d.getTime();
  if (game.cash < -20) {
    game.over = true;
    log(game, 'end', 'Out of money: the creditors take the factories.');
    events.push({ kind: 'end', reason: 'bankrupt' });
  } else if (game.date >= END) {
    game.over = true;
    log(game, 'end', `2100 reached. Kardashev ${game.kardashev.toFixed(3)}, ${Math.round(game.mars.population).toLocaleString('en-US')} people on Mars.`);
    events.push({ kind: 'end', reason: 'time' });
  }
  return events;
}

export function advanceTo(game, predicate, maxMonths = 120) {
  const events = [];
  for (let i = 0; i < maxMonths && !game.over; i++) {
    events.push(...advance(game));
    if (predicate(game)) break;
  }
  return events;
}

export function score(game) {
  const ahead = MILESTONES.reduce((sum, m) => sum + (game.achieved[m.id] ? Math.max(0, 5 - Math.max(0, game.achieved[m.id] - m.target)) : 0), 0);
  return Math.round(1000 * Math.max(0, game.kardashev - 0.7) + Math.log10(1 + game.mars.population) * 50 + ahead * 10);
}

export { entrySpeed, BODIES };
