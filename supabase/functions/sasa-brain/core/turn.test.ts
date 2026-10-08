import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, type TurnContext, type TurnDeps, type TurnInput } from './turn.ts';
import type { ToolRow } from './tools.ts';
import type { SendItem } from './builtin.ts';

const TOOLS: ToolRow[] = [
  { name: 'search_products', business_id: null, description: 'find', parameters: { type: 'object', properties: { query: { type: 'string' } } }, kind: 'builtin', target: 'search_products', phase: 'lookup' },
  { name: 'update_profile', business_id: null, description: 'note', parameters: { type: 'object', properties: { note: { type: 'string' } } }, kind: 'builtin', target: 'update_profile', phase: 'write' },
  { name: 'send_products', business_id: null, description: 'send', parameters: { type: 'object', properties: { product_ids: { type: 'array', items: { type: 'string' } } } }, kind: 'builtin', target: 'send_products', phase: 'send' },
  { name: 'handoff', business_id: null, description: 'handoff', parameters: { type: 'object', properties: {} }, kind: 'builtin', target: 'handoff', phase: 'write' },
  { name: 'load_skill', business_id: null, description: 'skill', parameters: { type: 'object', properties: { key: { type: 'string' } } }, kind: 'builtin', target: 'load_skill', phase: 'lookup' },
];

const PRODUCT = { id: 'p1', title: 'Volume Lash Set', price: 3500, old_price: null, category: 'Lashes', description_short: 'Fluffy volume set', images: ['https://img.test/p1.jpg'], stock_quantity: 4, product_type: 'service' };

const baseCtx = (over: Partial<TurnContext> = {}): TurnContext => ({
  business: { name: 'Lashes by Shazz', currency: 'KES', model: 'gpt-5-mini' },
  settings: { effort: 'medium', settleMs: 0, holdingAfterMs: 0, maxRounds: 6, holdingModel: 'gpt-4.1-mini' },
  persona: { persona: 'Warm, short, a bit playful' }, categories: [{ name: 'Lashes', count: 3 }],
  skills: [
    { key: 'first_reply', title: 'First reply', when_to_use: 'new customer', instructions: 'FIRST-REPLY-RULES' },
    { key: 'checkout', title: 'Checkout', when_to_use: 'wants to buy', instructions: 'CHECKOUT-RULES' },
  ],
  toolRows: TOOLS, flows: [], customer: { name: 'Amina', first_contact: false }, adIds: [], listIds: [], stickyFlowId: null,
  history: [{ role: 'user', text: 'Hi, how much is the volume set?' }], ...over,
});

