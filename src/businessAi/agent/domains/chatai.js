// Chat AI setup: flows (special instructions for chats from an ad or a list) and skills (how it handles situations).
import { ToolError, asText, clip, isUuid, must, uniq } from '../helpers.js';

const MAX_INSTRUCTIONS = 4000;

const flowView = (f) => ({ id: f.id, name: f.name, on: Boolean(f.enabled), priority: f.priority, goal: clip(f.goal, 200) || null, instructions: clip(f.instructions, 500), skills: f.skill_keys ?? [], applies_to: { ad_ids: f.trigger?.ad_ids ?? [], list_ids: f.trigger?.list_ids ?? [] } });

const SKILL_KEY = /^[a-z][a-z0-9_]{2,39}$/;

// Ads and lists a flow can be pointed at, so the assistant never has to guess an id.
async function targetsFor(ctx) {
  const [ads, lists] = await Promise.all([
    ctx.db.from('v_ad_leaderboard').select('ad_id, ad_headline, ad_platform, lead_count').eq('business_id', ctx.businessId).order('lead_count', { ascending: false }).limit(20),
    ctx.db.from('lists').select('id, name, type, archived').eq('business_id', ctx.businessId),
  ]);
  return {
    ads: (must(ads, 'ads') ?? []).map((a) => ({ ad_id: a.ad_id, headline: clip(a.ad_headline, 80) || 'Untitled ad', platform: a.ad_platform || undefined, leads: a.lead_count })),
    lists: (must(lists, 'lists') ?? []).filter((l) => !l.archived).map((l) => ({ id: l.id, name: l.name, kind: l.type === 'auto' ? 'auto' : 'manual' })),
  };
}

const nameTargets = (trigger, targets) => ({
  ads: (trigger?.ad_ids ?? []).map((id) => targets.ads.find((a) => String(a.ad_id) === String(id))?.headline ?? `ad ${id}`),
  lists: (trigger?.list_ids ?? []).map((id) => targets.lists.find((l) => l.id === id)?.name ?? 'a list'),
});

const get_chat_ai_setup = {
  name: 'get_chat_ai_setup', area: 'chat_ai', kind: 'read', status: 'Checking the chat AI setup…',
  description: 'How the chat AI is set up: whether it is on, its flows (extra instructions for chats from certain ads or lists), its skills (how it handles situations like price questions or handing over to the owner), and the ads and lists a new flow can be pointed at. Use get_flow or get_chat_skill to read one in full.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const [flows, skills, business, targets] = await Promise.all([
      ctx.db.from('chat_flows').select('*').eq('business_id', ctx.businessId).order('priority', { ascending: false }),
      ctx.db.from('chat_ai_skills').select('id, key, title, when_to_use, instructions, enabled').eq('business_id', ctx.businessId),
      ctx.db.from('businesses').select('*').eq('business_id', ctx.businessId).maybeSingle(),
      targetsFor(ctx),
    ]);
    const b = must(business, 'business') ?? {};
    return {
      chat_ai_on: b.chat_ai_enabled === true, chats_per_day_limit: b.chat_ai_daily_cap ?? 0,
      flows: (must(flows, 'flows') ?? []).map((f) => ({ ...flowView(f), applies_to_names: nameTargets(f.trigger, targets) })),
      skills: (must(skills, 'skills') ?? []).map((s) => ({ key: s.key, title: s.title, on: Boolean(s.enabled), when_to_use: clip(s.when_to_use, 160), instructions: clip(s.instructions, 400) })),
      can_point_a_flow_at: targets,
    };
  },
};

const get_flow = {
  name: 'get_flow', area: 'chat_ai', kind: 'read', status: 'Opening that flow…',
  description: 'One flow in full: its goal, complete instructions, skills, whether it is on, and which ads and lists it applies to (by name).',
  parameters: { type: 'object', properties: { flow_id: { type: 'string' } }, required: ['flow_id'], additionalProperties: false },
  async run(ctx, { flow_id: id }) {
    const f = must(await ctx.db.from('chat_flows').select('*').eq('business_id', ctx.businessId).eq('id', id).maybeSingle(), 'flow');
    if (!f) throw new ToolError('I could not find that flow.');
    const targets = await targetsFor(ctx);
    return { id: f.id, name: f.name, on: Boolean(f.enabled), priority: f.priority, goal: f.goal || null, instructions: f.instructions, skills: f.skill_keys ?? [], applies_to: nameTargets(f.trigger, targets), made_by_assistant: f.created_via === 'assistant' };
  },
};

