// The whole chain with fakes only at the edges: an in-memory database, a scripted OpenAI and a stand-in sender.
// Catches wiring mistakes the unit tests cannot: query shapes, the outbox wait, what gets saved and logged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from './turn.ts';
import { buildDeps } from './deps.ts';

type Row = Record<string, any>;

// Column defaults the real database applies on insert.
const DEFAULTS: Record<string, Row> = { chat_ai_outbox: { status: 'queued' } };

function fakeDb(tables: Record<string, Row[]>, rpcs: Record<string, (args: any) => any>) {
  let idCounter = 0;
  return {
    tables,
    rpc: async (fn: string, args: any) => ({ data: rpcs[fn] ? rpcs[fn](args) : null, error: rpcs[fn] ? null : { message: `no rpc ${fn}` } }),
    from(table: string) {
      if (!tables[table]) throw new Error(`unknown table ${table}`);
      const q: any = { filters: [] as Array<(r: Row) => boolean>, op: 'select', payload: null, single: false, limitN: null, orders: [] as Array<[string, boolean]>, returning: false };
      const rows = () => tables[table].filter((r) => q.filters.every((f: any) => f(r)));
      const api: any = {
        select() { if (q.op !== 'select') q.returning = true; return api; },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api; },
        neq(c: string, v: any) { q.filters.push((r: Row) => r[c] !== v); return api; },
        gt(c: string, v: any) { q.filters.push((r: Row) => r[c] > v); return api; },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api; },
        or(expr: string) {
          const parts = expr.split(',').map((p) => p.split('.'));
          q.filters.push((r: Row) => parts.some(([col, op, val]) => (op === 'is' && val === 'null' ? r[col] == null : op === 'eq' ? r[col] === val : false)));
          return api;
        },
        order(c: string, o?: { ascending?: boolean }) { q.orders.push([c, o?.ascending !== false]); return api; },
        limit(n: number) { q.limitN = n; return api; },
        maybeSingle() { q.single = true; return api; },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api; },
        update(p: any) { q.op = 'update'; q.payload = p; return api; },
        then(resolve: any, reject: any) {
          const run = () => {
            if (q.op === 'insert') {
              const made = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r: Row) => ({ id: `gen${++idCounter}`, ...(DEFAULTS[table] ?? {}), ...r }));
              tables[table].push(...made);
              return { data: q.returning ? made : null, error: null };
            }
            if (q.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, q.payload)); return { data: q.returning ? hit : null, error: null }; }
            let out = rows();
            for (const [c, asc] of [...q.orders].reverse()) out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
            if (q.limitN) out = out.slice(0, q.limitN);
            return { data: q.single ? (out[0] ?? null) : out, error: null };
          };
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const call = (n: number, name: string, args: unknown) => ({ type: 'function_call', call_id: `c${n}`, name, arguments: JSON.stringify(args) });
const message = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const usage = { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 80 };

function world() {
  const tables: Record<string, Row[]> = {
    businesses: [{ business_id: 'b1', name: 'Lashes by Shazz', currency: 'KES', chat_ai_model: 'gpt-5-mini', chat_ai_settings: { settle_ms: 0, holding_after_ms: 0 } }],
    persona_packs: [{ business_id: 'b1', is_active: true, version: 1, pack: { persona: 'Warm and short' } }],
    products: [
      { id: 'p1', business_id: 'b1', status: 'approved', ai_visible: true, category: 'Lashes' },
      { id: 'p2', business_id: 'b1', status: 'approved', ai_visible: true, category: 'Lashes' },
      { id: 'p3', business_id: 'b1', status: 'discovered', ai_visible: false, category: 'Hidden' },
    ],
    chat_ai_skills: [{ business_id: 'b1', enabled: true, key: 'checkout', title: 'Checkout', when_to_use: 'wants to buy', instructions: 'CHECKOUT-RULES' }, { business_id: 'b1', enabled: true, key: 'first_reply', title: 'First reply', when_to_use: 'new', instructions: 'FIRST' }],
    chat_ai_tools: [
      { name: 'search_products', business_id: null, enabled: true, description: 'find', parameters: {}, kind: 'builtin', target: 'search_products', phase: 'lookup' },
      { name: 'send_products', business_id: null, enabled: true, description: 'send', parameters: {}, kind: 'builtin', target: 'send_products', phase: 'send' },
      { name: 'update_profile', business_id: null, enabled: true, description: 'note', parameters: {}, kind: 'builtin', target: 'update_profile', phase: 'write' },
      { name: 'handoff', business_id: null, enabled: true, description: 'handoff', parameters: {}, kind: 'builtin', target: 'handoff', phase: 'write' },
      { name: 'other_business_only', business_id: 'b2', enabled: true, description: 'x', parameters: {}, kind: 'builtin', target: 'search_products', phase: 'lookup' },
    ],
    chat_flows: [{ id: 'f1', business_id: 'b1', enabled: true, name: 'Lash ad', priority: 100, trigger: { ad_ids: ['ad9'] }, goal: 'Book this week', instructions: 'Ask which style first.', skill_keys: ['checkout'], created_at: '2026-01-01' }],
    contacts: [{ id: 7, name: 'Amina', ad_id: 'ad9', original_ad_id: null, notes: null, objection_tags: null, ad_headline: 'Valentine lashes' }],
    conversations: [{ id: 'c1', chat_ai_flow_id: null, context_summary: null }],
    list_members: [],
    messages: [
      { whatsapp_message_id: 'W1', conversation_id: 'c1', direction: 'in', type: 'text', content: { text: 'hi how much is the volume set' }, created_at: '2026-10-04T10:00:00Z' },
    ],
    customer_notes: [],
    chat_ai_outbox: [],
    chat_ai_turns: [],
    business_balances: [{ business_id: 'b1', balance_usd: 5 }],
  };
  const billed: any[] = [];
  const db = fakeDb(tables, {
    bill_ai_usage: (a: any) => { billed.push(a); return { base_usd: 0.001, billed_usd: 0.008 }; },
    match_products_v8: (a: any) => (a.filter_business_id === 'b1' ? [{ id: 'p1', title: 'Volume Lash Set', price: 3500, category: 'Lashes', description_short: 'Fluffy', images: ['https://img.test/p1.jpg'], stock_quantity: 0, product_type: 'service' }] : []),
  });
  // Stand-in sender: whenever the brain waits, mark queued outbox rows as sent, like the follow-up engine would.
  let sentCount = 0;
  const sleep = async () => { for (const r of tables.chat_ai_outbox) if (r.status === 'queued') { r.status = 'sent'; r.whatsapp_message_id = `S${++sentCount}`; } };
  return { tables, db, sleep, billed };
}

