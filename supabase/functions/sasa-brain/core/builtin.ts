// The built-in tools. Each handler gets the arguments the model chose and the state of the current turn.

import type { ToolRow } from './tools.ts';

export type ProductRow = {
  id: string; title: string; price: number | null; old_price?: number | null; category: string | null;
  description_short: string | null; images: string[] | null; stock_quantity?: number | null; product_type?: string | null;
};

export type SendItem = { text?: string; media?: { type: 'image'; url: string; caption: string } };
export type SendResult = { ok: boolean; results?: Array<{ ok: boolean; error?: string; messageId?: string | null }>; error?: string };

export type TurnState = {
  businessId: string; contactId: number | null; conversationId: string | null; currency: string | null; simulate: boolean;
  seenProducts: Map<string, ProductRow>;
  skills: Map<string, { key: string; title: string; instructions: string }>;
  skillsLoaded: Set<string>;
  productsSent: string[];
  handoff: { reason: string; urgency: string; summary: string } | null;
  corpus: string[];                // every legitimate fact the reply may use (feeds the price check)
};

export type Deps = {
  // deno-lint-ignore no-explicit-any
  db: any;
  embed: (text: string) => Promise<number[]>;
  send: (items: SendItem[]) => Promise<SendResult>;
  fetch: typeof fetch;
  toolSecret?: string;
};

export function formatPrice(price: number | null | undefined, currency: string | null): string {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return '';
  const n = Number(price);
  const shown = Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency || 'KES'} ${shown}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

type Handler = (args: Record<string, unknown>, state: TurnState, deps: Deps) => Promise<unknown>;

