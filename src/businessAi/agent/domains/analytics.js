// Analytics: the numbers from the dashboard's Analytics tab, each with what it means and why it matters, in plain words.
// Every section can be read for a time period (today, this week, last month...) and then comes with a change versus the
// comparable earlier period. The change is left out when there is no earlier data, because "no change" beats a misleading one.
import { ToolError, asText, clip, daysSince, fetchAll, isCustomerLead, isWaiting, must, money, plural, round1, topCounts } from '../helpers.js';
import { isOptedOut, loadLeads } from './leads.js';
import { settingsResult } from './settings.js';

// The meaning of every number. The assistant explains these in its own words; it never invents reasons.
export const GLOSSARY = {
  total_leads: { label: 'People who messaged you', meaning: 'Everyone who has chatted with your business on WhatsApp (personal chats, vendors, staff and junk left out).', why: 'This is the size of your pool of possible customers. Every sale starts here.' },
  active_7d: { label: 'Active this week', meaning: 'People who were in touch in the last 7 days.', why: 'These are warm. A fast reply to them is the cheapest sale you can make.' },
  quiet_14d: { label: 'Gone quiet (2 weeks+)', meaning: 'People who have not been in touch for 14 days or more.', why: 'Some of them still want to buy and just got busy. A friendly follow-up wins some back.' },
  waiting_for_reply: { label: 'Waiting for your reply', meaning: 'People whose last message you have not answered yet.', why: 'Every hour of waiting loses sales. Answering these first is the best use of your time.' },
  hot_leads: { label: 'Hot leads', meaning: 'People whose buying-interest score is high (7 or more out of 10 by default), and who have not bought.', why: 'They are the closest to paying. Talk to them today.' },
  won: { label: 'Customers who bought', meaning: 'Leads recorded as sold.', why: 'This is what the business lives on.' },
  win_rate: { label: 'How many bought', meaning: 'Out of everyone who messaged, the share who bought.', why: 'If it is low, either the wrong people are coming, replies are slow, or follow-up is missing. Compare it with your own past months, not with other businesses.' },
  revenue: { label: 'Sales recorded', meaning: 'The total value of the sales recorded in HeySasa.', why: 'It shows what your WhatsApp conversations actually earn. Sales you forgot to record are not counted.' },
  avg_deal: { label: 'Average sale', meaning: 'Sales value divided by the number of sales.', why: 'Raising it (bundles, upsells) can grow income without needing more customers.' },
  ai_closed: { label: 'Sales closed by the AI', meaning: 'Sales where the AI, not you, closed the deal.', why: 'Shows how much work the AI is taking off you.' },
  new_leads: { label: 'New people', meaning: 'People who messaged you for the first time in this period.', why: 'Shows whether your ads and word of mouth are bringing fresh conversations.' },
  customer_messages: { label: 'Messages from customers', meaning: 'Messages customers sent you in this period.', why: 'A rough measure of how busy your WhatsApp is. A drop can mean fewer ads or slower replies.' },
  period_sales: { label: 'Sales in this period', meaning: 'Sales recorded in this period.', why: 'Tells you how the period is going compared with the one before.' },
  period_revenue: { label: 'Sales value in this period', meaning: 'The value of sales recorded in this period.', why: 'The money side of the period. Sales you forgot to record are not counted.' },
  pipeline_value: { label: 'Possible sales value', meaning: 'An estimate: for each person still deciding, the price of the product they asked about, added up.', why: 'A rough "what is on the table" number. It is only as good as the products and prices you have approved, and people who did not name a priced product add nothing.' },
  lead_count: { label: 'Leads from this ad', meaning: 'People who first messaged you after seeing this ad.', why: 'Shows which ads bring conversations. More leads is only good if they also buy.' },
  ad_replies: { label: 'Ad leads who wrote back', meaning: 'Leads from this ad who kept the conversation going.', why: 'Shows whether the ad brings people who actually talk.' },
  ad_conversions: { label: 'Ad leads who bought', meaning: 'Leads from this ad who bought.', why: 'The real test of an ad: does it bring buyers, not just chats.' },
  top_products: { label: 'Most asked-about products', meaning: 'Products people mention most in their chats.', why: 'This is what customers want. Stock it, show it first, and write your ads about it.' },
  top_worries: { label: 'Most common worries', meaning: 'Reasons people hesitate, like price or delivery.', why: 'Answer the top worry in your ads and first replies, and fewer people drift away.' },
  top_objection: { label: 'Biggest worry right now', meaning: 'The single reason people hesitate most, in the people of this period.', why: 'Fix or answer this one first: it costs you the most sales.' },
  top_questions: { label: 'Questions people ask before buying', meaning: 'The things people ask before they decide.', why: 'Put the answers in your product descriptions and persona so nobody has to ask.' },
  competitors: { label: 'Other sellers they mention', meaning: 'Other businesses your leads compare you with.', why: 'Tells you who you are up against and what to say about why you are better.' },
  sent_30d: { label: 'Follow-ups sent', meaning: 'Follow-up messages that went out to customers (last 30 days unless a period is chosen).', why: 'Following up is how quiet people come back. If it is zero, follow-ups may be off.' },
  failed_30d: { label: 'Follow-ups that failed', meaning: 'Messages that could not be delivered.', why: 'A lot of failures can mean a disconnected WhatsApp or invalid numbers. Check the connection.' },
  skipped_30d: { label: 'Follow-ups skipped', meaning: 'Messages that were not sent (you said no, quiet hours, or the person opted out).', why: 'Skipping on purpose is fine. Many skips you did not choose can mean a setting is too strict.' },
  waiting_approval: { label: 'Messages waiting for your OK', meaning: 'Drafts the AI wrote that need your approval before they send.', why: 'Nothing goes to customers until you approve. Waiting drafts get stale, so clear them daily.' },
  campaign_sent: { label: 'Campaign messages sent', meaning: 'Messages sent by all your campaigns (all time).', why: 'The volume of outreach. More is not always better: replies matter more.' },
  campaign_replies: { label: 'Replies to campaigns', meaning: 'People who wrote back after a campaign message (all time).', why: 'A reply means the message worked. Replies turn into sales.' },
  reply_rate: { label: 'Campaign reply rate', meaning: 'Replies as a share of people reached (all time).', why: 'Compare it with your own earlier campaigns: if it rises, the wording or timing is working; if it falls, change one thing and test again.' },
  campaign_revenue: { label: 'Sales from campaigns', meaning: 'Sales value from people who bought after a campaign (all time).', why: 'Shows whether campaigns pay for themselves.' },
  busiest_hours: { label: 'When customers message most', meaning: 'The hours of the day with the most messages from customers.', why: 'Be ready to reply then, and send campaigns just before these hours.' },
  busiest_days: { label: 'Busiest days', meaning: 'The days of the week with the most customer messages.', why: 'Plan your promotions and your staff around these days.' },
  messages_by_month: { label: 'Customer messages by month', meaning: 'How many messages customers sent in each of the last months.', why: 'Shows whether interest is growing, flat or seasonal.' },
};

