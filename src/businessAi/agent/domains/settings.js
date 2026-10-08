// Settings: follow-up preferences, business details, and the chat AI switch. Same limits as the Preferences page.
import { ToolError, asText, must } from '../helpers.js';

// Keep in sync with FIELD_MAP in src/followupSettingsRoutes.js.
export const FOLLOWUP_FIELDS = {
  followup_enabled: { col: 'followup_ai_enabled', label: 'Follow-ups on', type: 'boolean' },
  max_per_lead: { col: 'followup_max_per_lead', label: 'Most follow-ups per person', type: 'int', min: 0, max: 20 },
  daily_cap: { col: 'followup_daily_cap', label: 'Most follow-ups per day', type: 'int', min: 0, max: 500 },
  quiet_start: { col: 'followup_quiet_start', label: 'Quiet hours start (hour 0-23)', type: 'int', min: 0, max: 23 },
  quiet_end: { col: 'followup_quiet_end', label: 'Quiet hours end (hour 0-23)', type: 'int', min: 0, max: 23 },
  active_days: { col: 'followup_active_days', label: 'Days to send (0 = Sunday … 6 = Saturday)', type: 'days' },
  zone_recent_days: { col: 'followup_zone_recent', label: 'Recent chats: up to this many days', type: 'int', min: 0, max: 365 },
  zone_recent_mode: { col: 'followup_zone_recent_mode', label: 'Recent chats: how to follow up', type: 'mode' },
  zone_medium_days: { col: 'followup_zone_medium', label: 'Middle chats: up to this many days', type: 'int', min: 0, max: 730 },
  zone_medium_mode: { col: 'followup_zone_medium_mode', label: 'Middle chats: how to follow up', type: 'mode' },
  zone_old_mode: { col: 'followup_zone_old_mode', label: 'Old chats: how to follow up', type: 'mode' },
  stop_at_stage: { col: 'followup_stop_at_stage', label: 'Stop following up at stage', type: 'text' },
  alert_at_stage: { col: 'followup_alert_at_stage', label: 'Alert me at stage', type: 'text' },
  nudge_enabled: { col: 'followup_nudge_enabled', label: 'Remind me about waiting approvals', type: 'boolean' },
  nudge_min_pending: { col: 'followup_nudge_min_pending', label: 'Remind me when this many are waiting', type: 'int', min: 0, max: 500 },
  nudge_interval_hrs: { col: 'followup_nudge_interval_hrs', label: 'Hours between reminders', type: 'int', min: 1, max: 168 },
  hot_lead_alert: { col: 'hot_lead_alert_enabled', label: 'Alert me about hot leads', type: 'boolean' },
  hot_lead_threshold: { col: 'hot_lead_intent_threshold', label: 'Hot lead score (0-10)', type: 'int', min: 0, max: 10 },
};
const MODES = ['approval', 'manual', 'auto'];
const MODE_WORDS = { approval: 'you approve each message', manual: 'only reminds you, you send', auto: 'sends by itself' };

const BUSINESS_FIELDS = { name: 'Business name', industry: 'Industry', website_url: 'Website', currency: 'Currency', timezone: 'Time zone', language: 'Language' };

function cleanFollowup(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    const f = FOLLOWUP_FIELDS[key];
    if (!f) throw new ToolError(`"${key}" is not a follow-up setting I can change.`);
    if (f.type === 'boolean') out[key] = value === true;
    else if (f.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new ToolError(`${f.label} must be a whole number from ${f.min} to ${f.max}.`);
      out[key] = n;
    } else if (f.type === 'mode') {
      if (!MODES.includes(value)) throw new ToolError(`${f.label} must be one of: ${MODES.join(', ')}.`);
      out[key] = value;
    } else if (f.type === 'days') {
      if (!Array.isArray(value) || !value.length || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ToolError('Days must be numbers from 0 (Sunday) to 6 (Saturday).');
      out[key] = [...new Set(value)].sort();
    } else out[key] = asText(value).slice(0, 80);
  }
  if (out.zone_recent_days != null && out.zone_medium_days != null && out.zone_recent_days >= out.zone_medium_days) throw new ToolError('The "recent" days must be fewer than the "middle" days.');
  return out;
}

const show = (key, v) => {
  if (v === null || v === undefined) return 'not set';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.join(', ');
  if (FOLLOWUP_FIELDS[key]?.type === 'mode') return `${v} (${MODE_WORDS[v] ?? v})`;
  return String(v);
};

