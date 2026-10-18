// The built-in tools. Each handler gets the arguments the model chose and the state of the current turn.

import type { ToolRow } from './tools.ts';
import { resolveRecipients, type HandoffConfig } from './handoff.ts';

export type ProductRow = {
  id: string; title: string; price: number | null; old_price?: number | null; category: string | null;
  description_short: string | null; images: string[] | null; stock_quantity?: number | null; product_type?: string | null;
};

export type SendItem = { text?: string; media?: { type: 'image'; url: string; caption: string } };
export type SendResult = { ok: boolean; results?: Array<{ ok: boolean; error?: string; messageId?: string | null }>; error?: string };
// Messages handed to the sender without waiting for them to go out. `settled` resolves once the sender is done with them.
export type QueueResult = { ok: boolean; error?: string; settled: Promise<SendResult> };
export type PendingSend = { ids: string[]; settled: Promise<SendResult> };

export type TurnState = {
  businessId: string; contactId: number | null; conversationId: string | null; currency: string | null; simulate: boolean;
  seenProducts: Map<string, ProductRow>;
  skills: Map<string, { key: string; title: string; instructions: string }>;
  skillsLoaded: Set<string>;
  productsSent: string[];
  pending?: PendingSend[];         // product photos queued but not yet confirmed sent (see settlePending)
  handoff: { reason: string; urgency: string; summary: string } | null;
  corpus: string[];                // every legitimate fact the reply may use (feeds the price check)
  knowledge: Array<{ id: string; title: string; file_type: string }>;   // files this chat may search (active, ready, for the chat AI)
  handoffConfig: HandoffConfig | null;
  ownerPhone: string | null;
  outbox: SendItem[];              // simulation only: what would have been sent, so the Playground can show it
  handoffAlert: { rule: { id: string; label: string } | null; recipients: Array<{ name: string; phone: string }>; whatsapp: boolean } | null;
};

export type Deps = {
  // deno-lint-ignore no-explicit-any
  db: any;
  embed: (text: string) => Promise<number[]>;
  send: (items: SendItem[]) => Promise<SendResult>;
  // Optional. When present, send_products queues its photos and returns at once instead of waiting for WhatsApp.
  queue?: (items: SendItem[]) => Promise<QueueResult>;
  fetch: typeof fetch;
  toolSecret?: string;
};

// Waits for every photo send queued this turn, records the ones that went out, and reports the ones that did not.
// Called before the written reply is sent, so the customer never gets a message about photos that are still on their
// way, and the AI is told about any that failed.
export async function settlePending(state: TurnState): Promise<{ sent: string[]; failed: Array<{ id: string; error: string }> }> {
  const batches = state.pending ?? [];
  state.pending = [];
  const sent: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const batch of batches) {
    const result = await batch.settled.catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) } as SendResult));
    batch.ids.forEach((id, i) => {
      const r = result.results?.[i];
      if (r?.ok) { sent.push(id); state.productsSent.push(id); } else failed.push({ id, error: r?.error || result.error || 'not sent' });
    });
  }
  return { sent, failed };
}

export function formatPrice(price: number | null | undefined, currency: string | null): string {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return '';
  const n = Number(price);
  const shown = Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency || 'KES'} ${shown}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const URGENCY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2 };

