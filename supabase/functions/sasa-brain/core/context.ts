// Reads everything the model needs for one turn. All database access for context lives here.
//
// Two kinds of data:
//   - business-level (persona, skills, tools, flows, product categories): the same for every chat of a business and
//     rarely edited, so a warm function instance keeps it for a short while instead of re-reading it on every message.
//   - chat-level (the customer, the conversation, the message history): always read fresh.
// The Playground (simulate) skips the cache entirely, so an owner who edits a skill and tests it sees the edit at once.

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
  // 'low' is the default: the chat AI follows short rules and skills, and reasoning time is the biggest part of a
  // reply's delay and cost. A business can still ask for 'medium' or 'high' in chat_ai_settings.effort.
  const effort = ['low', 'medium', 'high'].includes(String(s.effort)) ? String(s.effort) : 'low';
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

// ── Short-lived cache for business-level data ───────────────────────────────────────────────────────────────────────

type Ttl<T> = (key: string, load: () => Promise<T>) => Promise<T>;
const MAX_CACHED_BUSINESSES = 200;

function ttl<T>(ms: number, now: () => number): Ttl<T> {
  const map = new Map<string, { at: number; value: Promise<T> }>();
  return (key, load) => {
    const hit = map.get(key);
    if (hit && now() - hit.at < ms) return hit.value;
    const value = load();
    if (map.size >= MAX_CACHED_BUSINESSES) map.delete(map.keys().next().value as string);
    map.set(key, { at: now(), value });
    // A failed read is never remembered: the next message tries again.
    value.catch(() => { if (map.get(key)?.value === value) map.delete(key); });
    return value;
  };
}

type Core = {
  // deno-lint-ignore no-explicit-any
  business: any; personaPack: Record<string, unknown> | null; skills: Skill[]; toolRows: ToolRow[]; flows: Flow[];
};
type Category = { name: string; count: number };

export type ContextCache = { core: Ttl<Core>; categories: Ttl<Category[]> };

// core: persona, skills, tools, flows and the business row. categories: the product category list, which needs a scan
// of up to 5,000 product rows, so it is kept longer. Neither changes how the AI behaves in any way except how fresh
// an owner's edit is: up to `coreMs` for live chats.
export function createContextCache(opts: { coreMs?: number; categoriesMs?: number; now?: () => number } = {}): ContextCache {
  const now = opts.now ?? Date.now;
  return { core: ttl<Core>(opts.coreMs ?? 30_000, now), categories: ttl<Category[]>(opts.categoriesMs ?? 300_000, now) };
}

// deno-lint-ignore no-explicit-any
async function loadCore(db: any, businessId: string): Promise<Core> {
  const [business, personaRows, skillRows, toolRows, flowRows] = await Promise.all([
    db.from('businesses').select('name, currency, chat_ai_model, chat_ai_settings').eq('business_id', businessId).maybeSingle().then((r: never) => must(r, 'the business')),
    db.from('persona_packs').select('pack').eq('business_id', businessId).eq('is_active', true).order('version', { ascending: false }).limit(1).then((r: never) => must(r, 'the persona pack')),
    db.from('chat_ai_skills').select('key, title, when_to_use, instructions').eq('business_id', businessId).eq('enabled', true).then((r: never) => must(r, 'skills')),
    db.from('chat_ai_tools').select('name, business_id, description, parameters, kind, target, phase').eq('enabled', true).or(`business_id.is.null,business_id.eq.${businessId}`).then((r: never) => must(r, 'tools')),
    db.from('chat_flows').select('id, name, enabled, priority, trigger, goal, instructions, skill_keys, created_at').eq('business_id', businessId).eq('enabled', true).then((r: never) => must(r, 'flows')),
  ]);
  if (!business) throw new Error('business not found');
  return { business, personaPack: personaRows?.[0]?.pack ?? null, skills: (skillRows ?? []) as Skill[], toolRows: (toolRows ?? []) as ToolRow[], flows: (flowRows ?? []) as Flow[] };
}

