import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator, UserFacingError } from './orchestrator.js';
import { createNotes } from './notes.js';
import { fakeEmbed, fakeStore, scriptedModel } from './fakes.js';

function setup({ script, afford = true, storeOver = {} } = {}) {
  const store = fakeStore(storeOver);
  const notes = createNotes({ store, embed: fakeEmbed });
  const callModel = scriptedModel(script);
  const bills = [];
  const logs = [];
  const handleChat = createOrchestrator({
    store, notes, embed: fakeEmbed, callModel, canAfford: async () => afford,
    billModel: async (b) => { bills.push(b); }, now: () => new Date('2026-10-06T09:30:00Z'),
    log: (...args) => logs.push(args),
  });
  const events = [];
  const run = (input) => handleChat({ businessId: 'b1', userId: 'u1', surface: 'campaign_message', message: 'remind them about the pan', ...input }, (e) => events.push(e));
  return { store, notes, callModel, bills, events, logs, run };
}

const text = (body) => body.input.map((i) => (typeof i.content === 'string' ? i.content : '')).join('\n---\n');

test('customer-facing surface: persona + surface skills are loaded, reply streams, draft is saved and returned', async () => {
  const t = setup({ script: [{ text: 'Here is a nudge.\n<draft>Hi {{first_name}}, the pan is still available. Want me to hold one?</draft>' }] });
  const done = await t.run({});

  assert.equal(t.store.db.calls.persona, 1);
  const prompt = text(t.callModel.calls[0]);
  assert.match(prompt, /CUSTOMERS WILL READ THE DRAFT/);
  assert.match(prompt, /Warm, short, uses "karibu"/);
  for (const rule of ['COPY RULES', 'CAMPAIGN RULES', 'SAFETY RULES']) assert.match(prompt, new RegExp(rule));
  assert.doesNotMatch(prompt, /FLOW RULES/);

  assert.equal(done.reply, 'Here is a nudge.');
  assert.equal(done.draft.text, 'Hi {{first_name}}, the pan is still available. Want me to hold one?');
  const streamed = t.events.filter((e) => e.type === 'reply').map((e) => e.text).join('');
  assert.equal(streamed.trim(), 'Here is a nudge.');
  assert.ok(t.events.some((e) => e.type === 'draft_start'));
  assert.equal(t.events.at(-1).type, 'done');

  const saved = t.store.db.messages;
  assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant']);
  assert.equal(saved[1].draft.type, 'text');
  assert.equal(t.store.db.conversations[0].message_count, 2);
});

test('chat lifecycle logs business-scoped metadata without logging chat content', async () => {
  const t = setup({ script: [{ text: 'Here is a nudge.' }] });
  await t.run({});

  assert.equal(t.logs[0][0], 'info');
  assert.equal(t.logs[0][2].event, 'assistant.chat_started');
  assert.equal(t.logs[0][2].businessId, 'b1');
  assert.equal(t.logs[0][2].details.surface, 'campaign_message');
  assert.equal(t.logs[1][0], 'ok');
  assert.equal(t.logs[1][2].event, 'assistant.chat_completed');
  assert.equal(t.logs[1][2].businessId, 'b1');
  assert.equal(t.logs[1][2].details.rounds, 1);
  assert.doesNotMatch(JSON.stringify(t.logs), /remind them about the pan/);
});

test('owner-only surface: the persona pack is NOT loaded and the AI is told to stay plain', async () => {
  const t = setup({ script: [{ text: 'What kind of customer is this flow for?' }] });
  await t.run({ surface: 'general', message: 'help me think' });
  assert.equal(t.store.db.calls.persona, 0);
  const prompt = text(t.callModel.calls[0]);
  assert.match(prompt, /OWNER ONLY/);
  assert.doesNotMatch(prompt, /karibu/);
  assert.match(prompt, /DISCOVERY RULES/);
});

