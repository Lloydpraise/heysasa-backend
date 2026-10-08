// Campaigns: read how they are doing, plan and launch one, change or pause it, and run the auto campaigns.
//
// Launching and editing are ports of the dashboard's own logic (listsCampaignsService.js), done here so the assistant
// can do the same job from the server. They follow the same rules: one lead can only be in one running campaign,
// and people who opted out are never enrolled.
import { ToolError, asText, chunk, clip, fetchAll, must, plural, round1, uniq } from '../helpers.js';

const MAX_STEPS = 6;
const MAX_STEP_CHARS = 1000;
const stamp = (action) => ({ created_via: 'assistant', ba_action_id: action?.id ?? null });
const hoursLabel = (h) => (h === 0 ? 'right away' : h % 24 === 0 ? `after ${plural(h / 24, 'day')}` : `after ${plural(h, 'hour')}`);

// ── shared pieces ───────────────────────────────────────────────────────────
async function resolveInstance(ctx, wanted = null) {
  const rows = must(await ctx.db.from('whatsapp_sessions').select('instance_name, phone_number, status').eq('business_id', ctx.businessId).eq('status', 'connected').order('created_at', { ascending: false }), 'whatsapp sessions') ?? [];
  const usable = rows.filter((r) => r.instance_name);
  if (!usable.length) throw new ToolError('WhatsApp is not connected right now. Connect it first (Preferences, then WhatsApp), then I can do this.');
  if (wanted) {
    const match = usable.find((r) => r.instance_name === wanted);
    if (!match) throw new ToolError('That WhatsApp number is not connected right now.');
    return match;
  }
  return usable[0];
}

function cleanSteps(steps, { firstGapZero = true } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new ToolError('A campaign needs at least one message.');
  if (steps.length > MAX_STEPS) throw new ToolError(`A campaign can have at most ${MAX_STEPS} messages. Fewer, better messages work best.`);
  return steps.map((s, i) => {
    const content = asText(s?.content);
    if (!content) throw new ToolError(`Message ${i + 1} is empty.`);
    if (content.length > MAX_STEP_CHARS) throw new ToolError(`Message ${i + 1} is too long for WhatsApp. Keep it under ${MAX_STEP_CHARS} characters.`);
    const gap = Number(s.delay_hours ?? s.gap_hours ?? 0);
    if (!Number.isFinite(gap) || gap < 0 || gap > 720) throw new ToolError(`The gap before message ${i + 1} must be between 0 and 720 hours.`);
    return { content, delay_hours: i === 0 && firstGapZero ? 0 : Math.round(gap), condition: i === 0 ? null : (s.condition ?? null) };
  });
}

const stepPreview = (steps) => steps.map((s, i) => ({ n: i + 1, when: i === 0 ? 'First message' : `Then ${hoursLabel(s.delay_hours)}`, text: s.content }));

async function leadFlags(ctx, ids) {
  const out = new Map();
  for (const part of chunk(ids, 200)) {
    const rows = must(await ctx.db.from('v_lead_summary').select('id, lead_state, do_not_contact, follow_up_opted_out_at').eq('business_id', ctx.businessId).in('id', part), 'leads') ?? [];
    for (const r of rows) out.set(String(r.id), r);
  }
  return out;
}

const optedOut = (r) => !r || r.do_not_contact === true || r.lead_state === 'do_not_contact' || Boolean(r.follow_up_opted_out_at);

async function busyLeadSet(ctx, exceptCampaignId = null) {
  let q = ctx.db.from('campaigns').select('id').eq('business_id', ctx.businessId).eq('status', 'active');
  if (exceptCampaignId) q = q.neq('id', exceptCampaignId);
  const campaigns = must(await q, 'campaigns') ?? [];
  if (!campaigns.length) return new Set();
  const rows = await fetchAll((from, to) => ctx.db.from('campaign_enrollments').select('lead_id').in('campaign_id', campaigns.map((c) => c.id)).in('status', ['pending', 'active']).range(from, to));
  return new Set(rows.map((r) => String(r.lead_id)));
}