const entry = (key, value, extra = {}) => ({ key, label: GLOSSARY[key].label, value, meaning: GLOSSARY[key].meaning, why_it_matters: GLOSSARY[key].why, ...extra });
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : 0);
const money0 = (n, cur) => money(n, cur);

// ── time periods ────────────────────────────────────────────────────────────
export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days', 'all_time'];
const DAY = 86_400_000;

function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - date.getTime();
}
function localParts(date, timeZone) {
  const local = new Date(date.getTime() + tzOffsetMs(date, timeZone));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), dow: local.getUTCDay() };
}
// The instant that is local midnight of y-m-d (month is 0-based; days and months may overflow).
function fromLocal(y, m, d, timeZone) {
  const wall = Date.UTC(y, m, d);
  const first = wall - tzOffsetMs(new Date(wall), timeZone);
  return new Date(wall - tzOffsetMs(new Date(first), timeZone));
}

export function resolvePeriod(key, now = new Date(), timeZone = 'Africa/Nairobi') {
  if (!key || key === 'all_time') return null;
  if (!PERIODS.includes(key)) throw new ToolError(`period must be one of: ${PERIODS.join(', ')}.`);
  const { y, m, d, dow } = localParts(now, timeZone);
  const mondayShift = (dow + 6) % 7;
  let start; let end; let prevStart; let label;
  if (key === 'today') { start = fromLocal(y, m, d, timeZone); end = now; prevStart = fromLocal(y, m, d - 1, timeZone); label = 'today'; }
  else if (key === 'yesterday') { start = fromLocal(y, m, d - 1, timeZone); end = fromLocal(y, m, d, timeZone); prevStart = fromLocal(y, m, d - 2, timeZone); label = 'yesterday'; }
  else if (key === 'this_week') { start = fromLocal(y, m, d - mondayShift, timeZone); end = now; prevStart = fromLocal(y, m, d - mondayShift - 7, timeZone); label = 'this week (from Monday)'; }
  else if (key === 'last_week') { start = fromLocal(y, m, d - mondayShift - 7, timeZone); end = fromLocal(y, m, d - mondayShift, timeZone); prevStart = fromLocal(y, m, d - mondayShift - 14, timeZone); label = 'last week'; }
  else if (key === 'this_month') { start = fromLocal(y, m, 1, timeZone); end = now; prevStart = fromLocal(y, m - 1, 1, timeZone); label = 'this month'; }
  else if (key === 'last_month') { start = fromLocal(y, m - 1, 1, timeZone); end = fromLocal(y, m, 1, timeZone); prevStart = fromLocal(y, m - 2, 1, timeZone); label = 'last month'; }
  else { const days = key === 'last_7_days' ? 7 : 30; end = now; start = new Date(now.getTime() - days * DAY); prevStart = new Date(start.getTime() - days * DAY); label = `the last ${days} days`; }
  // The earlier period is compared over the same elapsed time (so a half-finished day is not set against a whole one).
  const prevEnd = new Date(Math.min(prevStart.getTime() + (end.getTime() - start.getTime()), start.getTime()));
  return { key, label, start, end, prevStart, prevEnd };
}

