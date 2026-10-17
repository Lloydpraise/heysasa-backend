import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.js';
import { createBrainCaller } from './brainClient.js';

const NOW = new Date('2026-10-17T10:00:00Z');
const message = { keyId: 'K1', text: 'hi', type: 'text', isFromMe: false, isGroupOrBroadcast: false, sentAt: new Date(NOW.getTime() - 5000) };
const chat = { conversation: { ai_enabled: true, handover_flag: false, is_business_chat: true }, contact: { lead_type: 'business', is_ad_lead: false, intent_score: 5, lead_state: 'new' }, lastOwnerMessageAt: null, aiHasReplied: false };
const store = (business) => ({ loadBusiness: async () => business, loadChat: async () => chat });
const on = { chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 10, chat_ai_settings: { audience: ['hot'] } };
const input = { businessId: 'b1', conversationId: 'c1', contactId: 7, message };

test('a skip that matters is written to the debug console with its reason', async () => {
  const logs = [];
  const handle = createOrchestrator({ store: store(on), log: (...a) => logs.push(a), now: () => NOW });
  const result = await handle(input);
  assert.equal(result.reason, 'outside_audience');
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'Chat AI');
  assert.equal(logs[0][3].reason, 'outside_audience');
});

test('chat switched off is normal for every message and is not logged', async () => {
  const logs = [];
  const handle = createOrchestrator({ store: store({ ...on, chat_ai_enabled: false }), log: (...a) => logs.push(a), now: () => NOW });
  assert.equal((await handle(input)).reason, 'switch_off');
  assert.equal(logs.length, 0);
});

const call = { businessId: 'b1', conversationId: 'c1', contactId: 7, message };
const caller = (fetchFn, logs) => createBrainCaller({ url: 'https://x.supabase.co', serviceKey: 'k', fetchFn, timeoutMs: 75_000, log: (...a) => logs.push(a) });

test('a brain that never answers is logged as an error with a plain reason', async () => {
  const logs = [];
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  await assert.rejects(caller(async () => { throw timeout; }, logs)(call), /did not answer within 75 seconds/);
  assert.equal(logs.at(-1)[0], 'error');
  assert.match(logs.at(-1)[2], /75 seconds/);
});

test('an HTTP error from the brain is logged with its status and message', async () => {
  const logs = [];
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({ error: 'OpenAI request failed' }) });
  await assert.rejects(caller(fetchFn, logs)(call), /500/);
  assert.match(logs.at(-1)[2], /HTTP 500/);
  assert.equal(logs.at(-1)[3].error, 'OpenAI request failed');
});

test('a normal reply is logged with how long the brain took', async () => {
  const logs = [];
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ status: 'replied' }) });
  const out = await caller(fetchFn, logs)(call);
  assert.equal(out.replied, true);
  assert.equal(logs.at(-1)[0], 'ok');
  assert.equal(typeof logs.at(-1)[3].ms, 'number');
});
