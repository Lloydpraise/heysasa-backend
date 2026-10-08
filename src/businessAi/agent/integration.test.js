import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOrchestrator } from '../orchestrator.js';
import { createAssistantRouter } from '../routes.js';
import { createNotes } from '../notes.js';
import { createAgent } from './index.js';
import { fakeDb } from './fakeDb.js';
import { fakeEmbed, fakeStore, scriptedModel } from '../fakes.js';

const NOW = new Date('2026-10-07T10:00:00Z');
const seed = () => ({
  v_lead_summary: [{ id: 1, business_id: 'b1', name: 'Amina', lead_state: 'engaged', lead_type: 'customer' }, { id: 5, business_id: 'b1', name: 'Esther', lead_state: 'engaged', lead_type: 'customer' }],
  contacts: [{ id: 1, business_id: 'b1', name: 'Amina', lead_state: 'engaged' }, { id: 5, business_id: 'b1', name: 'Esther', lead_state: 'engaged' }],
  lists: [], list_members: [], campaigns: [], businesses: [{ business_id: 'b1', name: 'Kitchen & All', currency: 'KES', chat_ai_enabled: false, chat_ai_daily_cap: 0, persona_pack_status: 'ready' }],
});

function boot(script) {
  const db = fakeDb(seed());
  const store = fakeStore();
  const notes = createNotes({ store, embed: fakeEmbed });
  const agent = createAgent({ supabase: db, store, canAfford: async () => true, now: () => NOW, env: { PORT: '1' } });
  const callModel = scriptedModel(script);
  const handleChat = createOrchestrator({ store, notes, embed: fakeEmbed, agent, callModel, canAfford: async () => true, billModel: async () => {}, now: () => NOW });
  return { db, store, notes, agent, callModel, handleChat };
}

const text = (body) => body.input.map((i) => (typeof i.content === 'string' ? i.content : '')).join('\n---\n');

test('general chat: agent tools are offered, a change comes back as a card, the message remembers it, and the next turn knows its fate', async () => {
  const t = boot([
    { calls: [{ name: 'create_list', args: { name: 'Braids fans', lead_ids: [1, 5] } }] },
    { text: 'I put the list up for your OK.' },
    { text: 'The list is ready, 2 people in it.' },
  ]);
  const events = [];
  const first = await t.handleChat({ businessId: 'b1', userId: 'u1', surface: 'general', message: 'make a list of my braids people', token: 'tok' }, (e) => events.push(e));

  const toolNames = t.callModel.calls[0].tools.map((x) => x.name);
  for (const n of ['load_skill', 'save_note', 'search_leads', 'create_list', 'launch_campaign', 'guide_user']) assert.ok(toolNames.includes(n), n);
  assert.match(t.callModel.calls[0].instructions, /YOU CAN ACT, NOT ONLY ADVISE/);
  assert.match(t.callModel.calls[0].instructions, /WHAT YOU NEVER DO YOURSELF/);

  const card = events.find((e) => e.type === 'action');
  assert.ok(card, 'the dashboard receives a card');
  assert.equal(card.action.status, 'pending');
  assert.equal(card.action.title, 'Make a list called "Braids fans"');
  assert.equal(card.action.can_always_allow, true);
  assert.equal(card.action.params, undefined, 'raw params never leave the server');
  assert.equal(t.db.tables.lists.length, 0);

  assert.deepEqual(first.action_ids, [card.action.id]);
  const saved = t.store.db.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(saved.action_ids, [card.action.id]);
  assert.equal(t.store.db.actions[0].message_id, saved.id);
  assert.ok(events.some((e) => e.type === 'status'));

  await t.agent.engine.approve(t.agent.makeCtx({ businessId: 'b1', userId: 'u1', token: 'tok' }), card.action.id);
  await t.handleChat({ businessId: 'b1', userId: 'u1', surface: 'general', conversationId: first.conversation_id, message: 'Approved.', token: 'tok' });
  assert.match(text(t.callModel.calls.at(-1)), /Changes you prepared[\s\S]*Make a list called "Braids fans": done/);
});

test('a tool error is explained to the model in plain words and nothing is created', async () => {
  const t = boot([{ calls: [{ name: 'create_list', args: { name: 'x' } }] }, { text: 'That name is too short. What would you like to call it?' }]);
  await t.handleChat({ businessId: 'b1', userId: 'u1', surface: 'general', message: 'make a list', token: 'tok' });
  const out = t.callModel.calls[1].input.find((i) => i.type === 'function_call_output');
  assert.match(out.output, /needs a name/);
  assert.equal(t.store.db.actions.length, 0);
});

