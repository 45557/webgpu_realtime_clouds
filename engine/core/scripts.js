// Script components. A script is an ES module (or plain object) with optional
// hooks: start(ctx), fixedUpdate(ctx, dt), update(ctx, dt), onCollision(ctx, other).
// Milestone 1 registers scripts by name; milestone 2 loads them from project files.

const registry = new Map();
export function registerScript(name, module) { registry.set(name, module); }
export function scriptModule(name) { return registry.get(name); }

export class ScriptSystem {
  /** @param {import('../engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<number, {module: any, ctx: any, started: boolean}>} */
    this.instances = new Map();
    engine.world.on('componentRemoved', ({ id, name }) => { if (name === 'Script') this.instances.delete(id); });
    engine.world.on('collisionStart', ({ a, b }) => {
      for (const [self, other] of [[a, b], [b, a]]) {
        const inst = this.instances.get(self);
        inst?.module.onCollision?.(inst.ctx, other);
      }
    });
  }

  sync() {
    const { world } = this.engine;
    for (const id of world.query('Script')) {
      if (this.instances.has(id)) continue;
      const script = world.get(id, 'Script');
      const module = registry.get(script.name);
      if (!module) { console.warn(`No script registered as "${script.name}"`); this.instances.set(id, { module: {}, ctx: null, started: true }); continue; }
      const defaults = Object.fromEntries(Object.entries(module.params ?? {}).map(([k, f]) => [k, f.default]));
      const ctx = { entity: id, engine: this.engine, world, params: { ...defaults, ...script.params }, state: {} };
      this.instances.set(id, { module, ctx, started: false });
    }
  }

  run(hook, dt) {
    this.sync();
    for (const inst of this.instances.values()) {
      if (!inst.ctx) continue;
      if (!inst.started) { inst.started = true; inst.module.start?.(inst.ctx); }
      inst.module[hook]?.(inst.ctx, dt);
    }
  }
}