// Who would actually be messaged: members of the lists, minus opted-out people, minus people already in another running campaign.
export async function audienceFor(ctx, listIds, exceptCampaignId = null) {
  const lists = must(await ctx.db.from('lists').select('id, name, archived').eq('business_id', ctx.businessId).in('id', listIds), 'lists') ?? [];
  if (lists.length !== listIds.length) throw new ToolError('One of those lists was not found.');
  if (lists.some((l) => l.archived)) throw new ToolError('One of those lists is archived. Bring it back first.');
  const members = await fetchAll((from, to) => ctx.db.from('list_members').select('lead_id').in('list_id', listIds).range(from, to));
  const all = uniq(members.map((m) => m.lead_id));
  const flags = await leadFlags(ctx, all);
  const real = all.filter((id) => flags.has(String(id)));
  const optOut = real.filter((id) => optedOut(flags.get(String(id))));
  const busy = await busyLeadSet(ctx, exceptCampaignId);
  const optSet = new Set(optOut.map(String));
  const inOther = real.filter((id) => !optSet.has(String(id)) && busy.has(String(id)));
  const otherSet = new Set(inOther.map(String));
  const eligible = real.filter((id) => !optSet.has(String(id)) && !otherSet.has(String(id)));
  return { lists, total: real.length, optedOut: optOut.length, inOtherCampaign: inOther.length, eligible };
}

async function syncEnrollments(ctx, campaignId, leadIds, firstSendAtIso) {
  const wanted = new Set(leadIds.map(String));
  const existing = must(await ctx.db.from('campaign_enrollments').select('lead_id, status').eq('campaign_id', campaignId), 'enrollments') ?? [];
  const have = new Set(existing.map((e) => String(e.lead_id)));
  const stale = existing.filter((e) => ['pending', 'active'].includes(e.status) && !wanted.has(String(e.lead_id))).map((e) => e.lead_id);
  for (const part of chunk(stale, 200)) must(await ctx.db.from('campaign_enrollments').delete().eq('campaign_id', campaignId).in('lead_id', part).in('status', ['pending', 'active']), 'remove enrollments');
  const fresh = leadIds.filter((id) => !have.has(String(id)));
  for (const part of chunk(fresh, 500)) {
    must(await ctx.db.from('campaign_enrollments').insert(part.map((id) => ({ campaign_id: campaignId, lead_id: id, status: 'active', current_step: 0, next_send_at: firstSendAtIso }))), 'enroll leads');
  }
  return fresh.length;
}

async function ownCampaign(ctx, id) {
  const c = must(await ctx.db.from('campaigns').select('*').eq('business_id', ctx.businessId).eq('id', id).maybeSingle(), 'campaign');
  if (!c) throw new ToolError('I could not find that campaign.');
  return c;
}

// ── read tools ──────────────────────────────────────────────────────────────
const campaignRow = (r, steps = []) => ({
  id: r.campaign_id, name: r.name, status: r.status, list: r.list_name || null, people_in_it: Number(r.enrolled_count ?? 0),
  messages_sent: Number(r.sent_count ?? 0), people_reached: Number(r.reached_count ?? 0), replies: Number(r.replies_count ?? 0),
  reply_rate_percent: round1(r.response_rate ?? 0), sales_value: Number(r.realized_revenue ?? 0), sent_today: Number(r.sent_today ?? 0),
  daily_limit: r.daily_cap, ai_rewrites_messages: Boolean(r.ai_rewrite_enabled), sends_without_asking: Boolean(r.auto_approve),
  steps: steps.sort((a, b) => a.step_number - b.step_number).map((s) => ({ n: s.step_number, text: clip(s.content, 200), gap_hours: s.delay_hours, sent: s.sent_count ?? 0, replied: s.replied_count ?? 0, opt_outs: s.opt_outs ?? 0 })),
});

const list_campaigns = {
  name: 'list_campaigns', area: 'campaigns', kind: 'read', status: 'Checking your campaigns…',
  description: 'The business\'s campaigns with status and results (sent, replies, sales). Optionally only one status.',
  parameters: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'paused', 'completed', 'failed'] } }, additionalProperties: false },
  async run(ctx, args) {
    let q = ctx.db.from('v_campaign_summary').select('*').eq('business_id', ctx.businessId);
    if (args.status) q = q.eq('status', args.status);
    const rows = (must(await q, 'campaigns') ?? []).slice(0, 25);
    const autos = must(await ctx.db.from('v_auto_campaigns').select('campaign_id').eq('business_id', ctx.businessId), 'auto campaigns') ?? [];
    const autoIds = new Set(autos.map((a) => a.campaign_id).filter(Boolean));
    return { campaigns: rows.map((r) => ({ ...campaignRow(r), kind: autoIds.has(r.campaign_id) ? 'auto' : 'manual' })) };
  },
};