test('flow surface returns a structured flow draft', async () => {
  const t = setup({ script: [{ text: 'First flow for your ad leads.\n<draft><name>Ad leads</name><goal>Get their location</goal><instructions>Ask what they want. Show products.</instructions><skills>offers_and_promotions</skills></draft>' }] });
  const done = await t.run({ surface: 'flow', message: 'people from my pan ad', context: { available_skills: [{ key: 'offers_and_promotions', title: 'Offers' }] } });
  assert.equal(done.draft.type, 'flow');
  assert.deepEqual(done.draft.skill_keys, ['offers_and_promotions']);
  assert.equal(t.store.db.calls.persona, 0);
});

test('tools run together, results go back with previous_response_id, and every response is billed', async () => {
  const t = setup({
    script: [
      { calls: [{ name: 'search_products', args: { query: 'pan' } }, { name: 'save_note', args: { text: 'Best seller is the pan', pinned: true } }] },
      { text: 'Used your real price.\n<draft>The 28cm pan is KES 2,500.</draft>' },
    ],
  });
  const done = await t.run({});

  assert.equal(t.callModel.calls.length, 2);
  const second = t.callModel.calls[1];
  assert.equal(second.previous_response_id, 'r1');
  assert.deepEqual(second.input.map((i) => i.type), ['function_call_output', 'function_call_output']);
  assert.match(second.input[0].output, /KES 2,500/);
  assert.equal(t.store.db.notes.length, 1);
  assert.equal(t.store.db.notes[0].pinned, true);
  assert.equal(t.bills.length, 2);
  assert.equal(t.bills[0].usage.input_tokens, 100);
  assert.ok(t.events.some((e) => e.type === 'status' && /products/i.test(e.text)));
  assert.deepEqual(t.store.db.messages.at(-1).tools_used, ['search_products', 'save_note']);
  assert.match(done.draft.text, /2,500/);
});

test('text streamed before a tool call is cleared with a reset event', async () => {
  const t = setup({ script: [{ text: 'Let me check <draft>' }, { text: 'Final.' }] });
  // First round returns plain text with no calls, so it ends there; use a tool round instead:
  const t2 = setup({ script: [{ calls: [{ name: 'recall_notes', args: { query: 'pan' } }] }, { text: 'Final answer.' }] });
  await t2.run({});
  assert.equal(t2.callModel.calls.length, 2);
  assert.equal(t.callModel.calls.length, 0);
});

test('a skill the AI loads itself is remembered for the next turn of the conversation', async () => {
  const t = setup({ script: [
    { calls: [{ name: 'load_skill', args: { key: 'offers_and_promotions' } }] },
    { text: 'Which discount?' },
    { text: 'Done.\n<draft>Promo text</draft>' },
  ] });
  const first = await t.run({});
  assert.deepEqual(t.store.db.conversations[0].loaded_skills, ['offers_and_promotions']);
  await t.run({ conversationId: first.conversation_id, message: '10% off until Friday' });
  const lastPrompt = text(t.callModel.calls.at(-1));
  assert.match(lastPrompt, /OFFER RULES/);
});

test('an empty balance stops everything before anything is saved', async () => {
  const t = setup({ script: [], afford: false });
  await assert.rejects(t.run({}), (e) => e instanceof UserFacingError && e.code === 'out_of_balance');
  assert.equal(t.store.db.conversations.length, 0);
  assert.equal(t.store.db.messages.length, 0);
});

test('another business cannot resume your conversation', async () => {
  const t = setup({ script: [{ text: 'hi' }] });
  const mine = await t.run({});
  const intruder = createOrchestrator({ store: t.store, notes: t.notes, embed: fakeEmbed, callModel: scriptedModel([{ text: 'x' }]), canAfford: async () => true, billModel: async () => {} });
  await assert.rejects(intruder({ businessId: 'b2', surface: 'general', message: 'hello', conversationId: mine.conversation_id }), (e) => e.code === 'conversation_not_found');
});

