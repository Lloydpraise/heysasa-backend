import test from 'node:test';
import assert from 'node:assert/strict';
import { createTyping } from './typing.js';
import { createOrchestrator } from './orchestrator.js';

const sessions = (rows) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: rows }) }) }) }) }) });
const JID = '254712345678@s.whatsapp.net';

test('typing is sent to the customer through the business\'s own WhatsApp connection', async () => {
  const calls = [];
  const typing = createTyping({ supabase: sessions([{ instance_name: 'heysasa_b1' }]), evolutionUrl: 'http://evo/', apiKey: 'K', fetchFn: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201 }; } });
  assert.equal(await typing.start('b1', JID), true);
  assert.equal(calls[0].url, 'http://evo/chat/sendPresence/heysasa_b1');
  assert.equal(calls[0].opts.headers.apikey, 'K');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.number, JID);
  assert.equal(body.presence, 'composing');
  assert.equal(body.options.presence, 'composing');
  await typing.stop('b1', JID);
  assert.equal(JSON.parse(calls[1].opts.body).presence, 'paused');
});

test('typing never throws: a failing Evolution is logged and the reply goes on', async () => {
  const logs = [];
  const bad = createTyping({ supabase: sessions([{ instance_name: 'i' }]), fetchFn: async () => { throw new Error('network down'); }, log: (...a) => logs.push(a) });
  assert.equal(await bad.start('b1', JID), false);
  assert.equal(logs[0][0], 'warn');
  const refused = createTyping({ supabase: sessions([{ instance_name: 'i' }]), fetchFn: async () => ({ ok: false, status: 500 }), log: (...a) => logs.push(a) });
  assert.equal(await refused.start('b1', JID), false);
});

test('groups, unknown addresses and a disconnected business are skipped without any call', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true }; };
  const typing = createTyping({ supabase: sessions([{ instance_name: 'i' }]), fetchFn });
  assert.equal(await typing.start('b1', '12345@g.us'), false);
  assert.equal(await typing.start('b1', null), false);
  assert.equal(await createTyping({ supabase: sessions([]), fetchFn }).start('b1', JID), false);
  assert.equal(calls, 0);
});

test('after Evolution says the endpoint does not exist it stops asking for a few minutes', async () => {
  let calls = 0, t = 0;
  const typing = createTyping({ supabase: sessions([{ instance_name: 'i' }]), now: () => t, fetchFn: async () => { calls++; return { ok: false, status: 404 }; } });
  await typing.start('b1', JID); await typing.start('b1', JID);
  assert.equal(calls, 1);
  t = 6 * 60_000;
  await typing.start('b1', JID);
  assert.equal(calls, 2);
});

const NOW = new Date('2026-10-17T10:00:00Z');
const business = { chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 10, chat_ai_settings: {} };
const chat = { conversation: { ai_enabled: true, handover_flag: false, is_business_chat: true }, contact: { lead_type: 'business' }, lastOwnerMessageAt: null, aiHasReplied: false };
const store = { loadBusiness: async () => business, loadChat: async () => chat, canAfford: async () => true, acquireLock: async () => 't', releaseLock: async () => {}, claimSlot: async () => ({ allowed: true }), unansweredInboundSince: async () => null, logTurn: async () => {} };
const input = { businessId: 'b1', conversationId: 'c1', contactId: 7, message: { keyId: 'K', jid: JID, text: 'hi', type: 'text', isFromMe: false, isGroupOrBroadcast: false, sentAt: new Date(NOW.getTime() - 3000) } };

test('typing starts before the brain is called, and is cleared if nothing is sent', async () => {
  const order = [];
  const typing = { start: async () => { order.push('start'); }, stop: async () => { order.push('stop'); } };
  const brain = async () => { order.push('brain'); return { replied: false, brain_status: 'skipped' }; };
  await createOrchestrator({ store, brain, typing, now: () => NOW })(input);
  assert.deepEqual(order, ['start', 'brain', 'stop']);
});

test('typing is left to clear itself when the brain replied, and a broken typing helper cannot stop the reply', async () => {
  const order = [];
  const typing = { start: async () => { throw new Error('boom'); }, stop: async () => { order.push('stop'); } };
  const brain = async () => { order.push('brain'); return { replied: true, brain_status: 'replied' }; };
  const result = await createOrchestrator({ store, brain, typing, now: () => NOW })(input).catch((e) => e);
  assert.equal(result.status, 'handled');
  assert.deepEqual(order, ['brain']);
});