const get_campaign = {
  name: 'get_campaign', area: 'campaigns', kind: 'read', status: 'Opening that campaign…',
  description: 'One campaign in detail: each message, how many were sent and answered, and the sales it brought.',
  parameters: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
  async run(ctx, { campaign_id: id }) {
    await ownCampaign(ctx, id);
    const row = must(await ctx.db.from('v_campaign_summary').select('*').eq('business_id', ctx.businessId).eq('campaign_id', id).maybeSingle(), 'summary');
    const steps = must(await ctx.db.from('v_campaign_step_summary').select('*').eq('campaign_id', id), 'steps') ?? [];
    if (!row) throw new ToolError('That campaign has no results yet.');
    return campaignRow(row, steps);
  },
};

const get_auto_campaigns = {
  name: 'get_auto_campaigns', area: 'campaigns', kind: 'read', status: 'Checking your auto campaigns…',
  description: 'The ready-made campaigns, one per auto list (hot, cold, abandoned cart, repeat buyers…): the playbook, the messages, whether they are running, and how many people are ready.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const rows = must(await ctx.db.from('v_auto_campaigns').select('*').eq('business_id', ctx.businessId), 'auto campaigns') ?? [];
    return {
      auto_campaigns: rows.map((r) => ({
        rule_id: r.rule_id, list: r.list_name, name: r.campaign_name, goal: clip(r.objective, 200), playbook: clip(r.playbook, 400),
        steps: (Array.isArray(r.steps) ? r.steps : []).map((s, i) => ({ n: i + 1, text: clip(s.content, 200), gap_hours: i === 0 ? 0 : Number(s.delay_hours ?? 24) })),
        ai_rewrites_messages: r.ai_rewrite_enabled ?? true, sends_without_asking: r.auto_approve ?? false, daily_limit: r.daily_cap ?? 40,
        running: r.campaign_status === 'active', campaign_status: r.campaign_status || 'not started', people_ready: Number(r.ready_count ?? 0), customised: Boolean(r.customised),
      })),
    };
  },
};

// ── launch ──────────────────────────────────────────────────────────────────
const STEP_SCHEMA = {
  type: 'array', maxItems: MAX_STEPS,
  items: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The WhatsApp message text, in the owner\'s voice. Merge fields like {{first_name}} are allowed.' },
      delay_hours: { type: 'number', description: 'Hours to wait after the previous message. The first message is always 0.' },
    },
    required: ['content'], additionalProperties: false,
  },
};

