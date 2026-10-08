import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAssistantRouter } from './routes.js';
import { createOrchestrator } from './orchestrator.js';
import { createNotes } from './notes.js';
import { createRateLimiter } from './rateLimit.js';
import { fakeEmbed, fakeStore, scriptedModel } from './fakes.js';

async function boot({ script = [{ text: 'Hi.\n<draft>Hello {{first_name}}</draft>' }], afford = true, limiter, handleChatOverride, log = () => {} } = {}) {
  const store = fakeStore();
  const notes = createNotes({ store, embed: fakeEmbed });
  const handleChat = handleChatOverride ?? createOrchestrator({ store, notes, embed: fakeEmbed, callModel: scriptedModel(script), canAfford: async () => afford, billModel: async () => {} });
  const auth = (req, res, next) => { req.businessId = req.headers['x-business-id'] || 'b1'; req.userId = 'u1'; next(); };
  const app = express();
  app.use(express.json());
  app.use('/assistant', createAssistantRouter({ store, notes, handleChat, skillsForBusiness: store.loadSkills, auth, limiter, log }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { store, call, close: () => server.close() };
}

const events = async (res) => (await res.text()).split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5)));

test('POST /chat streams events and ends with done', async () => {
  const t = await boot();
  const res = await t.call('/chat', { method: 'POST', body: { surface: 'campaign_message', message: 'say hello', context_key: 'campaign_draft:step:1' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const ev = await events(res);
  assert.equal(ev[0].type, 'conversation');
  assert.equal(ev.at(-1).type, 'done');
  assert.equal(ev.at(-1).draft.text, 'Hello {{first_name}}');
  assert.equal(t.store.db.conversations[0].context_key, 'campaign_draft:step:1');
  t.close();
});

test('an empty balance is a normal 402 before any stream starts', async () => {
  const t = await boot({ afford: false });
  const res = await t.call('/chat', { method: 'POST', body: { surface: 'general', message: 'hi' } });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'out_of_balance');
  t.close();
});

test('unexpected streaming failures are logged with safe request context', async () => {
  const logs = [];
  const t = await boot({
    handleChatOverride: async (_input, emit) => {
      emit({ type: 'conversation', conversation_id: 'conversation-1' });
      throw new Error('model provider unavailable');
    },
    log: (...args) => logs.push(args),
  });
  const res = await t.call('/chat', { method: 'POST', body: { surface: 'general', message: 'hi' } });
  const ev = await events(res);
  assert.equal(ev.at(-1).type, 'error');
  assert.equal(ev.at(-1).message, 'Something went wrong. Please try again.');
  const failure = logs.find(([level, , metadata]) => level === 'error' && metadata?.event === 'assistant.chat_failed');
  assert.ok(failure);
  assert.match(failure[1], /model provider unavailable/);
  assert.equal(failure[2].details.errorName, 'Error');
  assert.match(failure[2].details.stack, /model provider unavailable/);
  t.close();
});

test('rate limit returns 429', async () => {
  const t = await boot({ script: [{ text: 'a' }, { text: 'b' }], limiter: createRateLimiter({ max: 1 }) });
  assert.equal((await t.call('/chat', { method: 'POST', body: { surface: 'general', message: 'one' } })).status, 200);
  const second = await t.call('/chat', { method: 'POST', body: { surface: 'general', message: 'two' } });
  assert.equal(second.status, 429);
  t.close();
});

test('conversations are listed by context key, fetched with messages, and approval is recorded', async () => {
  const t = await boot();
  const done = (await events(await t.call('/chat', { method: 'POST', body: { surface: 'campaign_message', message: 'hello', context_key: 'k1' } }))).at(-1);
  const list = await (await t.call('/conversations?context_key=k1')).json();
  assert.equal(list.conversations.length, 1);
  const full = await (await t.call(`/conversations/${done.conversation_id}`)).json();
  assert.deepEqual(full.messages.map((m) => m.role), ['user', 'assistant']);
  const ok = await t.call(`/messages/${done.message_id}/approve`, { method: 'POST', body: { final_text: 'Hello Jane' } });
  assert.equal(ok.status, 200);
  assert.equal(t.store.db.messages.find((m) => m.id === done.message_id).approved, true);
  assert.equal((await t.call('/conversations/not-a-uuid')).status, 400);
  const other = await t.call(`/conversations/${done.conversation_id}`, { headers: { 'X-Business-Id': 'b2' } });
  assert.equal(other.status, 404);
  t.close();
});

test('notes: add, list, edit, delete, and one business cannot touch another\'s', async () => {
  const t = await boot();
  const added = await (await t.call('/notes', { method: 'POST', body: { text: 'We deliver in Nairobi only', pinned: true } })).json();
  assert.equal(added.status, 'saved');
  const list = await (await t.call('/notes')).json();
  assert.equal(list.notes.length, 1);
  const id = list.notes[0].id;
  assert.equal((await t.call(`/notes/${id}`, { method: 'PATCH', headers: { 'X-Business-Id': 'b2' }, body: { text: 'hijacked' } })).status, 404);
  assert.equal((await t.call(`/notes/${id}`, { method: 'PATCH', body: { pinned: false } })).status, 200);
  assert.equal((await t.call(`/notes/${id}`, { method: 'DELETE', headers: { 'X-Business-Id': 'b2' } })).status, 404);
  assert.equal((await t.call(`/notes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await t.call('/notes', { method: 'POST', body: { text: 'a' } })).status, 400);
  t.close();
});

test('preferences validate and round-trip', async () => {
  const t = await boot();
  assert.equal((await (await t.call('/preferences')).json()).preferences.language, 'auto');
  assert.equal((await t.call('/preferences', { method: 'PUT', body: { personalization: 'x', language: 'klingon', emoji_level: 'none', message_length: 'short' } })).status, 400);
  assert.equal((await t.call('/preferences', { method: 'PUT', body: { personalization: 'x'.repeat(1501), language: 'auto', emoji_level: 'none', message_length: 'short' } })).status, 400);
  const saved = await (await t.call('/preferences', { method: 'PUT', body: { personalization: ' Be warm ', language: 'mixed', emoji_level: 'none', message_length: 'medium' } })).json();
  assert.equal(saved.preferences.personalization, 'Be warm');
  t.close();
});

test('skills endpoint exposes titles only, never instructions', async () => {
  const t = await boot();
  const body = await (await t.call('/skills')).json();
  assert.ok(body.skills.length > 3);
  for (const s of body.skills) assert.deepEqual(Object.keys(s).sort(), ['key', 'title']);
  assert.doesNotMatch(JSON.stringify(body), /RULES/);
  t.close();
});
