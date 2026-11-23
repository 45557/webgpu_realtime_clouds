// The roadmap: what Elon Musk has said SpaceX would do, when he said it would
// happen, and what actually happened. Quotes are verbatim from the cited
// source; `said` is the date he said it. Targets after 2026 are his stated
// goals, not facts. Anything beyond his public statements is marked
// `extrapolated` and is game design, not a claim about his plans.

const SRC = Object.freeze({
  sxsw2013: { label: 'HuffPost, SXSW 2013 (11 Mar 2013)', url: 'https://www.huffingtonpost.ca/2013/03/11/sxsw-interactive-2013-elon-musk-mars-spacex_n_2855562.html' },
  npc2011: { label: 'AFP via Phys.org, National Press Club (29 Sep 2011)', url: 'https://phys.org/news/2011-09-spacex-reusable-rocket-colonize-mars.html' },
  newspace2017: { label: 'Musk, "Making Humans a Multi-Planetary Species", New Space 5(2), June 2017, via Universe Today', url: 'https://www.universetoday.com/articles/elon-musk-details-vision-human-civilization-mars' },
  iac2017: { label: 'CNBC (16 Mar 2018), quoting IAC 2017', url: 'https://www.cnbc.com/2018/03/16/elon-musk-on-inspiration-and-success.html' },
  techcrunch2019: { label: 'TechCrunch (7 Nov 2019)', url: 'https://techcrunch.com/2019/11/07/elon-musk-says-building-the-first-sustainable-city-on-mars-will-take-1000-starships-and-20-years/' },
  mars2025: { label: 'Business Today on "The Road to Making Life Multiplanetary" (29 May 2025)', url: 'https://www.businesstoday.in/latest/trends/story/mars-by-2026-elon-musk-shares-critical-updates-on-starship-launch-2029-human-landing-goal-478538-2025-05-31' },
  davos2026: { label: 'Business Today, WEF Davos (22 Jan 2026)', url: 'https://www.businesstoday.in/amp/wef-2026/story/wef-summit-davos-2026-elon-musk-ai-data-centres-space-512507-2026-01-22' },
  moon2026: { label: 'NBC News (Feb 2026)', url: 'https://www.nbcnews.com/science/space/spacex-prioritizes-moon-before-mars-musk-says-rcna258168' },
  gigasat2026: { label: "Tom's Hardware (9 Jun 2026)", url: 'https://www.tomshardware.com/tech-industry/big-tech/spacex-unveils-11-million-square-foot-gigasat-factory-a-new-manufacturing-facility-for-space-based-data-centers-aims-for-1-gw-year-of-space-ai-compute-by-late-2027-from-its-satellites' },
  starshipList: { label: 'Wikipedia, List of Starship launches (as of 28 Sep 2026)', url: 'https://en.wikipedia.org/wiki/List_of_Starship_launches' },
  flight12: { label: 'Wikipedia, Starship flight test 12', url: 'https://en.wikipedia.org/wiki/Starship_flight_test_12' },
  v3: { label: 'NewSpace Economy, Starship V3 review (16 Apr 2026)', url: 'https://newspaceeconomy.ca/2026/04/16/detailed-review-of-starship-v3/' },
  launches2025: { label: 'Space.com, 165 orbital launches in 2025', url: 'https://www.space.com/space-exploration/private-spaceflight/spacex-shatters-its-rocket-launch-record-yet-again-167-orbital-flights-in-2025' },
  ptd: { label: 'Wikipedia, Starship Propellant Transfer Demonstration', url: 'https://en.wikipedia.org/wiki/Starship_Propellant_Transfer_Demonstration' },
});
export const SOURCES = SRC;

export const QUOTES = Object.freeze({
  dieOnMars: { text: 'I would like to die on Mars. Just not on impact.', said: '2013-03-09', source: SRC.sxsw2013 },
  reusable: { text: 'A fully and rapidly reusable system is fully required for life to become multi-planetary, for us to establish life on Mars,', said: '2011-09-29', source: SRC.npc2011 },
  planes: { text: 'If planes were not reusable, very few people would fly.', said: '2011-09-29', source: SRC.npc2011 },
  bifurcate: { text: 'History is going to bifurcate along two directions.', said: '2017-06-01', source: SRC.newspace2017 },
  stars: { text: "And I can't think of anything more exciting than going out there and being among the stars.", said: 'via CNBC, 2018', source: SRC.iac2017 },
  dangerous: { text: 'For the early people that go to Mars, it will be far more dangerous.', said: 'via CNBC, 2018', source: SRC.iac2017 },
  anyone: { text: "Ideally, we'll be able to take anyone who wants to go to Mars,", said: '2025-05-29', source: SRC.mars2025 },
  twoPlanets: { text: 'Having two strong, self-sustaining planets will be critical for the long-term survival of civilization.', said: '2025-05-29', source: SRC.mars2025 },
  optimusFirst: { text: 'Maybe to just be safe, we might do two landing episodes with Optimus and the third one with humans. We will see,', said: '2025-05-29', source: SRC.mars2025 },
  recompile: { text: "There's a lot of freedom and opportunity in Mars to do a recompile on civilization, which will be up to the Martians.", said: '2025-05-29', source: SRC.mars2025 },
  power: { text: 'The limiting factor is electrical power,', said: '2026-01-22', source: SRC.davos2026 },
  factor100: { text: 'When you achieve full reusability, the cost of space access drops by a factor of 100,', said: '2026-01-22', source: SRC.davos2026 },
  spaceSolar: { text: 'Solar power in space is five times more efficient than on Earth.', said: '2026-01-22', source: SRC.davos2026 },
  ultimatePower: { text: 'Space is the ultimate power source.', said: '2026-01-22', source: SRC.davos2026 },
  moonFaster: { text: 'the overriding priority is securing the future of civilization and the Moon is faster.', said: '2026-02', source: SRC.moon2026 },
  moonDistraction: { text: 'No, we\'re going straight to Mars. The Moon is a distraction,', said: '2025-01', source: SRC.moon2026 },
  starlinkRevenue: { text: 'Vast majority of SpaceX revenue is the commercial Starlink system,', said: '2026-02', source: SRC.moon2026 },
  gigawatt: { text: 'get to roughly an annualized rate of a gigawatt per year by the end of next year at Space AI compute', said: '2026-06-08', source: SRC.gigasat2026 },
});

