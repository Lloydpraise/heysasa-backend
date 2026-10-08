// Lists: see them, make them from a search, change who is in them, rename or archive, and switch the auto lists on or off.
import { ToolError, asText, chunk, clip, fetchAll, must, plural, resolveLeadIds, uniq } from '../helpers.js';

// The auto lists and what can be tuned on each (same as the Automations tab in the dashboard).
export const AUTO_RULES = {
  hot_inquiries: { name: 'Hot Inquiries', factors: { window_days: { type: 'number', min: 1, max: 90 }, require_price_request: { type: 'boolean' } } },
  unanswered: { name: 'Unanswered Messages', factors: { min_hours: { type: 'number', min: 0, max: 168 }, max_days: { type: 'number', min: 1, max: 90 } } },
  price_hesitant: { name: 'Price-Hesitant Leads', factors: { window_days: { type: 'number', min: 1, max: 180 } } },
  cold_dormant: { name: 'Cold / Dormant Leads', factors: { inactivity_days: { type: 'number', min: 1, max: 365 } } },
  cart_abandoners: { name: 'Cart Abandoners / Pending Payment', factors: { no_purchase_window_days: { type: 'number', min: 1, max: 60 } } },
  post_purchase: { name: 'Post-Purchase / Repeat Buyers', factors: { min_purchases: { type: 'number', min: 1, max: 50 } } },
  low_intent: { name: 'Low Intent / Unqualified', factors: { flag_source: { type: 'select', options: ['agent', 'ai', 'both'] } } },
};

const stamp = (action, extra = {}) => ({ created_via: 'assistant', ba_action_id: action?.id ?? null, ...extra });

async function ownList(ctx, listId) {
  const list = must(await ctx.db.from('lists').select('id, name, type, archived, rule_id').eq('business_id', ctx.businessId).eq('id', listId).maybeSingle(), 'list');
  if (!list) throw new ToolError('I could not find that list.');
  return list;
}

const summaryRow = (r) => ({
  id: r.list_id, name: r.name, kind: r.type === 'auto' ? 'auto' : 'manual', archived: Boolean(r.archived), rule: r.rule_id || undefined,
  people: r.total_contacts ?? 0, ready_to_message: r.ready_count ?? 0, in_a_campaign: r.in_campaign_count ?? 0, opted_out: r.opted_out_count ?? 0,
  estimated_value: r.est_pipeline_value ?? undefined,
});

const list_lists = {
  name: 'list_lists', area: 'lists', kind: 'read', status: 'Checking your lists…',
  description: 'All lists (auto lists and ones the owner made) with how many people are in each and how many can be messaged right now.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const rows = must(await ctx.db.from('v_list_summary').select('*').eq('business_id', ctx.businessId), 'lists') ?? [];
    return { lists: rows.map(summaryRow), auto_list_rules: Object.entries(AUTO_RULES).map(([id, r]) => ({ id, name: r.name, tunable: Object.keys(r.factors) })) };
  },
};

const get_list = {
  name: 'get_list', area: 'lists', kind: 'read', status: 'Opening that list…',
  description: 'One list: counts, and the first few people in it.',
  parameters: { type: 'object', properties: { list_id: { type: 'string' } }, required: ['list_id'], additionalProperties: false },
  async run(ctx, { list_id: listId }) {
    await ownList(ctx, listId);
    const summary = must(await ctx.db.from('v_list_summary').select('*').eq('business_id', ctx.businessId).eq('list_id', listId).maybeSingle(), 'list summary');
    const members = must(await ctx.db.from('list_members').select('lead_id').eq('list_id', listId).limit(8), 'members') ?? [];
    const people = members.length ? must(await ctx.db.from('contacts').select('id, name').eq('business_id', ctx.businessId).in('id', members.map((m) => m.lead_id)), 'contacts') ?? [] : [];
    return { ...(summary ? summaryRow(summary) : {}), first_people: people.map((p) => ({ id: p.id, name: p.name || 'Unknown' })) };
  },
};

