import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { createWhatsAppProxyRouter, ABANDONED_AFTER_MS } from './proxyRoutes.js';

const NOW = Date.parse('2026-10-24T10:00:00Z');

function setup({ sessions = [], evolution } = {}) {
    const db = fakeSupabase({ whatsapp_sessions: sessions });
    const calls = [];
    const evo = evolution || (async (path, options = {}) => {
        calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (path === '/instance/fetchInstances') return [{ name: 'biz_a1' }, { name: 'other_b1' }];
        return { ok: true, path };
    });
    const auth = (req, res, next) => { req.businessId = req.headers['x-business-id']; next(); };
    const app = express();
    app.use(express.json());
    app.use('/wa', createWhatsAppProxyRouter({ auth, supabase: db, evolution: evo, now: () => NOW }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/wa`;
    const call = async (path, { method = 'GET', body, business = 'biz' } = {}) => {
        const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Business-Id': business }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { db, calls, call, close: () => server.close() };
}

test('create saves a pending session first, then creates the instance', async () => {
    const t = setup();
    const r = await t.call('/instance/create', { method: 'POST', body: { instanceName: 'biz_new1', qrcode: true } });
    t.close();
    assert.equal(r.status, 201);
    assert.deepEqual(t.calls[0], { path: '/instance/create', method: 'POST', body: { instanceName: 'biz_new1', integration: 'WHATSAPP-BAILEYS', qrcode: true } });
    const row = t.db.tables.whatsapp_sessions.find((s) => s.instance_name === 'biz_new1');
    assert.equal(row.business_id, 'biz');
    assert.equal(row.status, 'pending');
});

test('a failed create removes the pending session again', async () => {
    const t = setup({ evolution: async () => { throw Object.assign(new Error('bad'), { status: 403, body: { message: 'forbidden' } }); } });
    const r = await t.call('/instance/create', { method: 'POST', body: { instanceName: 'biz_new2' } });
    t.close();
    assert.equal(r.status, 403);
    assert.equal(t.db.tables.whatsapp_sessions.length, 0);
});

test('an instance name owned by another business cannot be taken or used', async () => {
    const t = setup({ sessions: [{ id: 's1', business_id: 'other', instance_name: 'other_b1', status: 'connected' }] });
    const create = await t.call('/instance/create', { method: 'POST', body: { instanceName: 'other_b1' } });
    const send = await t.call('/message/sendText/other_b1', { method: 'POST', body: { number: '254700000000', text: 'hi' } });
    const state = await t.call('/instance/connectionState/other_b1');
    const del = await t.call('/instance/delete/other_b1', { method: 'DELETE' });
    t.close();
    assert.equal(create.status, 409);
    assert.equal(send.status, 404);
    assert.equal(state.status, 404);
    assert.equal(del.status, 404);
    assert.equal(t.calls.length, 0);
});

test('owners can send, read chats and load media for their own instance', async () => {
    const t = setup({ sessions: [{ id: 's1', business_id: 'biz', instance_name: 'biz_a1', status: 'connected' }] });
    const send = await t.call('/message/sendText/biz_a1', { method: 'POST', body: { number: '254700000000', text: 'hi' } });
    const chats = await t.call('/chat/findChats/biz_a1', { method: 'POST', body: {} });
    const msgs = await t.call('/chat/findMessages/biz_a1', { method: 'POST', body: { page: 1 } });
    const media = await t.call('/chat/getBase64FromMediaMessage/biz_a1', { method: 'POST', body: { message: { key: { id: 'x' } } } });
    t.close();
    assert.deepEqual([send.status, chats.status, msgs.status, media.status], [200, 200, 200, 200]);
    assert.deepEqual(t.calls.map((c) => c.path), ['/message/sendText/biz_a1', '/chat/findChats/biz_a1', '/chat/findMessages/biz_a1', '/chat/getBase64FromMediaMessage/biz_a1']);
    assert.deepEqual(t.calls[0].body, { number: '254700000000', text: 'hi' });
});

test('connect forwards only the digits of the pairing number', async () => {
    const t = setup({ sessions: [{ id: 's1', business_id: 'biz', instance_name: 'biz_a1', status: 'pending' }] });
    const r = await t.call('/instance/connect/biz_a1?number=%2B254%20712');
    t.close();
    assert.equal(r.status, 200);
    assert.equal(t.calls[0].path, '/instance/connect/biz_a1?number=254712');
});

test('fetchInstances only lists this business instances', async () => {
    const t = setup({ sessions: [{ id: 's1', business_id: 'biz', instance_name: 'biz_a1', status: 'connected' }, { id: 's2', business_id: 'other', instance_name: 'other_b1', status: 'connected' }] });
    const r = await t.call('/instance/fetchInstances');
    t.close();
    assert.deepEqual(r.json, [{ name: 'biz_a1' }]);
});

test('deleting an unfinished connection also removes its pending row; a finished one keeps it', async () => {
    const t = setup({ sessions: [
        { id: 's1', business_id: 'biz', instance_name: 'biz_p1', status: 'pending' },
        { id: 's2', business_id: 'biz', instance_name: 'biz_c1', status: 'connected' },
    ] });
    await t.call('/instance/delete/biz_p1', { method: 'DELETE' });
    await t.call('/instance/delete/biz_c1', { method: 'DELETE' });
    t.close();
    assert.deepEqual(t.db.tables.whatsapp_sessions.map((s) => s.id), ['s2']);
});

test('starting a new connection clears this business abandoned ones', async () => {
    const old = new Date(NOW - ABANDONED_AFTER_MS - 1000).toISOString();
    const fresh = new Date(NOW - 60_000).toISOString();
    const t = setup({ sessions: [
        { id: 'old', business_id: 'biz', instance_name: 'biz_old', status: 'pending', updated_at: old },
        { id: 'fresh', business_id: 'biz', instance_name: 'biz_fresh', status: 'pending', updated_at: fresh },
        { id: 'theirs', business_id: 'other', instance_name: 'other_old', status: 'pending', updated_at: old },
    ] });
    await t.call('/instance/create', { method: 'POST', body: { instanceName: 'biz_new3' } });
    t.close();
    const ids = t.db.tables.whatsapp_sessions.map((s) => s.id);
    assert.ok(!ids.includes('old'));
    assert.ok(ids.includes('fresh') && ids.includes('theirs'));
    assert.ok(t.calls.some((c) => c.path === '/instance/delete/biz_old'));
});

test('bad instance names are refused', async () => {
    const t = setup();
    const r = await t.call('/instance/create', { method: 'POST', body: { instanceName: '../admin' } });
    t.close();
    assert.equal(r.status, 400);
});