const get_chat_skill = {
  name: 'get_chat_skill', area: 'chat_ai', kind: 'read', status: 'Opening that skill…',
  description: 'One chat AI skill in full: when it is used and its complete instructions.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  async run(ctx, { key }) {
    const s = must(await ctx.db.from('chat_ai_skills').select('key, title, when_to_use, instructions, enabled').eq('business_id', ctx.businessId).eq('key', asText(key)).maybeSingle(), 'skill');
    if (!s) throw new ToolError('I could not find that skill. Check get_chat_ai_setup for the names.');
    return { key: s.key, title: s.title, on: Boolean(s.enabled), when_to_use: s.when_to_use, instructions: s.instructions };
  },
};

async function validateTargets(ctx, trigger) {
  const adIds = uniq(trigger?.ad_ids ?? []).map(String).slice(0, 50);
  const listIds = uniq(trigger?.list_ids ?? []).filter(isUuid).slice(0, 50);
  if (listIds.length) {
    const rows = must(await ctx.db.from('lists').select('id').eq('business_id', ctx.businessId).in('id', listIds), 'lists') ?? [];
    if (rows.length !== listIds.length) throw new ToolError('One of those lists was not found.');
  }
  return { ad_ids: adIds, list_ids: listIds };
}

async function validateSkillKeys(ctx, keys) {
  const wanted = uniq(keys ?? []).map(String).slice(0, 30);
  if (!wanted.length) return [];
  const rows = must(await ctx.db.from('chat_ai_skills').select('key').eq('business_id', ctx.businessId).in('key', wanted), 'skills') ?? [];
  const have = new Set(rows.map((r) => r.key));
  const missing = wanted.filter((k) => !have.has(k));
  if (missing.length) throw new ToolError(`These skills do not exist: ${missing.join(', ')}. Check get_chat_ai_setup for the names.`);
  return wanted;
}