// deno-lint-ignore no-explicit-any
async function loadCategories(db: any, businessId: string): Promise<Category[]> {
  const productRows = must(
    await db.from('products').select('category').eq('business_id', businessId).eq('status', 'approved').eq('ai_visible', true).limit(5000),
    'products',
  );
  const counts = new Map<string, number>();
  for (const p of productRows ?? []) {
    const c = String(p.category ?? '').trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}

// deno-lint-ignore no-explicit-any
const getCore = (db: any, businessId: string, cache?: ContextCache) => (cache ? cache.core(businessId, () => loadCore(db, businessId)) : loadCore(db, businessId));
// deno-lint-ignore no-explicit-any
const getCategories = (db: any, businessId: string, cache?: ContextCache) => (cache ? cache.categories(businessId, () => loadCategories(db, businessId)) : loadCategories(db, businessId));

// Just the settings (how long to wait for a burst of messages, how hard the model thinks). One cached read, so a turn can
// decide how long to wait without loading the whole context first.
// deno-lint-ignore no-explicit-any
export async function loadSettings(db: any, input: TurnInput, cache?: ContextCache) {
  const core = await getCore(db, input.business_id, input.simulate === true ? undefined : cache);
  return readSettings(core.business.chat_ai_settings);
}

// ── The chat itself: always fresh ───────────────────────────────────────────────────────────────────────────────────

type Volatile = {
  customer: CustomerFile; adIds: Array<string | null | undefined>; listIds: string[]; stickyFlowId: string | null; history: HistoryMessage[];
};

// deno-lint-ignore no-explicit-any
async function loadVolatile(db: any, input: TurnInput): Promise<Volatile> {
  if (input.simulate === true) {
    let history = (input.history ?? []).slice(-HISTORY_LIMIT);
    if (!history.length && input.message) history = [{ role: 'user', text: input.message }];
    const customer: CustomerFile = { ...(input.contact ?? {}), first_contact: !history.some((m) => m.role === 'assistant') };
    return { customer, adIds: [input.contact?.ad_id], listIds: input.contact?.list_ids ?? [], stickyFlowId: null, history };
  }

  const contactId = input.contact_id;
  const [contact, convo, members, messages] = await Promise.all([
    db.from('contacts').select('name, ad_headline, ad_body, lead_summary, context_summary, customer_intent, lead_quality, objection_tags, notes, ad_id, original_ad_id').eq('id', contactId).maybeSingle().then((r: never) => must(r, 'the customer')),
    db.from('conversations').select('conv_stage, lead_stage_service, lead_stage_ecom, context_summary, chat_ai_flow_id').eq('id', input.conversation_id).maybeSingle().then((r: never) => must(r, 'the conversation')),
    db.from('list_members').select('list_id').eq('lead_id', contactId).then((r: never) => must(r, 'the customer lists')),
    db.from('messages').select('direction, agent_role, type, content, created_at').eq('conversation_id', input.conversation_id).order('created_at', { ascending: false }).limit(HISTORY_LIMIT).then((r: never) => must(r, 'messages')),
  ]);
  const history = toHistory([...(messages ?? [])].reverse());
  const customer: CustomerFile = {
    name: contact?.name, ad_headline: contact?.ad_headline, ad_body: contact?.ad_body, lead_summary: contact?.lead_summary,
    context_summary: convo?.context_summary || contact?.context_summary, customer_intent: contact?.customer_intent,
    lead_quality: contact?.lead_quality, objection_tags: contact?.objection_tags, notes: contact?.notes,
    stage: convo?.lead_stage_service || convo?.lead_stage_ecom || convo?.conv_stage || null,
    first_contact: !history.some((m) => m.role === 'assistant'),
  };
  return {
    customer, adIds: [contact?.ad_id, contact?.original_ad_id], listIds: (members ?? []).map((m: { list_id: string }) => String(m.list_id)),
    stickyFlowId: convo?.chat_ai_flow_id ?? null, history,
  };
}

// deno-lint-ignore no-explicit-any
export async function loadContext(db: any, input: TurnInput, cache?: ContextCache): Promise<TurnContext> {
  const businessId = input.business_id;
  const c = input.simulate === true ? undefined : cache;
  const [core, categories, chat] = await Promise.all([getCore(db, businessId, c), getCategories(db, businessId, c), loadVolatile(db, input)]);

  return {
    business: { name: core.business.name || 'the business', currency: core.business.currency || null, model: core.business.chat_ai_model || 'gpt-5-mini' },
    settings: readSettings(core.business.chat_ai_settings),
    persona: core.personaPack,
    categories,
    skills: core.skills,
    toolRows: core.toolRows,
    flows: core.flows,
    ...chat,
  };
}
