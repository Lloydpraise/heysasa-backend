import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, enqueueAndWait, waitForDelivery } from './outbox.ts';
import { toHistory, readSettings, loadContext, loadSettings, createContextCache } from './context.ts';
import { makeCallModel, makeEmbed } from './openai.ts';
import { builtinHandlers, runRegistryTool, settlePending, type TurnState } from './builtin.ts';
import type { ToolRow } from './tools.ts';

// ── a tiny in-memory outbox table ──
function outboxDb(onSubscribe: (rows: any[], emit: () => void) => void) {
  const rows: any[] = [];
  let onChange = () => {};
  const channel = {
    on: (_event: string, _filter: unknown, callback: () => void) => { onChange = callback; return channel; },
    subscribe: (callback: (status: string) => void) => { queueMicrotask(() => { callback('SUBSCRIBED'); onSubscribe(rows, onChange); }); return channel; },
  };
  const db = {
    channel: () => channel,
    removeChannel: async () => 'ok',
    from: (table: string) => {
      assert.equal(table, 'chat_ai_outbox');
      return {
        insert: (input: any[]) => ({
          select: async () => {
            const made = input.map((r, i) => ({ ...r, id: `o${rows.length + i}`, status: 'queued', error: null, whatsapp_message_id: null }));
            rows.push(...made);
            return { data: made.map((r) => ({ id: r.id, seq: r.seq })), error: null };
          },
        }),
        select: () => ({ in: async (_c: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r })), error: null }) }),
        update: (patch: any) => ({ in: (_c: string, ids: string[]) => ({ eq: async (_s: string, status: string) => { rows.filter((r) => ids.includes(r.id) && r.status === status).forEach((r) => Object.assign(r, patch)); return { error: null }; } }) }),
      };
    },
  };
  return { db, rows };
}
const target = { businessId: 'b1', conversationId: 'c1', contactId: 7 };

test('the outbox waits until every message is sent and reports each result in order', async () => {
  const { db, rows } = outboxDb((r, emit) => {
    queueMicrotask(() => {
      r[0].status = 'sent'; r[0].whatsapp_message_id = 'W1';
      emit();
      r[1].status = 'sent'; r[1].whatsapp_message_id = 'W2';
      emit();
    });
  });
  const result = await enqueueAndWait(db, target, [{ media: { type: 'image', url: 'https://x/a.jpg', caption: 'A\nKES 100' } }, { text: 'hello' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ ok: true, messageId: 'W1' }, { ok: true, messageId: 'W2' }]);
  assert.deepEqual(rows.map((r) => [r.kind, r.seq]), [['image', 0], ['text', 1]]);
  assert.equal(rows[0].media.caption, 'A\nKES 100');
});

test('a message the sender rejects comes back as failed with the reason', async () => {
  const { db } = outboxDb((r, emit) => { r[0].status = 'failed'; r[0].error = 'no_send_target'; emit(); });
  const result = await enqueueAndWait(db, target, [{ text: 'hi' }]);
  assert.deepEqual([result.ok, result.results?.[0]?.error], [false, 'no_send_target']);
});

test('if the sender never picks a message up, it is cancelled so it cannot go out late', async () => {
  const { db, rows } = outboxDb(() => {});
  const result = await enqueueAndWait(db, target, [{ text: 'hi' }], { timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error, 'timed_out_waiting_for_sender');
});

test('queueing returns at once; the wait for delivery can be done later and reports each result', async () => {
  const { db, rows } = outboxDb((r, emit) => {
    queueMicrotask(() => {
      r.forEach((x, i) => { x.status = 'sent'; x.whatsapp_message_id = `W${i}`; });
      emit();
    });
  });
  const queued = await enqueue(db, target, [{ text: 'a' }, { text: 'b' }]);
  assert.equal(queued.ok, true);
  assert.equal(rows.length, 2, 'rows are saved for the sender');
  assert.equal(rows.every((r) => r.status === 'queued'), true, 'nothing has waited for the sender yet');
  const result = await waitForDelivery(db, (queued as { ok: true; queued: any }).queued);
  assert.deepEqual(result.results, [{ ok: true, messageId: 'W0' }, { ok: true, messageId: 'W1' }]);
});

test('queueing reports a database failure instead of pretending the message was saved', async () => {
  const db = { from: () => ({ insert: () => ({ select: async () => ({ data: null, error: { message: 'db down' } }) }) }) };
  const queued = await enqueue(db, target, [{ text: 'a' }]);
  assert.deepEqual(queued, { ok: false, error: 'could not queue the message: db down' });
});

// ── context helpers ──
test('history labels the owner and automatic follow-ups, and shows photos and voice notes as labels', () => {
  const rows = [
    { direction: 'in', type: 'text', content: { text: 'Hi' } },
    { direction: 'out', agent_role: 'follow_up_ai', type: 'text', content: { text: 'Still interested?' } },
    { direction: 'out', agent_role: 'human', type: 'text', content: { text: 'Call me' } },
    { direction: 'in', type: 'image', content: { text: 'this one' } },
    { direction: 'in', type: 'audio', content: {} },
    { direction: 'in', type: 'reaction', content: { text: '👍' } },
    { direction: 'out', agent_role: 'chat_ai', type: 'text', content: { text: 'Classic or volume?' } },
  ];
  assert.deepEqual(toHistory(rows), [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: '[automatic follow-up] Still interested?' },
    { role: 'assistant', text: '[sent by the owner] Call me' },
    { role: 'user', text: '[photo] this one' },
    { role: 'user', text: '[voice note]' },
    { role: 'assistant', text: 'Classic or volume?' },
  ]);
});