const within = (iso, a, b) => Boolean(iso) && new Date(iso) >= a && new Date(iso) < b;
const inPeriod = (iso, p) => !p || within(iso, p.start, p.end);
const inPrev = (iso, p) => p && within(iso, p.prevStart, p.prevEnd);
const firstSeen = (l) => l.first_seen_at ?? l.created_at ?? null;
const cohortDate = (l) => firstSeen(l) ?? l.last_seen ?? null;

// { previous, change_percent } or nothing when there is no earlier data to compare with.
function change(current, previous) {
  const cur = Number(current); const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return {};
  return { change_vs_earlier: { earlier_value: prev, change_percent: round1(((cur - prev) / prev) * 100) } };
}

async function loadBusiness(ctx) {
  const biz = must(await settingsResult(ctx), 'business') ?? {};   // the account's view of the settings
  let zone = biz.timezone || 'Africa/Nairobi';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'Africa/Nairobi'; }
  return { biz, zone, currency: biz.currency || 'KES' };
}

async function customerLeads(ctx) { return (await loadLeads(ctx.db, ctx.businessId)).filter(isCustomerLead); }

async function inboundMessageTimes(ctx, sinceIso, untilIso = null, max = 60000) {
  return fetchAll((from, to) => {
    let q = ctx.db.from('messages').select('created_at').eq('business_id', ctx.businessId).eq('direction', 'in').gte('created_at', sinceIso);
    if (untilIso) q = q.lt('created_at', untilIso);
    return q.range(from, to);
  }, { max });
}

// What a person who is still deciding might be worth: the price of the approved product they asked about.
async function priceBook(ctx) {
  const rows = await fetchAll((from, to) => ctx.db.from('products').select('title, price, aliases, status').eq('business_id', ctx.businessId).range(from, to), { max: 3000 });
  return rows.filter((r) => r.status === 'approved' && Number(r.price) > 0).map((r) => ({ names: [r.title, ...(Array.isArray(r.aliases) ? r.aliases : [])].map((n) => String(n ?? '').toLowerCase().trim()).filter((n) => n.length >= 3), price: Number(r.price) }));
}
function estimateValue(lead, book) {
  for (const interest of (Array.isArray(lead.product_interests) ? lead.product_interests : [])) {
    const t = String(interest ?? '').toLowerCase().trim();
    if (t.length < 3) continue;
    const hit = book.find((b) => b.names.some((n) => n.includes(t) || t.includes(n)));
    if (hit) return hit.price;
  }
  return 0;
}

