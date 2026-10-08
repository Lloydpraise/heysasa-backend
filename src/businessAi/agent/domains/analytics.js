// Analytics: the numbers from the dashboard's Analytics tab, each with what it means and why it matters, in plain words.
import { ToolError, asText, clip, daysSince, fetchAll, must, money, plural, round1, topCounts } from '../helpers.js';
import { loadLeads } from './leads.js';

// The meaning of every number. The assistant explains these in its own words; it never invents reasons.
export const GLOSSARY = {
  total_leads: { label: 'People who messaged you', meaning: 'Everyone who has chatted with your business on WhatsApp (personal chats left out).', why: 'This is the size of your pool of possible customers. Every sale starts here.' },
  active_7d: { label: 'Active this week', meaning: 'People who were in touch in the last 7 days.', why: 'These are warm. A fast reply to them is the cheapest sale you can make.' },
  quiet_14d: { label: 'Gone quiet (2 weeks+)', meaning: 'People who have not been in touch for 14 days or more.', why: 'Some of them still want to buy and just got busy. A friendly follow-up wins some back.' },
  waiting_for_reply: { label: 'Waiting for your reply', meaning: 'People whose last message you have not answered yet.', why: 'Every hour of waiting loses sales. Answering these first is the best use of your time.' },
  hot_leads: { label: 'Hot leads', meaning: 'People whose buying-interest score is high (7 or more out of 10), and who have not bought.', why: 'They are the closest to paying. Talk to them today.' },
  won: { label: 'Customers who bought', meaning: 'Leads recorded as sold.', why: 'This is what the business lives on.' },
  win_rate: { label: 'How many bought', meaning: 'Out of everyone who messaged, the share who bought.', why: 'If it is low, either the wrong people are coming, replies are slow, or follow-up is missing. Compare it with your own past months, not with other businesses.' },
  revenue: { label: 'Sales recorded', meaning: 'The total value of the sales recorded in HeySasa.', why: 'It shows what your WhatsApp conversations actually earn. Sales you forgot to record are not counted.' },
  avg_deal: { label: 'Average sale', meaning: 'Sales value divided by the number of sales.', why: 'Raising it (bundles, upsells) can grow income without needing more customers.' },
  ai_closed: { label: 'Sales closed by the AI', meaning: 'Sales where the AI, not you, closed the deal.', why: 'Shows how much work the AI is taking off you.' },
  lead_count: { label: 'Leads from this ad', meaning: 'People who first messaged you after seeing this ad.', why: 'Shows which ads bring conversations. More leads is only good if they also buy.' },
  top_products: { label: 'Most asked-about products', meaning: 'Products people mention most in their chats.', why: 'This is what customers want. Stock it, show it first, and write your ads about it.' },
  top_worries: { label: 'Most common worries', meaning: 'Reasons people hesitate, like price or delivery.', why: 'Answer the top worry in your ads and first replies, and fewer people drift away.' },
  top_questions: { label: 'Questions people ask before buying', meaning: 'The things people ask before they decide.', why: 'Put the answers in your product descriptions and persona so nobody has to ask.' },
  competitors: { label: 'Other sellers they mention', meaning: 'Other businesses your leads compare you with.', why: 'Tells you who you are up against and what to say about why you are better.' },
  sent_30d: { label: 'Follow-ups sent (30 days)', meaning: 'Follow-up messages that went out to customers in the last month.', why: 'Following up is how quiet people come back. If it is zero, follow-ups may be off.' },
  failed_30d: { label: 'Follow-ups that failed', meaning: 'Messages that could not be delivered.', why: 'A lot of failures can mean a disconnected WhatsApp or invalid numbers. Check the connection.' },
  skipped_30d: { label: 'Follow-ups skipped', meaning: 'Messages that were not sent (you said no, quiet hours, or the person opted out).', why: 'Skipping on purpose is fine. Many skips you did not choose can mean a setting is too strict.' },
  waiting_approval: { label: 'Messages waiting for your OK', meaning: 'Drafts the AI wrote that need your approval before they send.', why: 'Nothing goes to customers until you approve. Waiting drafts get stale, so clear them daily.' },
  campaign_sent: { label: 'Campaign messages sent', meaning: 'Messages sent by all your campaigns.', why: 'The volume of outreach. More is not always better: replies matter more.' },
  campaign_replies: { label: 'Replies to campaigns', meaning: 'People who wrote back after a campaign message.', why: 'A reply means the message worked. Replies turn into sales.' },
  reply_rate: { label: 'Campaign reply rate', meaning: 'Replies as a share of people reached.', why: 'Above about 10 percent is a good sign for cold outreach. Low means the wording or the timing needs work.' },
  campaign_revenue: { label: 'Sales from campaigns', meaning: 'Sales value from people who bought after a campaign.', why: 'Shows whether campaigns pay for themselves.' },
  busiest_hours: { label: 'When customers message most', meaning: 'The hours of the day with the most messages from customers.', why: 'Be ready to reply then, and send campaigns just before these hours.' },
  busiest_days: { label: 'Busiest days', meaning: 'The days of the week with the most customer messages.', why: 'Plan your promotions and your staff around these days.' },
};