async function existingLeadIds(ctx, ids) {
  const out = [];
  for (const part of chunk(ids, 200)) {
    const rows = must(await ctx.db.from('contacts').select('id').eq('business_id', ctx.businessId).in('id', part), 'contacts') ?? [];
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

async function nameTaken(ctx, name) {
  const rows = must(await ctx.db.from('lists').select('id, name').eq('business_id', ctx.businessId), 'lists') ?? [];
  return rows.some((r) => String(r.name || '').trim().toLowerCase() === name.toLowerCase());
}

const create_list = {
  name: 'create_list', area: 'lists', kind: 'propose', risk: 'normal',
  description: 'Make a new list the owner can use for campaigns. Give search_id (from search_leads) or lead_ids to fill it. People are added as they are now (it will not update by itself).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A plain name that says who is in it, like "Mombasa buyers".' },
      search_id: { type: 'string' },
      lead_ids: { type: 'array', items: { type: ['string', 'number'] } },
    },
    required: ['name'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const name = asText(args.name).slice(0, 60);
    if (name.length < 2) throw new ToolError('The list needs a name.');
    if (await nameTaken(ctx, name)) throw new ToolError(`You already have a list called "${name}". Pick another name, or add people to that one.`);
    const ids = await existingLeadIds(ctx, resolveLeadIds(ctx, args, { max: 2000 }));
    const sample = ids.length ? must(await ctx.db.from('contacts').select('name').eq('business_id', ctx.businessId).in('id', ids.slice(0, 5)), 'contacts') ?? [] : [];
    return {
      title: `Make a list called "${name}"`,
      params: { name, lead_ids: ids },
      preview: { headline: `New list "${name}" with ${plural(ids.length, 'person', 'people')}`, lines: sample.map((s) => s.name || 'Unknown'), more: Math.max(0, ids.length - sample.length) },
    };
  },
  async execute(ctx, params, action) {
    if (await nameTaken(ctx, params.name)) throw new ToolError(`A list called "${params.name}" already exists now, so I did not make another.`);
    const ids = await existingLeadIds(ctx, params.lead_ids);
    const list = must(await ctx.db.from('lists').insert({ business_id: ctx.businessId, name: params.name, type: 'manual', ...stamp(action) }).select().single(), 'create list');
    try {
      for (const part of chunk(ids, 500)) must(await ctx.db.from('list_members').insert(part.map((id) => ({ list_id: list.id, lead_id: id }))), 'add members');
    } catch (error) {
      await ctx.db.from('lists').delete().eq('id', list.id).eq('business_id', ctx.businessId);
      throw error;
    }
    return { summary: `Made the list "${params.name}" with ${plural(ids.length, 'person', 'people')}.`, result: { list_id: list.id, count: ids.length } };
  },
  async undo(ctx, action) {
    const id = action.result?.list_id;
    const inCampaign = must(await ctx.db.from('campaigns').select('id').eq('business_id', ctx.businessId).eq('list_id', id).in('status', ['active', 'paused']), 'campaigns') ?? [];
    if (inCampaign.length) throw new ToolError('A campaign is using this list now, so I cannot remove it.');
    must(await ctx.db.from('list_members').delete().eq('list_id', id), 'remove members');
    must(await ctx.db.from('lists').delete().eq('business_id', ctx.businessId).eq('id', id), 'remove list');
    return { summary: 'Removed the list I made.' };
  },
};

