// Minimal entity component system with schema-described components.
// Schemas drive defaults, JSON serialization and (later) the editor inspector.

/**
 * @typedef {'number'|'int'|'bool'|'string'|'enum'|'vec2'|'vec3'|'quat'|'color'|'asset'|'entity'|'json'} FieldType
 * @typedef {{type: FieldType, default?: any, options?: string[], min?: number, max?: number}} FieldSchema
 * @typedef {{name: string, fields: Record<string, FieldSchema>, runtime?: boolean}} ComponentType
 */

/** @type {Map<string, ComponentType>} */
const registry = new Map();

const DEFAULTS = { number: 0, int: 0, bool: false, string: '', enum: '', vec2: [0, 0], vec3: [0, 0, 0], quat: [0, 0, 0, 1], color: [1, 1, 1, 1], asset: '', entity: '', json: null };

const clone = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);

/**
 * Register a component type. `runtime: true` components are never saved.
 * @param {string} name
 * @param {Record<string, FieldSchema>} fields
 * @param {{runtime?: boolean}} [opts]
 */
export function defineComponent(name, fields = {}, opts = {}) {
  const type = { name, fields, runtime: !!opts.runtime };
  registry.set(name, type);
  return type;
}

export function componentType(name) { return registry.get(name); }
export function componentTypes() { return [...registry.values()]; }

/** Build a component value from its schema defaults plus `data`. */
export function makeComponent(name, data = {}) {
  const type = registry.get(name);
  if (!type) throw new Error(`Unknown component "${name}"`);
  const out = {};
  for (const [key, field] of Object.entries(type.fields)) {
    out[key] = key in data ? clone(data[key]) : clone(field.default ?? DEFAULTS[field.type]);
  }
  for (const key of Object.keys(data)) if (!(key in out)) out[key] = clone(data[key]);
  return out;
}

let uuidCounter = 0;
export function newUuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `e${Date.now().toString(36)}${(uuidCounter++).toString(36)}`;
}

export class World {
  constructor() {
    this.nextId = 1;
    /** @type {Map<number, string>} id -> uuid */
    this.entities = new Map();
    /** @type {Map<string, number>} uuid -> id */
    this.byUuid = new Map();
    /** @type {Map<string, Map<number, object>>} */
    this.stores = new Map();
    /** @type {Map<string, {names: string[], ids: number[]|null}>} */
    this.queries = new Map();
    /** @type {{name: string, update?: Function, fixedUpdate?: Function, removed?: Function}[]} */
    this.systems = [];
    /** Singletons: time, input, physics, renderer... */
    this.resources = {};
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /** Create an entity. Returns its numeric id. */
  create(uuid = newUuid()) {
    if (this.byUuid.has(uuid)) throw new Error(`Duplicate entity uuid ${uuid}`);
    const id = this.nextId++;
    this.entities.set(id, uuid);
    this.byUuid.set(uuid, id);
    return id;
  }

  /** Destroy an entity and its children. */
  destroy(id) {
    if (!this.entities.has(id)) return;
    for (const child of this.children(id)) this.destroy(child);
    for (const name of [...this.stores.keys()]) if (this.has(id, name)) this.remove(id, name);
    this.byUuid.delete(this.entities.get(id));
    this.entities.delete(id);
  }

  alive(id) { return this.entities.has(id); }
  uuid(id) { return this.entities.get(id); }
  find(uuid) { return this.byUuid.get(uuid); }

  /** Find the first entity whose Name component matches. */
  findByName(name) {
    for (const [id, c] of this.store('Name')) if (c.value === name) return id;
    return undefined;
  }

  store(name) {
    let s = this.stores.get(name);
    if (!s) { s = new Map(); this.stores.set(name, s); }
    return s;
  }

  /** Add (or replace) a component, filling defaults from its schema. */
  add(id, name, data = {}) {
    if (!this.entities.has(id)) throw new Error(`Entity ${id} is not alive`);
    const value = makeComponent(name, data);
    const had = this.store(name).has(id);
    this.store(name).set(id, value);
    if (!had) this.invalidate(name);
    this.emit('componentAdded', { id, name, value });
    return value;
  }

  /** @returns {any} */
  get(id, name) { return this.stores.get(name)?.get(id); }
  has(id, name) { return !!this.stores.get(name)?.has(id); }

  remove(id, name) {
    const s = this.stores.get(name);
    if (!s?.has(id)) return;
    const value = s.get(id);
    s.delete(id);
    this.invalidate(name);
    this.emit('componentRemoved', { id, name, value });
  }

  invalidate(name) {
    for (const q of this.queries.values()) if (q.names.includes(name)) q.ids = null;
  }

  /** Entities that have every named component. Cached until membership changes. */
  query(...names) {
    const key = names.join('|');
    let q = this.queries.get(key);
    if (!q) { q = { names, ids: null }; this.queries.set(key, q); }
    if (!q.ids) {
      const [first, ...rest] = names.map((n) => this.store(n)).sort((a, b) => a.size - b.size);
      q.ids = [...first.keys()].filter((id) => rest.every((s) => s.has(id)));
    }
    return q.ids;
  }

  /** Children via the Parent component (parent stores the parent's uuid). */
  children(id) {
    const uuid = this.uuid(id);
    const out = [];
    for (const [child, p] of this.store('Parent')) if (p.parent === uuid) out.push(child);
    return out;
  }

  parentOf(id) {
    const p = this.get(id, 'Parent');
    return p ? this.find(p.parent) : undefined;
  }

  addSystem(system) { this.systems.push(system); return system; }

  on(event, fn) {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(payload);
  }
}