const entry = (key, value, extra = {}) => ({ key, label: GLOSSARY[key].label, value, meaning: GLOSSARY[key].meaning, why_it_matters: GLOSSARY[key].why, ...extra });
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : 0);
const isReal = (l) => l.lead_type !== 'personal';

const SECTIONS = ['overview', 'ads', 'demand', 'followups', 'timing', 'revenue'];

async function overview(ctx) {
  const now = ctx.now();
  const leads = (await loadLeads(ctx.db, ctx.businessId)).filter(isReal);
  const biz = must(await ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(), 'business') ?? {};
  const threshold = Number(biz.hot_lead_intent_threshold ?? 7);
  const won = leads.filter((l) => l.lead_state === 'won');
  const revenue = won.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const byState = leads.reduce((a, l) => ({ ...a, [l.lead_state || 'unknown']: (a[l.lead_state || 'unknown'] ?? 0) + 1 }), {});
  return {
    metrics: [
      entry('total_leads', leads.length),
      entry('active_7d', leads.filter((l) => (daysSince(l.last_seen, now) ?? 99) <= 7).length),
      entry('quiet_14d', leads.filter((l) => l.lead_state !== 'won' && (daysSince(l.last_seen, now) ?? 0) >= 14).length),
      entry('waiting_for_reply', leads.filter((l) => l.awaiting_business_reply === true || Number(l.unread_count) > 0).length),
      entry('hot_leads', leads.filter((l) => l.lead_state !== 'won' && Number(l.intent_score) >= threshold).length, { note: `Hot means interest score ${threshold} or more out of 10.` }),
      entry('won', won.length),
      entry('win_rate', `${pct(won.length, leads.length)}%`),
      entry('revenue', money(revenue, biz.currency || 'KES')),
    ],
    details: { leads_by_state: byState },
  };
}

async function ads(ctx) {
  const rows = must(await ctx.db.from('v_ad_leaderboard').select('*').eq('business_id', ctx.businessId).order('lead_count', { ascending: false }).limit(10), 'ads') ?? [];
  return {
    metrics: [entry('lead_count', rows.reduce((s, r) => s + (Number(r.lead_count) || 0), 0), { note: 'Total across the top ads shown.' })],
    details: { top_ads: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'business_id' && (v === null || ['string', 'number', 'boolean'].includes(typeof v))).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 120) : v]))) },
    note: rows.length ? undefined : 'No ad leads yet. This fills in when people message you from a Facebook or Instagram ad.',
  };
}

async function demand(ctx) {
  const leads = (await loadLeads(ctx.db, ctx.businessId)).filter(isReal);
  return {
    metrics: [
      entry('top_products', topCounts(leads.map((l) => l.product_interests), 8)),
      entry('top_worries', topCounts(leads.map((l) => l.objection_tags), 8)),
      entry('top_questions', topCounts(leads.map((l) => l.pre_purchase_questions), 6)),
      entry('competitors', topCounts(leads.map((l) => l.competitor_mentions), 6)),
    ],
    note: leads.some((l) => l.context_summary || l.customer_intent) ? undefined : 'Your chats have not been studied yet, so this is empty. Studying them fills it in.',
  };
}

async function followups(ctx) {
  const since = new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString();
  const queue = await fetchAll((from, to) => ctx.db.from('follow_up_queue').select('status, approval_status').eq('business_id', ctx.businessId).gte('scheduled_at', since).range(from, to), { max: 20000 });
  const c = (s) => queue.filter((q) => q.status === s).length;
  const camps = must(await ctx.db.from('v_campaign_summary').select('*').eq('business_id', ctx.businessId), 'campaigns') ?? [];
  const sum = (k) => camps.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const reached = sum('reached_count');
  return {
    metrics: [
      entry('sent_30d', c('sent')), entry('failed_30d', c('failed')), entry('skipped_30d', c('skipped')),
      entry('waiting_approval', queue.filter((q) => q.approval_status === 'awaiting_approval').length),
      entry('campaign_sent', sum('sent_count')), entry('campaign_replies', sum('replies_count')), entry('reply_rate', `${pct(sum('replies_count'), reached)}%`), entry('campaign_revenue', money(sum('realized_revenue'))),
    ],
  };
}

