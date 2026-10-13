import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageStore, createPatchBuffer, bulkWrite, bulkDelete, chunk, isMissingRpc } from './batchIo.js';

// Minimal chainable stand-in for the supabase-js query builder.
function fakeSupabase({ messages = [], rpc = () => ({ error: null }), writeError = () => null } = {}) {
    const calls = [];
    const from = (table) => {
        const q = { table, filters: [], orders: [], range: null, op: 'select', payload: null };
        const b = {
            select() { return b; },
            in(col, vals) { q.filters.push(['in', col, vals]); return b; },
            eq(col, val) { q.filters.push(['eq', col, val]); return b; },
            order(col) { q.orders.push(col); return b; },
            range(a, z) { q.range = [a, z]; return b; },
            update(p) { q.op = 'update'; q.payload = p; return b; },
            insert(p) { q.op = 'insert'; q.payload = p; return b; },
            upsert(p, o) { q.op = 'upsert'; q.payload = p; q.opts = o; return b; },
            delete() { q.op = 'delete'; return b; },
            then(resolve, reject) {
                calls.push(q);
                let result;
                if (q.op === 'select') {
                    let rows = messages;
                    for (const [t, c, v] of q.filters) rows = rows.filter(r => t === 'in' ? v.includes(r[c]) : r[c] === v);
                    rows = [...rows].sort((a, z) => a.contact_id - z.contact_id || a.id - z.id);
                    // emulate a server that caps pages at 1000 rows
                    const [a, z] = q.range || [0, 999];
                    result = { data: rows.slice(a, Math.min(z + 1, a + 1000)), error: null };
                } else {
                    const err = writeError(q);
                    result = { data: null, error: err };
                }
                return Promise.resolve(result).then(resolve, reject);
            },
        };
        return b;
    };
    return { calls, from, rpc: async (name, args) => { calls.push({ rpc: name, args }); return rpc(name, args); } };
}

test('chunk splits evenly', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('message store reads many contacts per request and answers get() from memory', async () => {
    const messages = [];
    for (let c = 1; c <= 400; c++) for (let m = 1; m <= 5; m++) messages.push({ id: c * 100 + m, contact_id: c, business_id: 'biz', created_at: `2026-01-0${m}` });
    const sb = fakeSupabase({ messages });
    const store = createMessageStore({ supabase: sb, businessId: 'biz' });
    await store.preload(Array.from({ length: 400 }, (_, i) => i + 1));
    const reads = sb.calls.length;
    assert.ok(reads <= 8, `expected a handful of reads for 400 contacts, got ${reads}`);   // 2 id-chunks x (page + empty page)
    for (let c = 1; c <= 400; c++) assert.equal((await store.get(c)).length, 5);
    assert.equal(sb.calls.length, reads, 'get() must not query again');
    assert.equal(store.stats.rowsRead, 2000);
});

test('message store keeps reading when the server caps page size', async () => {
    const messages = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, contact_id: 1, created_at: `t${String(i).padStart(5, '0')}` }));
    const sb = fakeSupabase({ messages });
    const store = createMessageStore({ supabase: sb, pageSize: 5000 });   // asks for 5000, server only returns 1000 per page
    await store.preload([1]);
    assert.equal((await store.get(1)).length, 2500);
});

test('message store empties itself when the cache cap is reached', async () => {
    const messages = [1, 2, 3].flatMap((c) => Array.from({ length: 10 }, (_, i) => ({ id: c * 100 + i, contact_id: c, created_at: 't' })));
    const sb = fakeSupabase({ messages });
    const store = createMessageStore({ supabase: sb, maxCachedRows: 10 });
    await store.preload([1]);
    await store.preload([2]);          // cap hit -> cleared first
    const before = sb.calls.length;
    await store.get(1);                // evicted, so it is fetched again
    assert.ok(sb.calls.length > before);
});

test('patch buffer merges patches per row and writes one RPC per chunk', async () => {
    const sb = fakeSupabase();
    const buf = createPatchBuffer({ supabase: sb, table: 'contacts', keyColumn: 'id', chunkSize: 500 });
    for (let i = 1; i <= 1200; i++) buf.add(i, { lead_type: 'business' });
    buf.add(1, { lead_quality: 'hot' });
    const result = await buf.flush();
    assert.equal(result.written, 1200);
    const rpcs = sb.calls.filter(c => c.rpc);
    assert.equal(rpcs.length, 3);
    assert.deepEqual(rpcs[0].args.p_rows[0], { k: 1, patch: { lead_type: 'business', lead_quality: 'hot' } });
    assert.equal(rpcs[0].args.p_table, 'contacts');
});

test('patch buffer falls back to row-by-row writes when the RPC is not installed, and reports bad rows', async () => {
    const failures = [], notices = [];
    const sb = fakeSupabase({
        rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.bulk_patch_rows' } }),
        writeError: (q) => (q.filters.some(f => f[2] === 2) ? { message: 'boom' } : null),
    });
    const buf = createPatchBuffer({ supabase: sb, table: 'contacts', onRowError: (k, m) => failures.push([k, m]), onNotice: (m) => notices.push(m) });
    buf.add(1, { a: 1 }); buf.add(2, { a: 2 }); buf.add(3, { a: 3 });
    const r = await buf.flush();
    assert.deepEqual(r, { written: 2, failed: 1 });
    assert.deepEqual(failures, [[2, 'boom']]);
    assert.equal(notices.length, 1);
    buf.add(4, { a: 4 });
    await buf.flush();
    assert.equal(sb.calls.filter(c => c.rpc).length, 1, 'does not retry a missing RPC on every flush');
});

test('bulkWrite dedupes by key, chunks, and isolates a bad row', async () => {
    const sb = fakeSupabase({ writeError: (q) => (Array.isArray(q.payload) && q.payload.length > 1 && q.payload.some(r => r.bad) ? { message: 'unique' } : (q.payload?.bad ? { message: 'unique' } : null)) });
    const rows = [{ k: 'a', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3, bad: true }, { k: 'c', v: 4 }];
    const failed = [];
    const r = await bulkWrite({ supabase: sb, table: 'ad_attributions', rows, mode: 'upsert', onConflict: 'k', dedupeKey: (x) => x.k, onRowError: (k, m) => failed.push(k) });
    assert.equal(r.written, 2);
    assert.deepEqual(failed, ['b']);
    const first = sb.calls.find(c => c.op === 'upsert');
    assert.equal(first.payload.length, 3, 'duplicate key collapsed');
    assert.equal(first.payload.find(x => x.k === 'a').v, 2, 'last write wins');
});

test('bulkDelete chunks ids', async () => {
    const sb = fakeSupabase();
    await bulkDelete({ supabase: sb, table: 'conversation_enrichment', column: 'contact_id', ids: Array.from({ length: 450 }, (_, i) => i), chunkSize: 200 });
    assert.equal(sb.calls.filter(c => c.op === 'delete').length, 3);
});

test('isMissingRpc recognises both PostgREST and Postgres shapes', () => {
    assert.ok(isMissingRpc({ code: 'PGRST202' }));
    assert.ok(isMissingRpc({ code: '42883' }));
    assert.ok(!isMissingRpc({ code: '23505', message: 'duplicate' }));
});