test('a live turn end to end: context from the database, tools, photo then reply through the outbox, turn logged for QC', async () => {
  const { tables, db, sleep, billed } = world();
  const bodies: any[] = [];
  const script = [
    { id: 'r1', usage, output: [{ type: 'reasoning', summary: [{ text: 'Price question, need to search.' }] }, call(1, 'search_products', { query: 'volume set' }), call(2, 'update_profile', { note: 'Asked about the volume set' })] },
    { id: 'r2', usage, output: [call(3, 'send_products', { product_ids: ['p1'] })] },
    { id: 'r3', usage, output: [message('The volume set is KES 3,500. Want to book this week?')] },
  ];
  const fetchFn = (async (url: string, init: any) => {
    if (String(url).endsWith('/embeddings')) return ok({ data: [{ embedding: [0.1, 0.2] }] });
    bodies.push(JSON.parse(init.body));
    return ok(script.shift());
  }) as unknown as typeof fetch;

  const input = { business_id: 'b1', conversation_id: 'c1', contact_id: 7, trigger_message_id: 'W1' };
  const deps = buildDeps({ db, openaiKey: 'k', fetch: fetchFn, sleep }, input);
  const out = await runTurn(deps, input);

  assert.equal(out.status, 'replied', String(out.error));
  assert.equal(out.reply, 'The volume set is KES 3,500. Want to book this week?');
  assert.equal(out.flow, 'Lash ad');
  assert.ok(out.skills_loaded.includes('checkout'));

  // every model call and the embedding were billed to the chat_ai runner under one run id
  assert.ok(billed.length >= 4, `billed ${billed.length}`);
  assert.ok(billed.every((b) => b.p_runner === 'chat_ai' && b.p_business_id === 'b1'));
  assert.equal(new Set(billed.map((b) => b.p_run_id)).size, 1);
  assert.equal(billed.filter((b) => b.p_model === 'gpt-5-mini').length, 3);
  assert.equal(billed.find((b) => b.p_model === 'gpt-5-mini').p_cached_tokens, 1500);

  // what went to the sender: the photo first, the reply second, in order
  assert.deepEqual(tables.chat_ai_outbox.map((r) => [r.seq === 0 ? r.kind : r.kind, r.status]), [['image', 'sent'], ['text', 'sent']]);
  assert.equal(tables.chat_ai_outbox[0].media.caption, 'Volume Lash Set\nKES 3,500');
  assert.equal(tables.chat_ai_outbox[1].text, 'The volume set is KES 3,500. Want to book this week?');
  assert.ok(tables.chat_ai_outbox.every((r) => r.business_id === 'b1' && r.conversation_id === 'c1' && r.contact_id === 7));

  // what the model saw
  const first = bodies[0];
  assert.equal(first.prompt_cache_key, 'sasa:b1');
  assert.deepEqual(first.tools.map((t: any) => t.name), ['handoff', 'search_products', 'send_products', 'update_profile'], 'sorted, and another business\'s tool is not shown');
  assert.match(first.instructions, /Lashes by Shazz/);
  assert.match(first.instructions, /Lashes \(2\)/, 'category index counts only approved, AI-visible products');
  assert.doesNotMatch(first.instructions, /Hidden/);
  const inputText = JSON.stringify(first.input);
  assert.match(inputText, /Ask which style first/);
  assert.match(inputText, /CHECKOUT-RULES/);
  assert.match(inputText, /hi how much is the volume set/);
  assert.equal(bodies[1].previous_response_id, 'r1');
  assert.equal(bodies[1].input[0].type, 'function_call_output');

  // what was saved
  assert.match(tables.contacts[0].notes, /Asked about the volume set/);
  assert.equal(tables.customer_notes[0].user_id, '7');
  assert.equal(tables.conversations[0].chat_ai_flow_id, 'f1', 'the flow sticks to the chat');

  // what was logged for the QC reviewer
  const turn = tables.chat_ai_turns[0];
  assert.deepEqual([turn.status, turn.mode, turn.qc_status, turn.flow_id], ['replied', 'live', 'pending', 'f1']);
  assert.match(turn.thoughts, /need to search/);
  assert.equal(turn.steps.length, 3);
  assert.equal(turn.tokens_cached, 4500);
  assert.ok(turn.cost_usd > 0);
  assert.ok(Math.abs(turn.cost_usd - 0.001 * billed.length) < 1e-9, 'logged cost is the sum of what was billed');
});