const periodNote = (p) => (p ? { period: p.label } : {});

// ── sections ────────────────────────────────────────────────────────────────
const SECTIONS = ['overview', 'funnel', 'ads', 'demand', 'market', 'followups', 'timing', 'revenue', 'health'];

async function overview(ctx, p) {
  const now = ctx.now();
  const { biz, currency } = await loadBusiness(ctx);
  const leads = await customerLeads(ctx);
  const threshold = Number(biz.hot_lead_intent_threshold ?? 7);
  const won = leads.filter((l) => l.lead_state === 'won');
  const revenue = won.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const byState = leads.reduce((a, l) => ({ ...a, [l.lead_state || 'unknown']: (a[l.lead_state || 'unknown'] ?? 0) + 1 }), {});
  const out = {
    metrics: [
      entry('total_leads', leads.length),
      entry('active_7d', leads.filter((l) => (daysSince(l.last_seen, now) ?? 99) <= 7).length),
      entry('quiet_14d', leads.filter((l) => l.lead_state !== 'won' && (daysSince(l.last_seen, now) ?? 0) >= 14).length),
      entry('waiting_for_reply', leads.filter(isWaiting).length),
      entry('hot_leads', leads.filter((l) => l.lead_state !== 'won' && Number(l.intent_score) >= threshold).length, { note: `Hot means interest score ${threshold} or more out of 10.` }),
      entry('won', won.length),
      entry('win_rate', `${pct(won.length, leads.length)}%`),
      entry('revenue', money0(revenue, currency)),
    ],
    details: { leads_by_state: byState, note: 'These are how things stand now.' },
  };
  if (p) {
    const msgs = await inboundMessageTimes(ctx, p.prevStart.toISOString(), p.end.toISOString());
    const sold = (a, b) => won.filter((l) => within(l.purchase_date, a, b));
    const sum = (rows) => rows.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
    const nowNew = leads.filter((l) => inPeriod(firstSeen(l), p)).length; const prevNew = leads.filter((l) => inPrev(firstSeen(l), p)).length;
    const nowMsgs = msgs.filter((m) => inPeriod(m.created_at, p)).length; const prevMsgs = msgs.filter((m) => inPrev(m.created_at, p)).length;
    const nowSales = sold(p.start, p.end); const prevSales = sold(p.prevStart, p.prevEnd);
    out.period = p.label;
    out.period_metrics = [
      entry('new_leads', nowNew, change(nowNew, prevNew)),
      entry('customer_messages', nowMsgs, change(nowMsgs, prevMsgs)),
      entry('period_sales', nowSales.length, change(nowSales.length, prevSales.length)),
      entry('period_revenue', money0(sum(nowSales), currency), change(sum(nowSales), sum(prevSales))),
    ];
  }
  return out;
}