const get_settings = {
  name: 'get_settings', area: 'settings', kind: 'read', status: 'Checking your settings…',
  description: 'Current settings: follow-up preferences (with what each means), the business details, and the chat AI switch and daily limit.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const b = must(await ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(), 'business');
    if (!b) throw new ToolError('I could not load the settings.');
    return {
      followups: Object.fromEntries(Object.entries(FOLLOWUP_FIELDS).map(([k, f]) => [k, { meaning: f.label, value: b[f.col] ?? null }])),
      follow_up_modes: MODE_WORDS,
      business: Object.fromEntries(Object.entries(BUSINESS_FIELDS).map(([k, label]) => [k, { meaning: label, value: b[k] ?? null }])),
      chat_ai: { answering_customers_by_itself: b.chat_ai_enabled === true, chats_per_day_limit: b.chat_ai_daily_cap ?? 0, pauses_after_owner_replies_minutes: b.chat_ai_human_pause_minutes ?? 60 },
      subscription_active: b.subscription_active !== false,
    };
  },
};

async function currentRow(ctx, cols) {
  const full = must(await ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(), 'business');
  if (!full) throw new ToolError('I could not load the settings.');
  return Object.fromEntries(cols.map((c) => [c, full[c] ?? null]));
}

const set_followup_settings = {
  name: 'set_followup_settings', area: 'settings', kind: 'propose', risk: 'critical',
  description: 'Change follow-up preferences (on/off, daily limits, quiet hours, days, how recent/middle/old chats are followed up, reminders, hot lead alerts). Send only what changes. Always waits for the owner\'s OK because it changes how customers are messaged.',
  parameters: { type: 'object', properties: { changes: { type: 'object', description: 'Setting name to new value, for example {"quiet_start": 21, "quiet_end": 7}. Names come from get_settings.', additionalProperties: true } }, required: ['changes'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const changes = cleanFollowup(args.changes);
    if (!Object.keys(changes).length) throw new ToolError('Tell me what to change.');
    const now = await currentRow(ctx, Object.keys(changes).map((k) => FOLLOWUP_FIELDS[k].col));
    const changed = Object.entries(changes).filter(([k, v]) => JSON.stringify(now[FOLLOWUP_FIELDS[k].col]) !== JSON.stringify(v));
    if (!changed.length) throw new ToolError('Those are already your settings.');
    return {
      title: 'Change follow-up settings', params: { changes: Object.fromEntries(changed) },
      preview: { headline: 'Follow-up settings', changes: changed.map(([k, v]) => ({ label: FOLLOWUP_FIELDS[k].label, from: show(k, now[FOLLOWUP_FIELDS[k].col]), to: show(k, v) })), warning: changed.some(([k, v]) => k.endsWith('_mode') && v === 'auto') ? 'Auto means HeySasa sends follow-ups by itself without asking you.' : undefined },
    };
  },
  async execute(ctx, params) {
    const changes = cleanFollowup(params.changes);
    const cols = Object.keys(changes).map((k) => FOLLOWUP_FIELDS[k].col);
    const before = await currentRow(ctx, cols);
    must(await ctx.db.from('businesses').update(Object.fromEntries(Object.entries(changes).map(([k, v]) => [FOLLOWUP_FIELDS[k].col, v]))).eq('business_id', ctx.businessId), 'save settings');
    return { summary: `Changed ${Object.keys(changes).length === 1 ? FOLLOWUP_FIELDS[Object.keys(changes)[0]].label.toLowerCase() : `${Object.keys(changes).length} follow-up settings`}.`, result: { keys: Object.keys(changes) }, before };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('businesses').update(action.before).eq('business_id', ctx.businessId), 'undo settings');
    return { summary: 'Put the settings back.' };
  },
};

const set_business_info = {
  name: 'set_business_info', area: 'settings', kind: 'propose', risk: 'normal',
  description: 'Change business details: name, industry, website, currency, time zone, language. Send only what changes.',
  parameters: { type: 'object', properties: Object.fromEntries(Object.keys(BUSINESS_FIELDS).map((k) => [k, { type: 'string' }])), additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const patch = {};
    for (const key of Object.keys(BUSINESS_FIELDS)) if (args[key] !== undefined) patch[key] = asText(args[key]).slice(0, 200);
    if ('name' in patch && patch.name.length < 2) throw new ToolError('The business name is too short.');
    if (!Object.keys(patch).length) throw new ToolError('Tell me what to change.');
    const now = await currentRow(ctx, Object.keys(patch));
    const changed = Object.entries(patch).filter(([k, v]) => (now[k] ?? '') !== v);
    if (!changed.length) throw new ToolError('Those are already your details.');
    return { title: 'Change business details', params: { patch: Object.fromEntries(changed) }, preview: { headline: 'Business details', changes: changed.map(([k, v]) => ({ label: BUSINESS_FIELDS[k], from: now[k] || 'not set', to: v })) } };
  },
  async execute(ctx, params) {
    const before = await currentRow(ctx, Object.keys(params.patch));
    must(await ctx.db.from('businesses').update(params.patch).eq('business_id', ctx.businessId), 'save business');
    return { summary: 'Updated your business details.', result: { keys: Object.keys(params.patch) }, before };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('businesses').update(action.before).eq('business_id', ctx.businessId), 'undo business');
    return { summary: 'Put the details back.' };
  },
};

