import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createEventsRouter, hashKey } from './routes.js';
import { renderTemplate, normalizePhone, formatItems, resolveTemplate } from './templates.js';

// In-memory stand-in for the parts of the Supabase client the router uses.
function fakeDb(state) {
    let nextId = 1;
    return {
        from(table) {
            state[table] ??= [];
            const q = { filters: [], op: 'select', payload: null, single: false, limitN: null, head: false, count: false, onConflict: null, returning: false };
            const rows = () => state[table].filter((r) => q.filters.every((f) => f(r)));
            const api = {
                select(_cols, opts) { if (q.op !== 'select') q.returning = true; q.head = !!opts?.head; q.count = !!opts?.count; return api; },
                eq(col, val) { q.filters.push((r) => r[col] === val); return api; },
                is(col, val) { q.filters.push((r) => (r[col] ?? null) === val); return api; },
                in(col, vals) { q.filters.push((r) => vals.includes(r[col])); return api; },
                order() { return api; },
                limit(n) { q.limitN = n; return api; },
                maybeSingle() { q.single = true; return api; },
                single() { q.single = true; return api; },
                insert(payload) { q.op = 'insert'; q.payload = payload; return api; },
                update(payload) { q.op = 'update'; q.payload = payload; return api; },
                upsert(payload, opts) { q.op = 'upsert'; q.payload = payload; q.onConflict = opts?.onConflict; return api; },
                delete() { q.op = 'delete'; return api; },
                then(resolve, reject) {
                    try {
                        if (q.op === 'insert') {
                            const row = { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, created_at: new Date().toISOString(), ...q.payload };
                            if (table === 'business_events' && row.external_id && state[table].some((r) => r.business_id === row.business_id && r.event_type === row.event_type && r.external_id === row.external_id)) {
                                return resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
                            }
                            state[table].push(row);
                            return resolve({ data: row, error: null });
                        }
                        if (q.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, q.payload)); return resolve({ data: q.single ? (hit[0] ?? null) : hit, error: null }); }
                        if (q.op === 'delete') { state[table] = state[table].filter((r) => !q.filters.every((f) => f(r))); return resolve({ data: null, error: null }); }
                        if (q.op === 'upsert') {
                            const cols = q.onConflict.split(',');
                            let row = state[table].find((r) => cols.every((c) => r[c] === q.payload[c]));
                            if (row) Object.assign(row, q.payload); else { row = { id: `t${nextId++}`, ...q.payload }; state[table].push(row); }
                            return resolve({ data: row, error: null });
                        }
                        let out = rows();
                        if (q.head) return resolve({ count: out.length, error: null });
                        if (q.limitN) out = out.slice(0, q.limitN);
                        return resolve({ data: q.single ? (out[0] ?? null) : out, error: null });
                    } catch (e) { return reject(e); }
                },
            };
            return api;
        },
    };
}

const KEY = 'hs_live_abcdefghijklmnopqrstuvwxyz012345';