// What already happened, for the prologue. Dates are UTC launch dates.
export const HISTORY = Object.freeze([
  { date: '2023-04-20', text: 'Starship Flight 1: first full-stack launch; vehicle lost.', source: SRC.starshipList },
  { date: '2024-10-13', text: 'Flight 5: first Super Heavy booster caught by the tower.', source: SRC.starshipList },
  { date: '2025-12-31', text: 'SpaceX flies 165 orbital launches in 2025.', source: SRC.launches2025 },
  { date: '2026-05-22', text: 'Flight 12: first Block 3 (V3) Starship; ship splashes down, booster lost.', source: SRC.flight12 },
  { date: '2026-09-28', text: 'Flight 14: first orbital Starship flight, 26 Starlink V3 deployed. Record: 14 flights, 9 successes.', source: SRC.starshipList },
]);

// Musk's stated targets. `target` is the year he gave; the game records the
// year you reach each one, so the timeline shows stated against achieved.
// `check(state)` decides when the milestone is reached.
export const MILESTONES = Object.freeze([
  { id: 'ship-catch', title: 'Catch a ship on the tower', target: 2026.9, said: '2026', stated: 'Flight 15 was planned to try the first ship catch (NET Nov 2026).', source: SRC.starshipList,
    check: s => s.counters.shipCatches > 0, quote: 'planes' },
  { id: 'refill', title: 'Ship-to-ship propellant transfer', target: 2027.2, said: '2026', stated: 'Propellant transfer demo slipped from Mar 2025 to NET late 2026 / early 2027.', source: SRC.ptd,
    check: s => s.tech.refilling >= 1, quote: 'reusable' },
  { id: 'gigawatt-ai', title: '1 GW/yr of AI compute launched to orbit', target: 2027.9, said: '2026-06', stated: 'About 1 GW/yr annualized by end of 2027.', source: SRC.gigasat2026,
    check: s => s.rates.aiGWPerYear >= 1, quote: 'gigawatt' },
  { id: 'mars-uncrewed', title: 'Uncrewed Starship lands on Mars', target: 2027.0, said: '2025-05', stated: 'Uncrewed ships with Optimus in the end-2026 window, about 50/50 odds.', source: SRC.mars2025,
    check: s => s.counters.marsLandings > 0, quote: 'optimusFirst' },
  { id: 'moon-landing', title: 'Starship lands on the Moon', target: 2027.2, said: '2026-02', stated: 'Uncrewed lunar landing targeted for March 2027 (WSJ, via NBC).', source: SRC.moon2026,
    check: s => s.counters.moonLandings > 0, quote: 'moonFaster' },
  { id: 'mars-crew', title: 'First humans land on Mars', target: 2029.1, said: '2025-05', stated: 'Humans possibly in the 2029 window.', source: SRC.mars2025,
    check: s => s.mars.population > 0, quote: 'dieOnMars' },
  { id: 'moon-city', title: 'Self-growing city on the Moon', target: 2036, said: '2026-02', stated: 'A self-growing lunar city in less than 10 years.', source: SRC.moon2026,
    check: s => s.moon.population >= 1000 && s.moon.selfSufficiency >= 0.5, quote: 'moonFaster' },
  { id: 'fleet-1000', title: '1,000 Starships built', target: 2035, said: '2019-11', stated: 'A sustainable Mars city needs about 1,000 Starships and 20 years.', source: SRC.techcrunch2019,
    check: s => s.counters.shipsBuilt >= 1000, quote: 'anyone' },
  { id: 'mars-city', title: 'Self-sustaining city on Mars', target: 2049, said: '2019-11', stated: '~20 years from the first ships (2019 talk); "five to seven years" for a Mars city (Feb 2026).', source: SRC.techcrunch2019,
    check: s => s.mars.selfSufficiency >= 1, quote: 'twoPlanets' },
  { id: 'million', title: 'One million people on Mars', target: 2060, said: '2020', stated: 'Extrapolated from the 1,000-ship, ~100 people-per-ship plan.', source: SRC.techcrunch2019, extrapolated: true,
    check: s => s.mars.population >= 1e6, quote: 'recompile' },
  { id: 'terawatt', title: '1 TW/yr of solar power launched to orbit', target: 2040, said: '2026', stated: 'Musk spoke of 100 GW/yr and eventually a terawatt per year of space solar AI.', source: SRC.gigasat2026,
    check: s => s.rates.aiGWPerYear >= 1000, quote: 'ultimatePower' },
  { id: 'kardashev', title: 'Kardashev 0.8 (100 TW harnessed)', target: 2100, said: '—', stated: 'Game goal by 2100. Musk often cites the Kardashev scale; he has given no dated target. Type I (10¹⁶ W) is out of reach this century on these numbers.', source: null, extrapolated: true,
    check: s => s.kardashev >= 0.8, quote: 'ultimatePower' },
]);
