// A tiny in-memory stand-in for the Supabase client, just big enough for the agent tools in tests.
// Supports: select, insert, update, delete, upsert, eq, neq, in, is, lt, lte, gt, gte, order, limit, range,
// maybeSingle, single, rpc. Views are just tables you seed.

export function fakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const log = [];
  const state = { seq: 0, failOn: null, rpc: {}, log };
  const uuid = () => `00000000-0000-4000-9000-${String(++state.seq).padStart(12, '0')}`;
  const same = (a, b) => (a === null || a === undefined || b === null || b === undefined ? a === b : String(a) === String(b));

  class Query {
    constructor(name) { this.name = name; this.op = 'select'; this.filters = []; this.sorts = []; this.returning = false; this.mode = 'many'; this.window = null; }
    select() { if (this.op === 'select') this.op = 'select'; else this.returning = true; return this; }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    upsert(rows, opts = {}) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.onConflict = opts.onConflict; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(col, val) { this.filters.push((r) => same(r[col], val)); return this; }
    neq(col, val) { this.filters.push((r) => !same(r[col], val)); return this; }
    in(col, vals) { this.filters.push((r) => vals.some((v) => same(r[col], v))); return this; }
    is(col, val) { this.filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val)); return this; }
    lt(col, val) { this.filters.push((r) => r[col] != null && r[col] < val); return this; }
    lte(col, val) { this.filters.push((r) => r[col] != null && r[col] <= val); return this; }
    gt(col, val) { this.filters.push((r) => r[col] != null && r[col] > val); return this; }
    gte(col, val) { this.filters.push((r) => r[col] != null && r[col] >= val); return this; }
    order(col, { ascending = true } = {}) { this.sorts.push([col, ascending]); return this; }
    limit(n) { this.window = [0, n - 1]; return this; }
    range(from, to) { this.window = [from, to]; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    single() { this.mode = 'single'; return this; }
    then(resolve, reject) { return Promise.resolve(this.exec()).then(resolve, reject); }

    exec() {
      const fail = state.failOn?.(this.name, this.op);
      if (fail) return { data: null, error: { message: fail } };
      const rows = (tables[this.name] ??= []);
      const matching = () => rows.filter((r) => this.filters.every((f) => f(r)));
      const finish = (list) => {
        let out = list.map((r) => ({ ...r }));
        for (const [col, asc] of [...this.sorts].reverse()) out.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
        if (this.window) out = out.slice(this.window[0], this.window[1] + 1);
        if (this.mode === 'maybe') return { data: out[0] ?? null, error: null };
        if (this.mode === 'single') return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
        return { data: out, error: null };
      };
      log.push([this.op, this.name]);
      if (this.op === 'select') return finish(matching());
      if (this.op === 'insert') {
        const added = this.payload.map((p) => ({ id: p.id ?? uuid(), ...p }));
        rows.push(...added);
        return this.returning ? finish(added) : { data: null, error: null };
      }
      if (this.op === 'update') {
        const hit = matching();
        hit.forEach((r) => Object.assign(r, this.payload));
        return this.returning ? finish(hit) : { data: null, error: null };
      }
      if (this.op === 'delete') {
        const hit = new Set(matching());
        tables[this.name] = rows.filter((r) => !hit.has(r));
        return { data: null, error: null };
      }
      if (this.op === 'upsert') {
        const keys = (this.onConflict ?? 'id').split(',').map((k) => k.trim());
        const out = [];
        for (const p of this.payload) {
          const found = rows.find((r) => keys.every((k) => same(r[k], p[k])));
          if (found) { Object.assign(found, p); out.push(found); } else { const n = { id: p.id ?? uuid(), ...p }; rows.push(n); out.push(n); }
        }
        return this.returning ? finish(out) : { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported ${this.op}` } };
    }
  }

  return {
    tables, state,
    from: (name) => new Query(name),
    rpc: async (name, args) => (state.rpc[name] ? state.rpc[name](args) : { data: null, error: { message: `no rpc ${name}` } }),
  };
}
