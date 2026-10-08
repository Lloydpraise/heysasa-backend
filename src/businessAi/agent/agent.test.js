import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from './index.js';
import { ABILITIES } from './prompt.js';
import { ActionError } from './engine.js';
import { fakeDb } from './fakeDb.js';
import { fakeStore } from '../fakes.js';

const NOW = new Date('2026-10-07T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const lead = (id, over = {}) => ({ id, business_id: 'b1', name: `Lead ${id}`, lead_state: 'engaged', lead_type: 'customer', is_ad_lead: false, intent_score: 5, last_seen: ago(2), unread_count: 0, product_interests: [], objection_tags: [], do_not_contact: false, ...over });

function setup(seed = {}, { afford = true } = {}) {
  const db = fakeDb({
    v_lead_summary: [], contacts: [], lists: [], list_members: [], campaigns: [], campaign_steps: [], campaign_enrollments: [], follow_up_queue: [],
    whatsapp_sessions: [{ business_id: 'b1', instance_name: 'inst1', phone_number: '254700000000', status: 'connected' }],
    businesses: [{ business_id: 'b1', name: 'Kitchen & All', currency: 'KES', followup_ai_enabled: false, followup_quiet_start: 21, followup_quiet_end: 7, chat_ai_enabled: false, chat_ai_daily_cap: 0, persona_pack_status: 'ready' }],
    persona_packs: [{ id: 'p1', business_id: 'b1', version: 1, is_active: true, pack: { persona: 'Warm and short.', objection_playbook: 'Offer a smaller size.', customer_profiles: ['x'] } }],
    ...seed,
  });
  const store = fakeStore();
  const agent = createAgent({ supabase: db, store, canAfford: async () => afford, now: () => NOW, env: { PORT: '1' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const ctx = agent.makeCtx({ businessId: 'b1', userId: 'u1', token: 't', conversationId: 'c1' });
  const tool = (name) => agent.registry.byName.get(name);
  return { db, store, agent, ctx, tool, propose: (name, args) => agent.engine.propose(ctx, tool(name), args), read: (name, args = {}) => tool(name).run(ctx, args) };
}

const seedLeads = () => ({
  v_lead_summary: [
    lead(1, { name: 'Amina', intent_score: 9, last_seen: ago(1), product_interests: ['Braids'], objection_tags: ['price'] }),
    lead(2, { name: 'Brian', intent_score: 3, last_seen: ago(30), lead_state: 'stalled', product_interests: ['Wigs'] }),
    lead(3, { name: 'Cate', intent_score: 8, last_seen: ago(3), product_interests: ['Braids'], do_not_contact: true }),
    lead(4, { name: 'Dan', lead_type: 'personal' }),
    lead(5, { name: 'Esther', intent_score: 7, last_seen: ago(2), awaiting_business_reply: true, product_interests: ['braids kit'] }),
  ],
  contacts: [1, 2, 3, 4, 5].map((id) => ({ id, business_id: 'b1', name: `Lead ${id}`, lead_state: 'engaged' })),
});

// ── registry ────────────────────────────────────────────────────────────────
test('registry: unique names, labels for every change tool, abilities cover every area, schemas are objects', () => {
  const { agent } = setup();
  const names = agent.registry.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  const areas = new Set(agent.registry.tools.filter((t) => t.kind === 'propose' && t.area !== 'analysis').map((t) => t.area));
  for (const area of areas) assert.ok(ABILITIES[area], `no ability text for ${area}`);
  for (const t of agent.registry.modelTools()) { assert.equal(t.parameters.type, 'object'); assert.ok(t.description.length > 20, t.name); }
  for (const name of ['launch_campaign', 'resume_campaign', 'edit_campaign', 'activate_auto_campaign', 'set_auto_campaign', 'approve_followups', 'update_persona', 'set_chat_ai', 'set_followup_settings', 'save_flow']) {
    assert.equal(agent.registry.byName.get(name).risk, 'critical', `${name} must be critical`);
  }
  // nothing the owner said the assistant must not do
  for (const banned of ['delete_lead', 'delete_list', 'delete_campaign', 'disconnect_whatsapp', 'top_up', 'send_message', 'send_whatsapp']) assert.ok(!names.includes(banned), banned);
});

// ── engine ──────────────────────────────────────────────────────────────────
test('a change waits for the owner, runs once on approve, and double-tap is safe', async () => {
  const t = setup(seedLeads());
  const { action, auto } = await t.propose('create_list', { name: 'Braids fans', lead_ids: [1, 5] });
  assert.equal(auto, false);
  assert.equal(action.status, 'pending');
  assert.equal(t.db.tables.lists.length, 0, 'nothing is created before approval');

  const first = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(first.action.status, 'done');
  assert.equal(first.action.approval, 'owner');
  assert.equal(first.action.approved_by, 'u1');
  assert.match(first.action.summary, /2 people/);
  assert.equal(t.db.tables.lists.length, 1);
  assert.equal(t.db.tables.lists[0].created_via, 'assistant');
  assert.equal(t.db.tables.lists[0].ba_action_id, action.id);
  assert.equal(t.db.tables.list_members.length, 2);

  const again = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(again.already, true);
  assert.equal(t.db.tables.lists.length, 1, 'second tap does not run it again');
});

test('another business cannot approve, reject or undo my action', async () => {
  const t = setup(seedLeads());
  const { action } = await t.propose('create_list', { name: 'Mine', lead_ids: [1] });
  const other = t.agent.makeCtx({ businessId: 'b2', userId: 'u9', token: 'x' });
  await assert.rejects(() => t.agent.engine.approve(other, action.id), (e) => e instanceof ActionError && e.code === 'action_not_found');
  await assert.rejects(() => t.agent.engine.reject(other, action.id), (e) => e.code === 'action_not_found');
  assert.equal(t.db.tables.lists.length, 0);
});

test('reject closes it without changing anything', async () => {
  const t = setup(seedLeads());
  const { action } = await t.propose('create_list', { name: 'No thanks', lead_ids: [1] });
  const out = await t.agent.engine.reject(t.ctx, action.id);
  assert.equal(out.action.status, 'rejected');
  assert.equal(t.db.tables.lists.length, 0);
  await assert.rejects(() => t.agent.engine.approve(t.ctx, action.id), (e) => e.code === 'not_pending');
});

test('always allow runs normal actions at once, but never critical ones', async () => {
  const t = setup(seedLeads());
  await t.agent.engine.setAlwaysAllow('b1', 'create_list', true);
  const auto = await t.propose('create_list', { name: 'Auto made', lead_ids: [1] });
  assert.equal(auto.auto, true);
  assert.equal(auto.action.status, 'done');
  assert.equal(auto.action.approval, 'always_allow');
  assert.equal(auto.action.approved_by ?? null, null);

  await assert.rejects(() => t.agent.engine.setAlwaysAllow('b1', 'launch_campaign', true), (e) => e.code === 'critical');
  // even if a row sneaks into the table, critical actions still wait
  t.store.db.actionPrefs.push({ business_id: 'b1', action_type: 'set_chat_ai', always_allow: true });
  const crit = await t.propose('set_chat_ai', { enabled: true, daily_cap: 20 });
  assert.equal(crit.auto, false);
  assert.equal(crit.action.status, 'pending');
  assert.equal(t.db.tables.businesses[0].chat_ai_enabled, false);
});

test('an expired request cannot be approved', async () => {
  const t = setup(seedLeads());
  const { action } = await t.propose('create_list', { name: 'Old news', lead_ids: [1] });
  t.store.db.actions[0].expires_at = new Date(NOW.getTime() - 1000).toISOString();
  await assert.rejects(() => t.agent.engine.approve(t.ctx, action.id), (e) => e.code === 'expired');
  assert.equal(t.db.tables.lists.length, 0);
});

test('a failure is recorded in plain words and leaves nothing half-made', async () => {
  const t = setup(seedLeads());
  const { action } = await t.propose('create_list', { name: 'Will fail', lead_ids: [1, 2] });
  t.db.state.failOn = (table, op) => (table === 'list_members' && op === 'insert' ? 'boom: secret db detail' : null);
  const out = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(out.action.status, 'failed');
  assert.doesNotMatch(out.action.summary, /boom|secret|db/i);
  assert.equal(t.db.tables.lists.length, 0, 'the empty list was cleaned up');
});

test('undo puts a list change back, once', async () => {
  const t = setup(seedLeads());
  const { action } = await t.propose('create_list', { name: 'Temp', lead_ids: [1, 2] });
  await t.agent.engine.approve(t.ctx, action.id);
  const out = await t.agent.engine.undo(t.ctx, action.id);
  assert.equal(out.action.status, 'undone');
  assert.equal(t.db.tables.lists.length, 0);
  await assert.rejects(() => t.agent.engine.undo(t.ctx, action.id), (e) => e.code === 'not_undoable');
});

// ── finding people and making lists ─────────────────────────────────────────
test('search_leads: criteria combine, opted-out and personal chats are left out, result id is reusable', async () => {
  const t = setup(seedLeads());
  const r = await t.read('search_leads', { interested_in: 'braids', min_intent: 7 });
  assert.equal(r.count, 2);                       // Amina + Esther (Cate opted out)
  assert.equal(r.left_out_opted_out, 1);
  assert.deepEqual(r.examples.map((e) => e.name).sort(), ['Amina', 'Esther']);
  assert.ok(r.search_id);
  assert.ok(!JSON.stringify(r).includes('254'), 'no phone numbers go to the model');

  const quiet = await t.read('search_leads', { quiet_days_min: 14 });
  assert.deepEqual(quiet.examples.map((e) => e.name), ['Brian']);
  const waiting = await t.read('search_leads', { waiting_for_reply: true });
  assert.deepEqual(waiting.examples.map((e) => e.name), ['Esther']);
  const none = await t.read('search_leads', { objection: 'delivery' });
  assert.equal(none.count, 0);
  assert.equal(none.search_id, null);
});

test('create_list from a search: only that business can use the search, name clashes are refused', async () => {
  const t = setup(seedLeads());
  const r = await t.read('search_leads', { interested_in: 'braids' });
  const { action } = await t.propose('create_list', { name: 'Braids interest', search_id: r.search_id });
  assert.match(action.preview.headline, /2 people/);
  await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(t.db.tables.list_members.length, 2);

  await assert.rejects(() => t.propose('create_list', { name: 'braids interest', search_id: r.search_id }), /already have a list/);
  const other = t.agent.makeCtx({ businessId: 'b2', userId: 'u2', token: 'x' });
  await assert.rejects(() => t.tool('create_list').plan(other, { name: 'Steal', search_id: r.search_id }), /expired/);
});

test('update_leads refuses "won" (use mark_as_bought) and undo restores states', async () => {
  const t = setup(seedLeads());
  await assert.rejects(() => t.propose('update_leads', { lead_ids: [1], state: 'won' }), /mark_as_bought/);
  const { action } = await t.propose('update_leads', { lead_ids: [1, 2], state: 'lost' });
  await t.agent.engine.approve(t.ctx, action.id);
  assert.deepEqual(t.db.tables.contacts.filter((c) => [1, 2].includes(c.id)).map((c) => c.lead_state), ['lost', 'lost']);
  await t.agent.engine.undo(t.ctx, action.id);
  assert.deepEqual(t.db.tables.contacts.filter((c) => [1, 2].includes(c.id)).map((c) => c.lead_state), ['engaged', 'engaged']);
});

// ── campaigns ───────────────────────────────────────────────────────────────
function campaignSeed() {
  return {
    ...seedLeads(),
    lists: [{ id: 'L1', business_id: 'b1', name: 'Braids fans', type: 'manual', archived: false }],
    list_members: [1, 2, 3, 5].map((id) => ({ list_id: 'L1', lead_id: id })),
    campaigns: [{ id: 'old', business_id: 'b1', status: 'active', name: 'Running' }],
    campaign_enrollments: [{ campaign_id: 'old', lead_id: 5, status: 'active' }],
  };
}
const STEPS = [{ content: 'Hi {{first_name}}, the braids kit is back. Want one?' }, { content: 'Still keen? I can hold one for you.', delay_hours: 48 }];

test('launch_campaign: preview leaves out opted-out and busy people; nothing sends until OK; stamps are written', async () => {
  const t = setup(campaignSeed());
  const { action } = await t.propose('launch_campaign', { name: 'Braids restock', list_ids: ['L1'], steps: STEPS, daily_cap: 2 });
  assert.equal(action.risk, 'critical');
  assert.match(action.preview.headline, /2 people/);          // Amina + Brian (Cate opted out, Esther is in another campaign)
  const text = action.preview.lines.join(' ');
  assert.match(text, /opted out/);
  assert.match(text, /already in another running campaign/);
  assert.match(text, /about 1 day/);
  assert.equal(action.preview.messages.length, 2);
  assert.equal(t.db.tables.campaigns.length, 1, 'no campaign yet');

  await t.agent.engine.approve(t.ctx, action.id);
  const c = t.db.tables.campaigns.find((x) => x.name === 'Braids restock');
  assert.equal(c.status, 'active');
  assert.equal(c.created_via, 'assistant');
  assert.equal(c.ba_action_id, action.id);
  assert.equal(c.whatsapp_instance_name, 'inst1');
  assert.equal(c.ai_rewrite_enabled, true);
  assert.equal(c.auto_approve, false, 'sends only after the owner approves each message, by default');
  assert.equal(t.db.tables.campaign_steps.filter((s) => s.campaign_id === c.id).length, 2);
  assert.deepEqual(t.db.tables.campaign_enrollments.filter((e) => e.campaign_id === c.id).map((e) => e.lead_id).sort(), [1, 2]);
});

test('launch_campaign: guards (no WhatsApp, empty balance, long message, nobody left, archived list)', async () => {
  const noWa = setup({ ...campaignSeed(), whatsapp_sessions: [] });
  await assert.rejects(() => noWa.propose('launch_campaign', { name: 'X1', list_ids: ['L1'], steps: STEPS }), /WhatsApp is not connected/);

  const broke = setup(campaignSeed(), { afford: false });
  await assert.rejects(() => broke.propose('launch_campaign', { name: 'X2', list_ids: ['L1'], steps: STEPS }), /balance is empty/);

  const t = setup(campaignSeed());
  await assert.rejects(() => t.propose('launch_campaign', { name: 'X3', list_ids: ['L1'], steps: [{ content: 'a'.repeat(1001) }] }), /too long/);
  await assert.rejects(() => t.propose('launch_campaign', { name: 'X4', list_ids: ['L1'], steps: [] }), /at least one message/);
  await assert.rejects(() => t.propose('launch_campaign', { name: 'X5', list_ids: ['nope'], steps: STEPS }), /not found/);
  t.db.tables.lists[0].archived = true;
  await assert.rejects(() => t.propose('launch_campaign', { name: 'X6', list_ids: ['L1'], steps: STEPS }), /archived/);
});

test('launch_campaign: re-checks at approval time (someone joined another campaign meanwhile)', async () => {
  const t = setup(campaignSeed());
  const { action } = await t.propose('launch_campaign', { name: 'Late check', list_ids: ['L1'], steps: STEPS });
  t.db.tables.campaign_enrollments.push({ campaign_id: 'old', lead_id: 1, status: 'active' }, { campaign_id: 'old', lead_id: 2, status: 'active' });
  const out = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(out.action.status, 'failed');
  assert.match(out.action.summary, /Nobody can be messaged/);
  assert.equal(t.db.tables.campaigns.length, 1);
});

test('pause is normal, resume is critical, undo of pause resumes', async () => {
  const t = setup(campaignSeed());
  const p = await t.propose('pause_campaign', { campaign_id: 'old' });
  assert.equal(p.action.risk, 'normal');
  await t.agent.engine.approve(t.ctx, p.action.id);
  assert.equal(t.db.tables.campaigns[0].status, 'paused');
  const r = await t.propose('resume_campaign', { campaign_id: 'old' });
  assert.equal(r.action.risk, 'critical');
  assert.equal(r.auto, false);
});

test('edit_campaign rewrites steps and queued messages, and undo restores them', async () => {
  const t = setup({
    ...campaignSeed(),
    campaign_steps: [{ id: 's1', campaign_id: 'old', step_number: 1, content: 'Old one', delay_hours: 0 }, { id: 's2', campaign_id: 'old', step_number: 2, content: 'Old two', delay_hours: 24 }],
    follow_up_queue: [{ id: 'q1', campaign_id: 'old', campaign_step: 1, status: 'pending', final_message: 'Old one' }],
  });
  const { action } = await t.propose('edit_campaign', { campaign_id: 'old', steps: [{ content: 'Brand new one' }] });
  await t.agent.engine.approve(t.ctx, action.id);
  assert.deepEqual(t.db.tables.campaign_steps.map((s) => s.content), ['Brand new one']);
  assert.equal(t.db.tables.follow_up_queue[0].final_message, 'Brand new one');
  await t.agent.engine.undo(t.ctx, action.id);
  assert.deepEqual(t.db.tables.campaign_steps.map((s) => s.content).sort(), ['Old one', 'Old two']);
});

test('auto campaigns: activation runs as the owner and maps errors to plain words', async () => {
  const t = setup({
    ...campaignSeed(),
    v_auto_campaigns: [{ business_id: 'b1', rule_id: 'hot_inquiries', list_name: 'Hot Inquiries', steps: [{ content: 'Hi!' }], campaign_status: null, ready_count: 12, daily_cap: 40 }],
  });
  const calls = [];
  t.ctx.userRpc = async (name, args) => { calls.push([name, args]); return { data: { ok: true }, error: null }; };
  const { action } = await t.propose('activate_auto_campaign', { rule_id: 'hot_inquiries' });
  assert.match(action.preview.headline, /12 people/);
  const out = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(out.action.status, 'done');
  assert.deepEqual(calls[0], ['activate_auto_campaign', { p_business_id: 'b1', p_rule_id: 'hot_inquiries' }]);

  const t2 = setup({ ...campaignSeed(), v_auto_campaigns: [{ business_id: 'b1', rule_id: 'cold_dormant', list_name: 'Cold', steps: [{ content: 'Hi' }], campaign_status: null }] });
  t2.ctx.userRpc = async () => ({ data: null, error: { message: 'auto_list_not_enabled' } });
  const p = await t2.propose('activate_auto_campaign', { rule_id: 'cold_dormant' });
  const failed = await t2.agent.engine.approve(t2.ctx, p.action.id);
  assert.equal(failed.action.status, 'failed');
  assert.match(failed.action.summary, /Turn on that auto list first/);
});

// ── settings, persona, follow-ups ───────────────────────────────────────────
test('set_followup_settings: validated, shows before and after, undo restores', async () => {
  const t = setup();
  await assert.rejects(() => t.propose('set_followup_settings', { changes: { quiet_start: 30 } }), /0 to 23/);
  await assert.rejects(() => t.propose('set_followup_settings', { changes: { nonsense: 1 } }), /not a follow-up setting/);
  await assert.rejects(() => t.propose('set_followup_settings', { changes: { zone_recent_days: 30, zone_medium_days: 10 } }), /fewer/);
  const { action } = await t.propose('set_followup_settings', { changes: { quiet_start: 22, followup_enabled: true } });
  assert.equal(action.risk, 'critical');
  const q = action.preview.changes.find((c) => /Quiet/.test(c.label));
  assert.deepEqual([q.from, q.to], ['21', '22']);
  await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(t.db.tables.businesses[0].followup_quiet_start, 22);
  assert.equal(t.db.tables.businesses[0].followup_ai_enabled, true);
  await t.agent.engine.undo(t.ctx, action.id);
  assert.equal(t.db.tables.businesses[0].followup_quiet_start, 21);
  assert.equal(t.db.tables.businesses[0].followup_ai_enabled, false);
});

test('set_chat_ai: will not switch on without a daily limit or a ready persona pack', async () => {
  const t = setup();
  await assert.rejects(() => t.propose('set_chat_ai', { enabled: true }), /daily limit above 0/);
  t.db.tables.businesses[0].persona_pack_status = 'pending';
  await assert.rejects(() => t.propose('set_chat_ai', { enabled: true, daily_cap: 20 }), /persona pack is not ready/);
  t.db.tables.businesses[0].persona_pack_status = 'ready';
  const { action } = await t.propose('set_chat_ai', { enabled: true, daily_cap: 20 });
  await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(t.db.tables.businesses[0].chat_ai_enabled, true);
});

test('update_persona: saves a new version, keeps the old, protects generated sections, undo restores', async () => {
  const t = setup();
  const read = await t.read('get_persona');
  assert.ok(!read.sections.some((s) => s.name === 'customer_profiles'));
  await assert.rejects(() => t.propose('update_persona', { section: 'customer_profiles', content: 'x'.repeat(10) }), /real chats/);
  await assert.rejects(() => t.propose('update_persona', { section: 'Bad Name', content: 'something long enough' }), /lowercase/);

  const { action } = await t.propose('update_persona', { section: 'delivery_rules', content: 'Delivery within Nairobi is free over KES 3,000.' });
  assert.equal(action.risk, 'critical');
  assert.match(action.preview.headline, /New section/);
  await t.agent.engine.approve(t.ctx, action.id);
  const packs = t.db.tables.persona_packs;
  assert.equal(packs.length, 2);
  assert.equal(packs.filter((p) => p.is_active).length, 1);
  assert.equal(packs.find((p) => p.is_active).version, 2);
  assert.equal(packs.find((p) => p.is_active).generated_by, 'ask_heysasa');
  assert.equal(packs.find((p) => p.is_active).pack.persona, 'Warm and short.', 'other sections untouched');

  await t.agent.engine.undo(t.ctx, action.id);
  const active = t.db.tables.persona_packs.find((p) => p.is_active);
  assert.equal(active.version, 3);
  assert.ok(!('delivery_rules' in active.pack));
});

test('update_persona refuses to overwrite a pack that changed since the card was made', async () => {
  const t = setup();
  const { action } = await t.propose('update_persona', { section: 'persona', content: 'Friendly and brief, Swahili mixed in.' });
  t.db.tables.persona_packs[0].is_active = false;
  t.db.tables.persona_packs.push({ id: 'p2', business_id: 'b1', version: 2, is_active: true, pack: { persona: 'Someone else edited this.' } });
  const out = await t.agent.engine.approve(t.ctx, action.id);
  assert.equal(out.action.status, 'failed');
  assert.match(out.action.summary, /changed since/);
});

test('approve_followups only touches messages that are awaiting approval, uses the business channel', async () => {
  const t = setup({
    follow_up_queue: [
      { id: 'a', business_id: 'b1', contact_id: 1, approval_status: 'awaiting_approval', status: 'pending', draft_message: 'Hi Amina!', scheduled_at: ago(0) },
      { id: 'b', business_id: 'b1', contact_id: 2, approval_status: 'approved', status: 'sent', draft_message: 'Old', scheduled_at: ago(1) },
    ],
    contacts: [{ id: 1, business_id: 'b1', name: 'Amina' }, { id: 2, business_id: 'b1', name: 'Brian' }],
    businesses: [{ business_id: 'b1', whatsapp_channel: 'baileys', name: 'K' }],
  });
  const waiting = await t.read('get_followup_approvals');
  assert.equal(waiting.waiting, 1);
  await assert.rejects(() => t.propose('approve_followups', { item_ids: ['b'] }), /no longer waiting/);
  const { action } = await t.propose('approve_followups', { item_ids: ['a'], edits: [{ id: 'a', text: 'Hi Amina, still keen?' }] });
  assert.equal(action.risk, 'critical');
  assert.equal(action.preview.messages[0].text, 'Hi Amina, still keen?');
  await t.agent.engine.approve(t.ctx, action.id);
  const row = t.db.tables.follow_up_queue.find((q) => q.id === 'a');
  assert.deepEqual([row.status, row.approval_status, row.channel, row.final_message], ['ready_to_send', 'approved', 'baileys', 'Hi Amina, still keen?']);
});

// ── products, analytics, snapshot, guide ────────────────────────────────────
test('change_products approves and undo restores', async () => {
  const t = setup({ products: [{ id: 'p1', business_id: 'b1', title: 'Braids kit', status: 'discovered', ai_visible: false }, { id: 'p2', business_id: 'b1', title: 'Wig', status: 'discovered', ai_visible: false }] });
  const { action } = await t.propose('change_products', { product_ids: ['p1', 'p2'], action: 'approve' });
  await t.agent.engine.approve(t.ctx, action.id);
  assert.deepEqual(t.db.tables.products.map((p) => [p.status, p.ai_visible]), [['approved', true], ['approved', true]]);
  await t.agent.engine.undo(t.ctx, action.id);
  assert.deepEqual(t.db.tables.products.map((p) => [p.status, p.ai_visible]), [['discovered', false], ['discovered', false]]);
  await assert.rejects(() => t.propose('change_products', { product_ids: ['p1'], action: 'delete' }), /do not know that action/);
});

test('analytics: every metric carries what it means and why it matters; explain_metric works', async () => {
  const t = setup(seedLeads());
  const r = await t.read('get_analytics', { section: 'overview' });
  assert.ok(r.metrics.length >= 6);
  for (const m of r.metrics) { assert.ok(m.meaning && m.why_it_matters, m.key); }
  assert.equal(r.metrics.find((m) => m.key === 'total_leads').value, 4);   // personal chat left out
  const e = await t.read('explain_metric', { metric: 'win rate' });
  assert.match(e.why_it_matters, /own past/);
  await assert.rejects(() => t.read('get_analytics', { section: 'nope' }), /Sections are/);
});

test('snapshot: the next setup step is the first one not done', async () => {
  const t = setup({
    ...seedLeads(), whatsapp_sessions: [], segmentation_rules: [], v_auto_campaigns: [], v_campaign_summary: [], products: [], follow_up_queue: [], v_list_summary: [], business_balances: [{ business_id: 'b1', balance_usd: 4.25 }],
  });
  const s = await t.read('get_business_snapshot');
  assert.equal(s.setup.next_step.key, 'whatsapp');
  assert.equal(s.setup.next_step.can_do_myself, false);
  t.db.tables.whatsapp_sessions.push({ business_id: 'b1', instance_name: 'i', status: 'connected' });
  const s2 = await t.read('get_business_snapshot');
  assert.equal(s2.setup.next_step.key, 'chats_studied');
  assert.equal(s2.balance_usd, 4.3);
});

test('guide_user tells the dashboard where to go, including for things the assistant never does', async () => {
  const t = setup();
  const events = [];
  t.ctx.emit = (e) => events.push(e);
  const r = await t.read('guide_user', { place: 'top_up' });
  assert.equal(r.shown, true);
  assert.deepEqual(events[0].nav, { tab: 'preferences', section: 'billing' });
  await t.read('guide_user', { place: 'delete_lead' });
  assert.equal(events[1].nav.tab, 'leads');
});