const launch_campaign = {
  name: 'launch_campaign', area: 'campaigns', kind: 'propose', risk: 'critical',
  description: 'Start a campaign: a short series of WhatsApp messages sent to everyone on one or more lists. This sends real messages to customers, so it always waits for the owner\'s OK. Check list_campaigns first: a person can only be in one running campaign.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      list_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      steps: STEP_SCHEMA,
      daily_cap: { type: 'number', description: 'Most messages to send per day. Default 40. Keep it low for newer WhatsApp numbers.' },
      ai_rewrite: { type: 'boolean', description: 'Let the AI personalise each message before sending. Default true.' },
      auto_approve: { type: 'boolean', description: 'Send without the owner approving each step. Default false.' },
      smart_timing: { type: 'boolean', description: 'Send when each person is usually active. Default true.' },
      first_send_at: { type: 'string', description: 'When to send the first message, as an ISO date-time. Default now.' },
      sequence_mode: { type: 'string', enum: ['linear', 'conditional'] },
    },
    required: ['name', 'list_ids', 'steps'], additionalProperties: false,
  },
  status: 'Planning the campaign…',
  async plan(ctx, args) {
    const name = asText(args.name).slice(0, 80);
    if (name.length < 2) throw new ToolError('The campaign needs a name.');
    const listIds = uniq(args.list_ids);
    if (!listIds.length || listIds.length > 5) throw new ToolError('Pick between 1 and 5 lists.');
    const steps = cleanSteps(args.steps);
    const dailyCap = Math.min(300, Math.max(1, Math.round(Number(args.daily_cap ?? 40)) || 40));
    let firstSendAt = ctx.now();
    if (args.first_send_at) {
      firstSendAt = new Date(args.first_send_at);
      if (Number.isNaN(firstSendAt.getTime())) throw new ToolError('I could not understand the start time.');
      if (firstSendAt.getTime() < ctx.now().getTime() - 5 * 60_000) throw new ToolError('The start time is in the past.');
      if (firstSendAt.getTime() > ctx.now().getTime() + 30 * 86_400_000) throw new ToolError('Start within the next 30 days.');
    }
    if (!(await ctx.canAfford())) throw new ToolError('The balance is empty, so messages could not be sent. Top up first (Preferences, then Billing).');
    const instance = await resolveInstance(ctx);
    const audience = await audienceFor(ctx, listIds);
    if (!audience.eligible.length) throw new ToolError(`Nobody can be messaged from ${audience.lists.length === 1 ? 'that list' : 'those lists'}${audience.inOtherCampaign ? `: ${plural(audience.inOtherCampaign, 'person', 'people')} are already in another running campaign` : ''}${audience.optedOut ? `, and ${plural(audience.optedOut, 'person', 'people')} opted out` : ''}.`);
    const aiRewrite = args.ai_rewrite !== false;
    const autoApprove = args.auto_approve === true;
    const days = Math.ceil(audience.eligible.length / dailyCap);
    const lines = [
      `Sent from WhatsApp number ${instance.phone_number || instance.instance_name}`,
      `At most ${dailyCap} messages a day, so the first message reaches everyone in about ${plural(days, 'day')}`,
      aiRewrite ? 'The AI will personalise each message before it goes out' : 'Messages go out exactly as written',
      autoApprove ? 'Messages are sent without asking you each time' : 'You approve each message before it is sent',
    ];
    if (audience.optedOut) lines.push(`Left out: ${plural(audience.optedOut, 'person', 'people')} who opted out`);
    if (audience.inOtherCampaign) lines.push(`Left out: ${plural(audience.inOtherCampaign, 'person', 'people')} already in another running campaign`);
    return {
      title: `Start the campaign "${name}"`,
      params: {
        name, list_ids: listIds, steps, daily_cap: dailyCap, ai_rewrite: aiRewrite, auto_approve: autoApprove, smart_timing: args.smart_timing !== false,
        first_send_at: firstSendAt.toISOString(), sequence_mode: args.sequence_mode === 'conditional' ? 'conditional' : 'linear', instance_name: instance.instance_name,
      },
      preview: {
        headline: `Message ${plural(audience.eligible.length, 'person', 'people')} on ${audience.lists.map((l) => `"${l.name}"`).join(' and ')}`,
        lines, messages: stepPreview(steps), warning: 'This sends real WhatsApp messages to your customers.',
      },
    };
  },
  async execute(ctx, params, action) {
    if (!(await ctx.canAfford())) throw new ToolError('The balance is empty, so I did not start it. Top up first.');
    const instance = await resolveInstance(ctx, params.instance_name).catch(() => resolveInstance(ctx));
    const audience = await audienceFor(ctx, params.list_ids);
    if (!audience.eligible.length) throw new ToolError('Nobody can be messaged any more (they may have joined another campaign or opted out), so I did not start it.');
    const campaign = must(await ctx.db.from('campaigns').insert({
      business_id: ctx.businessId, list_id: params.list_ids[0], name: params.name, whatsapp_instance_name: instance.instance_name,
      sequence_mode: params.sequence_mode, smart_timing: params.smart_timing, status: 'active', gateway_type: 'Baileys', daily_cap: params.daily_cap,
      ai_rewrite_enabled: params.ai_rewrite, auto_approve: params.auto_approve, ...stamp(action),
    }).select().single(), 'create campaign');
    try {
      must(await ctx.db.from('campaign_steps').insert(params.steps.map((s, i) => ({ campaign_id: campaign.id, step_number: i + 1, content: s.content, media: null, delay_hours: s.delay_hours, condition: s.condition }))), 'create steps');
      await syncEnrollments(ctx, campaign.id, audience.eligible, params.first_send_at);
    } catch (error) {
      await ctx.db.from('campaigns').delete().eq('id', campaign.id).eq('business_id', ctx.businessId);
      throw error;
    }
    return {
      summary: `Started "${params.name}" for ${plural(audience.eligible.length, 'person', 'people')}. ${params.auto_approve ? 'Messages go out by themselves.' : 'Approve each message in your Leads tab.'}`,
      result: { campaign_id: campaign.id, enrolled: audience.eligible.length }, before: { status: null },
    };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('campaigns').update({ status: 'paused' }).eq('business_id', ctx.businessId).eq('id', action.result.campaign_id), 'pause campaign');
    return { summary: 'Paused the campaign. Messages already sent cannot be taken back.' };
  },
};

