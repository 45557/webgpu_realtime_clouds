# Roadmap 2100

A strategy game on the planet clouds demo. You run SpaceX from December 2026 to December 2100 and try to hit the milestones Elon Musk has stated in public. The timeline shows his stated year next to the year you reach each one.

Open `index.html?demo=game` (add `&new` to start over, `&seed=N` for another dice roll). The game saves in the browser after each action.

## How it uses the renderer

The game does not draw its own planets. It registers hooks (`tools/clouds/planetSceneHooks.js`) and then loads the unchanged planet demo, so everything on screen is the existing stack:

| Game need | Existing primitive |
| --- | --- |
| Earth, Moon, Mars | Planet catalog presets through the panel's `#preset` select: `lakeshore`, `lunar-highlands`, `mars-dawn` (with fallbacks) |
| Their skies | `PLANET_CLOUD_STYLES` through the weather path (`rotatingWeatherConfig` + `queueSettings`): `satellite_realistic` on Earth, `ice_filaments` on Mars (Mars has thin water-ice cirrus), clouds off on the Moon |
| Camera | The demo's `orbit({ direction, altitude })` navigation |
| Ships arriving | The life layer's meteor overlay (`planetLifeLayer.meteor`), fed an entry record built with `impactPhysics.slantToAltitude` at the transfer's real entry speed, ending subsonic instead of in a crater |
| Dice | `createRandom` from `planetLifeSim.js` |
| UI | Cloud Lab theme (`cl-*` classes, `createDisclosure`) |

Two small additions to existing files make this possible: `planetApproachClouds.js` calls the hooks (setup, frame, world ready) and exposes a scene API, and `planetLifePanel.js` gains `configure()` (pause evolution, choose layers) and `entry()` (draw a spacecraft entry trail). The life simulation is paused in the game, and its bare-ground palette is off.

## Game loop

One step is one month. Each month:

1. Research finishes, factories make Raptors, boosters (about two per pad) and ships (up to what you need on hand).
2. Launch capacity is the smallest of pads ÷ turnaround, liquid-oxygen supply, boosters and ships. The binding limit is shown so you know what to build next.
3. During a Mars window (±45 days of the Hohmann phase angle, every ~26 months), Mars ships fly with their tankers. Moon flights go any month. The rest of the launches go to Starlink and AI-compute satellites in the ratio you set.
4. Each launch succeeds with the current reliability. Failures lose the ship and sometimes the booster.
5. Ships in transit arrive, land with the Mars landing odds, and deliver 100 t of cargo or 100 people.
6. Starlink and AI compute pay; satellites wear out (5 and 6 years).
7. Milestones are checked. Reaching one shows Musk's quote and his stated date.

You lose if cash falls below −$20B. At 2100 the score combines the Kardashev rating, Mars population and how early you hit the milestones.

## Physics (`physics.js`)

All exact mechanics with published constants:

