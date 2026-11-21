// Draws the life simulation over the planet: colonies, habitat chemistry,
// biomes, meteorite impacts, lightning and fires. Points are projected with
// the planet camera's own basis (position, right, up, forward, tanX, tanY),
// so the layer stays pinned to the rendered terrain.
import { HABITATS } from './planetLifeSim.js';

const HABITAT_COLORS = ['', '255,140,60', '90,220,255', '120,255,200', '255,210,90', ''];
const HABITAT_KEYS = Object.keys(HABITATS);

export function createLifeOverlay(doc, parent) {
  const canvas = doc.createElement('canvas');
  canvas.id = 'planet-life-overlay';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none';
  parent.append(canvas);
  const ctx = canvas.getContext('2d');
  const flashes = [];
  const meteors = [];

  function resize(source) {
    const w = source.clientWidth || source.width, h = source.clientHeight || source.height;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return { w: canvas.width, h: canvas.height };
  }

  function projector(camera, size) {
    const [cx, cy, cz] = camera.position;
    const { right, up, forward, tanX, tanY } = camera;
    return (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
      if (depth <= camera.near) return null;
      const sx = (dx * right[0] + dy * right[1] + dz * right[2]) / (depth * tanX);
      const sy = (dx * up[0] + dy * up[1] + dz * up[2]) / (depth * tanY);
      if (sx < -1.2 || sx > 1.2 || sy < -1.2 || sy > 1.2) return null;
      return [(sx * 0.5 + 0.5) * size.w, (0.5 - sy * 0.5) * size.h, depth];
    };
  }

  return {
    canvas,
    // Called from the planet demo's frame hook with the live camera.
    draw({ sim, world, camera, layers, now }) {
      const size = resize(world.canvas);
      ctx.clearRect(0, 0, size.w, size.h);
      if (!sim || !camera || canvas.style.display === 'none') return;
      const project = projector(camera, size);
      const { grid, env } = sim;
      const R = world.radius;
      const cam = camera.position;
      const camDist = Math.hypot(...cam);
      // Half the projected cell spacing, capped so a close camera is not buried in dots.
      const cellPixels = (depth) => Math.min(36, Math.max(1.2, grid.spacing * R / depth * size.h / (2 * camera.tanY) * 0.5));
      const surface = (i, lift = 0) => {
        const r = R + Math.max(env.height[i], 0) + lift * R;
        return [grid.dirs[i * 3] * r, grid.dirs[i * 3 + 1] * r, grid.dirs[i * 3 + 2] * r];
      };
      // A point faces the camera when it lies on the near side of the horizon.
      const facing = (i) => {
        const d = grid.dirs[i * 3] * cam[0] + grid.dirs[i * 3 + 1] * cam[1] + grid.dirs[i * 3 + 2] * cam[2];
        return d > R * R / camDist * 0.995;
      };
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < grid.count; i++) {
        if (!facing(i)) continue;
        const p = project(...surface(i));
        if (!p) continue;
        const r = cellPixels(p[2]);
        if (layers.biomes) {
          const biome = biomeColor(sim, i);
          if (biome) {
            ctx.fillStyle = biome;
            ctx.beginPath(); ctx.arc(p[0], p[1], r * 1.15, 0, 2 * Math.PI); ctx.fill();
          }
        }
        if (layers.habitat) {
          const color = HABITAT_COLORS[env.habitat[i]];
          const o = Math.min(1, sim.organics[i] / 1.5);
          if (color && o > 0.04) {
            ctx.fillStyle = `rgba(${color},${0.2 + 0.6 * o})`;
            ctx.beginPath(); ctx.arc(p[0], p[1], r * (0.35 + 0.5 * o), 0, 2 * Math.PI); ctx.fill();
          }
        }
        if (layers.scars && sim.scar[i] > 0.05) {
          ctx.strokeStyle = `rgba(70,40,25,${0.55 * sim.scar[i]})`;
          ctx.lineWidth = Math.max(1, r * 0.18);
          ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.6, 0, 2 * Math.PI); ctx.stroke();
        }
        const l = sim.lineageOf[i];
        if (layers.life && l >= 0) {
          const lineage = sim.lineages[l];
          const mass = Math.min(1, sim.biomass[i] / 2);
          const selected = layers.selected === l || layers.selectedFamily?.has(l);
          ctx.fillStyle = `hsla(${lineage.hue},${selected ? 100 : 78}%,${selected ? 70 : 58}%,${selected ? 0.95 : 0.3 + 0.45 * mass})`;
          ctx.beginPath(); ctx.arc(p[0], p[1], r * (0.28 + 0.3 * mass), 0, 2 * Math.PI); ctx.fill();
          if (selected) {
            ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
        if (layers.fire && sim.fire[i] > 0) {
          const flicker = 0.6 + 0.4 * Math.sin(now * 23 + i);
          ctx.fillStyle = `rgba(255,${110 + 80 * flicker | 0},30,${0.5 + 0.4 * flicker})`;
          ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.7, 0, 2 * Math.PI); ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'lighter';
      // Lightning: a jagged bolt from the cloud deck down to the strike.
      for (let n = flashes.length - 1; n >= 0; n--) {
        const flash = flashes[n];
        const age = now - flash.start;
        if (age > 0.35) { flashes.splice(n, 1); continue; }
        if (!facing(flash.cell)) continue;
        const ground = project(...surface(flash.cell));
        const top = project(...surface(flash.cell, 0.012));
        if (!ground || !top) continue;
        const alpha = 1 - age / 0.35;
        ctx.strokeStyle = `rgba(210,225,255,${alpha})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(top[0], top[1]);
        const segments = 6;
        for (let k = 1; k < segments; k++) {
          const t = k / segments;
          const jitter = (Math.sin(flash.seed * 13 + k * 7.1) * 0.5) * Math.hypot(ground[0] - top[0], ground[1] - top[1]) * 0.18;
          ctx.lineTo(top[0] + (ground[0] - top[0]) * t + jitter, top[1] + (ground[1] - top[1]) * t);
        }
        ctx.lineTo(ground[0], ground[1]);
        ctx.stroke();
        const glow = ctx.createRadialGradient(top[0], top[1], 0, top[0], top[1], 26);
        glow.addColorStop(0, `rgba(190,210,255,${0.7 * alpha})`);
        glow.addColorStop(1, 'rgba(190,210,255,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(top[0] - 26, top[1] - 26, 52, 52);
      }
      // Meteorites: a streak that ends in a flash at the impact site.
      for (let n = meteors.length - 1; n >= 0; n--) {
        const m = meteors[n];
        const age = now - m.start;
        if (age > 2.4) { meteors.splice(n, 1); continue; }
        const [x, y, z] = m.dir;
        const r = R + Math.max(0, env.height[m.cell]);
        const facingImpact = x * cam[0] + y * cam[1] + z * cam[2] > R * R / camDist;
        if (!facingImpact) continue;
        const hit = project(x * r, y * r, z * r);
        if (!hit) continue;
        if (age < 0.8) {
          const t = age / 0.8;
          const from = 1 + 0.5 * (1 - t);
          const tail = 1 + 0.5 * Math.max(0, 1 - t - 0.25);
          const a = project(x * r * from + m.side[0] * R * 0.3 * (1 - t), y * r * from + m.side[1] * R * 0.3 * (1 - t), z * r * from + m.side[2] * R * 0.3 * (1 - t));
          const b = project(x * r * tail + m.side[0] * R * 0.3 * Math.max(0, 1 - t - 0.25), y * r * tail + m.side[1] * R * 0.3 * Math.max(0, 1 - t - 0.25), z * r * tail + m.side[2] * R * 0.3 * Math.max(0, 1 - t - 0.25));
          if (a && b) {
            const streak = ctx.createLinearGradient(b[0], b[1], a[0], a[1]);
            streak.addColorStop(0, 'rgba(255,170,90,0)');
            streak.addColorStop(1, 'rgba(255,235,190,.95)');
            ctx.strokeStyle = streak; ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(a[0], a[1]); ctx.stroke();
          }
        } else {
          const t = (age - 0.8) / 1.6;
          const radius = (12 + 90 * m.size) * (0.4 + t) * Math.min(1, R / Math.max(1, hit[2]) * 4);
          const glow = ctx.createRadialGradient(hit[0], hit[1], 0, hit[0], hit[1], radius);
          glow.addColorStop(0, `rgba(255,240,200,${1 - t})`);
          glow.addColorStop(0.4, `rgba(255,150,60,${0.6 * (1 - t)})`);
          glow.addColorStop(1, 'rgba(255,90,30,0)');
          ctx.fillStyle = glow;
          ctx.fillRect(hit[0] - radius, hit[1] - radius, radius * 2, radius * 2);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    },
    flash(cell, now) {
      if (flashes.length < 8) flashes.push({ cell, start: now, seed: Math.random() * 100 });
    },
    meteor(record, now) {
      const [x, y, z] = record.dir;
      // Any direction along the surface works for the incoming slant.
      const side = Math.abs(y) < 0.9 ? [-z, 0, x] : [0, z, -y];
      const length = Math.hypot(...side) || 1;
      meteors.push({ ...record, side: side.map(v => v / length), start: now });
      if (meteors.length > 6) meteors.shift();
    },
    setVisible(visible) { canvas.style.display = visible ? '' : 'none'; },
    dispose() { canvas.remove(); },
  };
}

// Biomes from the simulated climate: ice, tundra, desert, steppe, forest,
// rainforest, and open water colour by temperature.
export function biomeColor(sim, i) {
  const t = sim.temperature[i];
  const { env } = sim;
  if (env.ocean[i]) return t < -2 ? 'rgba(225,240,255,.55)' : null;
  if (t < -2) return 'rgba(240,248,255,.6)';
  const greenery = sim.lineageOf[i] >= 0 && sim.genome[i * 11 + 3] > 0.4 ? Math.min(1, sim.biomass[i] / 1.5) : 0;
  const m = env.moisture[i];
  if (t < 5) return `rgba(150,165,140,${0.35 + 0.2 * greenery})`;
  if (m < 0.25) return 'rgba(220,180,110,.45)';
  if (greenery > 0.2) return t > 22 && m > 0.5 ? 'rgba(20,120,50,.55)' : 'rgba(60,140,60,.5)';
  return 'rgba(170,170,90,.4)';
}

export const HABITAT_LEGEND = HABITAT_KEYS.map((key, i) => ({ key, label: HABITATS[key], color: HABITAT_COLORS[i] })).filter(h => h.color);