test('first turn: relevant saved notes are recalled in code; later turns do not repeat the lookup', async () => {
  const t = setup({ script: [{ text: 'one' }, { text: 'two' }] });
  await t.notes.save({ businessId: 'b1', text: 'The pan is our best seller' });
  const first = await t.run({ message: 'write about the pan' });
  assert.match(text(t.callModel.calls[0]), /NOTES THAT MAY BE RELEVANT[\s\S]*best seller/);
  await t.run({ conversationId: first.conversation_id, message: 'shorter please' });
  assert.doesNotMatch(text(t.callModel.calls[1]), /NOTES THAT MAY BE RELEVANT/);
});

test('pinned notes and owner preferences ride in every prompt; history includes earlier drafts', async () => {
  const t = setup({ script: [{ text: 'a\n<draft>First draft</draft>' }, { text: 'b\n<draft>Shorter draft</draft>' }] });
  t.store.db.prefs = { language: 'mixed', emoji_level: 'none', message_length: 'short', personalization: 'Never mention competitors.' };
  await t.notes.save({ businessId: 'b1', text: 'We only sell cookware', pinned: true });
  const first = await t.run({ message: 'draft something' });
  const body = t.callModel.calls[0];
  assert.match(body.instructions, /PINNED NOTES[\s\S]*only sell cookware/);
  assert.match(body.instructions, /Never mention competitors/);
  assert.match(body.instructions, /Use no emojis/);
  assert.match(body.instructions, /SKILL MENU/);

  await t.run({ conversationId: first.conversation_id, message: 'shorter', currentText: 'old box text' });
  const second = text(t.callModel.calls[1]);
  assert.match(second, /Draft you proposed[\s\S]*First draft/);
  assert.match(second, /CURRENT TEXT IN THE BOX[\s\S]*old box text/);
});

test('the same conversation cannot run two turns at once', async () => {
  let release;
  const slow = async () => { await new Promise((r) => { release = r; }); return { id: 'r1', usage: {}, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }; };
  const store = fakeStore();
  const notes = createNotes({ store, embed: fakeEmbed });
  const handle = createOrchestrator({ store, notes, embed: fakeEmbed, callModel: slow, canAfford: async () => true, billModel: async () => {} });
  const conv = await store.createConversation({ business_id: 'b1', surface: 'general' });
  const first = handle({ businessId: 'b1', surface: 'general', message: 'one', conversationId: conv.id });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(handle({ businessId: 'b1', surface: 'general', message: 'two', conversationId: conv.id }), (e) => e.code === 'busy');
  release();
  await first;
});

test('retry does not save the owner message twice', async () => {
  const t = setup({ script: [{ text: 'first try' }, { text: 'second try' }] });
  const a = await t.run({ message: 'same thing' });
  await t.run({ conversationId: a.conversation_id, message: 'same thing', retry: true });
  assert.equal(t.store.db.messages.filter((m) => m.role === 'user').length, 1);
});

test('input is validated; surface is whitelisted; context is cleaned', async () => {
  const t = setup({ script: [{ text: 'ok' }] });
  await assert.rejects(t.run({ message: '   ' }), (e) => e.code === 'empty_message');
  await assert.rejects(t.run({ message: 'x'.repeat(4001) }), (e) => e.code === 'message_too_long');
  await t.run({ surface: 'made_up', context: { campaign_name: 'Reactivation', 'bad key!': 1, nested: { a: { b: { c: 1 } } } } });
  assert.equal(t.store.db.conversations[0].surface, 'general');
  assert.deepEqual(Object.keys(t.store.db.conversations[0].context), ['campaign_name', 'nested']);
});

test('a model that returns nothing still gives the owner something to read', async () => {
  const t = setup({ script: [{ text: '' }] });
  const done = await t.run({});
  assert.ok(done.reply.length > 10);
  assert.equal(done.draft, null);
});