type Scripted = { thoughts?: string; calls?: Array<{ name: string; args: unknown }>; text?: string };
const response = (n: number, s: Scripted) => ({
  id: `resp_${n}`,
  output: [
    ...(s.thoughts ? [{ type: 'reasoning', summary: [{ text: s.thoughts }] }] : []),
    ...(s.calls ?? []).map((c, i) => ({ type: 'function_call', call_id: `c${n}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
    ...(s.text !== undefined ? [{ type: 'message', content: [{ type: 'output_text', text: s.text }] }] : []),
  ],
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50 },
});

function harness(script: Scripted[], opts: { ctx?: TurnContext; newerInbound?: boolean[]; modelDelayMs?: number; holding?: string | null } = {}) {
  const log = { bodies: [] as Array<Record<string, any>>, sent: [] as SendItem[][], turns: [] as Array<Record<string, any>>, handoffs: [] as string[], flowsRemembered: [] as string[], order: [] as string[] };
  const newer = [...(opts.newerInbound ?? [])];
  let n = 0;
  const ctx = opts.ctx ?? baseCtx();
  const deps: TurnDeps = {
    loadContext: async () => ctx,
    hasNewerInbound: async () => newer.length ? newer.shift()! : false,
    callModel: async (body) => {
      log.bodies.push(body);
      if (opts.modelDelayMs) await new Promise((r) => setTimeout(r, opts.modelDelayMs));
      const next = script[n++];
      if (!next) throw new Error('the model was called more times than the script allows');
      return response(n, next);
    },
    tools: {
      db: {
        rpc: async (fn: string) => { log.order.push(`rpc:${fn}`); return { data: fn === 'match_products_v8' ? [PRODUCT] : [], error: null }; },
        from: (table: string) => ({ update: (row: Record<string, unknown>) => ({ eq: async () => { log.order.push(`update:${table}:${Object.keys(row).join(',')}`); return { error: null }; } }) }),
      },
      embed: async () => [0.1, 0.2], fetch: fetch,
    },
    send: async (items) => { log.order.push('send'); log.sent.push(items); return { ok: true, results: items.map(() => ({ ok: true, messageId: 'm' })) }; },
    holdingMessage: async () => opts.holding ?? null,
    recordHandoff: async (_i, reason) => { log.handoffs.push(reason); },
    rememberFlow: async (_i, id) => { log.flowsRemembered.push(id); },
    logTurn: async (row) => { log.turns.push(row); },
    sleep: async () => {},
  };
  return { deps, log };
}

const SIM: TurnInput = { business_id: 'b1', simulate: true, message: 'Hi, how much is the volume set?' };
const LIVE: TurnInput = { business_id: 'b1', conversation_id: 'c1', contact_id: 7, trigger_message_id: 'W1' };

test('a product question: search, then send the photo alone, then the reply last', async () => {
  const { deps, log } = harness([
    { thoughts: 'Customer wants a price. Search first.', calls: [{ name: 'search_products', args: { query: 'volume lash set' } }, { name: 'load_skill', args: { key: 'checkout' } }] },
    { calls: [{ name: 'send_products', args: { product_ids: ['p1'] } }] },
    { text: 'The volume set is KES 3,500. Want me to book you in this week?' },
  ]);
  const out = await runTurn(deps, SIM);
  assert.equal(out.status, 'replied');
  assert.equal(out.reply, 'The volume set is KES 3,500. Want me to book you in this week?');
  assert.deepEqual(log.sent[0], [{ media: { type: 'image', url: 'https://img.test/p1.jpg', caption: 'Volume Lash Set\nKES 3,500' } }]);
  assert.equal(log.sent.length, 2, 'photo first, reply second');
  assert.deepEqual(out.skills_loaded.sort(), ['checkout']);
  assert.match(out.thoughts, /Search first/);
  assert.equal(out.steps.length, 3);
  assert.equal(log.turns[0].mode, 'simulation');
  assert.equal(log.turns[0].qc_status, null, 'simulations are not queued for QC');
  assert.equal(out.usage.cached, 2400);
});

test('send_products may only use ids that search_products returned in this turn', async () => {
  const { deps, log } = harness([
    { calls: [{ name: 'send_products', args: { product_ids: ['made-up'] } }] },
    { text: 'Let me check that for you.' },
  ]);
  const out = await runTurn(deps, SIM);
  assert.equal(log.sent.length, 1, 'only the reply went out, no photo');
  assert.match((out.steps[0] as any).calls[0].output, /did not come from search_products/);
});

test('an assistant-style draft is sent back for a rewrite and only the rewrite is sent', async () => {
  const { deps, log } = harness([{ text: 'Hi! How can I assist you today?' }, { text: 'Which lash style are you after, classic or volume?' }]);
  const out = await runTurn(deps, SIM);
  assert.equal(out.reply, 'Which lash style are you after, classic or volume?');
  assert.equal(log.sent.length, 1);
  assert.equal(log.bodies[1].previous_response_id, 'resp_1');
  assert.equal(log.bodies[1].tool_choice, 'none');
});

test('two bad drafts in a row hand the chat to the owner and send nothing', async () => {
  const { deps, log } = harness([{ text: 'How can I help you today?' }, { text: 'Feel free to ask me anything!' }]);
  const out = await runTurn({ ...deps }, LIVE);
  assert.equal(out.status, 'handoff');
  assert.equal(out.reply, null);
  assert.equal(log.sent.length, 0);
  assert.deepEqual(log.handoffs, ['reply_failed_checks']);
});

test('an invented price is caught', async () => {
  const { deps, log } = harness([{ text: 'It is KES 2,100 only!' }, { text: 'It is KES 2,100 only, today.' }]);
  const out = await runTurn(deps, SIM);
  assert.equal(out.status, 'handoff');
  assert.equal(log.sent.length, 0);
});

test('the AI can choose silence', async () => {
  const { deps, log } = harness([{ text: '<no_reply>' }]);
  const out = await runTurn(deps, SIM);
  assert.deepEqual([out.status, out.skip_reason, log.sent.length], ['skipped', 'ai_chose_silence', 0]);
});

test('when the customer writes again mid-turn the stale draft is dropped and the turn restarts', async () => {
  const { deps, log } = harness(
    [{ text: 'Which style do you want?' }, { text: 'Got both messages. Classic or volume?' }],
    { newerInbound: [true, false] },
  );
  const out = await runTurn(deps, LIVE);
  assert.equal(out.status, 'replied');
  assert.equal(out.reruns, 1);
  assert.equal(log.sent.length, 1, 'only the fresh reply is sent');
  assert.equal(out.reply, 'Got both messages. Classic or volume?');
});

test('a customer who keeps writing cannot loop the turn forever', async () => {
  const { deps, log } = harness(
    [{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }],
    { newerInbound: [true, true, true, true] },
  );
  const out = await runTurn(deps, LIVE);
  assert.equal(out.reruns, 2);
  assert.equal(log.sent.length, 1);
  assert.equal(out.reply, 'Three.');
});

test('a slow turn sends one holding message and tells the model not to greet again', async () => {
  const { deps, log } = harness(
    [{ calls: [{ name: 'search_products', args: { query: 'x' } }] }, { text: 'Found it: the volume set is KES 3,500.' }],
    { ctx: baseCtx({ settings: { ...baseCtx().settings, holdingAfterMs: 20 } }), modelDelayMs: 80, holding: 'One sec, checking that for you.' },
  );
  const out = await runTurn(deps, LIVE);
  assert.equal(out.holding_message, 'One sec, checking that for you.');
  assert.deepEqual(log.sent.map((s) => (s[0] as any).text), ['One sec, checking that for you.', 'Found it: the volume set is KES 3,500.']);
  const second = JSON.stringify(log.bodies[1].input);
  assert.match(second, /already sent the customer this holding message/);
});

test('a fast turn sends no holding message', async () => {
  const { deps, log } = harness([{ text: 'Classic or volume?' }], { ctx: baseCtx({ settings: { ...baseCtx().settings, holdingAfterMs: 500 } }), holding: 'One sec.' });
  const out = await runTurn(deps, LIVE);
  assert.equal(out.holding_message, null);
  assert.equal(log.sent.length, 1);
});

test('a flow is chosen by code, remembered, and its skills are loaded up front', async () => {
  const flow = { id: 'f1', name: 'Valentine ad', enabled: true, priority: 100, trigger: { ad_ids: ['ad9'] }, goal: 'Book this week', instructions: 'Always ask which service first.', skill_keys: ['checkout'], created_at: '2026-01-01' };
  const { deps, log } = harness([{ text: 'Which service caught your eye?' }], { ctx: baseCtx({ flows: [flow], adIds: ['ad9'] }) });
  const out = await runTurn(deps, LIVE);
  assert.equal(out.flow, 'Valentine ad');
  assert.deepEqual(log.flowsRemembered, ['f1']);
  const first = JSON.stringify(log.bodies[0].input);
  assert.match(first, /Always ask which service first/);
  assert.match(first, /CHECKOUT-RULES/);
  assert.ok(out.skills_loaded.includes('checkout'));
  assert.equal(log.turns[0].flow_id, 'f1');
  assert.equal(log.turns[0].qc_status, 'pending');
});

test('a first-time customer gets the first-reply skill without asking for it', async () => {
  const { deps, log } = harness([{ text: 'Which style are you after?' }], { ctx: baseCtx({ customer: { first_contact: true } }) });
  const out = await runTurn(deps, SIM);
  assert.deepEqual(out.skills_loaded, ['first_reply']);
  assert.match(JSON.stringify(log.bodies[0].input), /FIRST-REPLY-RULES/);
});

test('the prompt prefix is identical between turns of the same business, so the cache can hit', async () => {
  const a = harness([{ text: 'Classic or volume?' }]);
  const b = harness([{ text: 'Classic or volume?' }], { ctx: baseCtx({ history: [{ role: 'user', text: 'A completely different question' }], customer: { name: 'Otieno' } }) });
  await runTurn(a.deps, SIM); await runTurn(b.deps, SIM);
  assert.equal(a.log.bodies[0].instructions, b.log.bodies[0].instructions);
  assert.equal(JSON.stringify(a.log.bodies[0].tools), JSON.stringify(b.log.bodies[0].tools));
  assert.equal(a.log.bodies[0].prompt_cache_key, 'sasa:b1');
});

test('a handoff is recorded and not dropped even if the customer wrote again', async () => {
  const { deps, log } = harness(
    [{ calls: [{ name: 'handoff', args: { reason: 'wants refund', urgency: 'high', summary: 'Wants a refund for the volume set.' } }] }, { text: 'I have passed this to the owner, they will pick up from here.' }],
    { newerInbound: [true] },
  );
  const out = await runTurn(deps, LIVE);
  assert.equal(out.status, 'handoff');
  assert.equal(out.handoff?.urgency, 'high');
  assert.equal(log.sent.length, 1, 'the customer is told the owner will pick up');
  assert.ok(log.order.some((o) => o.startsWith('update:conversations:handover_flag')), 'the handoff was written to the conversation');
  assert.equal(out.reruns, 0);
});

test('a failing model call is reported as an error turn, never thrown into the caller', async () => {
  const { deps, log } = harness([]);
  const out = await runTurn(deps, SIM);
  assert.equal(out.status, 'error');
  assert.match(out.error!, /more times than the script/);
  assert.equal(log.turns[0].status, 'error');
});

test('an empty wallet stops the turn before any model call, and logs why', async () => {
  const { deps, log } = harness([]);
  deps.canAfford = async () => false;
  const out = await runTurn(deps, LIVE);
  assert.equal(out.status, 'skipped');
  assert.equal(out.skip_reason, 'no_balance');
  assert.equal(log.bodies.length, 0);
  assert.equal(log.sent.length, 0);
  assert.equal(log.turns[0].skip_reason, 'no_balance');
});

test('the logged cost is what was actually billed when the deps report it', async () => {
  const { deps, log } = harness([{ text: 'Hi Amina! The volume set is great. Want to book?' }]);
  deps.spend = () => ({ base: 0.0123, billed: 0.0984 });
  await runTurn(deps, SIM);
  assert.equal(log.turns[0].cost_usd, 0.0123);
});

// ── speed: photos in the background, burst wait, effort ──
const PHOTO_TURN: Scripted[] = [
  { calls: [{ name: 'search_products', args: { query: 'volume lash set' } }] },
  { calls: [{ name: 'send_products', args: { product_ids: ['p1'] } }] },
  { text: 'The volume set is KES 3,500. Want me to book you in this week?' },
];

test('photos go out while the AI writes, and the reply is only sent once they have landed', async () => {
  let landPhotos!: () => void;
  const landed = new Promise<void>((resolve) => { landPhotos = resolve; });
  const events: string[] = [];
  const { deps, log } = harness(PHOTO_TURN);
  deps.queue = async (items) => {
    events.push('queued');
    log.sent.push(items);
    return { ok: true, settled: landed.then(() => { events.push('photos landed'); return { ok: true, results: items.map(() => ({ ok: true, messageId: 'm' })) }; }) };
  };
  const plainSend = deps.send;
  deps.send = async (items) => { events.push('reply sent'); return plainSend(items); };

  const turn = runTurn(deps, LIVE);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(log.bodies.length, 3, 'the AI wrote its message without waiting for WhatsApp');
  assert.deepEqual(events, ['queued'], 'the reply is held back until the photos have landed');
  landPhotos();
  const out = await turn;
  assert.deepEqual(events, ['queued', 'photos landed', 'reply sent']);
  assert.equal(out.status, 'replied');
  assert.match(JSON.stringify(out.steps), /being sent to the customer now/);
  assert.equal(typeof log.turns[0].input.timings.delivery_wait_ms, 'number');
});

test('if a photo fails to send, the AI writes its reply again knowing which one, and never claims the customer saw it', async () => {
  const { deps, log } = harness([
    ...PHOTO_TURN.slice(0, 2),
    { text: 'Here is the volume set, KES 3,500. Shall I book you in?' },
    { text: 'The volume set is KES 3,500. The photo did not go through, so I will send it again shortly. Shall I book you in?' },
  ]);
  deps.queue = async (items) => ({ ok: true, settled: Promise.resolve({ ok: false, error: 'whatsapp_not_connected', results: items.map(() => ({ ok: false, error: 'whatsapp_not_connected' })) }) });
  const out = await runTurn(deps, LIVE);
  assert.equal(out.status, 'replied');
  assert.match(out.reply!, /photo did not go through/);
  assert.equal(log.bodies.length, 4);
  assert.equal(log.bodies[3].previous_response_id, 'resp_3');
  assert.match(JSON.stringify(log.bodies[3].input), /did not reach the customer, so they have not seen them: Volume Lash Set/);
  assert.equal(log.sent.length, 1, 'only the corrected reply went out');
  assert.match((log.sent[0][0] as { text: string }).text, /did not go through/);
});

test('after a failed photo the AI can still retry it, and that retry waits for WhatsApp so it sees the real outcome', async () => {
  const { deps, log } = harness([
    ...PHOTO_TURN.slice(0, 2),
    { text: 'Here is the volume set, KES 3,500. Shall I book you in?' },
    { calls: [{ name: 'send_products', args: { product_ids: ['p1'] } }] },
    { text: 'Sent the volume set again, KES 3,500. Shall I book you in?' },
  ]);
  deps.queue = async (items) => ({ ok: true, settled: Promise.resolve({ ok: false, error: 'timed_out_waiting_for_sender', results: items.map(() => ({ ok: false, error: 'timed_out_waiting_for_sender' })) }) });
  const out = await runTurn(deps, LIVE);
  assert.equal(out.status, 'replied');
  assert.equal(log.sent.length, 2, 'the retried photo, then the reply');
  assert.ok((log.sent[0][0] as { media?: unknown }).media, 'the retry went through the waiting path');
});

test('the burst wait only covers what is left of the quiet time, and stretches while the customer keeps writing', async () => {
  const settings = { effort: 'low', settleMs: 3000, holdingAfterMs: 0, maxRounds: 6, holdingModel: 'gpt-4.1-mini' };
  const run = async (latest: ((clock: number, call: number) => number | null) | null) => {
    const { deps } = harness([{ text: 'Which style do you want?' }], { ctx: baseCtx({ settings }) });
    const sleeps: number[] = [];
    let clock = 1_000_000;
    let call = 0;
    deps.now = () => clock;
    deps.sleep = async (ms) => { sleeps.push(ms); clock += ms; };
    if (latest) deps.latestInboundAt = async () => latest(clock, ++call);
    await runTurn(deps, LIVE);
    return sleeps;
  };
  assert.deepEqual(await run((c, n) => (n === 1 ? c - 2000 : n === 2 ? c - 200 : c - 10_000)), [1000, 2800], 'waits the rest, then again after a new message');
  assert.deepEqual(await run((c) => c - 5000), [], 'no wait at all when the message is already old enough');
  assert.deepEqual(await run(() => null), [3000], 'cannot tell when it arrived: the full wait');
  assert.deepEqual(await run(null), [3000], 'no lookup available: the full wait');
  assert.deepEqual(await run((c) => c), [3000, 3000], 'never more than twice the settle time');
});

test('only reasoning models are sent a reasoning setting', async () => {
  const plain = harness([{ text: 'Which style do you want?' }], { ctx: baseCtx({ business: { name: 'Biz', currency: 'KES', model: 'gpt-4.1-mini' } }) });
  await runTurn(plain.deps, SIM);
  assert.equal('reasoning' in plain.log.bodies[0], false);
  const reasoning = harness([{ text: 'Which style do you want?' }]);
  await runTurn(reasoning.deps, SIM);
  assert.equal(reasoning.log.bodies[0].reasoning.effort, 'medium', 'the business setting is passed through');
});

test('the wallet check and the settings read run together, and an empty wallet still stops the turn before any model call', async () => {
  const order: string[] = [];
  const { deps, log } = harness([{ text: 'never reached' }]);
  deps.loadSettings = async () => { order.push('settings'); return baseCtx().settings; };
  deps.canAfford = async () => { order.push('wallet'); return false; };
  const out = await runTurn(deps, LIVE);
  assert.deepEqual(order.sort(), ['settings', 'wallet']);
  assert.deepEqual([out.status, out.skip_reason, log.bodies.length], ['skipped', 'no_balance', 0]);
});

test('where the time went is saved with every live turn', async () => {
  const { deps, log } = harness([{ text: 'Which style do you want?' }]);
  await runTurn(deps, LIVE);
  assert.deepEqual(Object.keys(log.turns[0].input.timings).sort(), ['context_ms', 'delivery_wait_ms', 'prep_ms', 'settle_ms']);
});