const set_chat_ai = {
  name: 'set_chat_ai', area: 'settings', kind: 'propose', risk: 'critical',
  description: 'Switch the chat AI (it answers customers on WhatsApp by itself) on or off, set how many chats it may handle per day, or how long it stays quiet after the owner replies. Before turning it on, check the persona pack and products are ready. Always waits for the owner\'s OK.',
  parameters: { type: 'object', properties: { enabled: { type: 'boolean' }, daily_cap: { type: 'integer', minimum: 0, maximum: 1000 }, human_pause_minutes: { type: 'integer', minimum: 0, maximum: 1440 } }, additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const patch = {};
    if (args.enabled !== undefined) patch.chat_ai_enabled = args.enabled === true;
    if (args.daily_cap !== undefined) { const n = Number(args.daily_cap); if (!Number.isInteger(n) || n < 0 || n > 1000) throw new ToolError('The daily limit must be a whole number from 0 to 1000.'); patch.chat_ai_daily_cap = n; }
    if (args.human_pause_minutes !== undefined) { const n = Number(args.human_pause_minutes); if (!Number.isInteger(n) || n < 0 || n > 1440) throw new ToolError('The quiet time must be from 0 to 1440 minutes.'); patch.chat_ai_human_pause_minutes = n; }
    if (!Object.keys(patch).length) throw new ToolError('Tell me what to change.');
    const now = await currentRow(ctx, [...Object.keys(patch), 'chat_ai_daily_cap', 'persona_pack_status']);
    const nextCap = patch.chat_ai_daily_cap ?? now.chat_ai_daily_cap ?? 0;
    if (patch.chat_ai_enabled === true && nextCap <= 0) throw new ToolError('The chat AI needs a daily limit above 0 to answer anyone. Tell me a limit, like 30 chats a day.');
    if (patch.chat_ai_enabled === true && now.persona_pack_status !== 'ready') throw new ToolError('The persona pack is not ready yet, so the AI would not know how to talk like the business. Build that first.');
    const lines = [];
    if ('chat_ai_enabled' in patch) lines.push({ label: 'Answers customers by itself', from: now.chat_ai_enabled ? 'on' : 'off', to: patch.chat_ai_enabled ? 'on' : 'off' });
    if ('chat_ai_daily_cap' in patch) lines.push({ label: 'Chats per day', from: String(now.chat_ai_daily_cap ?? 0), to: String(patch.chat_ai_daily_cap) });
    if ('chat_ai_human_pause_minutes' in patch) lines.push({ label: 'Stays quiet after you reply (minutes)', from: String(now.chat_ai_human_pause_minutes ?? 60), to: String(patch.chat_ai_human_pause_minutes) });
    return { title: patch.chat_ai_enabled === true ? 'Turn on the chat AI' : patch.chat_ai_enabled === false ? 'Turn off the chat AI' : 'Change chat AI limits', params: { patch }, preview: { headline: 'Chat AI', changes: lines, warning: patch.chat_ai_enabled === true ? 'The AI will start replying to customers on WhatsApp. Each reply uses a little of your balance.' : undefined } };
  },
  async execute(ctx, params) {
    const before = await currentRow(ctx, Object.keys(params.patch));
    must(await ctx.db.from('businesses').update(params.patch).eq('business_id', ctx.businessId), 'save chat ai');
    const on = params.patch.chat_ai_enabled;
    return { summary: on === true ? 'Turned the chat AI on.' : on === false ? 'Turned the chat AI off.' : 'Updated the chat AI limits.', result: { keys: Object.keys(params.patch) }, before };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('businesses').update(action.before).eq('business_id', ctx.businessId), 'undo chat ai');
    return { summary: 'Put the chat AI back as it was.' };
  },
};

export default [get_settings, set_followup_settings, set_business_info, set_chat_ai];