test('settings have safe defaults and limits', () => {
  assert.deepEqual(readSettings(null), { effort: 'low', settleMs: 3000, holdingAfterMs: 9000, maxRounds: 6, holdingModel: 'gpt-4.1-mini' });
  const s = readSettings({ effort: 'banana', settle_ms: 999999, holding_after_ms: 0, max_rounds: 1 });
  assert.deepEqual([s.effort, s.settleMs, s.holdingAfterMs, s.maxRounds], ['low', 15000, 0, 2]);
  assert.equal(readSettings({ effort: 'high' }).effort, 'high', 'a business can still ask for more thinking');
});

// ── OpenAI calls ──
const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('a rate limit is retried once, a bad request is not', async () => {
  let calls = 0;
  const ok = makeCallModel({ apiKey: 'k', sleep: async () => {}, fetch: (async () => (++calls === 1 ? res(429, 'slow down') : res(200, { id: 'r' }))) as typeof fetch });
  assert.deepEqual(await ok({ model: 'm' }), { id: 'r' });
  assert.equal(calls, 2);

  calls = 0;
  const bad = makeCallModel({ apiKey: 'k', sleep: async () => {}, fetch: (async () => { calls++; return res(400, 'bad model'); }) as typeof fetch });
  await assert.rejects(bad({ model: 'x' }), /400: bad model/);
  assert.equal(calls, 1);
});

test('embeddings return the vector and fail loudly when OpenAI sends none', async () => {
  const good = makeEmbed({ apiKey: 'k', sleep: async () => {}, fetch: (async (_u: string, init: RequestInit) => { assert.match(String(init.body), /text-embedding-3-small/); return res(200, { data: [{ embedding: [1, 2] }] }); }) as unknown as typeof fetch });
  assert.deepEqual(await good('x'), [1, 2]);
  const none = makeEmbed({ apiKey: 'k', sleep: async () => {}, fetch: (async () => res(200, { data: [] })) as typeof fetch });
  await assert.rejects(none('x'), /no embedding/);
});

// ── built-in handlers and the dynamic registry ──
const state = (over: Partial<TurnState> = {}): TurnState => ({
  businessId: 'b1', contactId: 7, conversationId: 'c1', currency: 'KES', simulate: false, seenProducts: new Map(), skills: new Map(), skillsLoaded: new Set(),
  productsSent: [], handoff: null, corpus: [], ...over,
});

test('product search returns only what the database returns, with price text, and remembers the ids for sending', async () => {
  const st = state();
  const db = { rpc: async (fn: string, args: any) => { assert.equal(fn, 'match_products_v8'); assert.equal(args.filter_business_id, 'b1'); return { data: [{ id: 'p1', title: 'Set', price: 1500, category: 'Lashes', description_short: 'd', images: [], stock_quantity: 0, product_type: 'service' }], error: null }; } };
  const out: any = await builtinHandlers.search_products({ query: 'set' }, st, { db, embed: async () => [0], send: async () => ({ ok: true }), fetch });
  assert.equal(out.results[0].price, 'KES 1,500');
  assert.equal(out.results[0].has_photo, false);
  assert.ok(st.seenProducts.has('p1'));
  const none: any = await builtinHandlers.search_products({ query: 'x' }, state(), { db: { rpc: async () => ({ data: [], error: null }) }, embed: async () => [0], send: async () => ({ ok: true }), fetch });
  assert.match(none.message, /No matching products/);
});