async function funnel(ctx, p) {
  const { biz, currency } = await loadBusiness(ctx);
  const threshold = Number(biz.hot_lead_intent_threshold ?? 7);
  const book = await priceBook(ctx);
  let leads = await customerLeads(ctx);
  if (p) leads = leads.filter((l) => inPeriod(cohortDate(l), p));
  const stages = {};
  for (const l of leads) {
    const s = (stages[l.lead_state || 'unknown'] ??= { people: 0, value: 0 });
    s.people += 1; if (!['won', 'lost', 'do_not_contact'].includes(l.lead_state)) s.value += estimateValue(l, book);
  }
  const open = leads.filter((l) => !['won', 'lost', 'do_not_contact'].includes(l.lead_state) && !isOptedOut(l));
  const temp = { hot: { people: 0, value: 0 }, warm: { people: 0, value: 0 }, cold: { people: 0, value: 0 }, not_studied_yet: { people: 0, value: 0 } };
  for (const l of open) {
    const score = Number(l.intent_score);
    const key = !Number.isFinite(score) || l.intent_score === null || l.intent_score === undefined ? 'not_studied_yet' : score >= threshold ? 'hot' : score >= 4 ? 'warm' : 'cold';
    temp[key].people += 1; temp[key].value += estimateValue(l, book);
  }
  const fmt = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { people: v.people, possible_value: v.value ? money0(v.value, currency) : undefined }]));
  const total = open.reduce((s, l) => s + estimateValue(l, book), 0);
  return {
    ...periodNote(p),
    metrics: [entry('pipeline_value', book.length ? money0(total, currency) : 'unknown: no approved products with prices yet', { note: p ? 'Only people who first messaged in this period.' : undefined })],
    details: { stages, stage_values: fmt(stages), temperature: fmt(temp), hot_means: `interest score ${threshold}+ out of 10, warm 4 to ${threshold - 1}, cold below 4` },
    note: 'A lead\'s stage is where the chat has got to. HeySasa uses the same stages everywhere; the owner cannot yet set their own.',
  };
}

async function ads(ctx, p) {
  const rows = must(await ctx.db.from('v_ad_leaderboard').select('*').eq('business_id', ctx.businessId).order('lead_count', { ascending: false }).limit(15), 'ads') ?? [];
  const leads = await customerLeads(ctx);
  const byAd = new Map();
  for (const l of leads) {
    if (!l.ad_id) continue;
    const e = byAd.get(String(l.ad_id)) ?? { last: null, inPeriod: 0 };
    const seen = firstSeen(l);
    if (seen && (!e.last || seen > e.last)) e.last = seen;
    if (p && inPeriod(seen, p)) e.inPeriod += 1;
    byAd.set(String(l.ad_id), e);
  }
  const top = rows.map((r) => {
    const extra = byAd.get(String(r.ad_id));
    return {
      ad_id: r.ad_id, headline: clip(r.ad_headline, 120) || 'Untitled ad', platform: r.ad_platform || null, leads: Number(r.lead_count) || 0,
      leads_who_replied: Number(r.reply_count) || 0, reply_rate_percent: r.reply_rate_pct ?? null, leads_who_bought: Number(r.conversion_count) || 0, buy_rate_percent: r.conversion_rate_pct ?? null,
      last_lead_on: (extra?.last ?? r.updated_at) ? String(extra?.last ?? r.updated_at).slice(0, 10) : null, ...(p ? { leads_in_period: extra?.inPeriod ?? 0 } : {}),
    };
  });
  return {
    ...periodNote(p),
    metrics: [entry('lead_count', top.reduce((s, r) => s + r.leads, 0), { note: 'Total across the top ads shown.' }), entry('ad_replies', top.reduce((s, r) => s + r.leads_who_replied, 0)), entry('ad_conversions', top.reduce((s, r) => s + r.leads_who_bought, 0))],
    details: { top_ads: top, note: 'These are ads that have brought leads, not a list of ads running right now. last_lead_on shows how recently each one brought someone.' },
    note: rows.length ? undefined : 'No ad leads yet. This fills in when people message you from a Facebook or Instagram ad.',
  };
}

async function demand(ctx, p) {
  const leads = (await customerLeads(ctx));
  const now = leads.filter((l) => inPeriod(cohortDate(l), p));
  const before = p ? leads.filter((l) => inPrev(cohortDate(l), p)) : [];
  const products = topCounts(now.map((l) => l.product_interests), 8);
  const earlier = new Map(topCounts(before.map((l) => l.product_interests), 50).map((c) => [c.name, c.count]));
  return {
    ...periodNote(p),
    metrics: [
      entry('top_products', products.map((c) => ({ ...c, ...(p && earlier.get(c.name) ? { earlier_period: earlier.get(c.name) } : {}) })), { note: p ? 'Counted among people who first messaged in this period.' : undefined }),
      entry('top_worries', topCounts(now.map((l) => l.objection_tags), 8)),
      entry('top_questions', topCounts(now.map((l) => l.pre_purchase_questions), 6)),
      entry('competitors', topCounts(now.map((l) => l.competitor_mentions), 6)),
    ],
    note: leads.some((l) => l.context_summary || l.customer_intent) ? (now.length ? undefined : 'Nobody new in this period, so there is nothing to count.') : 'Your chats have not been studied yet, so this is empty. Studying them fills it in.',
  };
}