- Tsiolkovsky rocket equation for ship Δv and propellant.
- Oberth departure burn from a 250 km parking orbit: Hohmann trans-Mars injection is 3.60 km/s (v∞ 2.94 km/s).
- Earth–Mars transfer solved as a conic with Kepler's equation for any departure v∞: Hohmann is 259 days; a refuelled Starship with 100 t reaches Mars in ~173 days at 7.4 km/s entry speed (capped at 7.5 km/s for the heat shield).
- Mars windows from mean planetary longitudes (J2000) and the Hohmann phase angle (44.3°). The game reproduces the real windows: November 2026, January 2029, February 2031.
- Lunar mission budget: TLI 3.1 + LOI 0.9 + descent 1.9 km/s.
- Kardashev rating from harnessed power (Sagan's interpolation, K = (log₁₀ P − 6) / 10). Earth today is about K 0.73.

Vehicle numbers (Starship V3 / Block 3): 33 + 6 Raptor 3, 280 tf each at sea level, ~3,400 t booster propellant, >1,500 t ship propellant, >100 t reusable to LEO ([NewSpace Economy](https://newspaceeconomy.ca/2026/04/16/detailed-review-of-starship-v3/)). Not published, so estimated: ship dry mass 120 t, blended vacuum Isp 375 s.

## Supply chain (`supply.js`)

- **Propellant.** Methalox at O/F 3.6. A full stack is 4,900 t, of which ~3,835 t is liquid oxygen. One world-scale air-separation train makes ~3,500 t O₂/day, so each oxygen plant supports ~0.91 launches a day. Oxygen, not methane, is the limit on Earth.
- **Refilling.** A Mars ship needs its full 1,500 t topped up in LEO: 15 tanker flights at 100 t each, 8 after the stretched-tanker research (200 t). SpaceX has cited 8–10 tankers to fill a depot and NASA estimated closer to 15 ([NewSpace Economy](https://newspaceeconomy.ca/2026/04/16/detailed-review-of-starship-v3/), [Wikipedia](https://en.wikipedia.org/wiki/Starship_Propellant_Transfer_Demonstration)).
- **Mars ISRU (Sabatier).** Net CO₂ + 2 H₂O → CH₄ + 2 O₂: per kg of methane, 2.25 kg water, 4.0 kg oxygen (more than the engines need) and 0.50 kg hydrogen electrolysed at ~52 kWh/kg. That is ~6.5 kWh per kg of loaded propellant, or ~9.8 GWh to refill one ship. With Mars solar at a 20% capacity factor, a 1 MW array makes ~0.73 t/day.
- **Engines.** 6 Raptors per ship and 33 per booster. A Raptor line makes 365 a year ("a Raptor a day").
- **Learning.** Unit costs follow Wright's law at 85% per doubling, with floors. Raptor 3's stated target is about $250k at full rate.
- **Reliability.** Duane reliability growth from the real record (5 failures in 14 flights): the failure rate falls with the square root of cumulative flights, capped at 99.5%.

## Calibrations (estimates, not SpaceX figures)

Starting cash $25B; Starlink about $14B/yr in 2026, demand growing 15%/yr to a $300B cap; each Starlink launch adds $0.12B/yr of capacity; AI compute pays $8B per GW-year; AI satellites carry 42 kW per tonne. Factory, pad and plant prices are in `COSTS`. Settlers need 5 t of sustained cargo each. Self-sufficiency is the smaller of cargo ÷ 1,000,000 t and population ÷ 100,000 on Mars (100,000 t and 10,000 on the Moon). Earth's own power use is 19.5 TW in 2026, growing 1.5%/yr. The lunar mass driver is game extrapolation, not a Musk plan.

## Musk's stated milestones

| Milestone | His target | Source |
| --- | --- | --- |
| Uncrewed ships to Mars with Optimus, ~50/50 odds | end-2026 window | [Business Today, 29 May 2025](https://www.businesstoday.in/latest/trends/story/mars-by-2026-elon-musk-shares-critical-updates-on-starship-launch-2029-human-landing-goal-478538-2025-05-31) |
| First humans on Mars | possibly 2029 | same |
| Self-growing city on the Moon, priority over Mars | under 10 years (Feb 2026) | [NBC News](https://www.nbcnews.com/science/space/spacex-prioritizes-moon-before-mars-musk-says-rcna258168) |
| ~1 GW/yr of AI compute launched to orbit | end of 2027 | [Tom's Hardware, 9 Jun 2026](https://www.tomshardware.com/tech-industry/big-tech/spacex-unveils-11-million-square-foot-gigasat-factory-a-new-manufacturing-facility-for-space-based-data-centers-aims-for-1-gw-year-of-space-ai-compute-by-late-2027-from-its-satellites) |
| Sustainable Mars city: ~1,000 Starships and ~20 years | from 2019 | [TechCrunch, 7 Nov 2019](https://techcrunch.com/2019/11/07/elon-musk-says-building-the-first-sustainable-city-on-mars-will-take-1000-starships-and-20-years/) |

What happened before the game starts: Flight 5 caught the first booster (13 Oct 2024); Flight 12 flew the first V3 (22 May 2026); Flight 14 was the first orbital flight (28 Sep 2026), for a record of 14 flights and 9 successes ([Wikipedia](https://en.wikipedia.org/wiki/List_of_Starship_launches)). SpaceX flew 165 orbital launches in 2025 ([Space.com](https://www.space.com/space-exploration/private-spaceflight/spacex-shatters-its-rocket-launch-record-yet-again-167-orbital-flights-in-2025)).

## Quotes

Every quote in `roadmap.js` is verbatim from its linked source, with the date it was said. Things he said that could not be checked word for word are paraphrased in the milestone notes, not shown as quotes.

## Tests

```bash
node --test tools/game/tests/*.test.mjs
```

They check the orbital mechanics against textbook values, the real launch-window years, the chemistry, Wright's law, the starting state, determinism for a seed, that every milestone has a sourced quote, and that a whole game reaches 2100 without NaN.

## Not done yet

- The planet render was not checked in this change's headless browser (no WebGPU device for these pipelines); the game panel and simulation were.
- No surface view of bases yet; settlements are numbers in the panel.
- Terraformed-Mars visuals (switching to a wetter preset as Mars warms) are not in.
- Balance is first-pass: an aggressive player outpaces Musk's dates by a few years.