function inZone(iso, timeZone) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false, weekday: 'long' }).formatToParts(d);
  return { hour: Number(parts.find((p) => p.type === 'hour').value) % 24, day: parts.find((p) => p.type === 'weekday').value };
}

async function timing(ctx) {
  const biz = must(await ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(), 'business') ?? {};
  let zone = biz.timezone || 'Africa/Nairobi';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'Africa/Nairobi'; }
  const since = new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString();
  const msgs = await fetchAll((from, to) => ctx.db.from('messages').select('created_at').eq('business_id', ctx.businessId).eq('direction', 'in').gte('created_at', since).range(from, to), { max: 30000 });
  if (msgs.length < 20) return { metrics: [], note: 'Not enough messages in the last 30 days to see a pattern yet.' };
  const hours = new Map(); const days = new Map();
  for (const m of msgs) { const z = inZone(m.created_at, zone); hours.set(z.hour, (hours.get(z.hour) ?? 0) + 1); days.set(z.day, (days.get(z.day) ?? 0) + 1); }
  const top = (map, n, fmt) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: fmt(k), messages: v }));
  return { metrics: [entry('busiest_hours', top(hours, 3, (h) => `${h}:00 to ${h}:59`)), entry('busiest_days', top(days, 3, (d) => d))], details: { time_zone: zone, messages_counted: msgs.length } };
}

async function revenue(ctx) {
  const now = ctx.now();
  const biz = must(await ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(), 'business') ?? {};
  const won = (await loadLeads(ctx.db, ctx.businessId)).filter((l) => isReal(l) && l.lead_state === 'won');
  const total = won.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const recent = won.filter((l) => (daysSince(l.purchase_date, now) ?? 999) <= 30);
  const ai = won.filter((l) => l.purchase_closed_by === 'ai').length;
  return {
    metrics: [
      entry('revenue', money(total, biz.currency || 'KES')), entry('won', won.length),
      entry('avg_deal', won.length ? money(total / won.length, biz.currency || 'KES') : 'none yet'),
      entry('ai_closed', `${ai} of ${won.length}`),
    ],
    details: { last_30_days: { sales: recent.length, value: money(recent.reduce((s, l) => s + (Number(l.deal_value) || 0), 0), biz.currency || 'KES') }, top_products_sold: topCounts(won.map((l) => l.product_sold), 5) },
  };
}

const BUILDERS = { overview, ads, demand, followups, timing, revenue };

const get_analytics = {
  name: 'get_analytics', area: 'analytics', kind: 'read', status: 'Reading your numbers…',
  description: 'The numbers behind the Analytics tab, each with what it means and why it matters. Sections: overview (how many leads, hot, waiting, sales), ads (which ads bring leads), demand (what people ask for and worry about), followups (follow-ups and campaigns), timing (when customers message), revenue (sales).',
  parameters: { type: 'object', properties: { section: { type: 'string', enum: SECTIONS } }, additionalProperties: false },
  async run(ctx, { section = 'overview' } = {}) {
    const build = BUILDERS[section];
    if (!build) throw new ToolError(`Sections are: ${SECTIONS.join(', ')}.`);
    return { section, ...(await build(ctx)) };
  },
};

const explain_metric = {
  name: 'explain_metric', area: 'analytics', kind: 'read', status: 'Looking that up…',
  description: 'Explain one number from the dashboard in plain words: what it is and why it matters. Give the metric name from get_analytics, or leave it out to see all the names.',
  parameters: { type: 'object', properties: { metric: { type: 'string' } }, additionalProperties: false },
  async run(ctx, { metric } = {}) {
    const key = asText(metric).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) return { metrics: Object.entries(GLOSSARY).map(([k, g]) => ({ key: k, label: g.label })) };
    const g = GLOSSARY[key] ?? Object.entries(GLOSSARY).find(([, v]) => v.label.toLowerCase().includes(asText(metric).toLowerCase()))?.[1];
    if (!g) throw new ToolError('I do not have that number. Ask me for a section with get_analytics instead.');
    return { label: g.label, meaning: g.meaning, why_it_matters: g.why };
  },
};

export default [get_analytics, explain_metric];