// ── pause / resume ──────────────────────────────────────────────────────────
function statusTool({ name, from, to, risk, title, verb, description }) {
  return {
    name, area: 'campaigns', kind: 'propose', risk, status: 'Getting that ready…', description,
    parameters: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
    async plan(ctx, { campaign_id: id }) {
      const c = await ownCampaign(ctx, id);
      if (c.status !== from) throw new ToolError(`"${c.name}" is ${c.status}, so it cannot be ${verb}.`);
      return { title: `${title} "${c.name}"`, params: { campaign_id: c.id }, preview: { headline: `${title} "${c.name}"`, lines: [to === 'paused' ? 'No more messages will go out until it is resumed.' : 'Messages will start going out again.'] } };
    },
    async execute(ctx, params) {
      const c = await ownCampaign(ctx, params.campaign_id);
      if (c.status !== from) throw new ToolError(`"${c.name}" is now ${c.status}, so I changed nothing.`);
      must(await ctx.db.from('campaigns').update({ status: to }).eq('business_id', ctx.businessId).eq('id', c.id), 'set campaign status');
      return { summary: `${to === 'paused' ? 'Paused' : 'Resumed'} "${c.name}".`, result: { campaign_id: c.id }, before: { status: from } };
    },
    async undo(ctx, action) {
      must(await ctx.db.from('campaigns').update({ status: from }).eq('business_id', ctx.businessId).eq('id', action.result.campaign_id), 'restore campaign status');
      return { summary: `Put it back to ${from}.` };
    },
  };
}

const pause_campaign = statusTool({ name: 'pause_campaign', from: 'active', to: 'paused', risk: 'normal', title: 'Pause', verb: 'paused', description: 'Stop a running campaign from sending more messages. Safe: it can be resumed.' });
const resume_campaign = statusTool({ name: 'resume_campaign', from: 'paused', to: 'active', risk: 'critical', title: 'Resume', verb: 'resumed', description: 'Start a paused campaign sending again. Always waits for the owner\'s OK.' });

// ── edit ────────────────────────────────────────────────────────────────────
async function writeSteps(ctx, campaignId, steps) {
  const existing = must(await ctx.db.from('campaign_steps').select('id, step_number').eq('campaign_id', campaignId), 'steps') ?? [];
  const byNumber = new Map(existing.map((s) => [s.step_number, s.id]));
  const extra = existing.filter((s) => s.step_number > steps.length).map((s) => s.id);
  if (extra.length) must(await ctx.db.from('campaign_steps').delete().in('id', extra), 'remove steps');
  for (const [i, step] of steps.entries()) {
    const payload = { step_number: i + 1, content: step.content, media: step.media ?? null, delay_hours: step.delay_hours, condition: i === 0 ? null : (step.condition ?? null) };
    if (byNumber.has(i + 1)) must(await ctx.db.from('campaign_steps').update(payload).eq('id', byNumber.get(i + 1)).eq('campaign_id', campaignId), 'update step');
    else must(await ctx.db.from('campaign_steps').insert({ campaign_id: campaignId, ...payload }), 'add step');
    // Messages already waiting in the queue carry the new wording too.
    must(await ctx.db.from('follow_up_queue').update({ final_message: payload.content, media: payload.media }).eq('campaign_id', campaignId).eq('campaign_step', i + 1).in('status', ['pending', 'ready_to_send']), 'update queued messages');
  }
}