async function setup({ templates = [], scopeOverride = {} } = {}) {
    const state = {
        api_keys: [{ id: 'k1', business_id: 'b1', account_id: null, key_hash: hashKey(KEY), revoked_at: null }],
        accounts: [{ id: 'a1', business_id: 'b1', is_primary: true }],
        businesses: [{ business_id: 'b1', name: 'Lashes by Shazz' }],
        event_templates: templates,
        business_events: [],
    };
    const created = [];
    const scope = (req, _res, next) => { req.businessId = 'b1'; req.userId = 'u1'; req.scope = { isAdmin: true, accountId: null, accountIds: ['a1'], ...scopeOverride }; next(); };
    const app = express();
    app.use(express.json());
    app.use(createEventsRouter({
        db: fakeDb(state), scope, admin: scope,
        contacts: {
            getOrCreateContact: async (businessId, jid, name, _alt, accountId) => { created.push({ businessId, jid, name, accountId }); return { id: 42, name }; },
            getOrCreateConversation: async () => 'conv1',
        },
        apiBaseUrl: 'https://api.example',
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { method = 'GET', body, key = KEY } = {}) => {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, json: await res.json() };
    };
    return { state, created, call, close: () => server.close() };
}

test('renderTemplate fills fields and tidies missing ones', () => {
    const text = renderTemplate('Hi {{first_name}}, order {{order_id}} ({{items}}) is on its way. {{tracking_url}}', {
        name: 'Wanjiku Kamau', data: { order_id: 'A12', items: [{ name: 'Lash kit', qty: 2 }, 'Glue'] },
    });
    assert.equal(text, 'Hi Wanjiku, order A12 (2 x Lash kit, Glue) is on its way.');
    assert.equal(renderTemplate('{{currency}} {{total}} {{data.colour}}', { data: { total: 2500, colour: 'red' } }), 'KES 2,500 red');
    assert.equal(renderTemplate('Hi {{first_name}}', { name: '0712345678' }), 'Hi there');
});

test('normalizePhone and formatItems', () => {
    assert.equal(normalizePhone('0712 345 678'), '254712345678');
    assert.equal(normalizePhone('+254712345678'), '254712345678');
    assert.equal(normalizePhone('712345678'), '254712345678');
    assert.equal(normalizePhone('12'), '');
    assert.equal(formatItems('Two kits'), 'Two kits');
    assert.equal(resolveTemplate('nope.thing', null), null);
    assert.equal(resolveTemplate('order.paid', { enabled: false }), null);
});

test('POST /v1/events schedules a cart reminder an hour out on the primary account', async () => {
    const t = await setup();
    try {
        const res = await t.call('/v1/events', { method: 'POST', body: { event: 'cart.abandoned', event_id: 'c1', phone: '0712345678', name: 'Wanjiku', data: { items: [{ name: 'Lash kit' }], cart_url: 'https://shop/c1' } } });
        assert.equal(res.status, 202);
        assert.equal(res.json.status, 'scheduled');
        const row = t.state.business_events[0];
        assert.equal(row.account_id, 'a1');
        assert.equal(row.phone, '254712345678');
        assert.equal(row.respect_quiet_hours, true);
        assert.match(row.message, /^Hi Wanjiku, you left Lash kit in your cart at Lashes by Shazz\. You can finish your order here: https:\/\/shop\/c1$/);
        assert.ok(Date.parse(row.send_at) - Date.now() > 59 * 60_000);
        assert.equal(t.created[0].jid, '254712345678@s.whatsapp.net');
    } finally { t.close(); }
});

test('the same event_id twice is one event', async () => {
    const t = await setup();
    try {
        const body = { event: 'order.paid', event_id: 'o1', phone: '+254712345678', data: { total: 100 } };
        const a = await t.call('/v1/events', { method: 'POST', body });
        const b = await t.call('/v1/events', { method: 'POST', body });
        assert.equal(a.status, 202);
        assert.equal(b.status, 200);
        assert.equal(b.json.duplicate, true);
        assert.equal(b.json.id, a.json.id);
        assert.equal(t.state.business_events.length, 1);
    } finally { t.close(); }
});

test('a paid order cancels the waiting cart reminder', async () => {
    const t = await setup();
    try {
        await t.call('/v1/events', { method: 'POST', body: { event: 'cart.abandoned', phone: '0712345678' } });
        await t.call('/v1/events', { method: 'POST', body: { event: 'order.paid', phone: '0712345678', data: { order_id: 'X1', total: 2500 } } });
        const [cart, paid] = t.state.business_events;
        assert.equal(cart.status, 'cancelled');
        assert.equal(paid.status, 'scheduled');
        assert.equal(paid.respect_quiet_hours, false);
        assert.ok(Date.parse(paid.send_at) <= Date.now());
    } finally { t.close(); }
});

test('bad key, bad phone, unknown or switched-off event are refused', async () => {
    const t = await setup({ templates: [{ business_id: 'b1', event_type: 'order.shipped', enabled: false, body: 'x', delay_minutes: 0 }] });
    try {
        assert.equal((await t.call('/v1/events', { method: 'POST', key: null, body: {} })).status, 401);
        assert.equal((await t.call('/v1/events', { method: 'POST', key: 'hs_live_wrongwrongwrongwrongwrong', body: {} })).status, 401);
        assert.equal((await t.call('/v1/events', { method: 'POST', body: { event: 'order.paid', phone: '12' } })).json.error, 'invalid_phone');
        assert.equal((await t.call('/v1/events', { method: 'POST', body: { event: 'booking.made', phone: '0712345678' } })).status, 422);
        assert.equal((await t.call('/v1/events', { method: 'POST', body: { event: 'order.shipped', phone: '0712345678' } })).json.error, 'event_not_enabled');
        assert.equal(t.state.business_events.length, 0);
        t.state.api_keys[0].revoked_at = new Date().toISOString();
        assert.equal((await t.call('/v1/events', { method: 'POST', body: { event: 'order.paid', phone: '0712345678' } })).status, 401);
    } finally { t.close(); }
});

test('a custom event works once the business saves a template for it', async () => {
    const t = await setup();
    try {
        const put = await t.call('/integrations/event-templates/booking.confirmed', { method: 'PUT', key: null, body: { body: 'See you on {{data.date}}, {{first_name}}!', delayMinutes: 0 } });
        assert.equal(put.status, 200);
        const res = await t.call('/v1/events', { method: 'POST', body: { event: 'booking.confirmed', phone: '0712345678', name: 'Amina', data: { date: 'Friday' } } });
        assert.equal(res.status, 202);
        assert.equal(t.state.business_events[0].message, 'See you on Friday, Amina!');
    } finally { t.close(); }
});

test('dashboard: create a key (shown once, stored hashed), list, revoke', async () => {
    const t = await setup();
    try {
        const made = await t.call('/integrations/api-keys', { method: 'POST', key: null, body: { label: 'Shop' } });
        assert.equal(made.status, 201);
        assert.match(made.json.key, /^hs_live_/);
        const stored = t.state.api_keys.find((k) => k.id === made.json.apiKey.id);
        assert.equal(stored.key_hash, hashKey(made.json.key));
        assert.ok(!JSON.stringify(stored).includes(made.json.key));

        const card = await t.call('/integrations/website', { key: null });
        assert.equal(card.json.apiBaseUrl, 'https://api.example');
        assert.ok(card.json.templates.some((tpl) => tpl.event === 'cart.abandoned' && tpl.delayMinutes === 60));

        const used = await t.call('/v1/events', { method: 'POST', key: made.json.key, body: { event: 'order.paid', phone: '0712345678' } });
        assert.equal(used.status, 202);
        await t.call(`/integrations/api-keys/${made.json.apiKey.id}`, { method: 'DELETE', key: null });
        assert.equal((await t.call('/v1/events', { method: 'POST', key: made.json.key, body: { event: 'order.paid', phone: '0712345678' } })).status, 401);
    } finally { t.close(); }
});

test('dashboard: a key cannot be tied to an account outside the caller\'s scope', async () => {
    const t = await setup();
    try {
        const res = await t.call('/integrations/api-keys', { method: 'POST', key: null, body: { accountId: '11111111-1111-4111-8111-111111111111' } });
        assert.equal(res.status, 403);
    } finally { t.close(); }
});

test('GET /v1/events/:id only shows the key\'s own business', async () => {
    const t = await setup();
    try {
        const made = await t.call('/v1/events', { method: 'POST', body: { event: 'order.paid', phone: '0712345678' } });
        const got = await t.call(`/v1/events/${made.json.id}`);
        assert.equal(got.json.status, 'scheduled');
        t.state.business_events[0].business_id = 'other';
        assert.equal((await t.call(`/v1/events/${made.json.id}`)).status, 404);
    } finally { t.close(); }
});
