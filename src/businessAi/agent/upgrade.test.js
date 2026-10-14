// Tests for the Oct 14 upgrade: reading leads and chats, analytics by period, opt-out sync, flows and skills, and the fixes from the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from './index.js';
import { fakeDb } from './fakeDb.js';
import { fakeStore } from '../fakes.js';
import { messageText } from './helpers.js';
import { resolvePeriod } from './domains/analytics.js';

const NOW = new Date('2026-10-07T10:00:00Z'); // a Wednesday, 13:00 in Nairobi
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const lead = (id, over = {}) => ({ id, business_id: 'b1', name: `Lead ${id}`, lead_state: 'engaged', lead_type: 'business', is_ad_lead: false, intent_score: 5, last_seen: ago(2), unread_count: 0, product_interests: [], objection_tags: [], do_not_contact: false, ...over });

function setup(seed = {}) {
  const db = fakeDb({
    v_lead_summary: [], contacts: [], lists: [], list_members: [], campaigns: [], campaign_steps: [], campaign_enrollments: [], follow_up_queue: [], messages: [],
    whatsapp_sessions: [{ business_id: 'b1', instance_name: 'inst1', phone_number: '254700000000', status: 'connected' }],
    businesses: [{ business_id: 'b1', name: 'Kitchen & All', currency: 'KES', timezone: 'Africa/Nairobi', followup_ai_enabled: false, chat_ai_enabled: false, chat_ai_daily_cap: 0, persona_pack_status: 'ready' }],
    persona_packs: [{ id: 'p1', business_id: 'b1', version: 1, is_active: true, pack: { persona: 'Warm and short. Says karibu.', objection_playbook: 'Offer a smaller size.', customer_profiles: ['x'] } }],
    ...seed,
  });
  const store = fakeStore({ now: () => NOW });
  const agent = createAgent({ supabase: db, store, canAfford: async () => true, now: () => NOW, env: { PORT: '1' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const ctx = agent.makeCtx({ businessId: 'b1', userId: 'u1', token: 't', conversationId: 'c1' });
  const tool = (name) => agent.registry.byName.get(name);
  return { db, store, agent, ctx, tool, propose: (name, args) => agent.engine.propose(ctx, tool(name), args), read: (name, args = {}) => tool(name).run(ctx, args), approve: (id) => agent.engine.approve(ctx, id) };
}

// ── helpers ─────────────────────────────────────────────────────────────────
test('messageText turns every kind of stored message into readable text', () => {
  assert.equal(messageText({ text: 'Hi there' }), 'Hi there');
  assert.equal(messageText('{"text":"from a string"}'), 'from a string');
  assert.equal(messageText({ type: 'image', media_url: 'x', caption: 'my pic' }), 'my pic');
  assert.equal(messageText({ type: 'image', media_url: 'x' }), '[image]');
  assert.equal(messageText({ title: 'Braids kit', price: 1500, product_id: 'p1' }), '[product: Braids kit, 1500]');
  assert.equal(messageText({ file_name: 'receipt.pdf' }), '[file: receipt.pdf]');
  assert.equal(messageText(null), '');
  assert.equal(messageText({ text: 'x'.repeat(900) }, 50).length, 50);
});

// ── registry ────────────────────────────────────────────────────────────────
test('registry: new tools exist, prices are critical, and no schema is sent as strict', () => {
  const { agent } = setup();
  for (const n of ['lead_breakdown', 'get_campaign_people', 'get_flow', 'get_chat_skill', 'create_chat_skill']) assert.ok(agent.registry.byName.has(n), n);
  assert.equal(agent.registry.byName.get('edit_product').risk, 'critical');
  assert.equal(agent.registry.byName.get('create_chat_skill').risk, 'critical');
  assert.ok(agent.registry.modelTools().every((t) => t.strict === false));
  assert.ok(agent.registry.allowable().find((a) => a.type === 'create_chat_skill').critical);
});

// ── leads ───────────────────────────────────────────────────────────────────
const richLeads = () => ({
  v_assistant_leads: [
    lead(1, { name: 'Amina', phone: '254711000111', intent_score: 9, last_seen: ago(1), first_seen_at: ago(1), awaiting_reply: true, product_interests: ['Braids'], objection_tags: ['price'] }),
    lead(2, { name: 'Brian', phone: '254722000222', intent_score: 3, last_seen: ago(30), first_seen_at: ago(60), lead_state: 'stalled', product_interests: ['Wigs'] }),
    lead(3, { name: 'Cate', intent_score: 8, last_seen: ago(3), first_seen_at: ago(10), do_not_contact: true, product_interests: ['Braids'] }),
    lead(4, { name: 'Dan', lead_type: 'vendor', first_seen_at: ago(5) }),
    lead(5, { name: 'Esther', phone: '254733000333', intent_score: 7, last_seen: ago(2), first_seen_at: ago(3), product_interests: ['braids kit'], objection_tags: ['price', 'delivery'] }),
    lead(6, { name: 'Faith', lead_type: 'junk', first_seen_at: ago(2) }),
  ],
  contacts: [1, 2, 3, 4, 5, 6].map((id) => ({ id, business_id: 'b1', name: `Lead ${id}`, lead_state: 'engaged', do_not_contact: id === 3 })),
});

test('search_leads: vendors and junk are left out, waiting uses awaiting_reply, sorting and paging work', async () => {
  const t = setup(richLeads());
  const all = await t.read('search_leads', {});
  assert.equal(all.count, 3);                       // Amina, Brian, Esther (Cate opted out, Dan vendor, Faith junk)
  assert.equal(all.left_out_opted_out, 1);
  const waiting = await t.read('search_leads', { waiting_for_reply: true });
  assert.deepEqual(waiting.examples.map((e) => e.name), ['Amina']);
  const byInterest = await t.read('search_leads', { sort_by: 'interest', limit: 2 });
  assert.deepEqual(byInterest.examples.map((e) => e.name), ['Amina', 'Esther']);
  const page2 = await t.read('search_leads', { sort_by: 'interest', limit: 2, offset: 2 });
  assert.deepEqual(page2.examples.map((e) => e.name), ['Brian']);
  assert.equal(page2.showing.from, 3);
  const quiet = await t.read('search_leads', { sort_by: 'quietest', limit: 1 });
  assert.equal(quiet.examples[0].name, 'Brian');
  const withVendors = await t.read('search_leads', { include_non_customers: true });
  assert.equal(withVendors.count, 5);
});

test('search_leads: date range, phone and text search', async () => {
  const t = setup(richLeads());
  const recent = await t.read('search_leads', { created_after: ago(4).slice(0, 10) });
  assert.deepEqual(recent.examples.map((e) => e.name).sort(), ['Amina', 'Esther']);
  const phone = await t.read('search_leads', { search: '722000' });
  assert.deepEqual(phone.examples.map((e) => e.name), ['Brian']);
  const name = await t.read('search_leads', { search: 'esth' });
  assert.equal(name.count, 1);
});

test('search_leads still works before the view migration is run (falls back to v_lead_summary)', async () => {
  const t = setup({ v_lead_summary: [lead(1, { name: 'Amina', awaiting_business_reply: true }), lead(2, { name: 'Brian', unread_count: 2 }), lead(3, { name: 'Cate' })] });
  const r = await t.read('search_leads', { waiting_for_reply: true });
  assert.deepEqual(r.examples.map((e) => e.name).sort(), ['Amina', 'Brian']);
});

test('lead_breakdown counts a group by what they want, their worries and their state', async () => {
  const t = setup(richLeads());
  const products = await t.read('lead_breakdown', { group_by: 'product_interest' });
  assert.equal(products.total_people, 3);
  assert.deepEqual(products.groups.map((g) => g.name).sort(), ['braids', 'braids kit', 'wigs']);
  const worries = await t.read('lead_breakdown', { group_by: 'objection', min_intent: 5 });
  assert.equal(worries.groups[0].name, 'price');
  assert.equal(worries.groups[0].people, 2);
  assert.equal(worries.groups[0].share_percent, 100);
  await assert.rejects(() => t.read('lead_breakdown', { group_by: 'nope' }), /group_by must be one of/);
});

test('get_lead reads the real chat (messages are JSON), lists, campaigns, and pages back', async () => {
  const t = setup({
    ...richLeads(),
    messages: [
      { business_id: 'b1', contact_id: 1, direction: 'in', content: { text: 'How much is the braids kit?' }, created_at: ago(1) },
      { business_id: 'b1', contact_id: 1, direction: 'out', content: { text: 'It is KES 1,500.' }, created_at: ago(0.9) },
      { business_id: 'b1', contact_id: 1, direction: 'in', content: { type: 'image', media_url: 'u', caption: 'this one?' }, created_at: ago(0.8) },
      { business_id: 'b1', contact_id: 1, direction: 'in', content: { text: 'older message' }, created_at: ago(5) },
    ],
    lists: [{ id: 'l1', business_id: 'b1', name: 'Hot people', type: 'manual' }],
    list_members: [{ list_id: 'l1', lead_id: 1 }],
    campaigns: [{ id: 'c1', business_id: 'b1', name: 'October nudge', status: 'active' }],
    campaign_enrollments: [{ campaign_id: 'c1', lead_id: 1, status: 'active', current_step: 1 }],
  });
  const r = await t.read('get_lead', { lead_id: 1, messages: 3 });
  assert.deepEqual(r.untrusted_recent_messages.map((m) => m.text), ['How much is the braids kit?', 'It is KES 1,500.', 'this one?']);
  assert.deepEqual(r.untrusted_recent_messages.map((m) => m.from), ['customer', 'business', 'customer']);
  assert.ok(!JSON.stringify(r).includes('[object Object]'));
  assert.equal(r.waiting_for_reply, true);
  assert.equal(r.phone, '254711000111');
  assert.deepEqual(r.in_lists.map((l) => l.name), ['Hot people']);
  assert.deepEqual(r.in_campaigns.map((c) => c.name), ['October nudge']);
  assert.ok(r.chat.older_than_hint);
  const older = await t.read('get_lead', { lead_id: 1, messages: 10, older_than: ago(2) });
  assert.deepEqual(older.untrusted_recent_messages.map((m) => m.text), ['older message']);
  const none = await t.read('get_lead', { lead_id: 1, messages: 0 });
  assert.deepEqual(none.untrusted_recent_messages, []);
  await assert.rejects(() => t.read('get_lead', { lead_id: 999 }), /could not find that lead/);
});

// ── opt-out sync ────────────────────────────────────────────────────────────
test('marking someone do_not_contact really opts them out: flags set, campaigns left, undo restores flags', async () => {
  const t = setup({
    ...richLeads(),
    campaign_enrollments: [{ id: 'e1', campaign_id: 'c1', lead_id: 1, status: 'active' }, { id: 'e2', campaign_id: 'c1', lead_id: 5, status: 'active' }],
    campaign_step_events: [{ enrollment_id: 'e1', opted_out_at: null }],
  });
  const { action } = await t.propose('update_leads', { lead_ids: [1], state: 'do_not_contact' });
  assert.match(action.preview.lines.join(' '), /no more messages/);
  const done = await t.approve(action.id);
  assert.equal(done.action.status, 'done');
  const c1 = t.db.tables.contacts.find((c) => c.id === 1);
  assert.equal(c1.do_not_contact, true);
  assert.equal(c1.lead_state, 'do_not_contact');
  assert.ok(c1.follow_up_opted_out_at);
  assert.equal(t.db.tables.campaign_enrollments.find((e) => e.id === 'e1').status, 'completed');
  assert.equal(t.db.tables.campaign_enrollments.find((e) => e.id === 'e2').status, 'active', 'other people are untouched');
  assert.ok(t.db.tables.campaign_step_events[0].opted_out_at);

  await t.agent.engine.undo(t.ctx, action.id);
  const back = t.db.tables.contacts.find((c) => c.id === 1);
  assert.equal(back.do_not_contact, false);
  assert.equal(back.lead_state, 'engaged');
});

test('someone who asked not to be contacted is never moved back by the assistant', async () => {
  const t = setup(richLeads());
  await assert.rejects(() => t.propose('update_leads', { lead_ids: [3], state: 'warm' }), /asked not to be contacted/);
  const mixed = await t.propose('update_leads', { lead_ids: [3, 5], state: 'warm' });
  assert.deepEqual(mixed.action.params.ids, [5]);
  assert.match(mixed.action.preview.lines.join(' '), /Left alone: 1 person/);
});

// ── analytics ───────────────────────────────────────────────────────────────
test('resolvePeriod: Nairobi days, Monday weeks, calendar months, and equal-length earlier windows', () => {
  const today = resolvePeriod('today', NOW, 'Africa/Nairobi');
  assert.equal(today.start.toISOString(), '2026-10-06T21:00:00.000Z');
  assert.equal(today.prevStart.toISOString(), '2026-10-05T21:00:00.000Z');
  assert.equal(today.prevEnd.toISOString(), '2026-10-06T10:00:00.000Z');   // the same 13 hours of yesterday
  const week = resolvePeriod('this_week', NOW, 'Africa/Nairobi');
  assert.equal(week.start.toISOString(), '2026-10-04T21:00:00.000Z');       // Monday 5 Oct 00:00 EAT
  const last = resolvePeriod('last_month', NOW, 'Africa/Nairobi');
  assert.equal(last.start.toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(last.end.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(last.prevStart.toISOString(), '2026-07-31T21:00:00.000Z');
  const yesterday = resolvePeriod('yesterday', NOW, 'Africa/Nairobi');
  assert.equal(yesterday.end.toISOString(), today.start.toISOString());
  assert.equal(resolvePeriod('all_time'), null);
  assert.equal(resolvePeriod(undefined), null);
  assert.throws(() => resolvePeriod('next_year'), /period must be one of/);
});

test('analytics overview by period shows the change versus the earlier period, and hides it with no earlier data', async () => {
  const t = setup({
    v_assistant_leads: [
      lead(1, { first_seen_at: '2026-10-05T08:00:00Z', lead_state: 'won', deal_value: 3000, purchase_date: '2026-10-06T08:00:00Z' }),
      lead(2, { first_seen_at: '2026-10-06T08:00:00Z' }),
      lead(3, { first_seen_at: '2026-10-07T06:00:00Z' }),
      lead(4, { first_seen_at: '2026-09-28T08:00:00Z' }),
    ],
    messages: [
      ...[0, 1, 2, 3].map((i) => ({ business_id: 'b1', direction: 'in', created_at: `2026-10-0${5 + (i % 2)}T0${i}:00:00Z` })),
      { business_id: 'b1', direction: 'in', created_at: '2026-09-29T08:00:00Z' },
      { business_id: 'b1', direction: 'out', created_at: '2026-10-06T08:00:00Z' },
    ],
  });
  const r = await t.read('get_analytics', { section: 'overview', period: 'this_week' });
  assert.equal(r.period, 'this week (from Monday)');
  const m = (k) => r.period_metrics.find((x) => x.key === k);
  assert.equal(m('new_leads').value, 3);
  assert.equal(m('new_leads').change_vs_earlier.earlier_value, 1);
  assert.equal(m('new_leads').change_vs_earlier.change_percent, 200);
  assert.equal(m('customer_messages').value, 4);
  assert.equal(m('period_sales').value, 1);
  assert.equal(m('period_sales').change_vs_earlier, undefined, 'no sale in the earlier period, so no misleading change');
  assert.match(String(m('period_revenue').value), /3,000/);
  for (const x of r.period_metrics) assert.ok(x.meaning && x.why_it_matters);

  const snapshotOnly = await t.read('get_analytics', { section: 'overview' });
  assert.equal(snapshotOnly.period_metrics, undefined);
  await assert.rejects(() => t.read('get_analytics', { section: 'overview', period: 'someday' }), /period must be one of/);
});

test('analytics funnel: stages, hot/warm/cold, and a possible value from approved prices', async () => {
  const t = setup({
    ...richLeads(),
    products: [{ id: 'p1', business_id: 'b1', title: 'Braids kit', price: 1500, status: 'approved' }, { id: 'p2', business_id: 'b1', title: 'Wig', price: 4000, status: 'discovered' }],
  });
  const r = await t.read('get_analytics', { section: 'funnel' });
  assert.equal(r.details.temperature.hot.people, 2);          // Amina 9, Esther 7 (Cate asked not to be contacted, so she is not a possible sale)
  assert.equal(r.details.temperature.cold.people, 1);          // Brian 3
  assert.equal(r.details.stages.engaged.people >= 1, true);
  assert.match(String(r.metrics[0].value), /KES 1,500|KES 3,000|KES 4,500/);
  assert.equal(r.details.stage_values.stalled.possible_value, undefined, 'Wig is not approved so it has no price');
  const noPrices = setup(richLeads());
  const r2 = await noPrices.read('get_analytics', { section: 'funnel' });
  assert.match(String(r2.metrics[0].value), /unknown/);
});

test('analytics ads: no quality score, last lead date, leads in period', async () => {
  const t = setup({
    v_ad_leaderboard: [{ business_id: 'b1', ad_id: 'ad1', ad_headline: 'Braids for Christmas', ad_platform: 'facebook', lead_count: 8, reply_count: 5, conversion_count: 2, quality_score: 71, reply_rate_pct: 62.5, conversion_rate_pct: 25, updated_at: '2026-09-01T00:00:00Z' }],
    v_assistant_leads: [lead(1, { ad_id: 'ad1', first_seen_at: '2026-10-06T08:00:00Z' }), lead(2, { ad_id: 'ad1', first_seen_at: '2026-09-20T08:00:00Z' })],
  });
  const r = await t.read('get_analytics', { section: 'ads', period: 'this_week' });
  const ad = r.details.top_ads[0];
  assert.equal(ad.last_lead_on, '2026-10-06');
  assert.equal(ad.leads_in_period, 1);
  assert.equal(ad.quality_score, undefined);
  assert.match(r.details.note, /not a list of ads running/);
});

test('analytics market: the biggest worry is whatever it really is, not always price', async () => {
  const t = setup({ v_assistant_leads: [lead(1, { objection_tags: ['delivery'], first_seen_at: ago(1) }), lead(2, { objection_tags: ['delivery', 'quality'], first_seen_at: ago(2) }), lead(3, { objection_tags: ['price'], first_seen_at: ago(3) })] });
  const r = await t.read('get_analytics', { section: 'market' });
  assert.deepEqual(r.metrics.find((m) => m.key === 'top_objection').value, { name: 'delivery', people: 2 });
});

test('analytics timing: busiest hours and a month-by-month view', async () => {
  const msgs = [];
  for (let i = 0; i < 30; i += 1) msgs.push({ business_id: 'b1', direction: 'in', created_at: new Date(NOW.getTime() - (i + 1) * 3_600_000 * 24 + 5 * 60_000).toISOString() });
  for (let i = 0; i < 5; i += 1) msgs.push({ business_id: 'b1', direction: 'in', created_at: `2026-08-1${i}T09:00:00Z` });
  const t = setup({ messages: msgs });
  const r = await t.read('get_analytics', { section: 'timing' });
  const months = r.metrics.find((m) => m.key === 'messages_by_month').value;
  assert.ok(months.some((x) => x.month === '2026-08' && x.messages === 5));
  assert.ok(r.metrics.find((m) => m.key === 'busiest_hours'));
  const thin = setup({ messages: msgs.slice(0, 3) });
  const r2 = await thin.read('get_analytics', { section: 'timing' });
  assert.match(r2.note, /Not enough messages/);
});

test('analytics health: plain checks that say what is wrong', async () => {
  const bad = setup({
    whatsapp_sessions: [], business_balances: [{ business_id: 'b1', balance_usd: 0 }], v_lead_summary: [lead(1)],
    follow_up_queue: [{ business_id: 'b1', status: 'failed', scheduled_at: ago(2) }, { business_id: 'b1', status: 'failed', scheduled_at: ago(3) }, { business_id: 'b1', status: 'sent', scheduled_at: ago(3) }],
    messages: [{ business_id: 'b1', direction: 'in', created_at: ago(12) }],
  });
  const r = await bad.read('get_analytics', { section: 'health' });
  const by = Object.fromEntries(r.details.checks.map((c) => [c.key, c]));
  assert.equal(by.whatsapp.status, 'problem');
  assert.equal(by.balance.status, 'problem');
  assert.equal(by.delivery.status, 'problem');
  assert.equal(by.inbound.status, 'problem');
  assert.equal(r.details.overall, 'needs attention');
  assert.ok(r.details.problems.includes('whatsapp'));
  for (const c of r.details.checks) assert.ok(c.detail.length > 10, c.key);

  const good = setup({ business_balances: [{ business_id: 'b1', balance_usd: 10 }], v_lead_summary: [lead(1, { context_summary: 'wants braids' })], messages: [{ business_id: 'b1', direction: 'in', created_at: ago(0.1) }] });
  const g = await good.read('get_analytics', { section: 'health' });
  assert.equal(g.details.checks.find((c) => c.key === 'whatsapp').status, 'ok');
  assert.equal(g.details.checks.find((c) => c.key === 'approvals').status, 'ok');
});

test('analytics glossary no longer carries invented benchmarks', async () => {
  const t = setup();
  const e = await t.read('explain_metric', { metric: 'reply_rate' });
  assert.doesNotMatch(e.why_it_matters, /10 percent/);
  const n = await t.read('explain_metric', { metric: 'new leads' });
  assert.match(n.meaning, /first time/);
});

// ── persona, campaigns, follow-ups ──────────────────────────────────────────
test('get_persona gives the owner voice in full without a second call', async () => {
  const t = setup();
  const r = await t.read('get_persona');
  assert.match(r.voice, /Says karibu/);
  assert.ok(r.sections.every((s) => s.name !== 'persona' && s.name !== 'customer_profiles'));
});

test('resume_campaign checks nobody is now in another running campaign', async () => {
  const t = setup({
    ...richLeads(),
    campaigns: [{ id: 'c1', business_id: 'b1', name: 'Paused one', status: 'paused' }, { id: 'c2', business_id: 'b1', name: 'Running one', status: 'active' }],
    campaign_enrollments: [{ campaign_id: 'c1', lead_id: 1, status: 'active' }, { campaign_id: 'c2', lead_id: 1, status: 'active' }, { campaign_id: 'c1', lead_id: 5, status: 'active' }],
  });
  await assert.rejects(() => t.propose('resume_campaign', { campaign_id: 'c1' }), /1 person in "Paused one" are now in another running campaign/);
  t.db.tables.campaigns.find((c) => c.id === 'c2').status = 'paused';
  const { action } = await t.propose('resume_campaign', { campaign_id: 'c1' });
  assert.equal(action.status, 'pending', 'resume always waits for the owner');
});

test('get_campaign_people shows who is in a campaign and how far they got', async () => {
  const t = setup({
    ...richLeads(),
    campaigns: [{ id: 'c1', business_id: 'b1', name: 'October nudge', status: 'active' }],
    campaign_enrollments: [{ campaign_id: 'c1', lead_id: 1, status: 'active', current_step: 2, last_reply_at: ago(1) }, { campaign_id: 'c1', lead_id: 5, status: 'completed', current_step: 3 }],
  });
  const r = await t.read('get_campaign_people', { campaign_id: 'c1' });
  assert.equal(r.people_total, 2);
  assert.deepEqual(r.by_status, { active: 1, completed: 1 });
  assert.equal(r.replied, 1);
  const only = await t.read('get_campaign_people', { campaign_id: 'c1', status: 'completed' });
  assert.equal(only.people.length, 1);
});

test('approve_followups card shows every message it will send', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, business_id: 'b1', contact_id: 1, approval_status: 'awaiting_approval', status: 'pending', draft_message: `Hi ${i}`, scheduled_at: ago(0) }));
  const t = setup({ ...richLeads(), follow_up_queue: rows });
  const { action } = await t.propose('approve_followups', { item_ids: rows.map((r) => r.id) });
  assert.equal(action.preview.messages.length, 12);
  assert.equal(action.preview.more, 0);
});

test('edit_product always waits for the owner, even after always-allow on the normal product tools', async () => {
  const t = setup({ products: [{ id: 'p1', business_id: 'b1', title: 'Braids kit', status: 'approved', price: 1500 }] });
  await t.store.setActionPref('b1', 'edit_product', true);
  const { action, auto } = await t.propose('edit_product', { product_id: 'p1', price: 1200 });
  assert.equal(auto, false);
  assert.equal(action.status, 'pending');
  assert.equal(t.db.tables.products[0].price, 1500);
});

// ── flows and skills ────────────────────────────────────────────────────────
const chatAiSeed = () => ({
  chat_flows: [{ id: 'f1', business_id: 'b1', name: 'Braids ad', enabled: true, priority: 100, trigger: { ad_ids: ['ad1'], list_ids: [] }, goal: 'Book a hair appointment', instructions: 'Always ask their hair length first. Then offer the kit.', skill_keys: ['price_questions'] }],
  chat_ai_skills: [{ id: 's1', business_id: 'b1', key: 'price_questions', title: 'Price questions', when_to_use: 'Customer asks the price', instructions: 'Quote the catalog price only.', enabled: true }],
  v_ad_leaderboard: [{ business_id: 'b1', ad_id: 'ad1', ad_headline: 'Braids for Christmas', ad_platform: 'facebook', lead_count: 8 }, { business_id: 'b1', ad_id: 'ad2', ad_headline: 'Wigs sale', ad_platform: 'instagram', lead_count: 3 }],
  lists: [{ id: 'l1', business_id: 'b1', name: 'Hot people', type: 'manual', archived: false }, { id: 'l2', business_id: 'b1', name: 'Old list', type: 'manual', archived: true }],
});

test('get_chat_ai_setup lists what a flow can be pointed at, and get_flow / get_chat_skill read in full', async () => {
  const t = setup(chatAiSeed());
  const setupRead = await t.read('get_chat_ai_setup');
  assert.deepEqual(setupRead.can_point_a_flow_at.ads.map((a) => a.ad_id), ['ad1', 'ad2']);
  assert.deepEqual(setupRead.can_point_a_flow_at.lists.map((l) => l.name), ['Hot people']);
  assert.deepEqual(setupRead.flows[0].applies_to_names.ads, ['Braids for Christmas']);
  const flow = await t.read('get_flow', { flow_id: 'f1' });
  assert.match(flow.instructions, /hair length/);
  assert.deepEqual(flow.applies_to.ads, ['Braids for Christmas']);
  const skill = await t.read('get_chat_skill', { key: 'price_questions' });
  assert.match(skill.instructions, /catalog price/);
  await assert.rejects(() => t.read('get_flow', { flow_id: 'nope' }), /could not find that flow/);
  await assert.rejects(() => t.read('get_chat_skill', { key: 'nope' }), /could not find that skill/);
});

test('save_flow: names the ads in the card, and a flow can be switched off by sending only enabled', async () => {
  const t = setup(chatAiSeed());
  const made = await t.propose('save_flow', { name: 'Wigs flow', goal: 'Sell wigs', instructions: 'Ask the head size first, then show two options.', applies_to: { ad_ids: ['ad2'], list_ids: ['00000000-0000-4000-9000-00000000000a'] } }).catch((e) => e);
  assert.match(String(made.message), /lists was not found/);
  const ok = await t.propose('save_flow', { name: 'Wigs flow', goal: 'Sell wigs', instructions: 'Ask the head size first, then show two options.', applies_to: { ad_ids: ['ad2'] } });
  assert.match(ok.action.preview.lines[0], /ad "Wigs sale"/);
  assert.equal(ok.action.status, 'pending');
  const off = await t.propose('save_flow', { flow_id: 'f1', enabled: false });
  await t.approve(off.action.id);
  assert.equal(t.db.tables.chat_flows.find((f) => f.id === 'f1').enabled, false);
  assert.equal(t.db.tables.chat_flows.find((f) => f.id === 'f1').instructions, 'Always ask their hair length first. Then offer the kit.');
  await assert.rejects(() => t.propose('save_flow', { name: 'No target', instructions: 'Do something useful for them.' }), /apply to something/);
});

test('create_chat_skill: needs an OK, validates, refuses duplicates, and undo switches it off', async () => {
  const t = setup(chatAiSeed());
  const { action, auto } = await t.propose('create_chat_skill', { key: 'discount_requests', title: 'Discount requests', when_to_use: 'A customer asks for a discount', instructions: 'Never promise a discount. Say the owner decides, and offer to ask them.' });
  assert.equal(auto, false);
  assert.equal(t.db.tables.chat_ai_skills.length, 1, 'nothing is added before the OK');
  const done = await t.approve(action.id);
  assert.equal(done.action.status, 'done');
  const added = t.db.tables.chat_ai_skills.find((s) => s.key === 'discount_requests');
  assert.equal(added.enabled, true);
  assert.equal(added.business_id, 'b1');
  await t.agent.engine.undo(t.ctx, action.id);
  assert.equal(t.db.tables.chat_ai_skills.find((s) => s.key === 'discount_requests').enabled, false);
  assert.equal(t.db.tables.chat_ai_skills.length, 2, 'undo keeps the skill, switched off');

  await assert.rejects(() => t.propose('create_chat_skill', { key: 'price_questions', title: 'Dup', when_to_use: 'when asked', instructions: 'Some long enough instructions.' }), /already a skill called/);
  await assert.rejects(() => t.propose('create_chat_skill', { key: 'Bad Key', title: 'Bad', when_to_use: 'when asked', instructions: 'Some long enough instructions.' }), /lowercase letters/);
  await assert.rejects(() => t.propose('create_chat_skill', { key: 'tiny_one', title: 'Tiny', when_to_use: 'when asked', instructions: 'short' }), /between 10 and/);
});