async function market(ctx, p) {
  const leads = await customerLeads(ctx);
  const now = leads.filter((l) => inPeriod(cohortDate(l), p));
  const worries = topCounts(now.map((l) => l.objection_tags), 8);
  return {
    ...periodNote(p),
    metrics: [
      entry('top_objection', worries[0] ? { name: worries[0].name, people: worries[0].count } : 'none found yet'),
      entry('top_worries', worries), entry('top_questions', topCounts(now.map((l) => l.pre_purchase_questions), 8)), entry('competitors', topCounts(now.map((l) => l.competitor_mentions), 8)),
    ],
    note: worries.length ? undefined : 'No worries have been found yet. They appear once the chats are studied.',
  };
}

async function followups(ctx, p) {
  const since = (p ? p.start : new Date(ctx.now().getTime() - 30 * DAY)).toISOString();
  const until = p ? p.end.toISOString() : null;
  const queue = await fetchAll((from, to) => {
    let q = ctx.db.from('follow_up_queue').select('status, approval_status').eq('business_id', ctx.businessId).gte('scheduled_at', since);
    if (until) q = q.lt('scheduled_at', until);
    return q.range(from, to);
  }, { max: 20000 });
  const waiting = await fetchAll((from, to) => ctx.db.from('follow_up_queue').select('id').eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval').range(from, to), { max: 5000 });
  const c = (s) => queue.filter((q) => q.status === s).length;
  const camps = must(await ctx.db.from('v_campaign_summary').select('*').eq('business_id', ctx.businessId), 'campaigns') ?? [];
  const sum = (k) => camps.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const reached = sum('reached_count');
  return {
    ...periodNote(p),
    metrics: [
      entry('sent_30d', c('sent')), entry('failed_30d', c('failed')), entry('skipped_30d', c('skipped')),
      entry('waiting_approval', waiting.length),
      entry('campaign_sent', sum('sent_count')), entry('campaign_replies', sum('replies_count')), entry('reply_rate', `${pct(sum('replies_count'), reached)}%`), entry('campaign_revenue', money0(sum('realized_revenue'))),
    ],
    note: p ? 'Follow-up counts are for the chosen period. Campaign totals are all time.' : undefined,
  };
}

function inZone(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false, weekday: 'long' }).formatToParts(new Date(iso));
  return { hour: Number(parts.find((x) => x.type === 'hour').value) % 24, day: parts.find((x) => x.type === 'weekday').value };
}

async function timing(ctx, p) {
  const { zone } = await loadBusiness(ctx);
  const now = ctx.now();
  const since = (p ? p.start : new Date(now.getTime() - 30 * DAY)).toISOString();
  const msgs = await inboundMessageTimes(ctx, since, p ? p.end.toISOString() : null, 30000);
  // Month view: the last six months, so activity can be compared across months.
  const sixMonthsAgo = new Date(now.getTime() - 183 * DAY).toISOString();
  const long = await inboundMessageTimes(ctx, sixMonthsAgo, null, 60000);
  const months = new Map();
  for (const m of long) { const k = String(m.created_at).slice(0, 7); months.set(k, (months.get(k) ?? 0) + 1); }
  const byMonth = [...months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-6).map(([month, messages]) => ({ month, messages }));
  const metrics = [];
  if (byMonth.length) metrics.push(entry('messages_by_month', byMonth));
  if (msgs.length < 20) return { ...periodNote(p), metrics, note: 'Not enough messages in this time to see an hourly pattern yet.' };
  const hours = new Map(); const days = new Map();
  for (const m of msgs) { const z = inZone(m.created_at, zone); hours.set(z.hour, (hours.get(z.hour) ?? 0) + 1); days.set(z.day, (days.get(z.day) ?? 0) + 1); }
  const top = (map, n, fmt) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: fmt(k), messages: v }));
  return { ...periodNote(p), metrics: [entry('busiest_hours', top(hours, 3, (h) => `${h}:00 to ${h}:59`)), entry('busiest_days', top(days, 3, (d) => d)), ...metrics], details: { time_zone: zone, messages_counted: msgs.length } };
}

