// A small in-memory stand-in for the Supabase client, enough for the knowledge and handoff tests.
export function fakeSupabase(tables = {}, { storage = {} } = {}) {
    let id = 0;
    const removed = [];
    return {
        tables, removed,
        from(name) {
            tables[name] ??= [];
            const q = { filters: [], op: 'select', payload: null, single: false, limitN: null, returning: false, orders: [] };
            const match = () => tables[name].filter((r) => q.filters.every((f) => f(r)));
            const api = {
                select(_cols, opts) { if (q.op !== 'select') q.returning = true; if (opts?.head) q.head = true; return api; },
                eq(c, v) { q.filters.push((r) => r[c] === v); return api; },
                is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return api; },
                lt(c, v) { q.filters.push((r) => r[c] != null && r[c] < v); return api; },
                gte(c, v) { q.filters.push((r) => r[c] != null && r[c] >= v); return api; },
                not(c, op, v) { const list = String(v).replace(/[()]/g, '').split(','); q.filters.push((r) => !(op === 'in' ? list.includes(String(r[c])) : r[c] === v)); return api; },
                in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return api; },
                order(c, o) { q.orders.push([c, o?.ascending !== false]); return api; },
                limit(n) { q.limitN = n; return api; },
                maybeSingle() { q.single = true; return api; },
                single() { q.single = true; return api; },
                insert(p) { q.op = 'insert'; q.payload = p; return api; },
                update(p) { q.op = 'update'; q.payload = p; return api; },
                delete() { q.op = 'delete'; return api; },
                then(resolve, reject) {
                    const run = () => {
                        if (q.op === 'insert') {
                            const made = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: `id${++id}`, ...r }));
                            tables[name].push(...made);
                            return { data: q.single ? made[0] : (q.returning ? made : null), error: null };
                        }
                        if (q.op === 'update') { const hit = match(); hit.forEach((r) => Object.assign(r, q.payload)); return { data: q.returning ? hit : null, error: null }; }
                        if (q.op === 'delete') { const hit = match(); tables[name] = tables[name].filter((r) => !hit.includes(r)); return { data: null, error: null }; }
                        if (q.head) return { data: null, count: match().length, error: null };
                        let out = match();
                        for (const [c, asc] of [...q.orders].reverse()) out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
                        if (q.limitN) out = out.slice(0, q.limitN);
                        return { data: q.single ? (out[0] ?? null) : out, error: null };
                    };
                    return Promise.resolve(run()).then(resolve, reject);
                },
            };
            return api;
        },
        storage: {
            from: () => ({
                download: async (path) => (storage[path] ? { data: { arrayBuffer: async () => storage[path] }, error: null } : { data: null, error: { message: 'not found' } }),
                remove: async (paths) => { removed.push(...paths); return { data: null, error: null }; },
                createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
            }),
        },
    };
}