const save_flow = {
  name: 'save_flow', area: 'chat_ai', kind: 'propose', risk: 'critical',
  description: 'Make a new flow, or change one: extra instructions the chat AI follows only for chats from certain ads or lists (for example "people from the braids ad: always ask their hair length first"). Take ad ids and list ids from get_chat_ai_setup (can_point_a_flow_at). Give flow_id to change an existing one (send only what changes; send enabled alone to switch it on or off); leave it out to make a new one. Always waits for the owner\'s OK.',
  parameters: {
    type: 'object',
    properties: {
      flow_id: { type: 'string' }, name: { type: 'string' }, goal: { type: 'string', description: 'What the AI is trying to achieve in these chats.' },
      instructions: { type: 'string', description: 'What the AI should do and say, in short clear rules.' },
      skill_keys: { type: 'array', items: { type: 'string' } },
      applies_to: { type: 'object', properties: { ad_ids: { type: 'array', items: { type: 'string' } }, list_ids: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      enabled: { type: 'boolean' }, priority: { type: 'integer', description: 'Higher wins when two flows fit. Default 100.' },
    },
    additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    let existing = null;
    if (args.flow_id) {
      existing = must(await ctx.db.from('chat_flows').select('*').eq('business_id', ctx.businessId).eq('id', args.flow_id).maybeSingle(), 'flow');
      if (!existing) throw new ToolError('I could not find that flow.');
    }
    const name = asText(args.name ?? existing?.name).slice(0, 80);
    const instructions = asText(args.instructions ?? existing?.instructions);
    if (name.length < 2) throw new ToolError('The flow needs a name.');
    if (instructions.length < 10) throw new ToolError('The flow needs clear instructions for the AI.');
    if (instructions.length > MAX_INSTRUCTIONS) throw new ToolError(`Keep the instructions under ${MAX_INSTRUCTIONS} characters.`);
    const trigger = await validateTargets(ctx, args.applies_to ?? existing?.trigger);
    if (!trigger.ad_ids.length && !trigger.list_ids.length) throw new ToolError('A flow has to apply to something: pick at least one ad or one list.');
    const skillKeys = await validateSkillKeys(ctx, args.skill_keys ?? existing?.skill_keys);
    const priority = Number.isFinite(Number(args.priority)) ? Math.round(Number(args.priority)) : (existing?.priority ?? 100);
    const row = { name, goal: asText(args.goal ?? existing?.goal).slice(0, 400) || null, instructions, skill_keys: skillKeys, trigger, enabled: args.enabled ?? existing?.enabled ?? true, priority };
    const named = nameTargets(trigger, await targetsFor(ctx));
    const lines = [`Applies to: ${[...named.ads.map((n) => `ad "${n}"`), ...named.lists.map((n) => `list "${n}"`)].join(', ')}`, row.enabled ? 'On' : 'Off'];
    return {
      title: existing ? `Change the chat flow "${name}"` : `Add a chat flow "${name}"`, params: { flow_id: existing?.id ?? null, row },
      preview: { headline: existing ? `Change flow "${name}"` : `New flow "${name}"`, lines, changes: [{ label: 'What the AI will do', from: existing ? clip(existing.instructions, 300) : 'nothing yet', to: clip(instructions, 300) }], warning: 'The AI will follow this in matching WhatsApp chats.' },
    };
  },
  async execute(ctx, params, action) {
    if (params.flow_id) {
      const old = must(await ctx.db.from('chat_flows').select('*').eq('business_id', ctx.businessId).eq('id', params.flow_id).maybeSingle(), 'flow');
      if (!old) throw new ToolError('That flow is gone, so I changed nothing.');
      must(await ctx.db.from('chat_flows').update({ ...params.row, updated_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('id', old.id), 'save flow');
      return { summary: `Updated the chat flow "${params.row.name}".`, result: { flow_id: old.id }, before: { flow: old } };
    }
    const created = must(await ctx.db.from('chat_flows').insert({ business_id: ctx.businessId, ...params.row, created_via: 'assistant', ba_action_id: action?.id ?? null }).select('id').single(), 'create flow');
    return { summary: `Added the chat flow "${params.row.name}".`, result: { flow_id: created.id }, before: { flow: null } };
  },
  async undo(ctx, action) {
    const id = action.result.flow_id;
    if (action.before?.flow) {
      const { id: _id, business_id: _b, ...rest } = action.before.flow;
      must(await ctx.db.from('chat_flows').update(rest).eq('business_id', ctx.businessId).eq('id', id), 'restore flow');
      return { summary: 'Put the flow back as it was.' };
    }
    must(await ctx.db.from('chat_flows').update({ enabled: false }).eq('business_id', ctx.businessId).eq('id', id), 'switch off flow');
    return { summary: 'Switched the flow off (it is kept, so you can delete it yourself in Chat AI).' };
  },
};

const edit_chat_skill = {
  name: 'edit_chat_skill', area: 'chat_ai', kind: 'propose', risk: 'critical',
  description: 'Change one of the chat AI\'s skills (how it handles a situation): its instructions, when it applies, or switch it on or off. Existing skills only; read them with get_chat_ai_setup first. Always waits for the owner\'s OK.',
  parameters: { type: 'object', properties: { key: { type: 'string' }, instructions: { type: 'string' }, when_to_use: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const skill = must(await ctx.db.from('chat_ai_skills').select('id, key, title, when_to_use, instructions, enabled').eq('business_id', ctx.businessId).eq('key', args.key).maybeSingle(), 'skill');
    if (!skill) throw new ToolError('I could not find that skill. Check get_chat_ai_setup for the names.');
    const patch = {};
    const changes = [];
    if (args.instructions !== undefined) { const t = asText(args.instructions); if (t.length < 10 || t.length > MAX_INSTRUCTIONS) throw new ToolError(`The instructions must be between 10 and ${MAX_INSTRUCTIONS} characters.`); patch.instructions = t; changes.push({ label: 'Instructions', from: clip(skill.instructions, 300), to: clip(t, 300) }); }
    if (args.when_to_use !== undefined) { const t = asText(args.when_to_use).slice(0, 400); if (t.length < 5) throw new ToolError('Say when this skill should be used.'); patch.when_to_use = t; changes.push({ label: 'Used when', from: clip(skill.when_to_use, 200), to: t }); }
    if (args.enabled !== undefined) { patch.enabled = args.enabled === true; changes.push({ label: 'On', from: skill.enabled ? 'yes' : 'no', to: patch.enabled ? 'yes' : 'no' }); }
    if (!Object.keys(patch).length) throw new ToolError('Nothing to change.');
    return { title: `Change the chat AI skill "${skill.title}"`, params: { key: skill.key, patch }, preview: { headline: `Skill: ${skill.title}`, changes, warning: 'This changes how the AI answers customers.' } };
  },
  async execute(ctx, params) {
    const skill = must(await ctx.db.from('chat_ai_skills').select('id, instructions, when_to_use, enabled, title').eq('business_id', ctx.businessId).eq('key', params.key).maybeSingle(), 'skill');
    if (!skill) throw new ToolError('That skill is gone, so I changed nothing.');
    must(await ctx.db.from('chat_ai_skills').update({ ...params.patch, updated_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('id', skill.id), 'save skill');
    return { summary: `Updated the chat AI skill "${skill.title}".`, result: { key: params.key }, before: { instructions: skill.instructions, when_to_use: skill.when_to_use, enabled: skill.enabled } };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('chat_ai_skills').update({ ...action.before, updated_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('key', action.result.key), 'restore skill');
    return { summary: 'Put the skill back as it was.' };
  },
};

const create_chat_skill = {
  name: 'create_chat_skill', area: 'chat_ai', kind: 'propose', risk: 'critical',
  description: 'Add a new skill for the chat AI: a situation it should handle in a particular way (for example "when a customer asks for a discount" or "when someone asks about delivery to Mombasa"). A flow can then list it. Give a short key, a title, when it applies, and clear instructions. Always waits for the owner\'s OK.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short name in lowercase_with_underscores, like discount_requests.' },
      title: { type: 'string' }, when_to_use: { type: 'string', description: 'The situation where the AI should use it.' },
      instructions: { type: 'string', description: 'What the AI should do and say, in short clear rules.' }, enabled: { type: 'boolean' },
    },
    required: ['key', 'title', 'when_to_use', 'instructions'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const key = asText(args.key).toLowerCase();
    if (!SKILL_KEY.test(key)) throw new ToolError('A skill key uses lowercase letters, numbers and underscores (3 to 40 characters), like discount_requests.');
    const title = asText(args.title).slice(0, 80);
    const when = asText(args.when_to_use).slice(0, 400);
    const instructions = asText(args.instructions);
    if (title.length < 3) throw new ToolError('The skill needs a title.');
    if (when.length < 5) throw new ToolError('Say when this skill should be used.');
    if (instructions.length < 10 || instructions.length > MAX_INSTRUCTIONS) throw new ToolError(`The instructions must be between 10 and ${MAX_INSTRUCTIONS} characters.`);
    const taken = must(await ctx.db.from('chat_ai_skills').select('id').eq('business_id', ctx.businessId).eq('key', key).maybeSingle(), 'skill');
    if (taken) throw new ToolError(`There is already a skill called "${key}". Use edit_chat_skill to change it, or pick another key.`);
    return {
      title: `Add the chat AI skill "${title}"`, params: { key, title, when_to_use: when, instructions, enabled: args.enabled !== false },
      preview: { headline: `New skill: ${title}`, lines: [`Used when: ${when}`, args.enabled === false ? 'Off until you switch it on' : 'On'], changes: [{ label: 'What the AI will do', from: 'nothing yet', to: clip(instructions, 300) }], warning: 'The AI will use this in matching WhatsApp chats.' },
    };
  },
  async execute(ctx, params) {
    const taken = must(await ctx.db.from('chat_ai_skills').select('id').eq('business_id', ctx.businessId).eq('key', params.key).maybeSingle(), 'skill');
    if (taken) throw new ToolError('A skill with that name now exists, so I added nothing.');
    const row = must(await ctx.db.from('chat_ai_skills').insert({ business_id: ctx.businessId, key: params.key, title: params.title, when_to_use: params.when_to_use, instructions: params.instructions, enabled: params.enabled }).select('id').single(), 'create skill');
    return { summary: `Added the chat AI skill "${params.title}".`, result: { key: params.key, id: row.id } };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('chat_ai_skills').update({ enabled: false, updated_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('key', action.result.key), 'switch off skill');
    return { summary: 'Switched the skill off (it is kept, so you can delete it yourself in the Playground).' };
  },
};

export default [get_chat_ai_setup, get_flow, get_chat_skill, save_flow, create_chat_skill, edit_chat_skill];
