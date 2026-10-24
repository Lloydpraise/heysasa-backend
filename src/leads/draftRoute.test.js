import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { createLeadDraftRouter, buildDraftPrompt } from './draftRoute.js';

function setup({ model = async () => 'Hi Wanjiru, the classic set is KES 2500. Shall I book you for Saturday?', afford = true, tables = {} } = {}) {
    const db = fakeSupabase({
        contacts: [
            { id: 7, business_id: 'biz', name: 'Wanjiru', lead_state: 'negotiating', lead_summary: 'Wants classic lashes Saturday', next_action_plan: 'Confirm Saturday slot', do_not_contact: false },
            { id: 8, business_id: 'other', name: 'Not yours' },
            { id: 9, business_id: 'biz', name: 'Stop', do_not_contact: true },
        ],
        businesses: [{ business_id: 'biz', name: 'Lashes Studio' }],
        persona_packs: [{ business_id: 'biz', is_active: true, pack: { voice_and_tone: 'friendly' } }],
        messages: [
            { contact_id: 7, direction: 'in', content: { text: 'how much is classic?' }, created_at: '2026-10-20T10:00:00Z' },
            { contact_id: 7, direction: 'out', content: { text: 'KES 2500' }, created_at: '2026-10-20T10:05:00Z' },
        ],
        products: [{ business_id: 'biz', title: 'classic set', price: 2500, status: 'approved', mention_count: 4 }],
        ...tables,
    });
    const seen = [];
    const auth = (req, _res, next) => { req.businessId = 'biz'; next(); };
    const app = express();
    app.use(express.json());
    app.use(createLeadDraftRouter({
        auth, supabase: db,
        callModel: async (args) => { seen.push(args); return model(args); },
        canAfford: async () => afford,
        check: (text) => ({ passed: !text.includes('[') }),
    }));
    const server = app.listen(0);
    const call = async (id, body = {}) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/leads/${id}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
    };
    return { call, seen, close: () => server.close() };
}

test('writes a message for the owner from the chat, the brief and the products', async () => {
    const t = setup();
    const r = await t.call(7);
    t.close();
    assert.equal(r.status, 200);
    assert.match(r.json.text, /classic set/);
    assert.deepEqual(r.json.usedProducts, ['classic set']);
    assert.equal(r.json.quality.passed, true);
    assert.equal(t.seen[0].businessId, 'biz');
    assert.match(t.seen[0].userContent, /Confirm Saturday slot/);
    assert.match(t.seen[0].userContent, /Customer: how much is classic\?\nBusiness: KES 2500/);
});

test('another business lead is not found, and nobody is charged', async () => {
    const t = setup();
    const r = await t.call(8);
    t.close();
    assert.equal(r.status, 404);
    assert.equal(t.seen.length, 0);
});

test('people who opted out are never written to', async () => {
    const t = setup();
    const r = await t.call(9);
    t.close();
    assert.equal(r.status, 409);
    assert.equal(t.seen.length, 0);
});

test('an empty wallet says so instead of calling the AI', async () => {
    const t = setup({ afford: false });
    const r = await t.call(7);
    t.close();
    assert.equal(r.status, 402);
    assert.equal(t.seen.length, 0);
});

test('when the AI is unavailable the owner gets a clear message', async () => {
    const t = setup({ model: async () => null });
    const r = await t.call(7);
    t.close();
    assert.equal(r.status, 503);
    assert.match(r.json.message, /could not write/);
});

test('the goal from the dashboard wins over the stored plan', () => {
    const { user } = buildDraftPrompt({ businessName: 'X', contact: { name: 'A' }, goal: { plan: 'Send location pin' }, messages: [], products: [] });
    assert.match(user, /Goal of this message: Send location pin/);
    assert.match(user, /no chat history yet/);
});
