// The persona pack: how the chat AI and the campaign writer sound like this business.
// Every change saves a NEW version (the old one is kept), so Undo is a real undo and nothing is ever lost.
import { ToolError, asText, clip, must } from '../helpers.js';

// customer_profiles is generated from real chats; the owner-facing editor never lets it be rewritten here either.
const PROTECTED = new Set(['customer_profiles']);
const SECTION_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_SECTION_CHARS = 6000;

async function activePack(ctx) {
  return must(await ctx.db.from('persona_packs').select('id, version, pack').eq('business_id', ctx.businessId).eq('is_active', true).order('version', { ascending: false }).limit(1).maybeSingle(), 'persona pack');
}

async function saveVersion(ctx, current, pack, by = 'ask_heysasa') {
  if (current) must(await ctx.db.from('persona_packs').update({ is_active: false }).eq('id', current.id).eq('business_id', ctx.businessId), 'retire version');
  const row = must(await ctx.db.from('persona_packs').insert({ business_id: ctx.businessId, version: (current?.version || 0) + 1, pack, is_active: true, generated_by: by, generated_at: ctx.now().toISOString() }).select('version').single(), 'save version');
  return row.version;
}

const sizeOf = (v) => (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);
const show = (v, max = 600) => clip(typeof v === 'string' ? v : JSON.stringify(v, null, 1), max);

const get_persona = {
  name: 'get_persona', area: 'chat_ai', kind: 'read', status: 'Reading how the business talks…',
  description: 'Read the persona pack (how the business talks to customers). Call this BEFORE writing any message a customer will read, so it sounds like the owner. Give a section name to read one section in full; without one you get the list of sections and a short look at each.',
  parameters: { type: 'object', properties: { section: { type: 'string', description: 'For example persona, business_context, closing_triggers, objection_playbook.' } }, additionalProperties: false },
  async run(ctx, { section } = {}) {
    const cur = await activePack(ctx);
    if (!cur) return { ready: false, note: 'There is no persona pack yet. It is built after the chats are studied.' };
    const pack = cur.pack ?? {};
    if (section) {
      if (!(section in pack) || PROTECTED.has(section)) throw new ToolError(`There is no editable "${section}" section. Sections: ${Object.keys(pack).filter((k) => !PROTECTED.has(k)).join(', ')}.`);
      return { ready: true, version: cur.version, section, content: pack[section] };
    }
    return { ready: true, version: cur.version, sections: Object.keys(pack).filter((k) => !PROTECTED.has(k)).map((k) => ({ name: k, looks_like: show(pack[k], 220) })) };
  },
};

const update_persona = {
  name: 'update_persona', area: 'chat_ai', kind: 'propose', risk: 'critical',
  description: 'Change or add one section of the persona pack, for example a new rule for the chat AI, how to answer a worry, or when to hand over to the owner. `content` REPLACES that section, so include the parts being kept (read it first with get_persona). A new section name adds a section. Changes how the AI talks to every customer, so it always waits for the owner\'s OK. The old version is kept and Undo restores it.',
  parameters: {
    type: 'object',
    properties: {
      section: { type: 'string', description: 'Section name in lowercase_with_underscores.' },
      content: { description: 'The full new text for the section (or the same shape the section already has, like a list).' },
    },
    required: ['section', 'content'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, { section, content }) {
    const name = asText(section).toLowerCase();
    if (!SECTION_RE.test(name)) throw new ToolError('A section name uses lowercase letters, numbers and underscores, like delivery_rules.');
    if (PROTECTED.has(name)) throw new ToolError('That section is built from real chats and is not edited by hand.');
    if (content === undefined || content === null || sizeOf(content) < 3) throw new ToolError('The new wording is empty.');
    if (sizeOf(content) > MAX_SECTION_CHARS) throw new ToolError(`That is too long. Keep a section under ${MAX_SECTION_CHARS} characters so the AI reads it properly.`);
    const cur = await activePack(ctx);
    if (!cur) throw new ToolError('There is no persona pack yet, so there is nothing to change. It is built after the chats are studied.');
    const before = cur.pack?.[name];
    if (JSON.stringify(before) === JSON.stringify(content)) throw new ToolError('That section already says exactly this.');
    return {
      title: before === undefined ? `Add "${name.replace(/_/g, ' ')}" to how your AI talks` : `Change "${name.replace(/_/g, ' ')}" in how your AI talks`,
      params: { section: name, content, based_on_version: cur.version },
      preview: { headline: before === undefined ? `New section: ${name.replace(/_/g, ' ')}` : `Change: ${name.replace(/_/g, ' ')}`, changes: [{ label: name.replace(/_/g, ' '), from: before === undefined ? 'nothing yet' : show(before), to: show(content) }], warning: 'This changes how the AI talks to every customer. You can undo it afterwards.' },
    };
  },
  async execute(ctx, params) {
    const cur = await activePack(ctx);
    if (!cur) throw new ToolError('The persona pack is gone, so I changed nothing.');
    if (cur.version !== params.based_on_version) throw new ToolError('The persona pack changed since I prepared this. Ask me again and I will redo it from the latest version.');
    const version = await saveVersion(ctx, cur, { ...cur.pack, [params.section]: params.content });
    return { summary: `Updated "${params.section.replace(/_/g, ' ')}" in how your AI talks (saved as version ${version}).`, result: { version, section: params.section }, before: { section: params.section, existed: params.section in (cur.pack ?? {}), content: cur.pack?.[params.section] ?? null, version: cur.version } };
  },
  async undo(ctx, action) {
    const cur = await activePack(ctx);
    if (!cur) throw new ToolError('The persona pack is gone.');
    if (cur.version !== action.result.version) throw new ToolError('The persona pack was changed again after this, so I cannot undo just this change.');
    const pack = { ...cur.pack };
    if (action.before.existed) pack[action.before.section] = action.before.content; else delete pack[action.before.section];
    const version = await saveVersion(ctx, cur, pack);
    return { summary: `Restored the earlier wording (saved as version ${version}).` };
  },
};

export default [get_persona, update_persona];