test('drafting boxes keep the small safe toolset and never get change tools', async () => {
  const t = boot([{ text: 'Here.\n<draft>Hi {{first_name}}</draft>' }]);
  await t.handleChat({ businessId: 'b1', userId: 'u1', surface: 'campaign_message', message: 'write a nudge' });
  assert.deepEqual(t.callModel.calls[0].tools.map((x) => x.name).sort(), ['load_skill', 'recall_notes', 'save_note', 'search_products']);
  assert.doesNotMatch(t.callModel.calls[0].instructions, /YOU CAN ACT/);
});

test('saving a note leaves a line in the Activity log', async () => {
  const t = boot([{ calls: [{ name: 'save_note', args: { text: 'We deliver only within Nairobi.' } }] }, { text: 'Noted.' }]);
  await t.handleChat({ businessId: 'b1', userId: 'u1', surface: 'general', message: 'we only deliver in Nairobi' });
  const row = t.store.db.actions.find((a) => a.type === 'save_note');
  assert.equal(row.status, 'done');
  assert.match(row.summary, /Remembered: We deliver only within Nairobi/);
});

// ── HTTP ────────────────────────────────────────────────────────────────────
async function bootHttp() {
  const t = boot([{ text: 'ok' }]);
  const auth = (req, res, next) => { req.businessId = req.headers['x-business-id'] || 'b1'; req.userId = 'u1'; next(); };
  const app = express();
  app.use(express.json());
  app.use('/assistant', createAssistantRouter({ store: t.store, notes: t.notes, handleChat: t.handleChat, agent: t.agent, skillsForBusiness: t.store.loadSkills, auth }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant`;
  const call = async (path, { method = 'GET', body, business } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok', ...(business ? { 'X-Business-Id': business } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const propose = async (name, args) => (await t.agent.engine.propose(t.agent.makeCtx({ businessId: 'b1', userId: 'u1', token: 'tok' }), t.agent.registry.byName.get(name), args)).action;
  return { ...t, call, propose, close: () => server.close() };
}

test('HTTP: pending list, approve, approve again, undo, activity log', async () => {
  const t = await bootHttp();
  const a = await t.propose('create_list', { name: 'Via HTTP', lead_ids: [1] });
  const pending = await t.call('/actions/pending');
  assert.equal(pending.json.actions.length, 1);
  assert.equal(pending.json.actions[0].id, a.id);

  const ok = await t.call(`/actions/${a.id}/approve`, { method: 'POST', body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.action.status, 'done');
  assert.equal(ok.json.already, false);
  assert.equal((await t.call(`/actions/${a.id}/approve`, { method: 'POST', body: {} })).json.already, true);

  const act = await t.call('/activity');
  assert.equal(act.json.activity.length, 1);
  assert.equal(act.json.activity[0].summary, 'Made the list "Via HTTP" with 1 person.');
  assert.equal(act.json.activity[0].params, undefined);
  assert.equal((await t.call('/actions/pending')).json.actions.length, 0);

  const undone = await t.call(`/actions/${a.id}/undo`, { method: 'POST' });
  assert.equal(undone.json.action.status, 'undone');
  assert.equal(t.db.tables.lists.length, 0);
  t.close();
});

test('HTTP: another business gets 404, a bad id gets 400, reject works', async () => {
  const t = await bootHttp();
  const a = await t.propose('create_list', { name: 'Private', lead_ids: [1] });
  assert.equal((await t.call(`/actions/${a.id}/approve`, { method: 'POST', body: {}, business: 'b2' })).status, 404);
  assert.equal((await t.call('/actions/nope/approve', { method: 'POST', body: {} })).status, 400);
  const rej = await t.call(`/actions/${a.id}/reject`, { method: 'POST' });
  assert.equal(rej.json.action.status, 'rejected');
  assert.equal((await t.call(`/actions/${a.id}/approve`, { method: 'POST', body: {} })).status, 409);
  t.close();
});

test('HTTP: always allow can be chosen on approve and managed, but never for critical actions', async () => {
  const t = await bootHttp();
  const a = await t.propose('create_list', { name: 'First', lead_ids: [1] });
  await t.call(`/actions/${a.id}/approve`, { method: 'POST', body: { always_allow: true } });
  const prefs = await t.call('/action-prefs');
  assert.equal(prefs.json.actions.find((x) => x.type === 'create_list').always_allow, true);
  assert.equal(prefs.json.actions.find((x) => x.type === 'launch_campaign').critical, true);
  assert.equal(prefs.json.actions.find((x) => x.type === 'launch_campaign').always_allow, false);

  const crit = await t.call('/action-prefs', { method: 'PUT', body: { type: 'launch_campaign', always_allow: true } });
  assert.equal(crit.status, 400);
  assert.equal((await t.call('/action-prefs', { method: 'PUT', body: { type: 'create_list', always_allow: false } })).json.always_allow, false);
  t.close();
});
