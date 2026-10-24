import '../test-helpers/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHandoffRouter } from './routes.js';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';

async function app(tables, send = async () => ({ ok: true })) {
    const db = fakeSupabase(tables);
    const server = express();
    server.use(express.json());
    server.use('/handoff', createHandoffRouter({ auth: (req, _res, next) => { req.businessId = 'b1'; next(); }, supabase: db, send }));
    const listener = http.createServer(server);
    await new Promise((r) => listener.listen(0, r));
    const base = `http://127.0.0.1:${listener.address().port}/handoff`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, json: await res.json() };
    };
    return { call, db, close: () => listener.close() };
}
const business = () => ({ business_id: 'b1', owner_phone: '0711000111', chat_ai_settings: { business_hours: { open: '08:00' }, settle_ms: 0 } });

test('saving keeps the rest of the settings, and a bad person is refused instead of silently dropped', async () => {
    const a = await app({ businesses: [business()] });
    const bad = await a.call('PUT', '/config', { recipients: [{ name: 'X', phone: '12' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /valid phone/);
    const good = await a.call('PUT', '/config', { recipients: [{ id: 'w', name: 'Wanjiru', phone: '0722333444' }], rules: [{ label: 'Refund', when: 'wants refund', to: ['w'] }] });
    assert.equal(good.status, 200);
    const saved = a.db.tables.businesses[0].chat_ai_settings;
    assert.equal(saved.settle_ms, 0);
    assert.deepEqual(saved.business_hours, { open: '08:00' });
    assert.equal(saved.handoff.rules[0].to[0], 'w');
    const read = await a.call('GET', '/config');
    assert.equal(read.json.owner_phone, '0711000111');
    assert.ok(read.json.suggested.length >= 4);
    a.close();
});

test('the test alert reaches the default people, and says so plainly when it cannot', async () => {
    const sent = [];
    const a = await app({ businesses: [business()] }, async (to) => { sent.push(to); return { ok: true }; });
    assert.deepEqual((await a.call('POST', '/test')).json, { ok: true, sent: 1, of: 1 });
    assert.deepEqual(sent, ['254711000111']);
    a.close();
    const b = await app({ businesses: [{ ...business(), owner_phone: null }] });
    assert.equal((await b.call('POST', '/test')).status, 400);
    b.close();
    const c = await app({ businesses: [business()] }, async () => ({ ok: false }));
    assert.equal((await c.call('POST', '/test')).status, 502);
    c.close();
});

test('Home lists chats handed over and not yet handled, and marking one handled removes it; other businesses are untouchable', async () => {
    const a = await app({
        businesses: [business()],
        conversations: [
            { id: 'c1', business_id: 'b1', contact_id: 7, handover_flag: true, handover_resolved_at: null, handover_reason: 'refund', handover_urgency: 'high', handover_at: '2' },
            { id: 'c2', business_id: 'b1', contact_id: 8, handover_flag: true, handover_resolved_at: '1', handover_at: '1' },
            { id: 'c3', business_id: 'b2', contact_id: 9, handover_flag: true, handover_resolved_at: null, handover_at: '3' },
        ],
    });
    assert.deepEqual((await a.call('GET', '/open')).json.items.map((i) => i.conversation_id), ['c1']);
    assert.equal((await a.call('POST', '/c3/resolve')).status, 404, 'another business\'s chat');
    assert.equal((await a.call('POST', '/c1/resolve')).status, 200);
    assert.deepEqual((await a.call('GET', '/open')).json.items, []);
    a.close();
});