export const builtinHandlers: Record<string, Handler> = {
  async search_products(args, state, deps) {
    const query = str(args.query);
    if (!query) return { error: 'query is required' };
    const embedding = await deps.embed(query);
    const { data, error } = await deps.db.rpc('match_products_v8', {
      query_embedding: embedding, match_threshold: 0.3, match_count: 5, filter_business_id: state.businessId, query_text: query,
    });
    if (error) throw new Error(`product search failed: ${error.message}`);
    const rows: ProductRow[] = data ?? [];
    for (const p of rows) state.seenProducts.set(p.id, p);
    if (!rows.length) return { results: [], message: 'No matching products in the catalog.' };
    const results = rows.map((p) => {
      const price = formatPrice(p.price, state.currency);
      const stock = p.product_type !== 'service' && Number(p.stock_quantity) > 0 ? Number(p.stock_quantity) : undefined;
      const out = {
        id: p.id, name: p.title, price: price || 'no price on file', category: p.category || undefined,
        description: p.description_short ? p.description_short.slice(0, 240) : undefined,
        has_photo: Array.isArray(p.images) && p.images.length > 0, in_stock_count: stock,
      };
      state.corpus.push(JSON.stringify(out), String(p.price ?? ''), String(p.old_price ?? ''));
      return out;
    });
    return { results };
  },

  async search_knowledge(args, state, deps) {
    const query = str(args.query);
    if (!query) return { error: 'query is required' };
    const embedding = await deps.embed(query);
    const { data, error } = await deps.db.rpc('match_knowledge', {
      query_embedding: embedding, match_threshold: 0.3, match_count: 3, filter_business_id: state.businessId,
    });
    if (error) throw new Error(`knowledge search failed: ${error.message}`);
    const rows: Array<{ content: string }> = data ?? [];
    if (!rows.length) return { results: [], message: 'Nothing on file about this. Say you will confirm, and hand off if it matters.' };
    const results = rows.map((r) => r.content.slice(0, 700));
    state.corpus.push(...results);
    return { results };
  },

  async load_skill(args, state) {
    const key = str(args.key);
    const skill = state.skills.get(key);
    if (!skill) return { error: `No skill called "${key}".`, available: [...state.skills.keys()].sort() };
    state.skillsLoaded.add(key);
    state.corpus.push(skill.instructions);
    return { skill: skill.key, instructions: skill.instructions };
  },

  async update_profile(args, state, deps) {
    const note = str(args.note).slice(0, 500);
    if (!note) return { error: 'note is required' };
    const tags = Array.isArray(args.objection_tags) ? args.objection_tags.map((t) => str(t).toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 5) : [];
    if (state.simulate || !state.contactId) return { ok: true, simulated: state.simulate };

    const { data: contact, error: readError } = await deps.db.from('contacts').select('notes, objection_tags').eq('id', state.contactId).maybeSingle();
    if (readError) throw new Error(`could not read the customer file: ${readError.message}`);
    const stamp = new Date().toISOString().slice(0, 10);
    const update: Record<string, unknown> = { notes: `${contact?.notes ? `${contact.notes}\n` : ''}[${stamp} AI] ${note}`.slice(-4000) };
    if (tags.length) update.objection_tags = [...new Set([...(contact?.objection_tags ?? []), ...tags])].slice(0, 20);
    const { error: writeError } = await deps.db.from('contacts').update(update).eq('id', state.contactId);
    if (writeError) throw new Error(`could not save the note: ${writeError.message}`);

    const embedding = await deps.embed(note).catch(() => null);
    await deps.db.from('customer_notes').insert({ user_id: String(state.contactId), business_id: state.businessId, note, ...(embedding ? { embedding } : {}) });
    return { ok: true };
  },

  async send_products(args, state, deps) {
    const ids = Array.isArray(args.product_ids) ? args.product_ids.map(String).slice(0, 3) : [];
    if (!ids.length) return { error: 'product_ids is required' };
    const unknown = ids.filter((id) => !state.seenProducts.has(id));
    if (unknown.length) return { error: `These ids did not come from search_products in this turn: ${unknown.join(', ')}. Search first.` };

    const items: SendItem[] = ids.map((id) => {
      const p = state.seenProducts.get(id)!;
      const price = formatPrice(p.price, state.currency);
      const caption = [p.title, price].filter(Boolean).join('\n');
      const photo = Array.isArray(p.images) ? p.images.find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : null;
      return photo ? { media: { type: 'image', url: photo, caption } } : { text: caption };
    });
    const result = await deps.send(items);
    if (!result.ok && !result.results?.some((r) => r.ok)) return { sent: [], error: result.error || 'The messages could not be sent. Do not claim the customer saw anything.' };
    const sent: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    ids.forEach((id, i) => {
      const r = result.results?.[i];
      if (r?.ok) { sent.push(id); state.productsSent.push(id); } else failed.push({ id, error: r?.error || 'not sent' });
    });
    return failed.length ? { sent, failed } : { sent, message: 'The customer can now see these products.' };
  },

  async handoff(args, state, deps) {
    const reason = str(args.reason).slice(0, 200) || 'handoff';
    const urgency = ['low', 'normal', 'high'].includes(str(args.urgency)) ? str(args.urgency) : 'normal';
    const summary = str(args.summary).slice(0, 1500);
    state.handoff = { reason, urgency, summary };
    if (state.simulate || !state.conversationId) return { ok: true, simulated: state.simulate, instruction: 'Now send the customer one short message saying the owner will pick up. Do not promise a time.' };
    const { error } = await deps.db.from('conversations').update({
      handover_flag: true, handover_reason: reason, handover_urgency: urgency, handover_summary: summary,
      handover_at: new Date().toISOString(), handover_source: 'ai', handover_resolved_at: null,
    }).eq('id', state.conversationId);
    if (error) throw new Error(`could not record the handoff: ${error.message}`);
    return { ok: true, instruction: 'Now send the customer one short message saying the owner will pick up. Do not promise a time.' };
  },
};

// Runs a tool from the registry: a built-in handler, a Postgres function, or an HTTP endpoint.
export async function runRegistryTool(row: ToolRow, args: Record<string, unknown>, state: TurnState, deps: Deps): Promise<unknown> {
  if (row.kind === 'builtin') {
    const handler = builtinHandlers[row.target];
    if (!handler) throw new Error(`The built-in handler "${row.target}" does not exist.`);
    return handler(args, state, deps);
  }
  if (state.simulate && row.phase !== 'lookup') return { ok: true, simulated: true };

  let result: unknown;
  if (row.kind === 'rpc') {
    const { data, error } = await deps.db.rpc(row.target, {
      p_business_id: state.businessId, p_contact_id: state.contactId, p_conversation_id: state.conversationId, p_args: args,
    });
    if (error) throw new Error(error.message);
    result = data;
  } else {
    const res = await deps.fetch(row.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(deps.toolSecret ? { 'x-sasa-secret': deps.toolSecret } : {}) },
      body: JSON.stringify({ business_id: state.businessId, contact_id: state.contactId, conversation_id: state.conversationId, args }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${row.name} returned ${res.status}`);
    result = await res.json();
  }
  state.corpus.push(typeof result === 'string' ? result : JSON.stringify(result));
  return result;
}
