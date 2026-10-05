// Reads everything the model needs for one turn. All database access for context lives here.

import type { TurnContext, TurnInput } from './turn.ts';
import type { CustomerFile, HistoryMessage, Skill } from './prompt.ts';
import type { Flow } from './flows.ts';
import type { ToolRow } from './tools.ts';

const HISTORY_LIMIT = 30;
const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

export function readSettings(raw: Record<string, unknown> | null | undefined) {
  const s = raw ?? {};
  const effort = ['low', 'medium', 'high'].includes(String(s.effort)) ? String(s.effort) : 'medium';
  return {
    effort,
    settleMs: clamp(s.settle_ms, 0, 15_000, 3_000),
    holdingAfterMs: clamp(s.holding_after_ms, 0, 60_000, 9_000),
    maxRounds: clamp(s.max_rounds, 2, 10, 6),
    holdingModel: typeof s.holding_model === 'string' && s.holding_model ? s.holding_model : 'gpt-4.1-mini',
  };
}

const NON_TEXT_LABEL: Record<string, string> = {
  image: '[photo]', audio: '[voice note]', ptt: '[voice note]', video: '[video]', document: '[document]', sticker: '[sticker]',
  location: '[location]', contact: '[contact card]',
};

// deno-lint-ignore no-explicit-any
export function toHistory(rows: any[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const row of rows) {
    const type = String(row.type || row.content?.type || 'text');
    if (type === 'reaction') continue;
    const raw = typeof row.content?.text === 'string' ? row.content.text.trim() : '';
    const caption = raw ? ` ${raw}` : '';
    const text = type === 'text' || type === 'conversation' || type === 'extendedTextMessage'
      ? raw
      : `${NON_TEXT_LABEL[type] ?? `[${type}]`}${caption}`;
    if (!text) continue;
    const clipped = text.length > 600 ? `${text.slice(0, 600)}...` : text;
    if (row.direction === 'in') { out.push({ role: 'user', text: clipped }); continue; }
    const prefix = row.agent_role === 'human' ? '[sent by the owner] ' : row.agent_role === 'follow_up_ai' ? '[automatic follow-up] ' : '';
    out.push({ role: 'assistant', text: `${prefix}${clipped}` });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
const must = (r: { data: any; error: any }, what: string) => {
  if (r.error) throw new Error(`could not load ${what}: ${r.error.message}`);
  return r.data;
};

// deno-lint-ignore no-explicit-any
export async function loadContext(db: any, input: TurnInput): Promise<TurnContext> {
  const businessId = input.business_id;
  const simulate = input.simulate === true;

  const [business, personaRows, productRows, skillRows, toolRows, flowRows] = await Promise.all([
    db.from('businesses').select('name, currency, chat_ai_model, chat_ai_settings').eq('business_id', businessId).maybeSingle().then((r: never) => must(r, 'the business')),
    db.from('persona_packs').select('pack').eq('business_id', businessId).eq('is_active', true).order('version', { ascending: false }).limit(1).then((r: never) => must(r, 'the persona pack')),
    db.from('products').select('category').eq('business_id', businessId).eq('status', 'approved').eq('ai_visible', true).limit(5000).then((r: never) => must(r, 'products')),
    db.from('chat_ai_skills').select('key, title, when_to_use, instructions').eq('business_id', businessId).eq('enabled', true).then((r: never) => must(r, 'skills')),
    db.from('chat_ai_tools').select('name, business_id, description, parameters, kind, target, phase').eq('enabled', true).or(`business_id.is.null,business_id.eq.${businessId}`).then((r: never) => must(r, 'tools')),
    db.from('chat_flows').select('id, name, enabled, priority, trigger, goal, instructions, skill_keys, created_at').eq('business_id', businessId).eq('enabled', true).then((r: never) => must(r, 'flows')),
  ]);
  if (!business) throw new Error('business not found');

  const counts = new Map<string, number>();
  for (const p of productRows ?? []) {
    const c = String(p.category ?? '').trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const categories = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));

  let customer: CustomerFile = { ...(input.contact ?? {}) };
  let adIds: Array<string | null | undefined> = [input.contact?.ad_id];
  let listIds: string[] = input.contact?.list_ids ?? [];
  let stickyFlowId: string | null = null;
  let history: HistoryMessage[] = [];

  if (simulate) {
    history = (input.history ?? []).slice(-HISTORY_LIMIT);
    if (!history.length && input.message) history = [{ role: 'user', text: input.message }];
    customer.first_contact = !history.some((m) => m.role === 'assistant');
  } else {
    const contactId = input.contact_id;
    const [contact, convo, members, messages] = await Promise.all([
      db.from('contacts').select('name, ad_headline, ad_body, lead_summary, context_summary, customer_intent, lead_quality, objection_tags, notes, ad_id, original_ad_id').eq('id', contactId).maybeSingle().then((r: never) => must(r, 'the customer')),
      db.from('conversations').select('conv_stage, lead_stage_service, lead_stage_ecom, context_summary, chat_ai_flow_id').eq('id', input.conversation_id).maybeSingle().then((r: never) => must(r, 'the conversation')),
      db.from('list_members').select('list_id').eq('lead_id', contactId).then((r: never) => must(r, 'the customer lists')),
      db.from('messages').select('direction, agent_role, type, content, created_at').eq('conversation_id', input.conversation_id).order('created_at', { ascending: false }).limit(HISTORY_LIMIT).then((r: never) => must(r, 'messages')),
    ]);
    history = toHistory([...(messages ?? [])].reverse());
    customer = {
      name: contact?.name, ad_headline: contact?.ad_headline, ad_body: contact?.ad_body, lead_summary: contact?.lead_summary,
      context_summary: convo?.context_summary || contact?.context_summary, customer_intent: contact?.customer_intent,
      lead_quality: contact?.lead_quality, objection_tags: contact?.objection_tags, notes: contact?.notes,
      stage: convo?.lead_stage_service || convo?.lead_stage_ecom || convo?.conv_stage || null,
      first_contact: !history.some((m) => m.role === 'assistant'),
    };
    adIds = [contact?.ad_id, contact?.original_ad_id];
    listIds = (members ?? []).map((m: { list_id: string }) => String(m.list_id));
    stickyFlowId = convo?.chat_ai_flow_id ?? null;
  }

  const personaPack = personaRows?.[0]?.pack ?? null;
  return {
    business: { name: business.name || 'the business', currency: business.currency || null, model: business.chat_ai_model || 'gpt-5-mini' },
    settings: readSettings(business.chat_ai_settings),
    persona: personaPack,
    categories,
    skills: (skillRows ?? []) as Skill[],
    toolRows: (toolRows ?? []) as ToolRow[],
    flows: (flowRows ?? []) as Flow[],
    customer, adIds, listIds, stickyFlowId, history,
  };
}