test('a product with no photo is sent as text, and a failed send is reported honestly', async () => {
  const st = state();
  st.seenProducts.set('p1', { id: 'p1', title: 'Set', price: 1500, category: null, description_short: null, images: [] });
  let sentItems: any[] = [];
  const ok: any = await builtinHandlers.send_products({ product_ids: ['p1'] }, st, { db: {}, embed: async () => [], fetch, send: async (items) => { sentItems = items; return { ok: true, results: [{ ok: true }] }; } });
  assert.deepEqual(sentItems, [{ text: 'Set\nKES 1,500' }]);
  assert.deepEqual(ok.sent, ['p1']);
  const failed: any = await builtinHandlers.send_products({ product_ids: ['p1'] }, st, { db: {}, embed: async () => [], fetch, send: async () => ({ ok: false, error: 'sender down' }) });
  assert.equal(failed.sent.length, 0);
  assert.match(failed.error, /sender down|could not be sent/);
});

test('update_profile saves a note, merges objection tags, and does nothing in simulation', async () => {
  const writes: any[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { notes: 'old', objection_tags: ['price'] }, error: null }) }) }),
      update: (row: any) => ({ eq: async () => { writes.push([table, row]); return { error: null }; } }),
      insert: async (row: any) => { writes.push([table, row]); return { error: null }; },
    }),
  };
  const out: any = await builtinHandlers.update_profile({ note: 'Wants it for a wedding on Dec 5', objection_tags: ['Timing', 'price'] }, state(), { db, embed: async () => [0.5], send: async () => ({ ok: true }), fetch });
  assert.equal(out.ok, true);
  assert.match(writes[0][1].notes, /^old\n\[\d{4}-\d{2}-\d{2} AI\] Wants it for a wedding/);
  assert.deepEqual(writes[0][1].objection_tags, ['price', 'timing']);
  assert.equal(writes[1][0], 'customer_notes');
  assert.equal(writes[1][1].user_id, '7');
  writes.length = 0;
  const sim: any = await builtinHandlers.update_profile({ note: 'x' }, state({ simulate: true }), { db, embed: async () => [], send: async () => ({ ok: true }), fetch });
  assert.deepEqual([sim.simulated, writes.length], [true, 0]);
});

test('a tool you add as a database row runs without any new code: rpc and http kinds', async () => {
  const rpcRow: ToolRow = { name: 'check_stock', business_id: null, description: 'd', parameters: {}, kind: 'rpc', target: 'my_check_stock', phase: 'lookup' };
  const httpRow: ToolRow = { name: 'book_slot', business_id: 'b1', description: 'd', parameters: {}, kind: 'http', target: 'https://example.test/hook', phase: 'write' };
  const calls: any[] = [];
  const deps = {
    db: { rpc: async (fn: string, args: any) => { calls.push([fn, args]); return { data: { in_stock: 3 }, error: null }; } },
    embed: async () => [], send: async () => ({ ok: true }),
    fetch: (async (url: string, init: any) => { calls.push([url, JSON.parse(init.body), init.headers['x-sasa-secret']]); return res(200, { booked: true }); }) as unknown as typeof fetch,
    toolSecret: 'sekret',
  };
  const st = state();
  assert.deepEqual(await runRegistryTool(rpcRow, { sku: 'a' }, st, deps), { in_stock: 3 });
  assert.deepEqual(calls[0], ['my_check_stock', { p_business_id: 'b1', p_contact_id: 7, p_conversation_id: 'c1', p_args: { sku: 'a' } }]);
  assert.deepEqual(await runRegistryTool(httpRow, { when: 'tue' }, st, deps), { booked: true });
  assert.deepEqual(calls[1], ['https://example.test/hook', { business_id: 'b1', contact_id: 7, conversation_id: 'c1', args: { when: 'tue' } }, 'sekret']);
  // In a Playground simulation, tools that change things are not run; lookups still are.
  const simState = state({ simulate: true });
  assert.deepEqual(await runRegistryTool(httpRow, {}, simState, deps), { ok: true, simulated: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(await runRegistryTool(rpcRow, {}, simState, deps), { in_stock: 3 });
});

test('a registry row pointing at a missing built-in handler is an error, not a crash', async () => {
  const row: ToolRow = { name: 'ghost', business_id: null, description: 'd', parameters: {}, kind: 'builtin', target: 'ghost', phase: 'lookup' };
  await assert.rejects(runRegistryTool(row, {}, state(), { db: {}, embed: async () => [], send: async () => ({ ok: true }), fetch }), /does not exist/);
});

// ── settling photos queued in the background ──
test('settlePending records the photos that went out and names the ones that did not', async () => {
  const st = state({
    pending: [
      { ids: ['p1', 'p2'], settled: Promise.resolve({ ok: false, results: [{ ok: true, messageId: 'W1' }, { ok: false, error: 'bad media' }] }) },
      { ids: ['p3'], settled: Promise.reject(new Error('network')) },
    ],
  });
  const out = await settlePending(st);
  assert.deepEqual(out.sent, ['p1']);
  assert.deepEqual(out.failed, [{ id: 'p2', error: 'bad media' }, { id: 'p3', error: 'network' }]);
  assert.deepEqual(st.productsSent, ['p1']);
  assert.deepEqual((await settlePending(st)).failed, [], 'nothing is settled twice');
});

test('send_products with a queue returns at once and records what is pending; without one it still waits', async () => {
  const st = state();
  st.seenProducts.set('p1', { id: 'p1', title: 'Set', price: 1500, category: null, description_short: null, images: ['https://x/a.jpg'] });
  let waited = false;
  const queued: any = await builtinHandlers.send_products({ product_ids: ['p1'] }, st, {
    db: {}, embed: async () => [], fetch, send: async () => { waited = true; return { ok: true }; },
    queue: async () => ({ ok: true, settled: Promise.resolve({ ok: true, results: [{ ok: true }] }) }),
  });
  assert.deepEqual(queued.queued, ['p1']);
  assert.equal(waited, false);
  assert.equal(st.pending?.length, 1);
  assert.equal(st.productsSent.length, 0, 'not counted as sent until delivery is confirmed');
  const refused: any = await builtinHandlers.send_products({ product_ids: ['p1'] }, state({ seenProducts: st.seenProducts }), {
    db: {}, embed: async () => [], fetch, send: async () => ({ ok: true }), queue: async () => ({ ok: false, error: 'could not queue', settled: Promise.resolve({ ok: false }) }),
  });
  assert.equal(refused.sent.length, 0);
  assert.match(refused.error, /could not queue/);
});

// ── the business-level cache ──
function contextDb(counter: Record<string, number>) {
  const answers: Record<string, any> = {
    businesses: { name: 'Biz', currency: 'KES', chat_ai_model: 'gpt-5-mini', chat_ai_settings: { effort: 'high' } },
    persona_packs: [{ pack: { persona: 'warm' } }], products: [{ category: 'Lashes' }, { category: 'Lashes' }],
    chat_ai_skills: [], chat_ai_tools: [], chat_flows: [], contacts: { name: 'Amina' }, conversations: { chat_ai_flow_id: null },
    list_members: [], messages: [{ direction: 'in', type: 'text', content: { text: 'hi' } }],
  };
  const chain = (table: string): any => {
    counter[table] = (counter[table] ?? 0) + 1;
    const q: any = new Proxy({}, { get: (_t, prop) => {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: answers[table], error: null });
      return () => q;
    } });
    return q;
  };
  return { from: chain };
}