const change_list_members = {
  name: 'change_list_members', area: 'lists', kind: 'propose', risk: 'normal',
  description: 'Add people to, or take people out of, a list the owner made (not an auto list: those fill themselves). Use search_id or lead_ids.',
  parameters: {
    type: 'object',
    properties: {
      list_id: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove'] },
      search_id: { type: 'string' }, lead_ids: { type: 'array', items: { type: ['string', 'number'] } },
    },
    required: ['list_id', 'action'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const list = await ownList(ctx, args.list_id);
    if (list.type === 'auto') throw new ToolError('Auto lists fill themselves. To change who is in one, change its rule instead.');
    const ids = await existingLeadIds(ctx, resolveLeadIds(ctx, args, { max: 2000 }));
    if (!ids.length) throw new ToolError('Tell me which people: run a search first, or give me their ids.');
    const current = new Set((await fetchAll((from, to) => ctx.db.from('list_members').select('lead_id').eq('list_id', list.id).range(from, to))).map((r) => String(r.lead_id)));
    const effective = args.action === 'add' ? ids.filter((id) => !current.has(String(id))) : ids.filter((id) => current.has(String(id)));
    if (!effective.length) throw new ToolError(args.action === 'add' ? 'They are all in that list already.' : 'None of them are in that list.');
    return {
      title: `${args.action === 'add' ? 'Add' : 'Take'} ${plural(effective.length, 'person', 'people')} ${args.action === 'add' ? 'to' : 'out of'} "${list.name}"`,
      params: { list_id: list.id, action: args.action, lead_ids: effective },
      preview: { headline: `${args.action === 'add' ? 'Add' : 'Remove'} ${plural(effective.length, 'person', 'people')} ${args.action === 'add' ? 'to' : 'from'} "${list.name}"`, lines: [] },
    };
  },
  async execute(ctx, params) {
    const list = await ownList(ctx, params.list_id);
    const ids = await existingLeadIds(ctx, params.lead_ids);
    if (params.action === 'add') {
      const current = new Set((await fetchAll((from, to) => ctx.db.from('list_members').select('lead_id').eq('list_id', list.id).range(from, to))).map((r) => String(r.lead_id)));
      const fresh = ids.filter((id) => !current.has(String(id)));
      for (const part of chunk(fresh, 500)) must(await ctx.db.from('list_members').insert(part.map((id) => ({ list_id: list.id, lead_id: id }))), 'add members');
      return { summary: `Added ${plural(fresh.length, 'person', 'people')} to "${list.name}".`, result: { list_id: list.id, ids: fresh }, before: { added: fresh } };
    }
    for (const part of chunk(ids, 200)) must(await ctx.db.from('list_members').delete().eq('list_id', list.id).in('lead_id', part), 'remove members');
    return { summary: `Took ${plural(ids.length, 'person', 'people')} out of "${list.name}".`, result: { list_id: list.id, ids }, before: { removed: ids } };
  },
  async undo(ctx, action) {
    const listId = action.result?.list_id;
    if (action.before?.added) for (const part of chunk(action.before.added, 200)) must(await ctx.db.from('list_members').delete().eq('list_id', listId).in('lead_id', part), 'undo add');
    if (action.before?.removed) for (const part of chunk(action.before.removed, 500)) must(await ctx.db.from('list_members').insert(part.map((id) => ({ list_id: listId, lead_id: id }))), 'undo remove');
    return { summary: 'Put the list back as it was.' };
  },
};

const edit_list = {
  name: 'edit_list', area: 'lists', kind: 'propose', risk: 'normal',
  description: 'Rename a list the owner made, or archive it (hide it) or bring it back. Lists are never deleted.',
  parameters: { type: 'object', properties: { list_id: { type: 'string' }, name: { type: 'string' }, archived: { type: 'boolean' } }, required: ['list_id'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const list = await ownList(ctx, args.list_id);
    if (list.type === 'auto') throw new ToolError('Auto lists are managed by their rule. Use set_auto_list to turn one off.');
    const patch = {};
    const lines = [];
    if (args.name !== undefined) {
      const name = asText(args.name).slice(0, 60);
      if (name.length < 2) throw new ToolError('The new name is too short.');
      if (name.toLowerCase() !== String(list.name).toLowerCase() && await nameTaken(ctx, name)) throw new ToolError(`You already have a list called "${name}".`);
      patch.name = name; lines.push(`Name: "${list.name}" to "${name}"`);
    }
    if (args.archived !== undefined && Boolean(args.archived) !== Boolean(list.archived)) {
      if (args.archived) {
        const busy = must(await ctx.db.from('campaigns').select('id').eq('business_id', ctx.businessId).eq('list_id', list.id).in('status', ['active', 'paused']), 'campaigns') ?? [];
        if (busy.length) throw new ToolError('A campaign is using this list, so it cannot be archived yet.');
      }
      patch.archived = Boolean(args.archived); lines.push(args.archived ? 'Archive it (hide it)' : 'Bring it back');
    }
    if (!Object.keys(patch).length) throw new ToolError('Nothing to change.');
    return { title: `Change the list "${list.name}"`, params: { list_id: list.id, patch }, preview: { headline: `Change "${list.name}"`, lines } };
  },
  async execute(ctx, params) {
    const list = await ownList(ctx, params.list_id);
    must(await ctx.db.from('lists').update(params.patch).eq('business_id', ctx.businessId).eq('id', list.id), 'edit list');
    return { summary: `Updated the list "${params.patch.name ?? list.name}".`, result: { list_id: list.id }, before: { name: list.name, archived: Boolean(list.archived) } };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('lists').update({ name: action.before.name, archived: action.before.archived }).eq('business_id', ctx.businessId).eq('id', action.result.list_id), 'undo list');
    return { summary: 'Put the list back.' };
  },
};

function cleanFactors(ruleId, factors) {
  const schema = AUTO_RULES[ruleId].factors;
  const out = {};
  for (const [key, value] of Object.entries(factors ?? {})) {
    const f = schema[key];
    if (!f) throw new ToolError(`"${key}" cannot be changed on ${AUTO_RULES[ruleId].name}. You can change: ${Object.keys(schema).join(', ')}.`);
    if (f.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < f.min || n > f.max) throw new ToolError(`${key} must be between ${f.min} and ${f.max}.`);
      out[key] = n;
    } else if (f.type === 'boolean') {
      out[key] = value === true;
    } else if (f.type === 'select') {
      if (!f.options.includes(value)) throw new ToolError(`${key} must be one of: ${f.options.join(', ')}.`);
      out[key] = value;
    }
  }
  return out;
}

