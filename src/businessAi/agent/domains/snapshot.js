// The business at a glance, and the setup steps that get an owner to value fastest.
import { fetchAll, must, plural, round1 } from '../helpers.js';
import { loadLeads } from './leads.js';

export const SETUP_ORDER = ['whatsapp', 'chats_loaded', 'chats_studied', 'persona', 'products', 'followups', 'auto_lists', 'auto_campaigns', 'chat_ai'];

const SETUP_COPY = {
  whatsapp: { label: 'Connect WhatsApp', why: 'Nothing else works until your business WhatsApp is linked.', where: 'whatsapp', can_do_myself: false },
  chats_loaded: { label: 'Bring in your WhatsApp chats', why: 'HeySasa learns from your past chats. They load by themselves after WhatsApp connects.', where: 'leads', can_do_myself: false },
  chats_studied: { label: 'Study your chats', why: 'This is how HeySasa tells hot leads from cold ones and learns what people ask for.', where: 'leads', can_do_myself: true },
  persona: { label: 'Build your persona pack', why: 'It teaches the AI to talk the way you talk to customers.', where: 'playground', can_do_myself: false },
  products: { label: 'Approve your products', why: 'The AI can only sell what you have approved.', where: 'products', can_do_myself: true },
  followups: { label: 'Turn on follow-ups', why: 'Follow-ups bring back people who went quiet. Sales often come from the second message.', where: 'followup_settings', can_do_myself: true },
  auto_lists: { label: 'Turn on the auto lists', why: 'They sort your leads by themselves (hot, cold, waiting) so you always know who to talk to.', where: 'auto_lists', can_do_myself: true },
  auto_campaigns: { label: 'Start an auto campaign', why: 'It messages the right people at the right time without you lifting a finger.', where: 'auto_lists', can_do_myself: true },
  chat_ai: { label: 'Let the chat AI answer customers', why: 'It replies to customers any hour of the day, so you stop losing people who message at night.', where: 'followup_settings', can_do_myself: true },
};

const count = (rows, pred) => rows.filter(pred).length;

const get_business_snapshot = {
  name: 'get_business_snapshot', area: 'snapshot', kind: 'read', status: 'Looking at your business…',
  description: 'The business at a glance: connection, how many leads, lists, campaigns, products, balance, messages waiting for approval, and the setup steps with which are done and which one comes next. Call this first when the owner is new, asks what to do, or asks how things are going overall.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const [business, sessions, leads, rules, autos, campaigns, products, pending, balance] = await Promise.all([
      ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(),
      ctx.db.from('whatsapp_sessions').select('instance_name, status').eq('business_id', ctx.businessId),
      loadLeads(ctx.db, ctx.businessId),
      ctx.db.from('segmentation_rules').select('rule_id, enabled').eq('business_id', ctx.businessId),
      ctx.db.from('v_auto_campaigns').select('rule_id, campaign_status').eq('business_id', ctx.businessId),
      ctx.db.from('v_campaign_summary').select('campaign_id, status').eq('business_id', ctx.businessId),
      fetchAll((from, to) => ctx.db.from('products').select('id, status').eq('business_id', ctx.businessId).range(from, to), { max: 5000 }),
      fetchAll((from, to) => ctx.db.from('follow_up_queue').select('id').eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval').range(from, to), { max: 2000 }),
      ctx.db.from('business_balances').select('balance_usd').eq('business_id', ctx.businessId).maybeSingle(),
    ]);
    const b = must(business, 'business') ?? {};
    const sess = must(sessions, 'sessions') ?? [];
    const ruleRows = must(rules, 'rules') ?? [];
    const autoRows = must(autos, 'auto campaigns') ?? [];
    const campRows = must(campaigns, 'campaigns') ?? [];
    const real = leads.filter((l) => l.lead_type !== 'personal');
    const studied = count(real, (l) => Boolean(l.context_summary || l.customer_intent));
    const approved = count(products, (p) => p.status === 'approved');
    const done = {
      whatsapp: count(sess, (s) => s.status === 'connected') > 0,
      chats_loaded: real.length > 0,
      chats_studied: studied > 0,
      persona: b.persona_pack_status === 'ready',
      products: approved > 0,
      followups: b.followup_ai_enabled === true,
      auto_lists: count(ruleRows, (r) => r.enabled) > 0,
      auto_campaigns: count(autoRows, (r) => r.campaign_status === 'active') > 0,
      chat_ai: b.chat_ai_enabled === true,
    };
    const steps = SETUP_ORDER.map((key) => ({ key, ...SETUP_COPY[key], done: done[key] }));
    const next = steps.find((s) => !s.done) ?? null;
    const lists = must(await ctx.db.from('v_list_summary').select('list_id').eq('business_id', ctx.businessId), 'lists') ?? [];
    return {
      business: { name: b.name, currency: b.currency || 'KES', industry: b.industry || null },
      whatsapp_connected: done.whatsapp,
      leads: { total: real.length, studied, waiting_for_reply: count(real, (l) => l.awaiting_business_reply === true || Number(l.unread_count) > 0), won: count(real, (l) => l.lead_state === 'won') },
      lists: lists.length, campaigns: { total: campRows.length, running: count(campRows, (c) => c.status === 'active') },
      products: { approved, waiting_for_review: count(products, (p) => p.status === 'discovered') },
      messages_waiting_for_your_ok: pending.length,
      balance_usd: balance?.data?.balance_usd != null ? round1(balance.data.balance_usd) : null,
      setup: { done_count: steps.filter((s) => s.done).length, of: steps.length, steps, next_step: next, all_done: !next },
      summary: `${plural(real.length, 'lead')}, ${plural(count(campRows, (c) => c.status === 'active'), 'running campaign')}, ${pending.length} message(s) waiting for approval.`,
    };
  },
};

export default [get_business_snapshot];