const edit_campaign = {
  name: 'edit_campaign', area: 'campaigns', kind: 'propose', risk: 'critical',
  description: 'Change a running or paused campaign: its name, the messages and gaps, the daily limit, or the AI rewrite / send-without-asking switches. Messages already sent are not changed; waiting messages get the new wording. Always waits for the owner\'s OK.',
  parameters: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string' }, name: { type: 'string' }, steps: STEP_SCHEMA, daily_cap: { type: 'number' },
      ai_rewrite: { type: 'boolean' }, auto_approve: { type: 'boolean' },
    },
    required: ['campaign_id'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const c = await ownCampaign(ctx, args.campaign_id);
    if (['completed', 'failed'].includes(c.status)) throw new ToolError('Finished campaigns cannot be changed. Start a new one instead.');
    const patch = {};
    const lines = [];
    if (args.name !== undefined) { const n = asText(args.name).slice(0, 80); if (n.length < 2) throw new ToolError('The new name is too short.'); patch.name = n; lines.push(`Name: "${c.name}" to "${n}"`); }
    if (args.daily_cap !== undefined) { const d = Math.min(300, Math.max(1, Math.round(Number(args.daily_cap)) || 0)); if (!d) throw new ToolError('The daily limit must be a number.'); patch.daily_cap = d; lines.push(`Daily limit: ${c.daily_cap} to ${d}`); }
    if (args.ai_rewrite !== undefined) { patch.ai_rewrite_enabled = args.ai_rewrite === true; lines.push(`AI personalises messages: ${patch.ai_rewrite_enabled ? 'on' : 'off'}`); }
    if (args.auto_approve !== undefined) { patch.auto_approve = args.auto_approve === true; lines.push(patch.auto_approve ? 'Messages will be sent without asking you each time' : 'You will approve each message first'); }
    const steps = args.steps ? cleanSteps(args.steps) : null;
    if (steps) lines.push(`${plural(steps.length, 'message')} in the series (replaces the current ones)`);
    if (!Object.keys(patch).length && !steps) throw new ToolError('Nothing to change.');
    return { title: `Change the campaign "${c.name}"`, params: { campaign_id: c.id, patch, steps }, preview: { headline: `Change "${c.name}"`, lines, ...(steps ? { messages: stepPreview(steps) } : {}), warning: c.status === 'active' ? 'This campaign is running now, so the change applies to messages not yet sent.' : undefined } };
  },
  async execute(ctx, params) {
    const c = await ownCampaign(ctx, params.campaign_id);
    if (['completed', 'failed'].includes(c.status)) throw new ToolError('That campaign has finished, so I changed nothing.');
    const oldSteps = must(await ctx.db.from('campaign_steps').select('step_number, content, media, delay_hours, condition').eq('campaign_id', c.id).order('step_number'), 'steps') ?? [];
    const before = { patch: Object.fromEntries(Object.keys(params.patch).map((k) => [k, c[k]])), steps: params.steps ? oldSteps : null };
    if (Object.keys(params.patch).length) must(await ctx.db.from('campaigns').update(params.patch).eq('business_id', ctx.businessId).eq('id', c.id), 'edit campaign');
    if (params.steps) await writeSteps(ctx, c.id, params.steps);
    return { summary: `Updated "${params.patch.name ?? c.name}".`, result: { campaign_id: c.id }, before };
  },
  async undo(ctx, action) {
    const b = action.before ?? {};
    const id = action.result.campaign_id;
    if (b.patch && Object.keys(b.patch).length) must(await ctx.db.from('campaigns').update(b.patch).eq('business_id', ctx.businessId).eq('id', id), 'undo campaign');
    if (b.steps) await writeSteps(ctx, id, b.steps.map((s) => ({ content: s.content, media: s.media, delay_hours: s.delay_hours, condition: s.condition })));
    return { summary: 'Put the campaign back as it was.' };
  },
};

// ── auto campaigns ──────────────────────────────────────────────────────────
const AUTO_ERRORS = {
  instance_required: 'Choose a connected WhatsApp number first.',
  instance_not_connected: 'That WhatsApp number is not connected right now.',
  auto_list_not_enabled: 'Turn on that auto list first.',
  no_steps_configured: 'Add at least one message to it first.',
};
const autoError = (error) => {
  const key = Object.keys(AUTO_ERRORS).find((code) => String(error?.message || '').includes(code));
  return key ? new ToolError(AUTO_ERRORS[key]) : error;
};