async function revenue(ctx, p) {
  const { currency } = await loadBusiness(ctx);
  const won = (await customerLeads(ctx)).filter((l) => l.lead_state === 'won');
  const sum = (rows) => rows.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const scoped = p ? won.filter((l) => inPeriod(l.purchase_date, p)) : won;
  const earlier = p ? won.filter((l) => inPrev(l.purchase_date, p)) : [];
  const ai = scoped.filter((l) => l.purchase_closed_by === 'ai').length;
  const recent = won.filter((l) => (daysSince(l.purchase_date, ctx.now()) ?? 999) <= 30);
  return {
    ...periodNote(p),
    metrics: [
      entry('revenue', money0(sum(scoped), currency), change(sum(scoped), sum(earlier))), entry('won', scoped.length, change(scoped.length, earlier.length)),
      entry('avg_deal', scoped.length ? money0(sum(scoped) / scoped.length, currency) : 'none yet'),
      entry('ai_closed', `${ai} of ${scoped.length}`),
    ],
    details: { ...(p ? {} : { last_30_days: { sales: recent.length, value: money0(sum(recent), currency) } }), top_products_sold: topCounts(scoped.map((l) => l.product_sold), 5) },
  };
}

// One plain verdict per thing that can go wrong, each saying what it is and what to do, instead of one vague warning.
async function health(ctx) {
  const now = ctx.now();
  const { biz } = await loadBusiness(ctx);
  const [sessions, balance, queue, waiting, lastIn, leads] = await Promise.all([
    ctx.db.from('whatsapp_sessions').select('status').eq('business_id', ctx.businessId),
    ctx.db.from('business_balances').select('balance_usd').eq('business_id', ctx.businessId).maybeSingle(),
    fetchAll((from, to) => ctx.db.from('follow_up_queue').select('status').eq('business_id', ctx.businessId).gte('scheduled_at', new Date(now.getTime() - 30 * DAY).toISOString()).range(from, to), { max: 20000 }),
    fetchAll((from, to) => ctx.db.from('follow_up_queue').select('scheduled_at').eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval').range(from, to), { max: 5000 }),
    ctx.db.from('messages').select('created_at').eq('business_id', ctx.businessId).eq('direction', 'in').order('created_at', { ascending: false }).limit(1),
    customerLeads(ctx),
  ]);
  const checks = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });
  const connected = (must(sessions, 'sessions') ?? []).some((s) => s.status === 'connected');
  add('whatsapp', 'WhatsApp connection', connected ? 'ok' : 'problem', connected ? 'Your WhatsApp is connected.' : 'WhatsApp is not connected, so nothing can be sent or received. Reconnect it in Preferences, then WhatsApp.');
  const bal = must(balance, 'balance')?.balance_usd;
  if (biz.business_type !== 'heysasa') add('balance', 'Balance', bal == null ? 'watch' : Number(bal) <= 0 ? 'problem' : Number(bal) < 1 ? 'watch' : 'ok', bal == null ? 'No balance on record.' : Number(bal) <= 0 ? 'The balance is empty, so the AI and campaigns are paused. Top up in Preferences, then Billing.' : Number(bal) < 1 ? 'The balance is getting low. Top up soon so the AI does not stop.' : 'You have balance left.');
  const sent = queue.filter((q) => q.status === 'sent').length; const failed = queue.filter((q) => q.status === 'failed').length;
  const failShare = sent + failed > 0 ? failed / (sent + failed) : 0;
  add('delivery', 'Follow-ups reaching people', sent + failed === 0 ? 'ok' : failShare >= 0.3 ? 'problem' : failShare >= 0.1 ? 'watch' : 'ok', sent + failed === 0 ? 'No follow-ups went out in the last 30 days.' : `${failed} of ${sent + failed} follow-ups failed in the last 30 days (${round1(failShare * 100)}%).${failShare >= 0.1 ? ' Check the WhatsApp connection and the phone numbers.' : ''}`);
  const oldest = waiting.length ? Math.max(...waiting.map((w) => (now.getTime() - new Date(w.scheduled_at).getTime()) / DAY)) : 0;
  add('approvals', 'Messages waiting for your OK', waiting.length === 0 ? 'ok' : waiting.length > 20 || oldest > 3 ? 'problem' : waiting.length > 5 || oldest > 1 ? 'watch' : 'ok', waiting.length === 0 ? 'Nothing is waiting for you.' : `${plural(waiting.length, 'message')} waiting, the oldest for about ${Math.max(1, Math.round(oldest))} day(s). They go stale, so clear them.`);
  const lastAt = lastIn.data?.[0]?.created_at;
  const idleDays = lastAt ? (now.getTime() - new Date(lastAt).getTime()) / DAY : null;
  add('inbound', 'Customers writing to you', idleDays === null ? 'watch' : idleDays > 7 ? 'problem' : idleDays > 3 ? 'watch' : 'ok', idleDays === null ? 'No customer messages found yet.' : idleDays > 3 ? `No customer message for ${Math.round(idleDays)} days. If that is not normal, check WhatsApp is connected and your ads are running.` : 'Customers are writing to you.');
  const studied = leads.filter((l) => l.context_summary || l.customer_intent).length;
  add('studied', 'Chats studied', leads.length === 0 ? 'watch' : studied === 0 ? 'problem' : studied / leads.length < 0.5 ? 'watch' : 'ok', leads.length === 0 ? 'No chats loaded yet.' : `${studied} of ${leads.length} chats are studied. Studying the rest sharpens hot leads, worries and demand.`);
  add('persona', 'How your AI talks', biz.persona_pack_status === 'ready' ? 'ok' : 'watch', biz.persona_pack_status === 'ready' ? 'Your persona pack is ready.' : 'No persona pack yet, so the AI does not know how you talk to customers.');
  add('chat_ai', 'Chat AI answering customers', biz.chat_ai_enabled === true ? 'ok' : 'watch', biz.chat_ai_enabled === true ? 'The chat AI is on.' : 'The chat AI is off, so customers who message at night wait for you.');
  const rank = { problem: 2, watch: 1, ok: 0 };
  const worst = checks.reduce((m, c) => Math.max(m, rank[c.status]), 0);
  return { metrics: [], details: { overall: ['all good', 'a few things to watch', 'needs attention'][worst], checks, problems: checks.filter((c) => c.status === 'problem').map((c) => c.key), watch: checks.filter((c) => c.status === 'watch').map((c) => c.key) }, note: 'Each check says what is wrong and what to do. Mention only the ones that are not ok.' };
}