// Records who must be told about a handoff. The backend reads these rows and sends the WhatsApp message from the
// HeySasa number (an edge function cannot reach that WhatsApp line). Home reads the conversation itself, so it shows the
// handoff whether or not this row could be saved. Never throws: a failed alert must not break the customer's reply.
export async function queueHandoffAlert(
  // deno-lint-ignore no-explicit-any
  db: any,
  state: Pick<TurnState, 'businessId' | 'contactId' | 'conversationId' | 'handoffConfig' | 'ownerPhone' | 'simulate' | 'handoffAlert'>,
  h: { reason: string; urgency: string; summary: string; ruleId?: string | null; source: 'ai' | 'rule' },
): Promise<{ urgency: string }> {
  const config = state.handoffConfig;
  const { recipients, rule } = config ? resolveRecipients(config, h.ruleId, state.ownerPhone)
    : { recipients: resolveRecipients({ recipients: [], rules: [], default_to: ['owner'], alert_whatsapp: true }, null, state.ownerPhone).recipients, rule: null };
  const urgency = rule && (URGENCY_RANK[rule.urgency] ?? 1) > (URGENCY_RANK[h.urgency] ?? 1) ? rule.urgency : h.urgency;
  const whatsapp = config?.alert_whatsapp !== false;
  state.handoffAlert = { rule: rule ? { id: rule.id, label: rule.label } : null, recipients, whatsapp };
  if (state.simulate || !state.conversationId) return { urgency };
  try {
    let contact: { name?: string | null; phone?: string | null } | null = null;
    if (state.contactId) contact = (await db.from('contacts').select('name, phone').eq('id', state.contactId).maybeSingle())?.data ?? null;
    await db.from('handoff_events').insert({
      business_id: state.businessId, conversation_id: state.conversationId, contact_id: state.contactId, contact_name: contact?.name ?? null,
      contact_phone: normalizeDigits(contact?.phone), reason: h.reason, urgency, summary: h.summary, rule_id: rule?.id ?? null, rule_label: rule?.label ?? null,
      source: h.source, recipients: whatsapp ? recipients : [], notify_status: whatsapp && recipients.length ? 'pending' : 'skipped',
    });
  } catch (error) {
    console.error(`[handoff] could not queue the alert business=${state.businessId}: ${String((error as Error)?.message ?? error)}`);
  }
  return { urgency };
}
const normalizeDigits = (v: unknown) => String(v ?? '').replace(/\D+/g, '') || null;

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

  // Searches the business's uploaded files (procedures, price lists, policies...). The chunks are the only source of truth.
  async file_search(args, state, deps) {
    const query = str(args.query);
    if (!query) return { error: 'query is required' };
    if (!state.knowledge.length) return { results: [], message: 'This business has no files you can search.' };
    const sourceId = str(args.source_id);
    if (sourceId && !state.knowledge.some((k) => k.id === sourceId)) return { error: `No file with id "${sourceId}". Use an id from the BUSINESS FILES list.` };
    const embedding = await deps.embed(query);
    const { data, error } = await deps.db.rpc('match_knowledge_chunks', {
      p_business_id: state.businessId, p_embedding: embedding, p_count: 5, p_threshold: 0.25, p_bot: 'chat', p_source_id: sourceId || null,
    });
    if (error) throw new Error(`file search failed: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    const rows: any[] = data ?? [];
    if (!rows.length) return { results: [], message: 'Nothing in the files matches. Do not guess. Say you will confirm, and hand off if it matters.' };
    const results = rows.map((r) => ({
      file: r.title ?? r.source_title ?? undefined, file_id: r.source_id, page: r.page ?? undefined, text: String(r.content ?? '').slice(0, 900),
    }));
    for (const r of results) state.corpus.push(r.text);
    return { results };
  },

  async send_knowledge_image(args, state, deps) {
    const id = str(args.source_id);
    const listed = state.knowledge.find((k) => k.id === id);
    if (!listed) return { error: `No file with id "${id}". Use an id from the BUSINESS FILES list.` };
    if (listed.file_type !== 'image') return { error: 'Only files marked image can be sent. Describe what the file says instead.' };
    const { data: row, error } = await deps.db.from('knowledge_sources').select('storage_path, title, mime_type')
      .eq('id', id).eq('business_id', state.businessId).eq('is_active', true).maybeSingle();
    if (error || !row?.storage_path) return { error: 'That file could not be found.' };
    const signed = await deps.db.storage.from('business-knowledge').createSignedUrl(row.storage_path, 600);
    const url = signed?.data?.signedUrl;
    if (!url) return { error: 'The image could not be prepared. Do not claim the customer saw it.' };
    const caption = str(args.caption).slice(0, 300) || row.title || '';
    const items: SendItem[] = [{ media: { type: 'image', url, caption } }];
    if (state.simulate) state.outbox.push(...items);
    const result = await deps.send(items);
    if (!result.ok && !result.results?.some((r) => r.ok)) return { sent: false, error: result.error || 'The image could not be sent. Do not claim the customer saw it.' };
    return { sent: true, message: 'The customer can now see the image.' };
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
    if (state.simulate) state.outbox.push(...items);
    if (deps.queue) {
      // The photos go out while the AI writes its message. turn.ts waits for them before the message is sent, and tells
      // the AI if any failed, so it still never claims the customer saw something they did not.
      const queued = await deps.queue(items);
      if (!queued.ok) return { sent: [], error: queued.error || 'The messages could not be queued. Do not claim the customer saw anything.' };
      (state.pending ??= []).push({ ids, settled: queued.settled });
      return { queued: ids, message: 'These products are being sent to the customer now. Write your message about them as if they can see them.' };
    }
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
    const ruleId = str(args.rule_id) || null;
    const alert = await queueHandoffAlert(deps.db, state, { reason, urgency, summary, ruleId, source: 'ai' });
    state.handoff = { reason, urgency: alert.urgency, summary };
    if (state.simulate || !state.conversationId) return { ok: true, simulated: state.simulate, instruction: 'Now send the customer one short message saying the owner will pick up. Do not promise a time.' };
    const { error } = await deps.db.from('conversations').update({
      handover_flag: true, handover_reason: reason, handover_urgency: alert.urgency, handover_summary: summary,
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