async function autoRow(ctx, ruleId) {
  const row = must(await ctx.db.from('v_auto_campaigns').select('*').eq('business_id', ctx.businessId).eq('rule_id', ruleId).maybeSingle(), 'auto campaign');
  if (!row) throw new ToolError('That auto campaign is not available. Turn on its auto list first.');
  return row;
}

const RULE_IDS = ['hot_inquiries', 'unanswered', 'price_hesitant', 'cold_dormant', 'cart_abandoners', 'post_purchase', 'low_intent'];

const activate_auto_campaign = {
  name: 'activate_auto_campaign', area: 'campaigns', kind: 'propose', risk: 'critical',
  description: 'Start the ready-made campaign for an auto list (it messages the people who land in that list, now and later). Sends real messages, so it always waits for the owner\'s OK.',
  parameters: { type: 'object', properties: { rule_id: { type: 'string', enum: RULE_IDS } }, required: ['rule_id'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, { rule_id: ruleId }) {
    const row = await autoRow(ctx, ruleId);
    if (row.campaign_status === 'active') throw new ToolError('That auto campaign is already running.');
    const steps = Array.isArray(row.steps) ? row.steps : [];
    if (!steps.length) throw new ToolError('That auto campaign has no messages yet. Set them up first.');
    if (!(await ctx.canAfford())) throw new ToolError('The balance is empty, so messages could not be sent. Top up first.');
    await resolveInstance(ctx, row.whatsapp_instance_name || null).catch((e) => { if (row.whatsapp_instance_name) return resolveInstance(ctx); throw e; });
    const msgs = steps.map((s, i) => ({ content: s.content, delay_hours: i === 0 ? 0 : Number(s.delay_hours ?? 24) }));
    return {
      title: `Start the "${row.list_name}" auto campaign`, params: { rule_id: ruleId },
      preview: {
        headline: `Message the people in "${row.list_name}"${row.ready_count ? ` (${plural(Number(row.ready_count), 'person', 'people')} ready now)` : ''}, and anyone who joins later`,
        lines: [row.ai_rewrite_enabled ?? true ? 'The AI personalises each message' : 'Messages go out as written', row.auto_approve ? 'Messages are sent without asking you each time' : 'You approve each message first', `At most ${row.daily_cap ?? 40} messages a day`],
        messages: stepPreview(msgs), warning: 'This sends real WhatsApp messages to your customers.',
      },
    };
  },
  async execute(ctx, params) {
    const { data, error } = await ctx.userRpc('activate_auto_campaign', { p_business_id: ctx.businessId, p_rule_id: params.rule_id });
    if (error) throw autoError(error);
    const row = await autoRow(ctx, params.rule_id).catch(() => null);
    return { summary: `Started the "${row?.list_name ?? 'auto'}" auto campaign.`, result: { rule_id: params.rule_id, campaign: data ?? null } };
  },
  async undo(ctx, action) {
    const row = await autoRow(ctx, action.result.rule_id);
    if (!row.campaign_id) throw new ToolError('I could not find the campaign to pause.');
    must(await ctx.db.from('campaigns').update({ status: 'paused' }).eq('business_id', ctx.businessId).eq('id', row.campaign_id), 'pause auto campaign');
    return { summary: 'Paused it. Messages already sent cannot be taken back.' };
  },
};

const set_auto_campaign = {
  name: 'set_auto_campaign', area: 'campaigns', kind: 'propose', risk: 'critical',
  description: 'Change how an auto campaign works: its goal, the "how to follow up" playbook, the messages and gaps, AI rewrite, send-without-asking, or the daily limit. Only send what changes. If it is running, the change reaches it. Always waits for the owner\'s OK.',
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', enum: RULE_IDS }, objective: { type: 'string' }, playbook: { type: 'string', description: 'How the AI should follow up these people. Under 150 words.' },
      steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'object', properties: { content: { type: 'string' }, gap_hours: { type: 'number' } }, required: ['content'], additionalProperties: false } },
      sequence_mode: { type: 'string', enum: ['linear', 'conditional'] }, ai_rewrite: { type: 'boolean' }, auto_approve: { type: 'boolean' }, daily_cap: { type: 'number' },
    },
    required: ['rule_id'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const row = await autoRow(ctx, args.rule_id);
    const patch = {};
    const lines = [];
    if (args.objective !== undefined) { patch.objective = asText(args.objective).slice(0, 600); lines.push('New goal for this campaign'); }
    if (args.playbook !== undefined) { patch.playbook = asText(args.playbook).slice(0, 2000); lines.push('New "how to follow up" playbook'); }
    if (args.steps !== undefined) {
      const steps = cleanSteps(args.steps.map((s) => ({ content: s.content, delay_hours: s.gap_hours })));
      patch.steps = steps.map((s, i) => ({ step_number: i + 1, content: s.content, delay_hours: i === 0 ? 0 : s.delay_hours }));
      lines.push(`${plural(steps.length, 'message')} in the series`);
    }
    if (args.sequence_mode !== undefined) patch.sequence_mode = args.sequence_mode === 'conditional' ? 'conditional' : 'linear';
    if (args.ai_rewrite !== undefined) { patch.ai_rewrite_enabled = args.ai_rewrite === true; lines.push(`AI personalises messages: ${patch.ai_rewrite_enabled ? 'on' : 'off'}`); }
    if (args.auto_approve !== undefined) { patch.auto_approve = args.auto_approve === true; lines.push(patch.auto_approve ? 'Messages are sent without asking you each time' : 'You approve each message first'); }
    if (args.daily_cap !== undefined) { const d = Math.min(300, Math.max(1, Math.round(Number(args.daily_cap)) || 0)); if (!d) throw new ToolError('The daily limit must be a number.'); patch.daily_cap = d; lines.push(`Daily limit: ${d}`); }
    if (!Object.keys(patch).length) throw new ToolError('Nothing to change.');
    const msgs = patch.steps ? patch.steps.map((s) => ({ content: s.content, delay_hours: s.delay_hours })) : null;
    return {
      title: `Change the "${row.list_name}" auto campaign`, params: { rule_id: args.rule_id, patch },
      preview: { headline: `Change the "${row.list_name}" auto campaign`, lines, ...(msgs ? { messages: stepPreview(msgs) } : {}), warning: row.campaign_status === 'active' ? 'It is running now, so this reaches messages not yet sent.' : undefined },
    };
  },
  async execute(ctx, params) {
    await autoRow(ctx, params.rule_id);
    const old = must(await ctx.db.from('auto_campaign_configs').select('*').eq('business_id', ctx.businessId).eq('rule_id', params.rule_id).maybeSingle(), 'config');
    const { error } = await ctx.db.from('auto_campaign_configs').upsert({ business_id: ctx.businessId, rule_id: params.rule_id, ...params.patch, updated_at: ctx.now().toISOString() }, { onConflict: 'business_id,rule_id' });
    if (error) throw new Error(`save config: ${error.message}`);
    const applied = await ctx.userRpc('apply_auto_campaign_config', { p_business_id: ctx.businessId, p_rule_id: params.rule_id });
    if (applied.error) throw autoError(applied.error);
    return { summary: 'Saved the changes to the auto campaign.', result: { rule_id: params.rule_id }, before: { config: old ?? null } };
  },
  async undo(ctx, action) {
    const ruleId = action.result.rule_id;
    const old = action.before?.config;
    if (old) must(await ctx.db.from('auto_campaign_configs').upsert(old, { onConflict: 'business_id,rule_id' }), 'restore config');
    else must(await ctx.db.from('auto_campaign_configs').update({ objective: null, playbook: null, steps: null, sequence_mode: null, ai_rewrite_enabled: null, auto_approve: null, daily_cap: null }).eq('business_id', ctx.businessId).eq('rule_id', ruleId), 'reset config');
    const applied = await ctx.userRpc('apply_auto_campaign_config', { p_business_id: ctx.businessId, p_rule_id: ruleId });
    if (applied.error) throw autoError(applied.error);
    return { summary: 'Put the auto campaign back as it was.' };
  },
};

export default [list_campaigns, get_campaign, get_auto_campaigns, launch_campaign, pause_campaign, resume_campaign, edit_campaign, activate_auto_campaign, set_auto_campaign];