const BUILDERS = { overview, funnel, ads, demand, market, followups, timing, revenue, health };

const get_analytics = {
  name: 'get_analytics', area: 'analytics', kind: 'read', status: 'Reading your numbers…',
  description: `The numbers behind the Analytics tab, each with what it means and why it matters. Sections: overview (how many leads, hot, waiting, sales; with a period it also shows new people, messages and sales against the earlier period), funnel (where leads are stuck, hot/warm/cold, and a rough possible sales value), ads (which ads bring leads, and when each last did), demand (what people ask for), market (biggest worry, questions, competitors), followups (follow-ups and campaigns), timing (busiest hours and days, and a month-by-month view), revenue (sales), health (a plain check of what is working and what needs attention). Pass a period to see a time window and the change versus the earlier one; leave it out for how things stand now.`,
  parameters: { type: 'object', properties: { section: { type: 'string', enum: SECTIONS }, period: { type: 'string', enum: PERIODS } }, additionalProperties: false },
  async run(ctx, { section = 'overview', period } = {}) {
    const build = BUILDERS[section];
    if (!build) throw new ToolError(`Sections are: ${SECTIONS.join(', ')}.`);
    const { zone } = await loadBusiness(ctx);
    const p = resolvePeriod(period, ctx.now(), zone);
    return { section, ...(await build(ctx, p)) };
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