const set_auto_list = {
  name: 'set_auto_list', area: 'lists', kind: 'propose', risk: 'normal',
  description: 'Switch an auto list on or off, and/or tune its rule (for example "cold means no reply for 21 days"). Auto lists fill themselves from the rule. Turning one off hides it and keeps its people for 30 days.',
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', enum: Object.keys(AUTO_RULES) }, enabled: { type: 'boolean' },
      factors: { type: 'object', description: 'Only the settings to change, like {"inactivity_days": 21}.', additionalProperties: true },
    },
    required: ['rule_id'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const rule = AUTO_RULES[args.rule_id];
    if (!rule) throw new ToolError('That auto list does not exist.');
    const factors = args.factors ? cleanFactors(args.rule_id, args.factors) : null;
    if (args.enabled === undefined && !factors) throw new ToolError('Tell me whether to turn it on or off, or what to change.');
    const current = must(await ctx.db.from('segmentation_rules').select('rule_id, enabled, factors').eq('business_id', ctx.businessId).eq('rule_id', args.rule_id).maybeSingle(), 'rule');
    const lines = [];
    if (args.enabled !== undefined) lines.push(`${rule.name}: ${current?.enabled ? 'on' : 'off'} to ${args.enabled ? 'on' : 'off'}`);
    for (const [k, v] of Object.entries(factors ?? {})) lines.push(`${k.replace(/_/g, ' ')}: ${current?.factors?.[k] ?? 'default'} to ${v}`);
    return {
      title: `${args.enabled === true ? 'Turn on' : args.enabled === false ? 'Turn off' : 'Tune'} the "${rule.name}" auto list`,
      params: { rule_id: args.rule_id, enabled: args.enabled, factors }, preview: { headline: `${rule.name} auto list`, lines },
    };
  },
  async execute(ctx, params, action) {
    const rule = AUTO_RULES[params.rule_id];
    const current = must(await ctx.db.from('segmentation_rules').select('rule_id, enabled, factors, disabled_at').eq('business_id', ctx.businessId).eq('rule_id', params.rule_id).maybeSingle(), 'rule');
    const before = { exists: Boolean(current), enabled: Boolean(current?.enabled), factors: current?.factors ?? null, disabled_at: current?.disabled_at ?? null };
    if (params.enabled !== undefined) {
      const enabled = params.enabled === true;
      must(await ctx.db.from('segmentation_rules').upsert({ business_id: ctx.businessId, rule_id: params.rule_id, enabled, disabled_at: enabled ? null : ctx.now().toISOString() }, { onConflict: 'business_id,rule_id' }), 'save rule');
      must(await ctx.db.from('lists').upsert({ business_id: ctx.businessId, rule_id: params.rule_id, type: 'auto', archived: !enabled, disabled_at: enabled ? null : ctx.now().toISOString(), ...(enabled ? stamp(action) : {}) }, { onConflict: 'business_id,rule_id' }), 'save list');
    }
    if (params.factors && Object.keys(params.factors).length) {
      const merged = { ...(current?.factors ?? {}), ...params.factors };
      must(await ctx.db.from('segmentation_rules').update({ factors: merged }).eq('business_id', ctx.businessId).eq('rule_id', params.rule_id), 'save factors');
    }
    const bits = [];
    if (params.enabled !== undefined) bits.push(params.enabled ? 'turned on' : 'turned off');
    if (params.factors && Object.keys(params.factors).length) bits.push('tuned');
    return { summary: `The "${rule.name}" auto list is ${bits.join(' and ')}.`, result: { rule_id: params.rule_id }, before };
  },
  async undo(ctx, action) {
    const b = action.before ?? {};
    const ruleId = action.result.rule_id;
    if (!b.exists) {
      must(await ctx.db.from('segmentation_rules').update({ enabled: false, disabled_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('rule_id', ruleId), 'undo rule');
      must(await ctx.db.from('lists').update({ archived: true, disabled_at: ctx.now().toISOString() }).eq('business_id', ctx.businessId).eq('rule_id', ruleId), 'undo list');
    } else {
      must(await ctx.db.from('segmentation_rules').update({ enabled: b.enabled, factors: b.factors, disabled_at: b.disabled_at }).eq('business_id', ctx.businessId).eq('rule_id', ruleId), 'undo rule');
      must(await ctx.db.from('lists').update({ archived: !b.enabled, disabled_at: b.disabled_at }).eq('business_id', ctx.businessId).eq('rule_id', ruleId), 'undo list');
    }
    return { summary: 'Put the auto list back as it was.' };
  },
};

export default [list_lists, get_list, create_list, change_list_members, edit_list, set_auto_list];
