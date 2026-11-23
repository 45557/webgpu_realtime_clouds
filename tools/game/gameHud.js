// The game's control rail, built from the Cloud Lab theme (cl-* classes and
// disclosures) so it sits next to the planet demo as one interface.
import { createDisclosure } from '../clouds/cloudLabUi.js';
import {
  BUILDS, PROJECTS, advance, build, canBuild, canStart, launchCapacity, marsLandingOdds, marsMissionLaunches, marsWindow,
  moonMissionLaunches, padTurnaroundDays, reliability, score, setPriorities, shipFor, startResearch, tankerDelivery, yearOf,
} from './game.js';
import { MILESTONES, HISTORY } from './roadmap.js';
import { STARSHIP_V3, bestMarsTransfer } from './physics.js';
import { isruEnergyPerKgPropellant, marsPropellantPerDay } from './supply.js';

const CSS = `
#roadmap-game { position:absolute; top:var(--space-4); right:var(--space-4); bottom:var(--space-4); width:min(400px, calc(100vw - 32px));
  overflow:auto; z-index:5; padding:var(--space-5); border-radius:var(--radius-lg); background:var(--rail-glass, rgba(14,20,30,.88));
  box-shadow:var(--shadow-rail); color:var(--ink, #e8eef5); font:14px/1.45 var(--font-sans, system-ui); }
#roadmap-game h1 { margin:0; font-size:20px; }
#roadmap-game .rg-sub { color:var(--ink-muted, #9fb0c2); font-size:12px; margin:2px 0 var(--space-4); }
#roadmap-game .rg-stats { display:grid; grid-template-columns:1fr 1fr; gap:var(--space-2) var(--space-4); margin:var(--space-3) 0; }
#roadmap-game .rg-stats div { display:flex; justify-content:space-between; gap:var(--space-2); font-size:12.5px; border-bottom:1px solid var(--line, #2a3545); padding-bottom:2px; }
#roadmap-game .rg-stats b { font:500 12.5px var(--font-mono, monospace); color:var(--ink, #fff); }
#roadmap-game .rg-row { display:flex; gap:var(--space-2); flex-wrap:wrap; margin:var(--space-3) 0; }
#roadmap-game .rg-row .cl-btn { flex:1 1 auto; }
#roadmap-game .rg-list { display:grid; gap:var(--space-2); }
#roadmap-game .rg-item { display:grid; grid-template-columns:1fr auto; gap:2px var(--space-2); align-items:center; font-size:12.5px; }
#roadmap-game .rg-item .cl-hint { grid-column:1 / -1; margin:0; font-size:11.5px; }
#roadmap-game .rg-ms { display:grid; grid-template-columns:1fr auto auto; gap:var(--space-2); font-size:12px; padding:4px 0; border-bottom:1px solid var(--line, #2a3545); }
#roadmap-game .rg-ms a { color:var(--sky, #7cc4ff); }
#roadmap-game .rg-ahead { color:#7be0a0; } #roadmap-game .rg-behind { color:#ffb366; }
#roadmap-game .rg-log { font-size:12px; display:grid; gap:6px; max-height:260px; overflow:auto; }
#roadmap-game .rg-log q { display:block; color:var(--sun, #ffd27a); font-style:italic; margin-top:2px; }
#roadmap-game label.rg-slider { display:grid; grid-template-columns:1fr 3ch; gap:var(--space-2); font-size:12.5px; align-items:center; }
#roadmap-game label.rg-slider input { grid-column:1 / -1; width:100%; }
#roadmap-game .rg-tabs { display:flex; gap:var(--space-2); }
#roadmap-game .rg-tabs .cl-btn[aria-pressed=true] { outline:2px solid var(--sky, #7cc4ff); }
#roadmap-toast { position:absolute; left:var(--space-4); bottom:var(--space-6); z-index:6; max-width:min(620px, calc(100vw - 460px));
  padding:var(--space-4) var(--space-5); border-radius:var(--radius-lg); background:rgba(10,14,22,.92); color:#fff; font:15px/1.5 var(--font-sans, system-ui);
  box-shadow:var(--shadow-rail); transition:opacity .6s; }
#roadmap-toast q { display:block; font-size:17px; font-style:italic; color:var(--sun, #ffd27a); margin:6px 0; }
@media (max-width: 900px) { #roadmap-toast { max-width:calc(100vw - 32px); bottom:auto; top:var(--space-4); } }
#roadmap-toast a { color:var(--sky, #7cc4ff); font-size:12px; }
`;