test('business-level data is read once and reused for a short while; the chat itself is always read fresh', async () => {
  let clock = 0;
  const cache = createContextCache({ coreMs: 30_000, categoriesMs: 300_000, now: () => clock });
  const counter: Record<string, number> = {};
  const db = contextDb(counter);
  const live = { business_id: 'b1', conversation_id: 'c1', contact_id: 7 };
  const first = await loadContext(db, live, cache);
  await loadContext(db, live, cache);
  await loadSettings(db, live, cache);
  assert.deepEqual([counter.businesses, counter.persona_packs, counter.chat_ai_skills, counter.chat_ai_tools, counter.chat_flows, counter.products], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([counter.messages, counter.contacts, counter.conversations], [2, 2, 2], 'the customer and the history are read every time');
  assert.deepEqual(first.categories, [{ name: 'Lashes', count: 2 }]);
  assert.equal(first.settings.effort, 'high');

  clock = 31_000;
  await loadContext(db, live, cache);
  assert.equal(counter.businesses, 2, 'persona, skills, tools and flows are re-read after 30 seconds');
  assert.equal(counter.products, 1, 'the product categories are kept for 5 minutes');
  clock = 301_000;
  await loadContext(db, live, cache);
  assert.equal(counter.products, 2);
});

test('the Playground never uses the cache, so an edited skill shows up at once', async () => {
  const cache = createContextCache();
  const counter: Record<string, number> = {};
  const db = contextDb(counter);
  const sim = { business_id: 'b1', simulate: true, message: 'hi' };
  await loadContext(db, sim, cache);
  await loadContext(db, sim, cache);
  assert.equal(counter.businesses, 2);
  assert.equal(counter.products, 2);
});

test('a failed read is never remembered', async () => {
  const cache = createContextCache();
  let calls = 0;
  const db = { from: () => { calls++; const q: any = new Proxy({}, { get: (_t, p) => (p === 'then' ? (r: (v: unknown) => void) => r({ data: null, error: { message: 'boom' } }) : () => q) }); return q; } };
  await assert.rejects(loadSettings(db, { business_id: 'b1' }, cache), /could not load the business/);
  const before = calls;
  await assert.rejects(loadSettings(db, { business_id: 'b1' }, cache), /could not load the business/);
  assert.ok(calls > before, 'the second message tried again instead of replaying the failure');
});
