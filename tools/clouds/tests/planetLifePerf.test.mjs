import test from 'node:test';
import assert from 'node:assert/strict';
import { createCellGrid, createEnvironment, createLifeSim, genomeComplexity, genomeTags } from '../life/planetLifeSim.js';

// The census counts traits and complexity in place and walks only living
// lineages; check it still agrees with the exported genome helpers.
test('census matches genomeTags and genomeComplexity, and extinct lineages stay extinct', () => {
  const grid = createCellGrid(1200);
  const sample = ([x, y, z]) => {
    const h = Math.sin(3 * x + 5) * Math.cos(2 * y) + 0.5 * Math.sin(5 * z + 6.5);
    return { height: h, depth: h < 0.1 ? 0.1 - h : 0, volcanic: Math.max(0, Math.sin(11 * x + 4 * z)) };
  };
  const env = createEnvironment(grid, { sample, climate: [0.1, 0.99, 0, 0.9], seed: 5 });
  const sim = createLifeSim({ grid, env, seed: 9 });
  for (let t = 0; t < 900; t++) sim.step(1);
  assert.ok(sim.state.alive > 0, 'expected living lineages');
  const tags = {}, cells = new Map();
  let complexity = 0;
  for (let i = 0; i < grid.count; i++) {
    const l = sim.lineageOf[i];
    if (l < 0) continue;
    cells.set(l, (cells.get(l) ?? 0) + 1);
    complexity = Math.max(complexity, genomeComplexity(sim.genomeOf(i)));
    for (const tag of genomeTags(sim.genomeOf(i))) tags[tag] = (tags[tag] ?? 0) + 1;
  }
  // The census ran at the end of the last step, so the grid has not changed since.
  assert.deepEqual(sim.state.tagCells, tags);
  assert.equal(sim.state.maxComplexity, complexity);
  assert.equal(sim.state.alive, cells.size);
  for (const lineage of sim.lineages) {
    if (lineage.extinct === null) assert.equal(lineage.cells, cells.get(lineage.id));
    else assert.equal(cells.has(lineage.id), false);
  }
});