const money = b => Math.abs(b) >= 1000 ? `$${(b / 1000).toFixed(2)}T` : `$${b.toFixed(1)}B`;
const num = n => Math.round(n).toLocaleString('en-US');
const ym = t => new Date(t).toISOString().slice(0, 7);

export function createGameHud(doc, game, scene, { onChange } = {}) {
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);
  const el = (tag, props = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
    }
    node.append(...children.filter(c => c != null));
    return node;
  };
  const button = (text, onclick, cls = '') => el('button', { type: 'button', class: `cl-btn cl-btn--sm ${cls}`, onclick }, text);

  const root = el('aside', { id: 'roadmap-game', class: 'cl-root', 'aria-label': 'Roadmap 2100 game' });
  const date = el('p', { class: 'rg-sub' });
  const stats = el('div', { class: 'rg-stats' });
  const world = el('div', { class: 'rg-tabs' });
  const time = el('div', { class: 'rg-row' });
  const buildList = el('div', { class: 'rg-list' });
  const researchList = el('div', { class: 'rg-list' });
  const planBody = el('div', { class: 'rg-list' });
  const physics = el('div', { class: 'rg-stats' });
  const roadmap = el('div');
  const logBox = el('div', { class: 'rg-log' });
  const toast = el('div', { id: 'roadmap-toast', style: 'opacity:0;pointer-events:none' });

  const run = (fn) => { fn(); refresh(); onChange?.(); };
  const step = (months, until) => run(() => {
    const events = [];
    for (let i = 0; i < months && !game.over; i++) {
      events.push(...advance(game));
      if (until?.(game)) break;
    }
    show(events);
  });
  time.append(
    button('+1 month', () => step(1), 'cl-btn--primary'),
    button('+6 months', () => step(6)),
    button('Next Mars window', () => step(40, g => marsWindow(g).open && g.marsPlan.ships > 0 && g.departedThisWindow === marsWindow(g).next)),
    button('+5 years', () => step(60)),
  );
  for (const [id, w] of Object.entries({ earth: 'Earth', moon: 'Moon', mars: 'Mars' })) {
    world.append(button(w, () => { scene.show(id); refresh(); }));
    world.lastChild.dataset.world = id;
  }

  function slider(text, get, set, max = 100, stepSize = 1) {
    const input = el('input', { type: 'range', min: 0, max, step: stepSize });
    const out = el('output');
    const label = el('label', { class: 'rg-slider' }, el('span', { text }), out, input);
    input.value = get();
    out.textContent = get();
    input.addEventListener('input', () => { set(Number(input.value)); out.textContent = input.value; refresh(); });
    return label;
  }
  planBody.append(
    el('p', { class: 'cl-hint', text: 'Launches left after Moon and Mars flights split between these two.' }),
    slider('Starlink', () => game.priorities.starlink, v => setPriorities(game, { starlink: v })),
    slider('AI compute satellites', () => game.priorities.ai, v => setPriorities(game, { ai: v })),
    slider('Moon share of launches', () => game.priorities.moon, v => setPriorities(game, { moon: v })),
    slider('Moon ships per month', () => game.moonPlan.shipsPerMonth, v => { game.moonPlan.shipsPerMonth = v; }, 50),
    slider('…of them crewed', () => game.moonPlan.crewed, v => { game.moonPlan.crewed = v; }, 50),
    slider('Mars ships per window', () => game.marsPlan.ships, v => { game.marsPlan.ships = v; }, 1000, 1),
    slider('…of them crewed', () => game.marsPlan.crewed, v => { game.marsPlan.crewed = v; }, 1000, 1),
  );

  const showControls = button('Renderer controls', () => {
    for (const id of ['controls', 'performance']) {
      const node = doc.getElementById(id);
      if (node) node.hidden = !node.hidden;
    }
  }, 'cl-btn--ghost');

  root.append(
    el('h1', { text: 'Roadmap 2100' }), date, world, time, stats,
    createDisclosure('Build', [buildList], { open: true }),
    createDisclosure('Research', [researchList], { open: true }),
    createDisclosure('Launch plan', [planBody]),
    createDisclosure('Physics', [physics]),
    createDisclosure("Musk's roadmap vs yours", [roadmap], { open: true }),
    createDisclosure('Log', [logBox], { open: true }),
    el('div', { class: 'rg-row' }, showControls),
    el('p', { class: 'cl-hint', text: 'Quotes are verbatim with sources. Money figures are calibrated estimates; see tools/game/README.md.' }),
  );
  doc.body.append(root, toast);

  let toastTimer;
  function popup(html) {
    toast.replaceChildren(...html);
    toast.style.opacity = '1';
    toast.style.pointerEvents = 'auto';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.pointerEvents = 'none'; }, 9000);
  }

  function show(events) {
    const milestone = events.filter(e => e.kind === 'milestone').at(-1);
    for (const e of events) {
      if (e.kind === 'departure' && e.to !== scene.world) continue;
      if (e.kind === 'arrival' && e.landed) {
        if (scene.world !== e.to) scene.show(e.to);
        scene.entries(e.landed, e.entrySpeed || 2400);
      }
    }
    if (milestone) {
      const { milestone: m, quote, year } = milestone;
      popup([
        el('b', { text: `${m.title} — ${year.toFixed(1)}` }),
        el('div', { class: 'cl-hint', text: `Musk's stated target: ${m.target.toFixed(0)}. ${m.stated}` }),
        quote ? el('q', { text: quote.text }) : null,
        quote ? el('a', { href: quote.source.url, target: '_blank', rel: 'noopener', text: `Elon Musk, ${quote.said} · ${quote.source.label}` }) : null,
      ].filter(Boolean));
    }
    const end = events.find(e => e.kind === 'end');
    if (end) popup([el('b', { text: end.reason === 'time' ? `2100. Score ${score(game)}.` : 'Bankrupt.' }), el('div', { text: game.log.at(-1).text })]);
  }

  function refresh() {
    const cap = launchCapacity(game);
    const win = marsWindow(game);
    date.textContent = `${ym(game.date)} · next Mars window ${win.open ? 'OPEN now' : ym(win.next)}`;
    for (const b of world.children) b.setAttribute('aria-pressed', String(b.dataset.world === scene.world));
    const row = (k, v) => el('div', {}, el('span', { text: k }), el('b', { text: v }));
    stats.replaceChildren(
      row('Cash', money(game.cash)), row('Revenue/yr', money(game.revenue)),
      row('Launch capacity/yr', num(cap.launches * 12)), row('Limited by', cap.limit),
      row('Launches/yr', num(game.rates.launchesPerYear)), row('Reliability', `${(reliability(game) * 100).toFixed(1)}%`),
      row('Ships ready', num(game.stock.ships)), row('Boosters', num(game.stock.boosters)),
      row('Raptors in stock', num(game.stock.raptors)), row('Pad turnaround', `${padTurnaroundDays(game).toFixed(1)} d`),
      row('Moon people', num(game.moon.population)), row('Moon cargo', `${num(game.moon.cargo)} t`),
      row('Mars people', num(game.mars.population)), row('Mars cargo', `${num(game.mars.cargo)} t`),
      row('Mars self-sufficiency', `${(game.mars.selfSufficiency * 100).toFixed(1)}%`), row('Mars propellant', `${num(game.mars.propellant)} t`),
      row('AI compute in orbit', `${game.ai.gw.toFixed(2)} GW`), row('Kardashev', game.kardashev.toFixed(4)),
    );
    buildList.replaceChildren(...Object.entries(BUILDS).map(([id, b]) => el('div', { class: 'rg-item' },
      el('span', { text: `${b.name} ×${game.lines[id]}` }),
      Object.assign(button(`Build ${money(b.cost)}`, () => run(() => build(game, id))), { disabled: !canBuild(game, id) || game.over }),
      el('p', { class: 'cl-hint', text: b.requires && !game.tech[b.requires] ? `Needs research: ${PROJECTS[b.requires].name}` : b.note }))));
    researchList.replaceChildren(...Object.entries(PROJECTS).map(([id, p]) => {
      const active = game.research.find(r => r.id === id);
      const level = game.tech[id];
      const status = active ? `${active.left} mo left` : level && !p.repeatable ? 'done' : `${money(p.cost)} · ${p.months} mo`;
      return el('div', { class: 'rg-item' },
        el('span', { text: `${p.name}${p.repeatable && level ? ` (lvl ${level})` : ''}` }),
        Object.assign(button(status, () => run(() => startResearch(game, id))), { disabled: !canStart(game, id) || game.over }),
        el('p', { class: 'cl-hint', text: (p.requires ?? []).filter(r => !game.tech[r]).length ? `Needs ${p.requires.filter(r => !game.tech[r]).map(r => PROJECTS[r].name).join(', ')}. ${p.note}` : p.note }));
    }));
    const transfer = bestMarsTransfer(STARSHIP_V3.payloadLEO, { ship: shipFor(game) });
    physics.replaceChildren(
      row('Ship Isp (vac)', `${shipFor(game).ispVacuum} s`), row('Tanker delivers', `${tankerDelivery(game) / 1000} t`),
      row('Launches per Mars ship', String(marsMissionLaunches(game))), row('Launches per Moon ship', String(moonMissionLaunches(game))),
      row('Mars transfer', `${Math.round(transfer.days)} d`), row('Mars entry speed', `${(transfer.entrySpeed / 1000).toFixed(2)} km/s`),
      row('Mars landing odds', `${(marsLandingOdds(game) * 100).toFixed(0)}%`), row('ISRU energy', `${isruEnergyPerKgPropellant().toFixed(1)} kWh/kg`),
      row('Mars power (rated)', `${num(game.mars.powerKW)} kW`), row('ISRU output', `${num(marsPropellantPerDay(game.mars.powerKW) / 1000)} t/day`),
      row('Binding limit', `${cap.limit}`), row('Pads / O₂ / boosters / ships', Object.values(cap.limits).map(v => num(v)).join(' / ')),
    );
    roadmap.replaceChildren(
      ...MILESTONES.map(m => {
        const got = game.achieved[m.id];
        const delta = got ? got - m.target : null;
        return el('div', { class: 'rg-ms' },
          el('span', {}, m.title, m.source ? el('a', { href: m.source.url, target: '_blank', rel: 'noopener', title: m.stated, text: ' ↗' }) : null, m.extrapolated ? el('span', { class: 'cl-hint', text: ' (extrapolated)' }) : null),
          el('span', { title: 'Stated target', text: String(Math.floor(m.target)) }),
          el('span', { class: delta === null ? 'cl-hint' : delta <= 0 ? 'rg-ahead' : 'rg-behind', text: got ? got.toFixed(1) : '—' }));
      }),
      el('p', { class: 'cl-hint', text: 'Before the game: ' + HISTORY.map(h => `${h.date.slice(0, 7)} ${h.text}`).join(' ') }),
    );
    logBox.replaceChildren(...game.log.filter(l => l.kind !== 'build').slice(-30).reverse().map(l =>
      el('div', {}, el('span', { class: 'cl-hint', text: `${ym(l.date)} ` }), l.text, l.quote ? el('q', { text: l.quote.text }) : null)));
  }

  refresh();
  return { refresh, root, popup, show };
}

export { yearOf };