test('a handoff is written to the conversation with its summary, and the customer still gets one message', async () => {
  const { tables, db, sleep } = world();
  const script = [
    { id: 'r1', usage, output: [call(1, 'handoff', { reason: 'wants a refund', urgency: 'high', summary: 'Amina wants a refund on the volume set bought Monday.' })] },
    { id: 'r2', usage, output: [message('I have passed this to the owner, they will pick up from here.')] },
  ];
  const fetchFn = (async (_u: string, init: any) => { JSON.parse(init.body); return ok(script.shift()); }) as unknown as typeof fetch;
  const input = { business_id: 'b1', conversation_id: 'c1', contact_id: 7, trigger_message_id: 'W1' };
  const out = await runTurn(buildDeps({ db, openaiKey: 'k', fetch: fetchFn, sleep }, input), input);
  assert.equal(out.status, 'handoff', String(out.error));
  const convo = tables.conversations[0];
  assert.deepEqual([convo.handover_flag, convo.handover_urgency, convo.handover_source, convo.handover_reason], [true, 'high', 'ai', 'wants a refund']);
  assert.match(convo.handover_summary, /refund on the volume set/);
  assert.equal(tables.chat_ai_outbox.length, 1);
  assert.equal(tables.chat_ai_turns[0].status, 'handoff');
});

test('if the sender is down the AI is told the customer saw nothing and the turn is an error, not a silent success', async () => {
  const { tables, db } = world();
  const script = [{ id: 'r1', usage, output: [message('Which style do you want?')] }];
  const fetchFn = (async (_u: string, init: any) => { JSON.parse(init.body); return ok(script.shift()); }) as unknown as typeof fetch;
  let clock = 0;
  const sleep = async () => { clock += 20_000; };
  const input = { business_id: 'b1', conversation_id: 'c1', contact_id: 7, trigger_message_id: 'W1' };
  const deps = buildDeps({ db, openaiKey: 'k', fetch: fetchFn, sleep }, input);
  const realNow = Date.now;
  Date.now = () => realNow() + clock;
  try {
    const out = await runTurn(deps, input);
    assert.equal(out.status, 'error');
    assert.match(out.error!, /timed_out_waiting_for_sender|not sent/);
    assert.equal(tables.chat_ai_outbox[0].status, 'failed', 'a message nobody sent is cancelled so it cannot go out late');
  } finally {
    Date.now = realNow;
  }
});

test('a simulation sends nothing and writes nothing to the customer, but logs a simulation turn', async () => {
  const { tables, db, sleep } = world();
  const script = [{ id: 'r1', usage, output: [call(1, 'update_profile', { note: 'should not be saved' })] }, { id: 'r2', usage, output: [message('Classic or volume?')] }];
  const fetchFn = (async (_u: string, init: any) => { JSON.parse(init.body); return ok(script.shift()); }) as unknown as typeof fetch;
  const input = { business_id: 'b1', simulate: true, message: 'hi', history: [{ role: 'user' as const, text: 'hi' }], contact: { name: 'Tester', ad_id: 'ad9' } };
  const out = await runTurn(buildDeps({ db, openaiKey: 'k', fetch: fetchFn, sleep }, input), input);
  assert.equal(out.status, 'replied');
  assert.equal(out.flow, 'Lash ad', 'flows can be tested in the Playground by giving the simulated contact an ad');
  assert.equal(tables.chat_ai_outbox.length, 0);
  assert.equal(tables.contacts[0].notes, null);
  assert.equal(tables.conversations[0].chat_ai_flow_id, null);
  assert.equal(tables.chat_ai_turns[0].mode, 'simulation');
});
